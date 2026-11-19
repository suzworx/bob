/**
 * The account's devices. Every function runs under withUser: RLS scopes reads
 * to the caller's own devices and the name-only column grant prevents any
 * other write. Revoke is bob_private.revoke_device in pairing-store.ts.
 */
import { StoreError, withUser, type Db } from '../platform/db/db.ts';

/** The generic 404: device absent or not owned by the caller. */
export class DeviceNotFoundError extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceNotFoundError';
  }
}

interface StoredDevice {
  id: string;
  name: string;
  model: string;
  /** The board its last hello named (OTA firmware), or null when none has. */
  board: string | null;
  pairedAt: number;
  lastSeenAt: number | null;
}

/** The account's non-revoked devices, newest paired first. */
export async function listDevices(db: Db, userId: string): Promise<StoredDevice[]> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<{
      id: string;
      name: string;
      model: string;
      fw_board: string | null;
      paired_at: Date | string;
      last_seen_at: Date | string | null;
    }>(
      `select id, name, model, fw_board, paired_at, last_seen_at
         from bob.devices
        where revoked_at is null
        order by paired_at desc`,
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      model: row.model,
      board: row.fw_board,
      pairedAt: new Date(row.paired_at).getTime(),
      lastSeenAt: row.last_seen_at === null ? null : new Date(row.last_seen_at).getTime(),
    }));
  });
}

/** An unknown, revoked or other account's device all raise DeviceNotFoundError. */
export async function renameDevice(
  db: Db,
  userId: string,
  deviceId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<{ id: string }>(
      'update bob.devices set name = $1 where id = $2 and revoked_at is null returning id',
      [name, deviceId],
    );
    const row = rows[0];
    if (row === undefined) throw new DeviceNotFoundError('device not found or not owned');
    return { id: row.id, name };
  });
}