/**
 * Space invitation store. Only a SHA-256 hash of the single-use token is
 * stored; the raw token is returned once at creation and never logged. Preview
 * and accept run as the server through security-definer functions, because a
 * pending invitee is NOT a member and RLS must not admit them. List, create
 * and revoke run under withUser(): a caller who cannot see the space gets
 * StoreNotFoundError (404), a member without the role StoreForbiddenError (403).
 */
import { createHash, randomBytes } from 'node:crypto';
import { asServer, StoreError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';

/** The caller can see the space but lacks the required role (403). */
export class StoreForbiddenError extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = 'StoreForbiddenError';
  }
}

type InvitationRole = 'admin' | 'member';

export type StoredInvitation = {
  id: string;
  spaceId: string;
  invitedEmail: string;
  role: InvitationRole;
  expiresAt: number;
  acceptedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
};

export type InvitationPreview = {
  spaceName: string;
  spaceKind: string;
  inviterDisplayName: string;
  exposesHistory: boolean;
  role: InvitationRole;
  /** Epoch milliseconds. */
  expiresAt: number;
};

type AcceptOutcome =
  | 'accepted'
  | 'already_accepted'
  | 'already_member'
  | 'expired'
  | 'revoked'
  | 'email_mismatch'
  | 'not_found';

const INVITATION_ROLES: readonly InvitationRole[] = ['admin', 'member'];

function isInvitationRole(value: unknown): value is InvitationRole {
  return typeof value === 'string' && (INVITATION_ROLES as readonly string[]).includes(value);
}

type InvitationRow = {
  id: unknown;
  spaceId: unknown;
  invitedEmail: unknown;
  role: unknown;
  expiresAt: unknown;
  acceptedAt: unknown;
  revokedAt: unknown;
  createdAt: unknown;
};

const INVITATION_COLUMNS = `id, space_id AS "spaceId", invited_email AS "invitedEmail", role,
  floor(extract(epoch from expires_at) * 1000)::bigint AS "expiresAt",
  floor(extract(epoch from accepted_at) * 1000)::bigint AS "acceptedAt",
  floor(extract(epoch from revoked_at) * 1000)::bigint AS "revokedAt",
  floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt"`;

function toInvitationRole(value: unknown): InvitationRole {
  return isInvitationRole(value) ? value : 'member';
}

type CallerRole = 'owner' | 'admin' | 'member' | null;

function rowToInvitation(row: InvitationRow): StoredInvitation {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    invitedEmail: String(row.invitedEmail),
    role: toInvitationRole(row.role),
    expiresAt: Number(row.expiresAt),
    acceptedAt: row.acceptedAt === null ? null : Number(row.acceptedAt),
    revokedAt: row.revokedAt === null ? null : Number(row.revokedAt),
    createdAt: Number(row.createdAt),
  };
}

/** The web layer validates with z.string().email() first; this guards direct callers. */
function validateEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length < 3 || trimmed.length > 254 || !trimmed.includes('@')) {
    throw new StoreError('invitation: invalid email');
  }
  return trimmed;
}

const INVITATION_TTL_DAYS = 7;

/** Null when not an active member, so a hidden space and a missing one look the same. */
async function callerRole(
  tx: Db,
  spaceId: string,
  userId: string,
): Promise<CallerRole> {
  const rows = await tx.query<{ role: unknown }>(
    `SELECT m.role FROM bob.space_memberships m
     WHERE m.space_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL`,
    [spaceId, userId],
  );
  const row = rows[0];
  if (!row) return null;
  const role = String(row.role);
  return role === 'owner' || role === 'admin' || role === 'member' ? role : null;
}

function isPrivileged(role: CallerRole): boolean {
  return role === 'owner' || role === 'admin';
}

/** Creates an invitation (owner/admin only); returns the raw token exactly once. */
export async function createInvitation(
  db: Db,
  userId: string,
  spaceId: string,
  input: { email: string; role: InvitationRole },
): Promise<{ invitation: StoredInvitation; token: string }> {
  if (!isInvitationRole(input.role)) throw new StoreError('createInvitation: invalid role');
  const email = validateEmail(input.email);
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const invitation = await withUser(db, userId, async (tx) => {
    const role = await callerRole(tx, spaceId, userId);
    if (role === null) throw new StoreNotFoundError('space not found');
    if (!isPrivileged(role)) throw new StoreForbiddenError('only an owner or admin can invite');
    // Supersede any prior pending invitation for the same identity so the
    // partial unique index (accepted_at/revoked_at null) never blocks a fresh
    // invite, and an expired-but-unrevoked old row cannot shadow a new one.
    await tx.query(
      `UPDATE bob.space_invitations
       SET revoked_at = now()
       WHERE space_id = $1 AND invited_email = $2
         AND accepted_at IS NULL AND revoked_at IS NULL`,
      [spaceId, email],
    );
    const rows = await tx.query<InvitationRow>(
      `INSERT INTO bob.space_invitations
         (space_id, invited_email, role, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5), $6)
       RETURNING ${INVITATION_COLUMNS}`,
      [spaceId, email, input.role, tokenHash, INVITATION_TTL_DAYS, userId],
    );
    const row = rows[0];
    if (!row) throw new StoreError('could not create invitation');
    return rowToInvitation(row);
  });
  return { invitation, token: rawToken };
}

