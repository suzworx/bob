/**
 * The per-account active-Space pointer (bob.user_state space_* columns),
 * plus an optional per-device pointer (bob.devices) layered on top: a device
 * uses its own pointer when set, else the account's -- no "newest wins". A
 * stale id (archived Space, revoked membership) is nulled on read, so it never
 * survives. A Space the caller cannot use throws the same StoreNotFoundError
 * whether it is unknown, not theirs, or archived (no oracle).
 */
import { StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';

export type ActiveSpaceSurface = 'web' | 'device';

type ActiveSpace = {
  spaceId: string | null;
  name: string | null;
  changedAt: number;
  cleared: boolean;
};

type RawPointer = { storedId: unknown; liveId: unknown; name: unknown; changedAt: unknown };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let lastStamp = 0;

/** A strictly increasing millisecond stamp. */
function now(): number {
  const wall = Date.now();
  lastStamp = wall > lastStamp ? wall : lastStamp + 1;
  return lastStamp;
}

function readAccountPointer(tx: Db, userId: string): Promise<RawPointer[]> {
  return tx.query<RawPointer>(
    `SELECT a.active_space_id AS "storedId", s.id AS "liveId", s.name,
            floor(extract(epoch from a.space_changed_at) * 1000)::bigint AS "changedAt"
     FROM bob.user_state a
     LEFT JOIN bob.space_memberships m
       ON m.space_id = a.active_space_id AND m.user_id = a.user_id AND m.revoked_at IS NULL
     LEFT JOIN bob.spaces s ON s.id = m.space_id AND s.archived_at IS NULL
     WHERE a.user_id = $1 AND a.space_surface IS NOT NULL`,
    [userId],
  );
}

function readDevicePointer(tx: Db, userId: string, deviceId: string): Promise<RawPointer[]> {
  return tx.query<RawPointer>(
    `SELECT d.active_space_id AS "storedId", s.id AS "liveId", s.name,
            floor(extract(epoch from d.space_changed_at) * 1000)::bigint AS "changedAt"
     FROM bob.devices d
     LEFT JOIN bob.space_memberships m
       ON m.space_id = d.active_space_id AND m.user_id = d.user_id AND m.revoked_at IS NULL
     LEFT JOIN bob.spaces s ON s.id = m.space_id AND s.archived_at IS NULL
     WHERE d.id = $1 AND d.user_id = $2 AND d.space_surface IS NOT NULL`,
    [deviceId, userId],
  );
}

async function resolvePointer(row: RawPointer, clearStale: (stamp: number) => Promise<unknown>): Promise<ActiveSpace> {
  if (row.storedId === null) {
    return { spaceId: null, name: null, changedAt: Number(row.changedAt), cleared: false };
  }
  if (row.liveId !== null) {
    return { spaceId: String(row.liveId), name: String(row.name), changedAt: Number(row.changedAt), cleared: false };
  }
  const stamp = now();
  await clearStale(stamp);
  return { spaceId: null, name: null, changedAt: stamp, cleared: true };
}

/**
 * Null when no row exists; `spaceId: null` when cleared. With `deviceId`, a
 * device without its own pointer (including an unknown or another account's
 * device) falls back to the account pointer.
 */
export async function getActiveSpace(db: Db, userId: string, deviceId?: string): Promise<ActiveSpace | null> {
  return withUser(db, userId, async (tx) => {
    if (deviceId !== undefined) {
      const deviceRow = (await readDevicePointer(tx, userId, deviceId))[0];
      if (deviceRow) {
        return resolvePointer(deviceRow, (stamp) => tx.query(
          `UPDATE bob.devices SET active_space_id = NULL, space_changed_at = to_timestamp($3 / 1000.0)
           WHERE id = $1 AND user_id = $2`,
          [deviceId, userId, stamp],
        ));
      }
    }
    const row = (await readAccountPointer(tx, userId))[0];
    if (!row) return null;
    return resolvePointer(row, (stamp) => tx.query(
      `UPDATE bob.user_state SET active_space_id = NULL, space_changed_at = to_timestamp($2 / 1000.0)
       WHERE user_id = $1`,
      [userId, stamp],
    ));
  });
}

/**
 * Upserts the pointer on the caller's withUser-bound transaction and returns
 * the stamp and the Space's name. With `deviceId` it also UPDATEs that
 * device's own pointer (an unknown or not-owned id matches no row); a web PUT
 * with device_id passes `moveAccount` false to move only the device. Without
 * `deviceId` it is an account-level move, so every device's own pointer is
 * reset and they follow the account again.
 */
export async function setActiveSpace(
  tx: Db,
  userId: string,
  spaceId: string | null,
  surface: ActiveSpaceSurface,
  deviceId?: string,
  moveAccount = true,
): Promise<{ changedAt: number; name: string | null }> {
  let name: string | null = null;
  if (spaceId !== null) {
    if (!UUID_RE.test(spaceId)) throw new StoreNotFoundError('space not found');
    const found = await tx.query<{ name: unknown }>(
      `SELECT s.name
       FROM bob.spaces s
       JOIN bob.space_memberships m ON m.space_id = s.id AND m.user_id = $1 AND m.revoked_at IS NULL
       WHERE s.id = $2 AND s.archived_at IS NULL`,
      [userId, spaceId],
    );
    const row = found[0];
    if (!row) throw new StoreNotFoundError('space not found');
    name = String(row.name);
  }
  const stamp = now();
  if (deviceId === undefined || moveAccount) {
    await tx.query(
      `INSERT INTO bob.user_state (user_id, active_space_id, space_changed_at, space_surface)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), $4)
       ON CONFLICT (user_id) DO UPDATE
         SET active_space_id  = EXCLUDED.active_space_id,
             space_changed_at = EXCLUDED.space_changed_at,
             space_surface    = EXCLUDED.space_surface`,
      [userId, spaceId, stamp, surface],
    );
  }
  if (deviceId !== undefined) {
    await tx.query(
      `UPDATE bob.devices
       SET active_space_id = $3, space_surface = $4, space_changed_at = to_timestamp($5 / 1000.0)
       WHERE id = $1 AND user_id = $2`,
      [deviceId, userId, spaceId, surface, stamp],
    );
  } else {
    await clearDeviceSpacePointers(tx, userId);
  }
  return { changedAt: stamp, name };
}

/**
 * Clears the account's pointer only if it names `spaceId`, and nulls the
 * devices pointing at it too (space_surface kept, so they read back
 * explicitly cleared rather than falling back). Returns the stamp when the
 * account row was cleared; the device clear runs either way.
 */
export async function clearActiveSpaceIf(db: Db, userId: string, spaceId: string): Promise<number | null> {
  if (!UUID_RE.test(spaceId)) return null;
  return withUser(db, userId, async (tx) => {
    const stamp = now();
    const rows = await tx.query<{ userId: unknown }>(
      `UPDATE bob.user_state SET active_space_id = NULL, space_changed_at = to_timestamp($3 / 1000.0)
       WHERE user_id = $1 AND active_space_id = $2
       RETURNING user_id AS "userId"`,
      [userId, spaceId, stamp],
    );
    await tx.query(
      `UPDATE bob.devices SET active_space_id = NULL, space_changed_at = to_timestamp($3 / 1000.0)
       WHERE user_id = $1 AND active_space_id = $2`,
      [userId, spaceId, stamp],
    );
    return rows.length > 0 ? stamp : null;
  });
}

/** Resets every device's space columns to "absent", so each follows the account pointer. */
export async function clearDeviceSpacePointers(db: Db, userId: string): Promise<void> {
  await withUser(db, userId, (tx) => tx.query(
    `UPDATE bob.devices SET active_space_id = NULL, space_surface = NULL, space_changed_at = NULL
     WHERE user_id = $1`,
    [userId],
  ));
}
