// member-roles.ts tests (#860). Real Postgres via createTestDb: the owner-only
// rule, the owner-target refusal and the revision bump are enforced by the store
// and RLS together, so they are proven against the real policies.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreNotFoundError, type Db } from '../../src/platform/db/db.ts';
import { StoreForbiddenError } from '../../src/spaces/invitations.ts';
import { setMemberRole } from '../../src/spaces/member-roles.ts';
import {
  addMember,
  archiveSpace,
  createSpace,
  ensurePrivateSpace,
  getSpace,
  listMembers,
  revokeMember,
  SpaceRuleError,
  transferOwnership,
} from '../../src/spaces/store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

async function roleIn(spaceId: string, viewer: string, target: string): Promise<string | undefined> {
  return (await listMembers(db, viewer, spaceId)).find((member) => member.userId === target)?.role;
}

async function revision(spaceId: string, viewer: string): Promise<number> {
  return (await getSpace(db, viewer, spaceId)).membershipRevision;
}

async function setup() {
  const owner = await addAccount(pg);
  const admin = await addAccount(pg);
  const member = await addAccount(pg);
  const outsider = await addAccount(pg);
  const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Roles' });
  await addMember(db, owner.userId, group.id, admin.userId, 'admin');
  await addMember(db, owner.userId, group.id, member.userId, 'member');
  return { owner, admin, member, outsider, group };
}

describe('setMemberRole', () => {
  it('lets the owner promote a member and demote an admin, bumping the revision once per change', async () => {
    const { owner, admin, member, group } = await setup();
    const before = await revision(group.id, owner.userId);

    expect(await setMemberRole(db, owner.userId, group.id, member.userId, 'admin')).toBe(true);
    expect(await roleIn(group.id, owner.userId, member.userId)).toBe('admin');
    expect(await revision(group.id, owner.userId)).toBe(before + 1);

    expect(await setMemberRole(db, owner.userId, group.id, admin.userId, 'member')).toBe(true);
    expect(await roleIn(group.id, owner.userId, admin.userId)).toBe('member');
    expect(await revision(group.id, owner.userId)).toBe(before + 2);
  });

  it('is idempotent for the same role: no change and no revision bump', async () => {
    const { owner, admin, group } = await setup();
    const before = await revision(group.id, owner.userId);

    expect(await setMemberRole(db, owner.userId, group.id, admin.userId, 'admin')).toBe(false);
    expect(await revision(group.id, owner.userId)).toBe(before);
  });

  it('refuses an admin and a plain member with StoreForbiddenError and changes nothing', async () => {
    const { owner, admin, member, group } = await setup();
    const before = await revision(group.id, owner.userId);

    await expect(setMemberRole(db, admin.userId, group.id, member.userId, 'admin')).rejects.toBeInstanceOf(
      StoreForbiddenError,
    );
    await expect(setMemberRole(db, member.userId, group.id, admin.userId, 'member')).rejects.toBeInstanceOf(
      StoreForbiddenError,
    );
    await expect(setMemberRole(db, member.userId, group.id, member.userId, 'admin')).rejects.toBeInstanceOf(
      StoreForbiddenError,
    );
    expect(await roleIn(group.id, owner.userId, member.userId)).toBe('member');
    expect(await roleIn(group.id, owner.userId, admin.userId)).toBe('admin');
    expect(await revision(group.id, owner.userId)).toBe(before);
  });

  it('answers an outsider and a missing space with the same StoreNotFoundError', async () => {
    const { outsider, member, group } = await setup();
    const hidden = await setMemberRole(db, outsider.userId, group.id, member.userId, 'admin').catch(
      (caught: unknown) => caught,
    );
    const missing = await setMemberRole(
      db,
      outsider.userId,
      '00000000-0000-4000-8000-000000000000',
      member.userId,
      'admin',
    ).catch((caught: unknown) => caught);
    expect(hidden).toBeInstanceOf(StoreNotFoundError);
    expect(missing).toBeInstanceOf(StoreNotFoundError);
    expect((hidden as Error).message).toBe((missing as Error).message);
  });

  it('never changes the owner: an owner target is refused, even by the owner themselves', async () => {
    const { owner, group } = await setup();
    const before = await revision(group.id, owner.userId);

    await expect(setMemberRole(db, owner.userId, group.id, owner.userId, 'member')).rejects.toBeInstanceOf(
      StoreForbiddenError,
    );
    expect(await roleIn(group.id, owner.userId, owner.userId)).toBe('owner');
    expect(await revision(group.id, owner.userId)).toBe(before);
  });

  it('finds no unknown or revoked target', async () => {
    const { owner, member, outsider, group } = await setup();
    await expect(setMemberRole(db, owner.userId, group.id, outsider.userId, 'admin')).rejects.toBeInstanceOf(
      StoreNotFoundError,
    );
    await revokeMember(db, owner.userId, group.id, member.userId);
    await expect(setMemberRole(db, owner.userId, group.id, member.userId, 'admin')).rejects.toBeInstanceOf(
      StoreNotFoundError,
    );
  });

  it('refuses a private space and an archived group with a SpaceRuleError', async () => {
    const { owner, member, group } = await setup();
    const priv = await ensurePrivateSpace(db, owner.userId);
    const privateError = await setMemberRole(db, owner.userId, priv.id, member.userId, 'admin').catch(
      (caught: unknown) => caught,
    );
    expect((privateError as SpaceRuleError).code).toBe('private_space');

    await archiveSpace(db, owner.userId, group.id);
    const archivedError = await setMemberRole(db, owner.userId, group.id, member.userId, 'admin').catch(
      (caught: unknown) => caught,
    );
    expect((archivedError as SpaceRuleError).code).toBe('space_archived');
    expect(await roleIn(group.id, owner.userId, member.userId)).toBe('member');
  });

  it('refuses when archiveSpace commits between the caller check and the space lock', async () => {
    const { owner, member, group } = await setup();
    const before = await revision(group.id, owner.userId);
    // Controlled interleave, no timing: just before the lock query runs, a
    // second connection archives the group and commits. A helper that read
    // archived_at before locking would still see it live and change the role.
    let archived = false;
    const wrap = (target: Db): Db => ({
      query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
        if (!archived && sql.includes('FOR UPDATE')) {
          archived = true;
          await archiveSpace(db, owner.userId, group.id);
        }
        return target.query<T>(sql, params);
      },
      tx: (fn) => target.tx((tx) => fn(wrap(tx))),
    });

    const error = await setMemberRole(wrap(db), owner.userId, group.id, member.userId, 'admin').catch(
      (caught: unknown) => caught,
    );

    expect(archived).toBe(true);
    expect(error).toBeInstanceOf(SpaceRuleError);
    expect((error as SpaceRuleError).code).toBe('space_archived');
    expect(await roleIn(group.id, owner.userId, member.userId)).toBe('member');
    expect(await revision(group.id, owner.userId)).toBe(before);
  });

  it('keeps ownership transfer working, and refuses the former owner afterwards', async () => {
    const { owner, admin, member, group } = await setup();
    await transferOwnership(db, owner.userId, group.id, admin.userId);

    await expect(setMemberRole(db, owner.userId, group.id, member.userId, 'admin')).rejects.toBeInstanceOf(
      StoreForbiddenError,
    );
    expect(await setMemberRole(db, admin.userId, group.id, member.userId, 'admin')).toBe(true);
    expect(await roleIn(group.id, admin.userId, owner.userId)).toBe('member');
  });
});
