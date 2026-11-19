/**
 * The durable inbox. It stores ids, types and revisions ONLY -- never a title,
 * body or snippet -- so the client refetches each resource under its own
 * authorization. Every read/mutation runs under withUser(), so RLS (not this
 * module) hides a notification for a space the caller is no longer an ACTIVE
 * member of.
 */
import { StoreError, asServer, withUser, type Db } from '../platform/db/db.ts';
import { outboxPayloadSchema } from '../platform/outbox/store.ts';

/** Security notices must be distinguishable by type from ordinary activity. */
export const NOTIFICATION_TYPES = [
  'mention',
  'assignment',
  'reminder',
  'event_change',
  'invitation',
  'security',
  'task_update',
  'bob_message',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Epoch-ms stamps; cursor is monotonic, newest = highest. */
export type StoredNotification = {
  id: string;
  recipientUserId: string;
  spaceId: string | null;
  type: NotificationType;
  resourceType: string;
  resourceId: string;
  revision: number;
  effectKey: string;
  cursor: number;
  readAt: number | null;
  createdAt: number;
};

/** effectKey is the idempotency key: one recipient never receives the same effect twice. */
export type NewNotification = {
  recipientUserId: string;
  spaceId?: string | null;
  type: NotificationType;
  resourceType: string;
  resourceId: string;
  revision?: number;
  effectKey: string;
};

/** afterCursor pages to OLDER rows (newest first). */
type ListNotificationsOptions = {
  afterCursor?: number;
  limit: number;
  unreadOnly?: boolean;
};

function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

function toNotificationType(value: unknown): NotificationType {
  if (!isNotificationType(value)) throw new StoreError('notification type is invalid');
  return value;
}

function validateResourceType(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 32) {
    throw new StoreError('notification resource_type must be 1..32 characters');
  }
  return trimmed;
}

function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new StoreError('listNotifications: limit must be a positive integer');
  }
  return limit;
}

const NOTIFICATION_COLUMNS = `id, recipient_user_id AS "recipientUserId",
  space_id AS "spaceId", type, resource_type AS "resourceType",
  resource_id AS "resourceId", revision, effect_key AS "effectKey", cursor,
  floor(extract(epoch from read_at) * 1000)::bigint AS "readAt",
  floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt"`;

type NotificationRow = {
  id: unknown;
  recipientUserId: unknown;
  spaceId: unknown;
  type: unknown;
  resourceType: unknown;
  resourceId: unknown;
  revision: unknown;
  effectKey: unknown;
  cursor: unknown;
  readAt: unknown;
  createdAt: unknown;
};

function rowToNotification(row: NotificationRow): StoredNotification {
  return {
    id: String(row.id),
    recipientUserId: String(row.recipientUserId),
    spaceId: row.spaceId === null ? null : String(row.spaceId),
    type: toNotificationType(row.type),
    resourceType: String(row.resourceType),
    resourceId: String(row.resourceId),
    revision: Number(row.revision),
    effectKey: String(row.effectKey),
    cursor: Number(row.cursor),
    readAt: row.readAt === null ? null : Number(row.readAt),
    createdAt: Number(row.createdAt),
  };
}

/**
 * Enqueues through the Db it is GIVEN, so a caller inside db.tx(...) commits
 * them with its domain write. The definer is the server-only write path (the
 * table is FORCE RLS with no insert policy). A duplicate
 * (recipient_user_id, effect_key) resolves to the existing row.
 */
