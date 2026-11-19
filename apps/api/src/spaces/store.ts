/**
 * Space and membership store. Every function runs under withUser() so RLS
 * decides access from ACTIVE membership rows; a space the caller cannot see
 * throws the same StoreNotFoundError as a missing one (no oracle).
 *
 * A group always has exactly one owner (revokeMember refuses to remove the
 * last one), and membership_revision increases on every membership change.
 * Self-leave bumps the revision through the guarded
 * bob_private.bump_membership_revision definer, because a plain member
 * cannot UPDATE bob.spaces under RLS.
 */
import { StoreConflictError, StoreError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';

/** A space rule the caller broke while allowed to see the space (409 `code`). */
type SpaceRuleCode = 'last_owner' | 'private_space' | 'unsupported_kind' | 'space_archived';

export class SpaceRuleError extends StoreConflictError {
  readonly code: SpaceRuleCode;
  constructor(code: SpaceRuleCode, message: string) {
    super(message);
    this.name = 'SpaceRuleError';
    this.code = code;
  }
}

type SpaceKind = 'private' | 'pair' | 'group';

type SpaceRole = 'owner' | 'admin' | 'member';


/** A space with the caller's own role in it (epoch-ms stamps). */
export type StoredSpace = {
  id: string;
  kind: SpaceKind;
  name: string;
  ownerUserId: string | null;
  conversationId: string | null;
  membershipRevision: number;
  createdAt: number;
  updatedAt: number;
  role: SpaceRole;
  archivedAt: number | null;
  /** Listing only: the caller's unread messages across the space's open threads. */
  unreadCount?: number;
  /** Listing only: the space's open (non-archived) threads. */
  threadCount?: number;
  /** Listing only: the newest of the space's own and its threads' updated_at. */
  lastActivityAt?: number;
};

/** An active member. The profile comes from the
 *  bob_private.space_member_profiles() definer, never a direct read of
 *  auth.users; handle is derived, never stored. */
export type SpaceMember = {
  userId: string;
  role: SpaceRole;
  joinedAt: number;
  displayName: string | null;
  email: string | null;
  handle: string;
};

const SPACE_KINDS: readonly SpaceKind[] = ['private', 'pair', 'group'];

const SPACE_ROLES: readonly SpaceRole[] = ['owner', 'admin', 'member'];

function isSpaceKind(value: unknown): value is SpaceKind {
  return typeof value === 'string' && (SPACE_KINDS as readonly string[]).includes(value);
}

function isSpaceRole(value: unknown): value is SpaceRole {
  return typeof value === 'string' && (SPACE_ROLES as readonly string[]).includes(value);
}

function toSpaceKind(value: unknown): SpaceKind {
  return isSpaceKind(value) ? value : 'group';
}

function toSpaceRole(value: unknown): SpaceRole {
  return isSpaceRole(value) ? value : 'member';
}

const SPACE_COLUMNS = `s.id, s.kind, s.name, s.owner_user_id AS "ownerUserId", s.conversation_id AS "conversationId",
  s.membership_revision AS "membershipRevision",
  floor(extract(epoch from s.created_at) * 1000)::bigint AS "createdAt",
  floor(extract(epoch from s.updated_at) * 1000)::bigint AS "updatedAt",
  floor(extract(epoch from s.archived_at) * 1000)::bigint AS "archivedAt"`;

type SpaceRow = {
  id: unknown;
  kind: unknown;
  name: unknown;
  ownerUserId: unknown;
  conversationId?: unknown;
  membershipRevision: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  role?: unknown;
  archivedAt?: unknown;
  unreadCount?: unknown;
  threadCount?: unknown;
  lastActivityAt?: unknown;
};

function rowToSpace(row: SpaceRow, role: SpaceRole): StoredSpace {
  return {
    id: String(row.id),
    kind: toSpaceKind(row.kind),
    name: String(row.name),
    ownerUserId: row.ownerUserId === null ? null : String(row.ownerUserId),
    conversationId: row.conversationId === null || row.conversationId === undefined ? null : String(row.conversationId),
    membershipRevision: Number(row.membershipRevision),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    role,
    archivedAt: row.archivedAt === null || row.archivedAt === undefined ? null : Number(row.archivedAt),
    ...(row.unreadCount === undefined ? {} : { unreadCount: Number(row.unreadCount) }),
    ...(row.threadCount === undefined ? {} : { threadCount: Number(row.threadCount) }),
    ...(row.lastActivityAt === undefined ? {} : { lastActivityAt: Number(row.lastActivityAt) }),
  };
}

/**
 * Per-space listing aggregates for `s` (`$1` is the caller). A private space
 * holds personal chats, not threads, so its counts are zero. Unread matches
 * the per-thread rule (thread-store THREAD_UNREAD_COUNT): non-tombstoned
 * messages after the caller's read cursor, in open threads only.
 */
const SPACE_LISTING_COLUMNS = `
  (SELECT COUNT(*)::int FROM bob.conversations t
    WHERE t.space_id = s.id AND t.archived_at IS NULL AND s.kind <> 'private') AS "threadCount",
  (SELECT COUNT(*)::int FROM bob.messages msg
    JOIN bob.conversations t ON t.id = msg.conversation_id
    WHERE t.space_id = s.id AND t.archived_at IS NULL AND s.kind <> 'private'
      AND msg.tombstoned_at IS NULL
      AND msg.sequence > COALESCE(
        (SELECT r.last_read_sequence FROM bob.conversation_reads r
          WHERE r.conversation_id = t.id AND r.user_id = $1), 0)) AS "unreadCount",
  floor(extract(epoch from GREATEST(s.updated_at, COALESCE(
    (SELECT max(t.updated_at) FROM bob.conversations t
      WHERE t.space_id = s.id AND t.archived_at IS NULL AND s.kind <> 'private'), s.updated_at))) * 1000)::bigint
    AS "lastActivityAt"`;

function validateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 60) {
    throw new StoreError('space name must be 1..60 characters');
  }
  return trimmed;
}

