// store/invitations.ts tests (spec 014, S03; data-model.md "space_invitations").
// Real Postgres via createTestDb, same setup as store-spaces.test.ts. The
// invitations migration's definer helpers read auth.users.email and
// raw_user_meta_data, which real Supabase has.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreNotFoundError, type Db } from '../../src/platform/db/db.ts';
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  previewInvitation,
  revokeInvitation,
} from '../../src/spaces/invitations.ts';
import {
  addMember,
  createSpace,
  getSpace,
  listMembers,
  listSpaces,
} from '../../src/spaces/store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb, withAdminAuth, withUserRaw } from '../support/test-db.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';

let pg: TestDb;
let db: Db;

/** Sets an account's auth.users email, through the admin seam: auth.users is
 *  Supabase Auth's table and bob_server has no grant on schema auth. */
async function setEmail(userId: string, email: string): Promise<void> {
  await withAdminAuth(pg, (admin) => admin.setProfile(userId, { email }));
}

/**
 * Forces an invitation past its expiry. This is time travel, and no account may
 * legitimately do it: letting a user move `expires_at` would let them extend
 * their own invitation. So it runs on an admin connection, which is the only
 * honest way to reach a state the app otherwise reaches by waiting an hour.
 */
async function expireInvitation(invitationId: string): Promise<void> {
  const url = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
  await withAdmin(url, (admin) =>
    admin`update bob.space_invitations set expires_at = now() - interval '1 hour' where id = ${invitationId}`,
  );
}

/** Creates a group owned by `owner` and invites `email` as a member. */
async function invite(ownerUserId: string, spaceId: string, email: string, role: 'admin' | 'member' = 'member') {
  return createInvitation(db, ownerUserId, spaceId, { email, role });
}

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

