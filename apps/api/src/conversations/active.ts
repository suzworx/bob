/**
 * The per-account active-conversation pointer ("follow last active") in
 * bob.user_state, plus each device's own pointer on bob.devices.
 *
 * setActive is an upsert the CALLER runs inside its own withUser transaction,
 * so the pointer can never name a conversation that failed to save. The FK
 * `on delete set null` clears the pointer when the active conversation is
 * deleted; getActive then reports the cleared form (both ids null) rather
 * than pretending there is no row.
 */
import { parseDeviceRef, threadRef } from '../devices/conversation-ref.ts';
import { asServer, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { canonicalId } from '../platform/ids.ts';
import { primeActiveConversation } from '../platform/observability/active-conversation.ts';
import { clearDeviceSpacePointers } from '../spaces/active.ts';

/** The action that changed the pointer. */
export type ActiveSurface = 'web_text' | 'web_voice' | 'device' | 'picker' | 'activate';

/** What the pointer names; null when it is cleared. */
type ActiveKind = 'conversation' | 'thread';

export type ActiveConversation = {
  /** The device ref: a conversation id, or `thr_<uuid>` for a space thread. */
  conversationId: string | null;
  kind: ActiveKind | null;
  threadId: string | null;
  spaceId: string | null;
  title: string | null;
  surface: ActiveSurface;
  changedAt: number;
  /** True when this read found a stale thread and nulled it. */
  cleared: boolean;
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SURFACES: readonly ActiveSurface[] = ['web_text', 'web_voice', 'device', 'picker', 'activate'];

function toSurface(value: unknown): ActiveSurface {
  return SURFACES.includes(value as ActiveSurface) ? (value as ActiveSurface) : 'web_text';
}

let lastStamp = 0;

/** A strictly increasing millisecond stamp, shared by every active-pointer write. */
export function now(): number {
  const wall = Date.now();
  lastStamp = wall > lastStamp ? wall : lastStamp + 1;
  return lastStamp;
}

/** Optional device scope: when set, the device's own pointer is also
 *  consulted or written alongside the account pointer. */
interface DeviceActiveOptions {
  deviceId?: string;
  /** Device actions also move the account pointer (default true); a web PUT
   *  with device_id passes false, moving only that device's own pointer. */
  moveAccount?: boolean;
}

interface PointerRow {
  storedId: unknown;
  liveId: unknown;
  spaceId: unknown;
  spaceKind: unknown;
  live: unknown;
  title: unknown;
  surface: unknown;
  changedAt: unknown;
}

/** Turns one pointer row into its ActiveConversation, nulling a stale thread
 *  through clearStale. Shared by the account and device reads. */
async function resolvePointer(
  row: PointerRow,
  clearStale: (stamp: number) => Promise<void>,
): Promise<ActiveConversation> {
  const surface = toSurface(row.surface);
  const empty = {
    conversationId: null, kind: null, threadId: null, spaceId: null, title: null, surface,
  } as const;
  if (row.storedId === null) {
    return { ...empty, changedAt: Number(row.changedAt), cleared: false };
  }
  if (row.liveId !== null && (row.spaceId === null || row.spaceKind === 'private')) {
    return {
      ...empty,
      conversationId: String(row.storedId),
      kind: 'conversation',
      title: row.title === null ? null : String(row.title),
      changedAt: Number(row.changedAt),
      cleared: false,
    };
  }
  if (row.liveId !== null && row.spaceKind !== null && row.live === true) {
    const threadId = String(row.liveId);
    return {
      conversationId: threadRef(threadId),
      kind: 'thread',
      threadId,
      spaceId: String(row.spaceId),
      title: String(row.title),
      surface,
      changedAt: Number(row.changedAt),
      cleared: false,
    };
  }
  const stamp = now();
  await clearStale(stamp);
  return { ...empty, changedAt: stamp, cleared: true };
}

/** deviceId's own pointer, scoped to userId's own device (not just RLS); null
 *  when it has none of its own, so getActive falls back to the account
 *  pointer. */
async function readDevicePointer(tx: Db, deviceId: string, userId: string): Promise<ActiveConversation | null> {
  const rows = await tx.query<PointerRow>(
    `SELECT d.active_conversation_id AS "storedId", c.id AS "liveId",
            c.space_id AS "spaceId", s.kind AS "spaceKind",
            (c.archived_at IS NULL AND s.archived_at IS NULL) AS "live", c.title,
            d.conversation_surface AS surface,
            floor(extract(epoch from d.conversation_changed_at) * 1000)::bigint AS "changedAt"
     FROM bob.devices d
     LEFT JOIN bob.conversations c ON c.id = d.active_conversation_id
     LEFT JOIN bob.spaces s ON s.id = c.space_id
     WHERE d.id = $1 AND d.user_id = $2 AND d.conversation_surface IS NOT NULL`,
    [deviceId, userId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return resolvePointer(row, async (stamp) => {
    await tx.query(
      `UPDATE bob.devices
       SET active_conversation_id = NULL, conversation_changed_at = to_timestamp($3 / 1000.0)
       WHERE id = $1 AND user_id = $2`,
      [deviceId, userId, stamp],
    );
  });
}

/** The account's pointer in bob.user_state; null when no row exists. */
async function readAccountPointer(tx: Db, userId: string): Promise<ActiveConversation | null> {
  const rows = await tx.query<PointerRow>(
    `SELECT a.active_conversation_id AS "storedId", c.id AS "liveId",
            c.space_id AS "spaceId", s.kind AS "spaceKind",
            (c.archived_at IS NULL AND s.archived_at IS NULL) AS "live", c.title,
            a.conversation_surface AS surface,
            floor(extract(epoch from a.conversation_changed_at) * 1000)::bigint AS "changedAt"
     FROM bob.user_state a
     LEFT JOIN bob.conversations c ON c.id = a.active_conversation_id
     LEFT JOIN bob.spaces s ON s.id = c.space_id
     WHERE a.user_id = $1 AND a.conversation_surface IS NOT NULL`,
    [userId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return resolvePointer(row, async (stamp) => {
    await tx.query(
      `UPDATE bob.user_state
       SET active_conversation_id = NULL, conversation_changed_at = to_timestamp($2 / 1000.0)
       WHERE user_id = $1`,
      [userId, stamp],
    );
  });
}

/**
 * The account pointer's stored id and nothing else (telemetry labels): one query, no joins, no stale-clearing write.
 * RLS still needs the user's claims, so it runs in the same minimal withUser transaction as every user read.
 */
export async function readActiveConversationId(db: Db, userId: string): Promise<string | null> {
  const rows = await withUser(db, userId, (tx) => tx.query<{ id: unknown }>(
    'SELECT active_conversation_id AS id FROM bob.user_state WHERE user_id = $1', [userId]));
  const id = rows[0]?.id;
  return id === undefined || id === null ? null : String(id);
}

/**
 * Many accounts' active conversations (canonical) in ONE read, for a background fan-out's telemetry
 * (never authorization). Server path through a definer: pass the RAW Db. Accounts with none are absent.
 */
export async function readActiveConversationIds(db: Db, userIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)].filter((id) => UUID_RE.test(id));
  if (ids.length === 0) return new Map();
  const rows = await asServer(db, (server) => server.query<{ userId: unknown; conversationId: unknown }>(
    'SELECT "userId", "conversationId" FROM bob_private.active_conversation_ids($1::uuid[])', [ids]));
  const out = new Map<string, string>();
  for (const row of rows) {
    const id = canonicalId('conversation', String(row.conversationId));
    if (id !== null) out.set(String(row.userId), id);
  }
  return out;
}

/**
 * Reads the active pointer. With a deviceId, the device's OWN pointer wins
 * when it has one set; else this is the account pointer (no newest-wins).
 */
export async function getActive(
  db: Db,
  userId: string,
  options: DeviceActiveOptions = {},
): Promise<ActiveConversation | null> {
  return withUser(db, userId, async (tx) => {
    if (options.deviceId !== undefined) {
      const device = await readDevicePointer(tx, options.deviceId, userId);
      if (device !== null) return device;
    }
    const account = await readAccountPointer(tx, userId);
    primeActiveConversation(userId, account?.conversationId ?? null);
    return account;
  });
}

/**
 * Upserts the account's pointer. With a deviceId, also writes that device's
 * own pointer in the same transaction, leaving other devices' untouched. With
 * NO deviceId, clears every device's own pointer ("follow-me": a plain
 * account-level write puts every device back to following the account).
 * `ref` is a device ref: a conversation id, a `thr_<uuid>` space thread, or
 * null to clear. A thread must be visible under RLS and not archived, else
 * StoreNotFoundError('thread not found') with no id in it. Runs on the
 * caller's transaction (a withUser-bound Db) and returns the changed_at stamp
 * it used, for the caller's `active.changed` event.
 */
export async function setActive(
  tx: Db,
  userId: string,
  ref: string | null,
  surface: ActiveSurface,
  options: DeviceActiveOptions = {},
): Promise<number> {
  let conversationId: string | null = null;
  if (ref !== null) {
    const parsed = parseDeviceRef(ref);
    if (parsed === null) throw new StoreNotFoundError('thread not found');
    if (parsed.kind === 'conversation') {
      conversationId = parsed.conversationId;
    } else {
      const found = await tx.query<{ id: unknown }>(
        `SELECT c.id FROM bob.conversations c JOIN bob.spaces s ON s.id = c.space_id
         WHERE c.id = $1 AND c.archived_at IS NULL AND s.kind <> 'private'`,
        [parsed.threadId],
      );
      const thread = found[0];
      if (!thread) throw new StoreNotFoundError('thread not found');
      conversationId = String(thread.id);
    }
  }
  const stamp = now();
  const moveAccount = options.deviceId === undefined || options.moveAccount !== false;
  if (moveAccount) {
    await tx.query(
      `INSERT INTO bob.user_state
         (user_id, active_conversation_id, conversation_changed_at, conversation_surface)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), $4)
       ON CONFLICT (user_id) DO UPDATE
         SET active_conversation_id  = EXCLUDED.active_conversation_id,
             conversation_changed_at = EXCLUDED.conversation_changed_at,
             conversation_surface    = EXCLUDED.conversation_surface`,
      [userId, conversationId, stamp, surface],
    );
    primeActiveConversation(userId, conversationId);
  }
  if (options.deviceId !== undefined) {
    await tx.query(
      `UPDATE bob.devices
       SET active_conversation_id = $4, conversation_surface = $5, conversation_changed_at = to_timestamp($3 / 1000.0)
       WHERE id = $1 AND user_id = $2`,
      [options.deviceId, userId, stamp, conversationId, surface],
    );
  } else {
    // Follow-me resets both pointer kinds: a device's own Space pointer too.
    await clearAllDeviceConversationPointers(tx, userId);
    await clearDeviceSpacePointers(tx, userId);
  }
  return stamp;
}

async function clearAllDeviceConversationPointers(tx: Db, userId: string): Promise<void> {
  await tx.query(
    `UPDATE bob.devices
     SET active_conversation_id = NULL, conversation_surface = NULL, conversation_changed_at = NULL
     WHERE user_id = $1`,
    [userId],
  );
}

/** Nulls every one of the account's devices' own conversation pointer, so
 *  every device goes back to following the account pointer. */
export async function clearDevicePointers(db: Db, userId: string): Promise<void> {
  await withUser(db, userId, (tx) => clearAllDeviceConversationPointers(tx, userId));
}

/** Nulls userId's device pointers naming a conversation in spaceId, through
 *  the definer (20261007120000_device_pointers) whenever it exists: a device's
 *  own pointer is independent of whether the account pointer matched. */
async function clearDeviceConversationsInSpace(tx: Db, userId: string, spaceId: string): Promise<void> {
  const present = await tx.query<{ present: unknown }>(
    `SELECT to_regprocedure('bob_private.clear_device_conversations_in_space(uuid,uuid)') IS NOT NULL
       AS present`,
  );
  if (present[0]?.present !== true) return;
  await tx.query('SELECT bob_private.clear_device_conversations_in_space($1, $2)', [userId, spaceId]);
}

/** Nulls only deviceId's own pointer in spaceId: a device is never moved by
 *  another device switching space. Returns whether a row matched, so the
 *  caller knows whether anything changed. */
async function clearOneDeviceConversationInSpace(tx: Db, deviceId: string, userId: string, spaceId: string): Promise<boolean> {
  const rows = await tx.query<{ id: unknown }>(
    `UPDATE bob.devices d
     SET active_conversation_id = NULL
     WHERE d.id = $1 AND d.user_id = $2
       AND EXISTS (SELECT 1 FROM bob.conversations c JOIN bob.spaces s ON s.id = c.space_id
                   WHERE c.id = d.active_conversation_id AND c.space_id = $3 AND s.kind <> 'private')
     RETURNING d.id`,
    [deviceId, userId, spaceId],
  );
  return rows.length > 0;
}

/**
 * Clears a thread pointer in `spaceId` (the caller left, was removed from, or
 * archived that space). With a deviceId (one device switching its own space
 * away), ONLY that device's own pointer there is nulled; with none, every
 * device's own pointer there is. Returns a new stamp when the account's
 * pointer or this device's own pointer was cleared, else null, so callers know
 * whether to publish active.changed; only an account-level clear moves the
 * account's `conversation_changed_at`. A device with no pointer of its own
 * follows the account's, so it gets an explicit null pointer instead and stops
 * following that thread out of the space. Runs through the bob_private
 * definer because after a revoke RLS no longer shows the conversation; a
 * database without it clears nothing here and getActive's read-time check
 * still nulls a stale pointer.
 */
export async function clearActiveThreadInSpace(
  db: Db,
  userId: string,
  spaceId: string,
  options: DeviceActiveOptions = {},
): Promise<number | null> {
  if (!UUID_RE.test(spaceId)) return null;
  const moveAccount = options.deviceId === undefined || options.moveAccount !== false;
  return withUser(db, userId, async (tx) => {
    let cleared = false;
    if (moveAccount) {
      const present = await tx.query<{ present: unknown }>(
        `SELECT to_regprocedure('bob_private.clear_active_conversation_in_space(uuid,uuid)') IS NOT NULL
           AS present`,
      );
      if (present[0]?.present === true) {
        const rows = await tx.query<{ cleared: unknown }>(
          'SELECT bob_private.clear_active_conversation_in_space($1, $2) AS cleared',
          [userId, spaceId],
        );
        cleared = rows[0]?.cleared === true;
      }
    }
    let deviceCleared = false;
    if (options.deviceId !== undefined) {
      deviceCleared = await clearOneDeviceConversationInSpace(tx, options.deviceId, userId, spaceId);
    } else {
      await clearDeviceConversationsInSpace(tx, userId, spaceId);
    }
    if (!cleared && !deviceCleared) {
      if (options.deviceId === undefined) return null;
      return setActive(tx, userId, null, 'device', { deviceId: options.deviceId, moveAccount: false });
    }
    const stamp = now();
    if (cleared) {
      await tx.query(
        `UPDATE bob.user_state
         SET conversation_changed_at = to_timestamp($2 / 1000.0)
         WHERE user_id = $1`,
        [userId, stamp],
      );
    }
    return stamp;
  });
}

/**
 * Clears the account's pointer and this account's device pointers naming
 * `threadId` (that thread was just archived). Same contract as
 * clearActiveThreadInSpace: the new stamp when the ACCOUNT's pointer was
 * that thread, else null.
 */
export async function clearActiveThread(
  db: Db,
  userId: string,
  threadId: string,
): Promise<number | null> {
  if (!UUID_RE.test(threadId)) return null;
  return withUser(db, userId, async (tx) => {
    const stamp = now();
    const rows = await tx.query<{ userId: unknown }>(
      `UPDATE bob.user_state a
       SET active_conversation_id = NULL, conversation_changed_at = to_timestamp($3 / 1000.0)
       WHERE a.user_id = $1 AND a.active_conversation_id = $2
         AND EXISTS (SELECT 1 FROM bob.conversations c JOIN bob.spaces s ON s.id = c.space_id
                     WHERE c.id = $2 AND s.kind <> 'private')
       RETURNING a.user_id AS "userId"`,
      [userId, threadId, stamp],
    );
    await tx.query(
      `UPDATE bob.devices d
       SET active_conversation_id = NULL, conversation_changed_at = to_timestamp($3 / 1000.0)
       WHERE d.user_id = $1 AND d.active_conversation_id = $2
         AND EXISTS (SELECT 1 FROM bob.conversations c JOIN bob.spaces s ON s.id = c.space_id
                     WHERE c.id = $2 AND s.kind <> 'private')`,
      [userId, threadId, stamp],
    );
    return rows.length > 0 ? stamp : null;
  });
}