function bumpRevision(tx: Db, spaceId: string): Promise<void> {
  return tx
    .query('select bob_private.bump_membership_revision($1::uuid)', [spaceId])
    .then(() => undefined);
}

/** The caller's space with their role. The message never embeds the id, so a
 *  hidden space and a missing one are byte-for-byte identical. */
async function findOwnSpace(tx: Db, userId: string, spaceId: string): Promise<StoredSpace> {
  const rows = await tx.query<SpaceRow>(
    `SELECT ${SPACE_COLUMNS}, m.role
     FROM bob.spaces s
     JOIN bob.space_memberships m ON m.space_id = s.id AND m.user_id = $1 AND m.revoked_at IS NULL
     WHERE s.id = $2`,
    [userId, spaceId],
  );
  const row = rows[0];
  if (!row) throw new StoreNotFoundError('space not found');
  return rowToSpace(row, toSpaceRole(row.role));
}

/** The member's active role, or undefined when they are not an active member. */
async function activeRole(tx: Db, spaceId: string, memberId: string): Promise<SpaceRole | undefined> {
  const rows = await tx.query<{ role: unknown }>(
    `SELECT m.role FROM bob.space_memberships m
     WHERE m.space_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL`,
    [spaceId, memberId],
  );
  const row = rows[0];
  return row ? toSpaceRole(row.role) : undefined;
}

async function updateSpace(tx: Db, sql: string, params: unknown[], role: SpaceRole): Promise<StoredSpace> {
  const rows = await tx.query<SpaceRow>(sql, params);
  const row = rows[0];
  if (!row) throw new StoreNotFoundError('space not found');
  return rowToSpace(row, role);
}

/** The caller's active spaces, newest activity first (the space itself or any
 *  of its open threads), each with its unread total and thread count. */