export async function enqueueNotifications(db: Db, rows: NewNotification[]): Promise<void> {
  if (rows.length === 0) return;
  // Every notification is also mailed: one email.notification outbox row per
  // row, written by the SAME statement (so the two commit or fail together,
  // whether or not the caller is inside db.tx). The outbox effect_key is
  // globally unique while a notification's is unique per recipient, so the
  // key carries both; a replayed (duplicate) notification maps to the same key
  // and the outbox's on-conflict-do-nothing adds no second row.
  const outbox = rows.map((r) => ({
    effectKey: emailEffectKey(r.recipientUserId, r.effectKey),
    payload: outboxPayloadSchema.parse({
      resource_type: 'notification',
      recipient_user_id: r.recipientUserId,
      event_type: EMAIL_NOTIFICATION_EVENT,
    }),
  }));
  await asServer(db, (server) =>
    server.query(
      `SELECT bob_private.notifications_enqueue(
         $1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::uuid[], $6::int[], $7::text[]
       ) AS enqueued,
       (SELECT count(*) FROM bob_private.outbox_enqueue(
         $2::uuid[], $8::text[], $9::text[], $5::uuid[], $6::int[], $10::text[], $11::jsonb[]
       )) AS mailed`,
      [
        rows.map((r) => r.recipientUserId),
        rows.map((r) => r.spaceId ?? null),
        rows.map((r) => toNotificationType(r.type)),
        rows.map((r) => validateResourceType(r.resourceType)),
        rows.map((r) => r.resourceId),
        rows.map((r) => r.revision ?? 1),
        rows.map((r) => r.effectKey),
        rows.map(() => EMAIL_NOTIFICATION_EVENT),
        rows.map(() => 'notification'),
        outbox.map((o) => o.effectKey),
        outbox.map((o) => o.payload),
      ],
    ),
  );
}

export const EMAIL_NOTIFICATION_EVENT = 'email.notification';

export function emailEffectKey(recipientUserId: string, effectKey: string): string {
  return `email:${recipientUserId}:${effectKey}`;
}

export function parseEmailEffectKey(
  key: string,
): { recipientUserId: string; effectKey: string } | null {
  const match = /^email:([0-9a-f-]{36}):(.+)$/i.exec(key);
  return match ? { recipientUserId: match[1]!, effectKey: match[2]! } : null;
}

/** True when the email for an outbox effect_key was already handed to the
 *  mail provider, so a row reclaimed after its send never mails twice. */
export async function emailEffectSent(db: Db, outboxEffectKey: string): Promise<boolean> {
  const rows = await asServer(db, (server) =>
    server.query<{ sent: unknown }>(
      'SELECT bob_private.email_effect_sent($1) AS sent', [outboxEffectKey]),
  );
  return rows[0]?.sent === true;
}

/** Idempotent: true when this call recorded it. */
export async function markEmailEffectSent(
  db: Db,
  outboxEffectKey: string,
  recipientUserId: string,
): Promise<boolean> {
  const rows = await asServer(db, (server) =>
    server.query<{ marked: unknown }>(
      'SELECT bob_private.email_effect_mark($1, $2::uuid) AS marked',
      [outboxEffectKey, recipientUserId]),
  );
  return rows[0]?.marked === true;
}

/** Read under withUser(recipient), so RLS decides it still exists for them. */
export async function getNotificationByEffectKey(
  db: Db,
  recipientUserId: string,
  effectKey: string,
): Promise<StoredNotification | null> {
  return withUser(db, recipientUserId, async (tx) => {
    const rows = await tx.query<NotificationRow>(
      `SELECT ${NOTIFICATION_COLUMNS} FROM bob.notifications
       WHERE recipient_user_id = $1 AND effect_key = $2`,
      [recipientUserId, effectKey],
    );
    return rows[0] ? rowToNotification(rows[0]) : null;
  });
}

/** Newest first. afterCursor excludes every row with cursor >= it, so paging
 *  with the previous page's last cursor walks back without gaps or repeats. */
export async function listNotifications(
  db: Db,
  userId: string,
  options: ListNotificationsOptions,
): Promise<StoredNotification[]> {
  const limit = validateLimit(options.limit);
  return withUser(db, userId, async (tx) => {
    const where = ['recipient_user_id = $1'];
    const params: unknown[] = [userId];
    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (options.afterCursor !== undefined) {
      where.push(`cursor < ${push(options.afterCursor)}`);
    }
    if (options.unreadOnly === true) {
      where.push('read_at IS NULL');
    }
    const rows = await tx.query<NotificationRow>(
      `SELECT ${NOTIFICATION_COLUMNS} FROM bob.notifications
       WHERE ${where.join(' AND ')}
       ORDER BY cursor DESC
       LIMIT ${push(limit)}`,
      params,
    );
    return rows.map(rowToNotification);
  });
}