/** The account-less preview; null for a used, expired, revoked or unknown token
 *  -- no detail, no content. */
export async function previewInvitation(
  db: Db,
  token: string,
): Promise<InvitationPreview | null> {
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const rows = await asServer(db, (server) =>
    server.query<{
      space_name: unknown;
      space_kind: unknown;
      inviter_display_name: unknown;
      exposes_history: unknown;
      role: unknown;
      expires_at: unknown;
    }>('select * from bob_private.preview_invitation($1)', [tokenHash]),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    spaceName: String(row.space_name),
    spaceKind: String(row.space_kind),
    inviterDisplayName: String(row.inviter_display_name),
    exposesHistory: Boolean(row.exposes_history),
    role: String(row.role) as InvitationRole,
    expiresAt: Number(row.expires_at),
  };
}

/** Single-use: the definer re-reads FOR UPDATE in one transaction, so a
 *  concurrent second accept admits nothing. */
export async function acceptInvitation(
  db: Db,
  userId: string,
  token: string,
): Promise<AcceptOutcome> {
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const rows = await asServer(db, (server) =>
    server.query<{ outcome: unknown }>(
      'select bob_private.accept_invitation($1, $2) AS outcome',
      [tokenHash, userId],
    ),
  );
  const outcome = rows[0]?.outcome;
  const accepted: readonly string[] = [
    'accepted',
    'already_accepted',
    'already_member',
    'expired',
    'revoked',
    'email_mismatch',
    'not_found',
  ];
  return (accepted as readonly string[]).includes(String(outcome))
    ? (String(outcome) as AcceptOutcome)
    : 'not_found';
}

function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The invitation this user accepted with the token, read under their own RLS
 *  (they are a member now, so the select policy admits it). Null when none. */
export async function findAcceptedInvitation(
  db: Db,
  accepterUserId: string,
  token: string,
): Promise<{ id: string; spaceId: string; inviterUserId: string } | null> {
  const tokenHash = hashInviteToken(token);
  const rows = await withUser(db, accepterUserId, (tx) => tx.query<{ id: unknown;
    spaceId: unknown; createdBy: unknown }>(
    `SELECT id, space_id AS "spaceId", created_by AS "createdBy"
     FROM bob.space_invitations WHERE token_hash = $1 AND accepted_by = $2`,
    [tokenHash, accepterUserId]));
  const row = rows[0];
  if (!row) return null;
  return { id: String(row.id), spaceId: String(row.spaceId), inviterUserId: String(row.createdBy) };
}

/** Revokes a pending invitation (owner/admin only). */
export async function revokeInvitation(
  db: Db,
  userId: string,
  invitationId: string,
): Promise<void> {
  return withUser(db, userId, async (tx) => {
    const found = await tx.query<{ spaceId: unknown }>(
      `SELECT space_id AS "spaceId" FROM bob.space_invitations WHERE id = $1`,
      [invitationId],
    );
    const row = found[0];
    if (!row) throw new StoreNotFoundError('invitation not found');
    const spaceId = String(row.spaceId);
    const role = await callerRole(tx, spaceId, userId);
    if (role === null) throw new StoreNotFoundError('space not found');
    if (!isPrivileged(role)) {
      throw new StoreForbiddenError('only an owner or admin can revoke an invitation');
    }
    const updated = await tx.query<{ id: unknown }>(
      `UPDATE bob.space_invitations
       SET revoked_at = now()
       WHERE id = $1 AND accepted_at IS NULL
       RETURNING id`,
      [invitationId],
    );
    if (updated.length === 0) {
      throw new StoreError('cannot revoke an accepted invitation');
    }
  });
}

/** Lists a space's pending invitations (owner/admin only). */
export async function listInvitations(
  db: Db,
  userId: string,
  spaceId: string,
): Promise<StoredInvitation[]> {
  return withUser(db, userId, async (tx) => {
    const role = await callerRole(tx, spaceId, userId);
    if (role === null) throw new StoreNotFoundError('space not found');
    if (!isPrivileged(role)) {
      throw new StoreForbiddenError('only an owner or admin can list invitations');
    }
    const rows = await tx.query<InvitationRow>(
      `SELECT ${INVITATION_COLUMNS} FROM bob.space_invitations
       WHERE space_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
         AND expires_at > now()
       ORDER BY created_at ASC`,
      [spaceId],
    );
    return rows.map(rowToInvitation);
  });
}