export async function listSpaces(
  db: Db,
  userId: string,
  options: { archived?: boolean } = {},
): Promise<StoredSpace[]> {
  return withUser(db, userId, async (tx) => {
    const archivedFilter = options.archived === true ? 'NOT NULL' : 'NULL';
    // The archive dialog promises the space is hidden "from everyone in it", so
    // an archived listing must be owner-only.
    const roleFilter = options.archived === true ? ` AND m.role = 'owner'` : '';
    const rows = await tx.query<SpaceRow>(
      `SELECT ${SPACE_COLUMNS}, m.role, ${SPACE_LISTING_COLUMNS}
       FROM bob.spaces s
       JOIN bob.space_memberships m ON m.space_id = s.id
       WHERE m.user_id = $1 AND m.revoked_at IS NULL AND s.conversation_id IS NULL AND s.archived_at IS ${archivedFilter}${roleFilter}
       ORDER BY "lastActivityAt" DESC, s.updated_at DESC`,
      [userId],
    );
    return rows.map((row) => rowToSpace(row, toSpaceRole(row.role)));
  });
}

export async function getSpace(db: Db, userId: string, spaceId: string): Promise<StoredSpace> {
  return withUser(db, userId, (tx) => findOwnSpace(tx, userId, spaceId));
}

/** Renames a group (owner or admin); a private space keeps its name. */
export async function renameSpace(db: Db, userId: string, spaceId: string, name: string): Promise<StoredSpace> {
  const trimmed = validateName(name);
  return withUser(db, userId, async (tx) => {
    const current = await findOwnSpace(tx, userId, spaceId);
    if (current.role !== 'owner' && current.role !== 'admin') {
      throw new StoreError('only an owner or admin can rename a space');
    }
    if (current.kind === 'private') throw new SpaceRuleError('unsupported_kind', 'a private space cannot be renamed');
    if (current.archivedAt !== null) throw new SpaceRuleError('space_archived', 'an archived space cannot be renamed');
    return updateSpace(
      tx,
      `UPDATE bob.spaces s SET name = $2, updated_at = now() WHERE s.id = $1 RETURNING ${SPACE_COLUMNS}`,
      [spaceId, trimmed],
      current.role,
    );
  });
}

async function findOwnedGroup(tx: Db, userId: string, spaceId: string): Promise<StoredSpace> {
  const current = await findOwnSpace(tx, userId, spaceId);
  if (current.role !== 'owner') throw new StoreError('only the owner can archive or restore a space');
  if (current.kind !== 'group') throw new SpaceRuleError('unsupported_kind', 'only a group can be archived');
  return current;
}

/**
 * Archives a group (owner only). Nothing is deleted: archived_at hides it and
 * freezes rename/new invitations until restoreSpace. Idempotent.
 */
export async function archiveSpace(
  db: Db,
  userId: string,
  spaceId: string,
): Promise<{ space: StoredSpace; invitationsRevoked: number }> {
  return withUser(db, userId, async (tx) => {
    const current = await findOwnedGroup(tx, userId, spaceId);
    if (current.archivedAt !== null) return { space: current, invitationsRevoked: 0 };
    const space = await updateSpace(
      tx,
      `UPDATE bob.spaces s SET archived_at = now(), updated_at = now() WHERE s.id = $1 RETURNING ${SPACE_COLUMNS}`,
      [spaceId],
      current.role,
    );
    const revoked = await tx.query<{ id: unknown }>(
      `UPDATE bob.space_invitations SET revoked_at = now()
       WHERE space_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
       RETURNING id`,
      [spaceId],
    );
    return { space, invitationsRevoked: revoked.length };
  });
}

/** Restores an archived group. Revoked invitations stay revoked. */
export async function restoreSpace(db: Db, userId: string, spaceId: string): Promise<StoredSpace> {
  return withUser(db, userId, async (tx) => {
    const current = await findOwnedGroup(tx, userId, spaceId);
    if (current.archivedAt === null) return current;
    return updateSpace(
      tx,
      `UPDATE bob.spaces s SET archived_at = NULL, updated_at = now() WHERE s.id = $1 RETURNING ${SPACE_COLUMNS}`,
      [spaceId],
      current.role,
    );
  });
}