type MarkReadOptions = {
  ids?: string[];
  upToCursor?: number;
};

/** By id, or in bulk (every unread row with cursor <= upToCursor). Returns how many rows moved. */
export async function markRead(
  db: Db,
  userId: string,
  options: MarkReadOptions,
): Promise<number> {
  return withUser(db, userId, async (tx) => {
    const where = ['read_at IS NULL'];
    const params: unknown[] = [userId];
    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (options.ids !== undefined && options.ids.length > 0) {
      where.push(`id = ANY(${push(options.ids)}::uuid[])`);
    }
    if (options.upToCursor !== undefined) {
      where.push(`cursor <= ${push(options.upToCursor)}`);
    }
    if (where.length === 1) {
      throw new StoreError('markRead: provide ids or upToCursor');
    }
    const rows = await tx.query<{ id: unknown }>(
      `UPDATE bob.notifications SET read_at = now()
       WHERE recipient_user_id = $1 AND ${where.join(' AND ')}
       RETURNING id`,
      params,
    );
    return rows.length;
  });
}

export async function unreadCount(db: Db, userId: string): Promise<number> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM bob.notifications
       WHERE recipient_user_id = $1 AND read_at IS NULL`,
      [userId],
    );
    return Number(rows[0]?.total ?? 0);
  });
}

/** type null = all types; quiet hours are all-or-nothing, read back as 'HH:MM:SS'. */
export type StoredPreference = {
  id: string;
  userId: string;
  spaceId: string | null;
  threadId: string | null;
  type: NotificationType | null;
  muted: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietZone: string | null;
};

/** undefined = leave the current value; null clears. */
export type NotificationPreferenceInput = {
  spaceId?: string | null;
  threadId?: string | null;
  type?: NotificationType | null;
  muted?: boolean;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  quietZone?: string | null;
};

type PreferenceKey = {
  spaceId?: string | null;
  threadId?: string | null;
  type?: NotificationType | null;
};

const PREFERENCE_COLUMNS = `id, user_id AS "userId", space_id AS "spaceId",
  conversation_id AS "threadId", type, muted,
  to_char(quiet_hours_start, 'HH24:MI:SS') AS "quietHoursStart",
  to_char(quiet_hours_end, 'HH24:MI:SS') AS "quietHoursEnd",
  quiet_zone AS "quietZone"`;

type PreferenceRow = {
  id: unknown;
  userId: unknown;
  spaceId: unknown;
  threadId: unknown;
  type: unknown;
  muted: unknown;
  quietHoursStart: unknown;
  quietHoursEnd: unknown;
  quietZone: unknown;
};

function rowToPreference(row: PreferenceRow): StoredPreference {
  return {
    id: String(row.id),
    userId: String(row.userId),
    spaceId: row.spaceId === null ? null : String(row.spaceId),
    threadId: row.threadId === null ? null : String(row.threadId),
    type: row.type === null ? null : toNotificationType(row.type),
    muted: row.muted === true,
    quietHoursStart: row.quietHoursStart === null ? null : String(row.quietHoursStart),
    quietHoursEnd: row.quietHoursEnd === null ? null : String(row.quietHoursEnd),
    quietZone: row.quietZone === null ? null : String(row.quietZone),
  };
}

function validateQuietHours(
  pref: NotificationPreferenceInput,
): { start: string | null; end: string | null; zone: string | null } {
  const start = pref.quietHoursStart ?? null;
  const end = pref.quietHoursEnd ?? null;
  const zone = pref.quietZone ?? null;
  const setCount = [start, end, zone].filter((value) => value !== null).length;
  if (setCount !== 0 && setCount !== 3) {
    throw new StoreError('quiet hours must be all-or-nothing: start, end and zone together');
  }
  return { start, end, zone };
}

export async function getPreferences(db: Db, userId: string): Promise<StoredPreference[]> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<PreferenceRow>(
      `SELECT ${PREFERENCE_COLUMNS} FROM bob.notification_preferences
       WHERE user_id = $1`,
      [userId],
    );
    return rows.map(rowToPreference);
  });
}

/** Upserts on the migration's unique index over coalesced (space_id,
 *  conversation_id, type), so NULLs are a real key and a global row is never
 *  duplicated. Muted and quiet hours are replaced in full. */
export async function upsertPreference(
  db: Db,
  userId: string,
  pref: NotificationPreferenceInput,
): Promise<StoredPreference> {
  const type = pref.type === undefined ? null : toNotificationType(pref.type);
  const quiet = validateQuietHours(pref);
  // ON CONFLICT names notification_prefs_conversation_only_uidx by its exact expressions.
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<PreferenceRow>(
      `INSERT INTO bob.notification_preferences
         (user_id, space_id, conversation_id, type, muted,
          quiet_hours_start, quiet_hours_end, quiet_zone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (
         user_id,
         (coalesce(space_id, '00000000-0000-0000-0000-000000000000')),
         (coalesce(conversation_id, '')),
         (coalesce(type, ''))
       ) DO UPDATE SET
         muted = excluded.muted,
         quiet_hours_start = excluded.quiet_hours_start,
         quiet_hours_end = excluded.quiet_hours_end,
         quiet_zone = excluded.quiet_zone
       RETURNING ${PREFERENCE_COLUMNS}`,
      [
        userId,
        pref.spaceId ?? null,
        pref.threadId ?? null,
        type,
        pref.muted ?? false,
        quiet.start,
        quiet.end,
        quiet.zone,
      ],
    );
    if (rows.length === 0) throw new StoreError('could not upsert preference');
    return rowToPreference(rows[0]!);
  });
}

/** Idempotent. */
export async function deletePreference(
  db: Db,
  userId: string,
  key: PreferenceKey,
): Promise<void> {
  return withUser(db, userId, async (tx) => {
    await tx.query(
      `DELETE FROM bob.notification_preferences
       WHERE user_id = $1
         AND coalesce(space_id, '00000000-0000-0000-0000-000000000000') = $2::uuid
         AND coalesce(conversation_id, '') = $3
         AND coalesce(type, '') = $4`,
      [
        userId,
        key.spaceId ?? '00000000-0000-0000-0000-000000000000',
        key.threadId ?? '',
        key.type ?? '',
      ],
    );
  });
}

function prefApplies(
  p: StoredPreference,
  context: { spaceId: string | null; threadId: string | null; type: NotificationType | null },
): boolean {
  if (p.spaceId !== null && p.spaceId !== context.spaceId) return false;
  if (p.threadId !== null && p.threadId !== context.threadId) return false;
  if (p.type !== null && p.type !== context.type) return false;
  return true;
}

function prefLevel(p: StoredPreference): number {
  if (p.threadId !== null) return 3;
  if (p.spaceId !== null) return 2;
  if (p.type !== null) return 1;
  return 0;
}

/** The most specific matching preference decides: thread > space > type >
 *  global; within a tier, one scoping MORE dimensions wins. A 'security'
 *  notice is never muted. */
export function isMuted(
  prefs: ReadonlyArray<StoredPreference>,
  context: { spaceId?: string | null; threadId?: string | null; type?: NotificationType | null },
): boolean {
  if (context.type === 'security') return false;
  const resolved = {
    spaceId: context.spaceId ?? null,
    threadId: context.threadId ?? null,
    type: context.type ?? null,
  };
  let best: StoredPreference | null = null;
  let bestLevel = -1;
  let bestDims = -1;
  for (const p of prefs) {
    if (!prefApplies(p, resolved)) continue;
    const level = prefLevel(p);
    const dims =
      (p.spaceId !== null ? 1 : 0) + (p.threadId !== null ? 1 : 0) + (p.type !== null ? 1 : 0);
    if (level > bestLevel || (level === bestLevel && dims > bestDims)) {
      best = p;
      bestLevel = level;
      bestDims = dims;
    }
  }
  return best?.muted ?? false;
}