describe('invitations store', () => {
  it('createInvitation stores only a SHA-256 hash; the raw token appears nowhere in the row', async () => {
    const owner = await addAccount(pg);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Hash Test' });
    const { invitation, token } = await invite(owner.userId, space.id, 'bob@example.com');

    expect(invitation.role).toBe('member');
    expect(invitation.invitedEmail).toBe('bob@example.com');
    expect(token.length).toBeGreaterThan(20);

    // Read as the owner who created the invitation: RLS applies, as in production.
    const rows = await withUserRaw(pg, owner.userId, (tx) =>
      tx.query<Record<string, unknown>>('select * from bob.space_invitations where id = $1', [invitation.id]),
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    expect(row.token_hash).not.toBe(token);
    expect(String(row.token_hash)).toMatch(/^[0-9a-f]{64}$/);
    // The raw token must not equal any column value, nor appear inside any.
    for (const value of Object.values(row)) {
      if (typeof value === 'string') {
        expect(value).not.toBe(token);
        expect(value).not.toContain(token);
      }
    }
  });

  it('two acceptInvitation calls admit exactly once', async () => {
    const owner = await addAccount(pg);
    const invitee = await addAccount(pg);
    await setEmail(invitee.userId, 'carol@example.com');
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Single Use' });
    const { token } = await invite(owner.userId, space.id, 'carol@example.com');

    const first = await acceptInvitation(db, invitee.userId, token);
    expect(first).toBe('accepted');
    const second = await acceptInvitation(db, invitee.userId, token);
    expect(second).toBe('already_accepted');

    const members = await listMembers(db, owner.userId, space.id);
    expect(members.filter((member) => member.userId === invitee.userId)).toHaveLength(1);
    expect((await getSpace(db, invitee.userId, space.id)).role).toBe('member');
  });

  it('an expired, revoked or already-accepted token is refused', async () => {
    const owner = await addAccount(pg);
    const invitee = await addAccount(pg);
    await setEmail(invitee.userId, 'dave@example.com');
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Refusals' });

    // Expired.
    const expired = await invite(owner.userId, space.id, 'dave@example.com');
    await expireInvitation(expired.invitation.id);
    expect(await acceptInvitation(db, invitee.userId, expired.token)).toBe('expired');

    // Revoked.
    const revoked = await invite(owner.userId, space.id, 'dave@example.com');
    await revokeInvitation(db, owner.userId, revoked.invitation.id);
    expect(await acceptInvitation(db, invitee.userId, revoked.token)).toBe('revoked');

    // Already accepted.
    const used = await invite(owner.userId, space.id, 'dave@example.com');
    expect(await acceptInvitation(db, invitee.userId, used.token)).toBe('accepted');
    expect(await acceptInvitation(db, invitee.userId, used.token)).toBe('already_accepted');
  });

  it('a token accepted by a user whose email does not match is refused', async () => {
    const owner = await addAccount(pg);
    const wrongUser = await addAccount(pg);
    await setEmail(wrongUser.userId, 'eve@example.com');
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Mismatch' });
    const { token } = await invite(owner.userId, space.id, 'intended@example.com');

    const outcome = await acceptInvitation(db, wrongUser.userId, token);
    expect(outcome).toBe('email_mismatch');
    const members = await listMembers(db, owner.userId, space.id);
    expect(members.map((member) => member.userId)).not.toContain(wrongUser.userId);
  });

  it('a pending invitee can read nothing in the space before accepting', async () => {
    const owner = await addAccount(pg);
    const invitee = await addAccount(pg);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Closed Door' });
    await invite(owner.userId, space.id, 'unaccepted@example.com');

    await expect(getSpace(db, invitee.userId, space.id)).rejects.toThrow(StoreNotFoundError);
    const visible = await listSpaces(db, invitee.userId);
    expect(visible.map((entry) => entry.id)).not.toContain(space.id);
    // listMembers matches getSpace's non-member behaviour above (S14-T019):
    // a space the caller cannot see is indistinguishable from a missing one.
    await expect(listMembers(db, invitee.userId, space.id)).rejects.toThrow(StoreNotFoundError);
  });

  it('listInvitations and revokeInvitation are owner/admin only; non-members are hidden', async () => {
    const owner = await addAccount(pg);
    const member = await addAccount(pg);
    const outsider = await addAccount(pg);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Permissions' });
    await invite(owner.userId, space.id, 'member@example.com');

    const pendingInv = await invite(owner.userId, space.id, 'pending@example.com');

    // A plain member may neither create nor list nor revoke (403-flavoured).
    await addMember(db, owner.userId, space.id, member.userId, 'member');
    await expect(createInvitation(db, member.userId, space.id, { email: 'x@example.com', role: 'member' }))
      .rejects.toThrow(/owner or admin can invite/);
    await expect(listInvitations(db, member.userId, space.id)).rejects.toThrow(/owner or admin can list/);
    await expect(revokeInvitation(db, member.userId, pendingInv.invitation.id)).rejects.toThrow(/owner or admin can revoke/);

    // A non-member cannot see the space at all (StoreNotFoundError, 404-flavoured).
    await expect(listInvitations(db, outsider.userId, space.id)).rejects.toThrow(StoreNotFoundError);
    await expect(revokeInvitation(db, outsider.userId, pendingInv.invitation.id)).rejects.toThrow(StoreNotFoundError);
  });

  it('previewInvitation returns metadata only, and null for a used/unknown token', async () => {
    const owner = await addAccount(pg);
    await setEmail(owner.userId, 'owner@example.com');
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Preview' });
    const { token } = await invite(owner.userId, space.id, 'guest@example.com');

    const preview = await previewInvitation(db, token);
    expect(preview).toEqual({
      spaceName: 'Preview',
      spaceKind: 'group',
      inviterDisplayName: 'owner@example.com',
      exposesHistory: true,
      role: 'member',
      expiresAt: expect.any(Number),
    });
    // No space content in the thin shape.
    expect(Object.keys(preview!).sort()).toEqual(
      ['expiresAt', 'exposesHistory', 'inviterDisplayName', 'role', 'spaceKind', 'spaceName'],
    );

    expect(await previewInvitation(db, 'bogus-token')).toBeNull();
    expect(await previewInvitation(db, token + '-x')).toBeNull();
  });

  it.each(['admin', 'member'] as const)(
    '#859 previewInvitation exposes the offered %s role and the invitation expiry, and no email or token',
    async (role) => {
      const owner = await addAccount(pg);
      await setEmail(owner.userId, `owner-${role}@example.com`);
      const space = await createSpace(db, owner.userId, { kind: 'group', name: `Offer ${role}` });
      const { invitation, token } = await invite(owner.userId, space.id, `guest-${role}@example.com`, role);

      const preview = await previewInvitation(db, token);
      expect(preview).toMatchObject({ role });
      // Postgres rounds epoch milliseconds; the driver truncates Date precision.
      expect(Math.abs(preview!.expiresAt - invitation.expiresAt)).toBeLessThanOrEqual(1);
      expect(typeof preview!.expiresAt).toBe('number');
      const serialised = JSON.stringify(preview);
      expect(serialised).not.toContain(`guest-${role}@example.com`);
      expect(serialised).not.toContain(token);
    },
  );
});