/**
 * Creates a group owned by the caller. A legacy `pair` request is created the
 * same way: an ownerless pair row fails the spaces RLS policies. `private` is
 * rejected: private spaces come only from the account backfill.
 */
export async function createSpace(
  db: Db,
  userId: string,
  input: { kind?: SpaceKind; name: string },
): Promise<StoredSpace> {
  if (input.kind !== undefined && !isSpaceKind(input.kind)) throw new StoreError('createSpace: invalid kind');
  if (input.kind === 'private') {
    throw new StoreError('private spaces are provisioned by the account backfill');
  }
  const name = validateName(input.name);
  return withUser(db, userId, async (tx) => {
    const spaces = await tx.query<SpaceRow>(
      `INSERT INTO bob.spaces (kind, name, owner_user_id)
       VALUES ('group', $1, $2)
       RETURNING id, kind, name, owner_user_id AS "ownerUserId",
         membership_revision AS "membershipRevision",
         floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt",
         floor(extract(epoch from updated_at) * 1000)::bigint AS "updatedAt"`,
      [name, userId],
    );
    const spaceRow = spaces[0];
    if (!spaceRow) throw new StoreError('could not create space');
    const members = await tx.query<{ user_id: unknown }>(
      `INSERT INTO bob.space_memberships (space_id, user_id, role)
       VALUES ($1, $2, 'owner')
       RETURNING user_id`,
      [spaceRow.id, userId],
    );
    if (members.length === 0) throw new StoreError('could not create owner membership');
    return rowToSpace(spaceRow, 'owner');
  });
}

/**
 * Returns the caller's private space, creating it for a new account
 * (idempotent). Concurrent first calls (a device turn plus a capability read,
 * web chat plus a device) race spaces_private_owner_uidx, so the insert is
 * ON CONFLICT DO NOTHING: a loser inserts nothing, keeps its transaction
 * alive, and re-reads the winner's row, which read committed makes visible to
 * the second select once the winner commits.
 */
export async function ensurePrivateSpace(db: Db, userId: string): Promise<StoredSpace> {
  return withUser(db, userId, async (tx) => {
    const findExisting = async (): Promise<StoredSpace | undefined> => {
      const rows = await tx.query<SpaceRow>(
        `SELECT ${SPACE_COLUMNS}, m.role
         FROM bob.spaces s
         JOIN bob.space_memberships m ON m.space_id = s.id AND m.user_id = $1 AND m.revoked_at IS NULL
         WHERE s.kind = 'private' AND s.owner_user_id = $1`,
        [userId],
      );
      const row = rows[0];
      return row ? rowToSpace(row, toSpaceRole(row.role)) : undefined;
    };
    const existing = await findExisting();
    if (existing) return existing;
    const created = await tx.query<SpaceRow>(
      `INSERT INTO bob.spaces (kind, name, owner_user_id)
       VALUES ('private', 'Private', $1)
       ON CONFLICT (owner_user_id) WHERE kind = 'private' DO NOTHING
       RETURNING id, kind, name, owner_user_id AS "ownerUserId",
         membership_revision AS "membershipRevision",
         floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt",
         floor(extract(epoch from updated_at) * 1000)::bigint AS "updatedAt"`,
      [userId],
    );
    const createdRow = created[0];
    if (!createdRow) {
      const raced = await findExisting();
      if (raced) return raced;
      throw new StoreError('could not create private space');
    }
    await tx.query(
      `INSERT INTO bob.space_memberships (space_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [createdRow.id, userId],
    );
    return rowToSpace(createdRow, 'owner');
  });
}

/**
 * Lists the active members with profile and derived @handle, ascending by join
 * time. The membership pre-check runs BEFORE the profile join, so a
 * non-member never reaches space_member_profiles() (which repeats the check
 * itself as defense in depth).
 */
export async function listMembers(
  db: Db,
  userId: string,
  spaceId: string,
): Promise<SpaceMember[]> {
  return withUser(db, userId, async (tx) => {
    if ((await activeRole(tx, spaceId, userId)) === undefined) throw new StoreNotFoundError('space not found');
    const rows = await tx.query<{
      userId: unknown;
      role: unknown;
      joinedAt: unknown;
      displayName: unknown;
      email: unknown;
    }>(
      `SELECT m.user_id AS "userId", m.role,
              floor(extract(epoch from m.joined_at) * 1000)::bigint AS "joinedAt",
              p.display_name AS "displayName", CASE WHEN (SELECT conversation_id FROM bob.spaces WHERE id = $1) IS NULL THEN p.email ELSE NULL END AS email
       FROM bob.space_memberships m
       JOIN bob_private.space_member_profiles($1::uuid) p ON p.user_id = m.user_id
       WHERE m.space_id = $1 AND m.revoked_at IS NULL
       ORDER BY m.joined_at ASC`,
      [spaceId],
    );
    const members = rows.map((row) => ({
      userId: String(row.userId),
      role: toSpaceRole(row.role),
      joinedAt: Number(row.joinedAt),
      displayName: row.displayName === null ? null : String(row.displayName),
      email: row.email === null ? null : String(row.email),
    }));
    const handles = new Map(
      deriveMemberHandles(members).map((entry) => [entry.userId, entry.handle] as const),
    );
    return members.map((member) => {
      const handle = handles.get(member.userId) ?? null;
      if (!handle) throw new StoreError('listMembers: handle lookup failed');
      return { ...member, handle };
    });
  });
}

/** Adds a member (owner/admin only) and bumps membership_revision. */
export async function addMember(
  db: Db,
  userId: string,
  spaceId: string,
  targetUserId: string,
  role: SpaceRole,
): Promise<SpaceMember> {
  if (!isSpaceRole(role)) throw new StoreError('addMember: invalid role');
  return withUser(db, userId, async (tx) => {
    // RLS remains the enforcement; this pre-check turns its raw WITH CHECK
    // violation into a clean StoreError.
    const callerRole = await activeRole(tx, spaceId, userId);
    if (callerRole !== 'owner' && callerRole !== 'admin') {
      throw new StoreError('only an owner or admin can add members');
    }
    const rows = await tx.query<{ userId: unknown; role: unknown; joinedAt: unknown }>(
      `INSERT INTO bob.space_memberships (space_id, user_id, role)
       VALUES ($1, $2, $3)
       RETURNING user_id AS "userId", role,
         floor(extract(epoch from joined_at) * 1000)::bigint AS "joinedAt"`,
      [spaceId, targetUserId, role],
    );
    const insertedRow = rows[0];
    if (!insertedRow) throw new StoreError('only an owner or admin can add members');
    await bumpRevision(tx, spaceId);
    // No profile lookup on add: listMembers derives the real handle.
    return {
      userId: String(insertedRow.userId),
      role: toSpaceRole(insertedRow.role),
      joinedAt: Number(insertedRow.joinedAt),
      displayName: null,
      email: null,
      handle: slugifyMemberName(null, null),
    };
  });
}

/** Throws unless the target can leave: active, not a private space's owner, not a group's last owner. */
async function assertCanRevoke(tx: Db, spaceId: string, targetUserId: string): Promise<void> {
  const spaces = await tx.query<{ kind: unknown; ownerUserId: unknown }>(
    `SELECT s.kind, s.owner_user_id AS "ownerUserId" FROM bob.spaces s WHERE s.id = $1`,
    [spaceId],
  );
  const spaceRow = spaces[0];
  if (!spaceRow) throw new StoreNotFoundError('space not found');
  const kind = toSpaceKind(spaceRow.kind);

  const targetRole = await activeRole(tx, spaceId, targetUserId);
  if (targetRole === undefined) throw new StoreError('target is not an active member');

  if (kind === 'private' && String(spaceRow.ownerUserId) === targetUserId) {
    throw new SpaceRuleError('private_space', 'the owner of a private space cannot leave it');
  }

  if (targetRole === 'owner') {
    const owners = await tx.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM bob.space_memberships
       WHERE space_id = $1 AND role = 'owner' AND revoked_at IS NULL`,
      [spaceId],
    );
    const ownerRow = owners[0];
    if (ownerRow && kind === 'group' && Number(ownerRow.total) <= 1) {
      throw new SpaceRuleError(
        'last_owner',
        'cannot remove the last owner of a group; transfer ownership or delete the space',
      );
    }
  }
}

/**
 * Revokes a member and bumps membership_revision in one transaction. An
 * owner/admin may revoke anyone; any member may self-leave. Refuses to remove
 * the last owner of a group.
 */
export async function revokeMember(
  db: Db,
  userId: string,
  spaceId: string,
  targetUserId: string,
): Promise<void> {
  return withUser(db, userId, async (tx) => {
    await assertCanRevoke(tx, spaceId, targetUserId);

    // The removed member stops being an assignee, follower or reminder
    // recipient here. These and the bump run BEFORE the revoke: RLS only lets
    // a self-leaving caller touch the space's rows while still a member.
    await tx.query(
      `UPDATE bob.tasks
       SET assignee_user_id = NULL, revision = revision + 1, updated_at = now()
       WHERE space_id = $1 AND assignee_user_id = $2`,
      [spaceId, targetUserId],
    );
    await tx.query(
      `DELETE FROM bob.task_subscribers ts
       USING bob.tasks t
       WHERE ts.task_id = t.id AND t.space_id = $1 AND ts.user_id = $2`,
      [spaceId, targetUserId],
    );
    await tx.query(
      `DELETE FROM bob.reminder_recipients rr
       USING bob.reminders r
       WHERE rr.reminder_id = r.id AND r.space_id = $1 AND rr.user_id = $2`,
      [spaceId, targetUserId],
    );

    await bumpRevision(tx, spaceId);
    const updated = await tx.query<{ user_id: unknown }>(
      `UPDATE bob.space_memberships
       SET revoked_at = now()
       WHERE space_id = $1 AND user_id = $2
       RETURNING user_id`,
      [spaceId, targetUserId],
    );
    if (updated.length === 0) {
      throw new StoreError('not authorized to revoke this member');
    }
  });
}

/** Transfers ownership of a group to an active member; the old owner becomes a member. */
export async function transferOwnership(
  db: Db,
  userId: string,
  spaceId: string,
  newOwnerUserId: string,
): Promise<StoredSpace> {
  return withUser(db, userId, async (tx) => {
    if ((await activeRole(tx, spaceId, userId)) !== 'owner') {
      throw new StoreError('only the owner can transfer ownership');
    }

    const spaces = await tx.query<{ kind: unknown }>(
      `SELECT s.kind FROM bob.spaces s WHERE s.id = $1`,
      [spaceId],
    );
    if (spaces.length === 0) throw new StoreNotFoundError('space not found');
    const spaceRow = spaces[0];
    if (!spaceRow || toSpaceKind(spaceRow.kind) !== 'group') {
      throw new SpaceRuleError('unsupported_kind', 'only a group can change owner');
    }

    if ((await activeRole(tx, spaceId, newOwnerUserId)) === undefined) {
      throw new StoreError('the new owner must be an active member');
    }

    const space = await updateSpace(
      tx,
      `UPDATE bob.spaces s
       SET owner_user_id = $2, membership_revision = membership_revision + 1, updated_at = now()
       WHERE s.id = $1
       RETURNING ${SPACE_COLUMNS}`,
      [spaceId, newOwnerUserId],
      'member',
    );

    await tx.query(
      `UPDATE bob.space_memberships SET role = 'owner'
       WHERE space_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [spaceId, newOwnerUserId],
    );
    if (newOwnerUserId !== userId) {
      await tx.query(
        `UPDATE bob.space_memberships SET role = 'member'
         WHERE space_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [spaceId, userId],
      );
    }
    await bumpRevision(tx, spaceId);
    return space;
  });
}

export async function isActiveMember(tx: Db, spaceId: string, candidate: string): Promise<boolean> {
  const rows = await tx.query<{ ok: unknown }>(
    `SELECT 1 AS ok FROM bob.space_memberships m
     WHERE m.space_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL`,
    [spaceId, candidate],
  );
  return rows.length > 0;
}

/** Turns creating into a missing or hidden space into a 404 instead of a raw
 *  database error from the insert. */
export async function requireSpaceMember(tx: Db, spaceId: string, userId: string): Promise<void> {
  if (!(await isActiveMember(tx, spaceId, userId))) throw new StoreNotFoundError('space not found');
}

function emailLocalPart(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  const local = at === -1 ? email : email.slice(0, at);
  return local.length > 0 ? local : null;
}

/** Lowercase ASCII letters and digits kept, every run of anything else
 *  collapsed to a single `.`, no leading `.`. */
function slugifyText(raw: string | null): string {
  let out = '';
  let pendingDot = false;
  const text = (raw ?? '').toLowerCase();
  for (const ch of text) {
    const keep = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
    if (keep) {
      if (pendingDot && out.length > 0) out += '.';
      pendingDot = false;
      out += ch;
    } else {
      pendingDot = true;
    }
  }
  return out;
}

/** A member's base @handle: the slugged display name, else the email local
 *  part, else `member`; at most 40 chars and within the mentions grammar. */
function slugifyMemberName(displayName: string | null, email: string | null): string {
  const candidates: Array<string | null> = [];
  if (displayName && displayName.trim().length > 0) candidates.push(displayName);
  candidates.push(emailLocalPart(email));
  for (const candidate of candidates) {
    let slug = slugifyText(candidate);
    if (slug.length === 0) continue;
    if (slug.length > 40) slug = slug.slice(0, 40);
    while (slug.endsWith('.') || slug.endsWith('-')) slug = slug.slice(0, -1);
    if (slug.length > 0) return slug;
  }
  return 'member';
}

/**
 * Assigns each member a unique @handle within the space, deterministic by
 * user_id (never join order). `bob` is reserved for the assistant, so a
 * member slugged `bob` gets `bob.1` and can never impersonate it.
 * Collisions append `.2`, `.3`, ... in user_id order.
 */
export function deriveMemberHandles(
  members: ReadonlyArray<{ userId: string; displayName: string | null; email: string | null }>,
): Array<{ userId: string; handle: string }> {
  const sorted = [...members].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  const used = new Set<string>();
  const baseCounts = new Map<string, number>();
  const handles: Array<{ userId: string; handle: string }> = [];
  for (const member of sorted) {
    const base = slugifyMemberName(member.displayName, member.email);
    const occurrence = baseCounts.get(base) ?? 0;
    baseCounts.set(base, occurrence + 1);
    let candidate = candidateFor(base, occurrence);
    let bump = occurrence;
    while (used.has(candidate)) {
      bump += 1;
      candidate = candidateFor(base, bump);
    }
    used.add(candidate);
    handles.push({ userId: member.userId, handle: candidate });
  }
  return handles;
}

function candidateFor(base: string, occurrence: number): string {
  if (occurrence === 0 && base !== 'bob') return base;
  return withSuffix(base, String(occurrence + 1));
}

/** `<base>.<suffix>`, truncating the base to stay within 40 chars. */
function withSuffix(base: string, suffix: string): string {
  const maxBase = 40 - suffix.length;
  const head = maxBase >= 1 ? base.slice(0, maxBase).replace(/[.\-]+$/, '') : '';
  return `${head}.${suffix}`;
}
