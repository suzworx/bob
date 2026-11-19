// store/spaces.ts tests (spec 014, S01). Real Postgres via createTestDb, same setup
// as store-conversations.test.ts. The migration's backfill runs when auth.users is
// empty, so the backfill test inserts a user first and then re-runs the two
// backfill statements (a copy of the migration's step 7) to prove idempotency.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreError, StoreNotFoundError, type Db } from '../../src/platform/db/db.ts';
import {
  addMember,
  createSpace,
  deriveMemberHandles,
  ensurePrivateSpace,
  getSpace,
  listMembers,
  listSpaces,
  revokeMember,
  SpaceRuleError,
  transferOwnership,
} from '../../src/spaces/store.ts';
import { parseMentions } from '../../src/spaces/mentions.ts';
import { createThread, markRead, postMessage } from '../../src/conversations/thread-store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb, withAdminAuth } from '../support/test-db.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';

// The migration's step 7 backfill, kept in sync with
// supabase/migrations/20260916050000_spaces_init.sql.
const BACKFILL_SPACES = `insert into bob.spaces (id, kind, name, owner_user_id)
  select gen_random_uuid(), 'private', 'Private', u.id from auth.users u
  on conflict (owner_user_id) where kind = 'private' do nothing;`;
const BACKFILL_MEMBERSHIPS = `insert into bob.space_memberships (space_id, user_id, role)
  select s.id, s.owner_user_id, 'owner' from bob.spaces s where s.kind = 'private'
  on conflict (space_id, user_id) do nothing;`;

let pg: TestDb;
let db: Db;

/** Sets an account's identity email. auth.users is Supabase Auth's table and
 *  bob_server has no grant on schema auth, so this goes through the admin
 *  seam rather than the connection under test. */
async function setEmail(userId: string, email: string | null): Promise<void> {
  await withAdminAuth(pg, (admin) => admin.setProfile(userId, { email }));
}

/** Sets an account's metadata display name (raw_user_meta_data.name). */
async function setMetaName(userId: string, name: string): Promise<void> {
  await withAdminAuth(pg, (admin) => admin.setProfile(userId, { name }));
}

/**
 * Runs the migration's step-7 backfill on an ADMIN connection. That SQL reads
 * auth.users and writes bob.* for every account at once, and in production it
 * runs inside a migration -- as the database superuser. Running it as admin
 * reproduces the privilege it genuinely has; it is not an RLS escape hatch for
 * app code, which never runs this SQL.
 */
async function runBackfill(): Promise<void> {
  const url = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
  await withAdmin(url, async (admin) => {
    await admin.unsafe(BACKFILL_SPACES);
    await admin.unsafe(BACKFILL_MEMBERSHIPS);
  });
}

/** Wraps a Db so every SQL string passed to query() (at any nesting level
 *  inside tx()) is recorded, while execution still runs for real against the
 *  wrapped Db. Lets a test assert on the exact query text a store function
 *  issues -- the only way to catch a dropped type cast that the test connection
 *  (which leaves parameter types for the server to infer) would let succeed. */
function recordingDb(inner: Db): { db: Db; queries: string[] } {
  const queries: string[] = [];
  const wrap = (target: Db): Db => ({
    query: (sql, params) => {
      queries.push(sql);
      return target.query(sql, params);
    },
    tx: (fn) => target.tx((tx) => fn(wrap(tx))),
  });
  return { db: wrap(inner), queries };
}

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

describe('spaces store', () => {
  it('backfills exactly one private space per existing user and is idempotent', async () => {
    const a = await addAccount(pg);
    await runBackfill();

    const space = await ensurePrivateSpace(db, a.userId);
    expect(space.kind).toBe('private');
    expect(space.name).toBe('Private');
    expect(space.ownerUserId).toBe(a.userId);
    expect(space.role).toBe('owner');

    const list = await listSpaces(db, a.userId);
    expect(list.filter((entry) => entry.kind === 'private')).toHaveLength(1);

    // Re-running the backfill must not create a second private space.
    await runBackfill();
    const again = await listSpaces(db, a.userId);
    expect(again.filter((entry) => entry.kind === 'private')).toHaveLength(1);
    expect(await getSpace(db, a.userId, space.id)).toMatchObject({ id: space.id, kind: 'private' });
  });

  it('ensurePrivateSpace is idempotent for a fresh account and gives it a space', async () => {
    const a = await addAccount(pg);
    const first = await ensurePrivateSpace(db, a.userId);
    const second = await ensurePrivateSpace(db, a.userId);
    expect(second.id).toBe(first.id);
    expect((await listSpaces(db, a.userId)).filter((s) => s.kind === 'private')).toHaveLength(1);
  });

  it('ensurePrivateSpace survives concurrent first calls for a new account', async () => {
    // A device turn's prepareTurn and a capability read (or web chat plus a
    // device) can both be the first caller. Each call is its own transaction on
    // its own pooled connection, so they race the unique private-space index.
    const a = await addAccount(pg);
    const spaces = await Promise.all(Array.from({ length: 5 }, () => ensurePrivateSpace(db, a.userId)));
    expect(new Set(spaces.map((space) => space.id)).size).toBe(1);
    for (const space of spaces) {
      expect(space).toMatchObject({ kind: 'private', ownerUserId: a.userId, role: 'owner' });
    }
    expect((await listSpaces(db, a.userId)).filter((s) => s.kind === 'private')).toHaveLength(1);
  });

  it('createSpace refuses kind private', async () => {
    const a = await addAccount(pg);
    await expect(
      createSpace(db, a.userId, { kind: 'private', name: 'nope' }),
    ).rejects.toThrow(StoreError);
  });

  // Escaped defect (prod 2026-10-06): a web-created pair failed with "new row
  // violates row-level security policy for table spaces". Spaces have no type
  // (owner decision), so every create request -- no kind, or a legacy
  // 'group'/'pair' -- runs under withUser (real RLS) and comes back owned.
  it.each([undefined, 'group', 'pair'] as const)('createSpace(kind %s) under real RLS makes the caller its active owner', async (kind) => {
    const a = await addAccount(pg);
    const outsider = await addAccount(pg);
    const space = await createSpace(db, a.userId, { kind, name: 'p1' });
    expect(space).toMatchObject({ name: 'p1', role: 'owner', ownerUserId: a.userId });
    expect(await getSpace(db, a.userId, space.id)).toMatchObject({ id: space.id, role: 'owner' });
    expect((await listSpaces(db, a.userId)).map((s) => s.id)).toContain(space.id);
    expect(await listMembers(db, a.userId, space.id)).toEqual([
      expect.objectContaining({ userId: a.userId, role: 'owner' }),
    ]);
    await expect(getSpace(db, outsider.userId, space.id)).rejects.toBeInstanceOf(StoreNotFoundError);
  });

  // Bob web redesign (#1240) P0: the rail's unread badge comes from the list,
  // so a space reports its unread total without its threads being fetched.
  it('listSpaces carries each space\'s unread total, thread count and last activity, newest first', async () => {
    const owner = await addAccount(pg);
    const reader = await addAccount(pg);
    const quiet = await createSpace(db, owner.userId, { name: 'Quiet' });
    const busy = await createSpace(db, owner.userId, { name: 'Busy' });
    await addMember(db, owner.userId, busy.id, reader.userId, 'member');
    const thread = await createThread(db, owner.userId, { spaceId: busy.id, title: 'Plans' });
    await postMessage(db, owner.userId, { threadId: thread.id, body: 'one', clientMessageId: randomUUID() });
    await postMessage(db, owner.userId, { threadId: thread.id, body: 'two', clientMessageId: randomUUID() });

    const forReader = await listSpaces(db, reader.userId);
    const busyRow = forReader.find((space) => space.id === busy.id);
    expect(busyRow).toMatchObject({ unreadCount: 2, threadCount: 1 });
    expect(busyRow?.lastActivityAt).toBeGreaterThanOrEqual(busy.updatedAt);

    await markRead(db, reader.userId, thread.id, {});
    expect((await listSpaces(db, reader.userId)).find((space) => space.id === busy.id)).toMatchObject({ unreadCount: 0 });

    const forOwner = (await listSpaces(db, owner.userId)).filter((space) => space.kind !== 'private');
    expect(forOwner.map((space) => space.id)).toEqual([busy.id, quiet.id]);
    expect(forOwner.find((space) => space.id === quiet.id)).toMatchObject({ unreadCount: 0, threadCount: 0 });
  });

  it('a non-member getSpace and a missing id are the same StoreNotFoundError', async () => {
    const owner = await addAccount(pg);
    const outsider = await addAccount(pg);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });

    const hidden = await getSpace(db, outsider.userId, group.id).catch((error: unknown) => error);
    const missing = await getSpace(db, outsider.userId, randomUUID()).catch((error: unknown) => error);
    expect(hidden).toBeInstanceOf(StoreNotFoundError);
    expect(missing).toBeInstanceOf(StoreNotFoundError);
    expect((hidden as Error).message).toBe((missing as Error).message);
    expect((hidden as Error).message).toMatch(/not found/);
  });

  it('addMember is refused for a plain member and succeeds for owner and admin', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const c = await addAccount(pg);
    const d = await addAccount(pg);
    const e = await addAccount(pg);
    const group = await createSpace(db, a.userId, { kind: 'group', name: 'Team' });

    await addMember(db, a.userId, group.id, b.userId, 'member');

    await expect(
      addMember(db, b.userId, group.id, c.userId, 'member'),
    ).rejects.toThrow(StoreError);

    await expect(
      addMember(db, a.userId, group.id, c.userId, 'member'),
    ).resolves.toMatchObject({ userId: c.userId, role: 'member' });

    await addMember(db, a.userId, group.id, d.userId, 'admin');
    await expect(
      addMember(db, d.userId, group.id, e.userId, 'member'),
    ).resolves.toMatchObject({ userId: e.userId, role: 'member' });
  });

  it('revokeMember bumps membership_revision and a revoked member loses access', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const group = await createSpace(db, a.userId, { kind: 'group', name: 'Shrinking' });
    await addMember(db, a.userId, group.id, b.userId, 'member');
    const before = (await getSpace(db, a.userId, group.id)).membershipRevision;

    await revokeMember(db, a.userId, group.id, b.userId);
    const after = (await getSpace(db, a.userId, group.id)).membershipRevision;
    expect(after).toBeGreaterThan(before);

    await expect(getSpace(db, b.userId, group.id)).rejects.toThrow(StoreNotFoundError);
  });

  it('revokeMember refuses to remove the last owner of a group', async () => {
    const a = await addAccount(pg);
    const group = await createSpace(db, a.userId, { kind: 'group', name: 'Solo' });
    await expect(revokeMember(db, a.userId, group.id, a.userId)).rejects.toThrow(/last owner/);
    expect(await getSpace(db, a.userId, group.id)).toBeDefined();
  });

  it('a plain member can self-leave', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const group = await createSpace(db, a.userId, { kind: 'group', name: 'Doors' });
    await addMember(db, a.userId, group.id, b.userId, 'member');
    const before = (await getSpace(db, a.userId, group.id)).membershipRevision;

    await revokeMember(db, b.userId, group.id, b.userId);
    expect((await getSpace(db, a.userId, group.id)).membershipRevision).toBeGreaterThan(before);
    await expect(getSpace(db, b.userId, group.id)).rejects.toThrow(StoreNotFoundError);
    expect(await listMembers(db, a.userId, group.id)).toHaveLength(1);
  });

  it('transferOwnership refuses a target who is not an active member', async () => {
    const a = await addAccount(pg);
    const stranger = await addAccount(pg);
    const group = await createSpace(db, a.userId, { kind: 'group', name: 'Succession' });
    await expect(
      transferOwnership(db, a.userId, group.id, stranger.userId),
    ).rejects.toThrow(/active member/);
  });

  it('transferOwnership on a private space rejects with a SpaceRuleError coded unsupported_kind', async () => {
    const a = await addAccount(pg);
    const private_ = await ensurePrivateSpace(db, a.userId);
    const error = await transferOwnership(db, a.userId, private_.id, a.userId).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SpaceRuleError);
    expect((error as SpaceRuleError).code).toBe('unsupported_kind');
  });

  it('transferOwnership moves the owner role and demotes the previous owner', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const group = await createSpace(db, a.userId, { kind: 'group', name: 'Handover' });
    await addMember(db, a.userId, group.id, b.userId, 'member');

    await transferOwnership(db, a.userId, group.id, b.userId);

    const byNewOwner = (await getSpace(db, b.userId, group.id))!;
    expect(byNewOwner.ownerUserId).toBe(b.userId);
    expect(byNewOwner.role).toBe('owner');
    const oldOwner = (await getSpace(db, a.userId, group.id))!;
    expect(oldOwner.role).toBe('member');
  });

  it('listMembers returns display names for the members of a space the caller belongs to', async () => {
    const owner = await addAccount(pg);
    await setMetaName(owner.userId, 'Ada Lovelace');
    await setEmail(owner.userId, 'ada@example.com');
    const member = await addAccount(pg);
    await setMetaName(member.userId, 'Grace Hopper');
    await setEmail(member.userId, 'grace@example.com');
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Named' });
    await addMember(db, owner.userId, group.id, member.userId, 'member');

    const members = await listMembers(db, owner.userId, group.id);
    expect(members).toHaveLength(2);
    const byId = new Map(members.map((entry) => [entry.userId, entry]));
    expect(byId.get(owner.userId)).toMatchObject({
      role: 'owner',
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    expect(byId.get(member.userId)).toMatchObject({
      role: 'member',
      displayName: 'Grace Hopper',
      email: 'grace@example.com',
    });
  });

  // The one that matters: this must fail if space_member_profiles() ever
  // loses its bob_private.is_space_member() authorization check.
  it('a non-member gets nothing from listMembers, and no email leaks in the error', async () => {
    const owner = await addAccount(pg);
    await setEmail(owner.userId, 'secret@example.com');
    const outsider = await addAccount(pg);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Locked' });

    const hidden = await listMembers(db, outsider.userId, group.id).catch((error: unknown) => error);
    const missing = await listMembers(db, outsider.userId, randomUUID()).catch((error: unknown) => error);
    expect(hidden).toBeInstanceOf(StoreNotFoundError);
    expect(missing).toBeInstanceOf(StoreNotFoundError);
    expect((hidden as Error).message).toBe((missing as Error).message);
    expect((hidden as Error).message).toMatch(/not found/);
    expect((hidden as Error).message).not.toMatch(/secret@example\.com/);

    // The owner still sees their own membership; the outsider's rejection
    // above proves it, not a query that happened to come back empty.
    expect(await listMembers(db, owner.userId, group.id)).toHaveLength(1);
  });

  it("a revoked member's profile disappears from listMembers once removed", async () => {
    const owner = await addAccount(pg);
    const member = await addAccount(pg);
    await setEmail(member.userId, 'leaving@example.com');
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Shrinking Profiles' });
    await addMember(db, owner.userId, group.id, member.userId, 'member');

    expect(await listMembers(db, owner.userId, group.id)).toHaveLength(2);

    await revokeMember(db, owner.userId, group.id, member.userId);

    const after = await listMembers(db, owner.userId, group.id);
    expect(after).toHaveLength(1);
    expect(after.map((entry) => entry.userId)).not.toContain(member.userId);
  });

  it('displayName falls back to the email local part with no name, and to null with neither', async () => {
    const owner = await addAccount(pg);
    const noName = await addAccount(pg);
    await setEmail(noName.userId, 'localpart@example.com');
    const noProfile = await addAccount(pg);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Fallbacks' });
    await addMember(db, owner.userId, group.id, noName.userId, 'member');
    await addMember(db, owner.userId, group.id, noProfile.userId, 'member');

    const members = await listMembers(db, owner.userId, group.id);
    const byId = new Map(members.map((entry) => [entry.userId, entry]));
    expect(byId.get(noName.userId)).toMatchObject({ displayName: 'localpart', email: 'localpart@example.com' });
    expect(byId.get(noProfile.userId)).toMatchObject({ displayName: null, email: null });
  });

  // Regression guard for a real-Postgres-only failure the test connection cannot reproduce
  // (S14-T026): bob_private.space_member_profiles(uuid) and
  // bob_private.bump_membership_revision(uuid) both take a single uuid
  // argument, but a bound parameter used ONLY as a function argument (no
  // surrounding column comparison to infer a type from) can be sent
  // untyped/text by some connection paths, which real Postgres then refuses
  // to resolve against a (uuid) overload -- "function ... does not exist".
  // The test connection leaves parameter types for the server to infer, so the
  // only thing that can catch a future regression here is asserting on the
  // query text itself, not on runtime behavior. queryLog below wraps the
  // real Db and records every SQL string a call issues.
  it('listMembers casts the profile-lookup parameter to uuid in the query text', async () => {
    const owner = await addAccount(pg);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Cast Check' });

    const { db: recording, queries } = recordingDb(db);
    await listMembers(recording, owner.userId, group.id);

    const profileQuery = queries.find((sql) => sql.includes('space_member_profiles'));
    expect(profileQuery).toBeDefined();
    expect(profileQuery).toContain('space_member_profiles($1::uuid)');
  });

  it('addMember (via bumpRevision) casts the membership-revision-bump parameter to uuid in the query text', async () => {
    const owner = await addAccount(pg);
    const member = await addAccount(pg);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Bump Cast Check' });

    const { db: recording, queries } = recordingDb(db);
    await addMember(recording, owner.userId, group.id, member.userId, 'member');

    const bumpQuery = queries.find((sql) => sql.includes('bump_membership_revision'));
    expect(bumpQuery).toBeDefined();
    expect(bumpQuery).toContain('bump_membership_revision($1::uuid)');
  });

  it('two members with the same display name get distinct, deterministic handles (by user_id)', async () => {
    const owner = await addAccount(pg);
    const first = await addAccount(pg);
    const second = await addAccount(pg);
    await setMetaName(first.userId, 'Jane Doe');
    await setMetaName(second.userId, 'Jane Doe');
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Twins' });
    await addMember(db, owner.userId, group.id, first.userId, 'member');
    await addMember(db, owner.userId, group.id, second.userId, 'member');

    const members = await listMembers(db, owner.userId, group.id);
    const handles = members.map((entry) => entry.handle);
    expect(new Set(handles).size).toBe(handles.length);
    const byId = new Map(members.map((entry) => [entry.userId, entry.handle]));
    const lower = first.userId < second.userId ? first.userId : second.userId;
    const higher = first.userId < second.userId ? second.userId : first.userId;
    expect(byId.get(lower)!).toBe('jane.doe');
    expect(byId.get(higher)!).toBe('jane.doe.2');

    // Determinism is by user_id, never by arrival/join order: deriving from the
    // reversed listing must produce the exact same user_id -> handle mapping.
    const derived = deriveMemberHandles([...members].reverse());
    expect(new Map(derived.map((entry) => [entry.userId, entry.handle]))).toEqual(byId);
  });

  it('an empty or symbol-only display name falls back to the email local part, then to member', async () => {
    const owner = await addAccount(pg);
    await setMetaName(owner.userId, 'Owner Person');
    const symbols = await addAccount(pg);
    await setMetaName(symbols.userId, '!!!');
    await setEmail(symbols.userId, 'symbols@example.com');
    const nameless = await addAccount(pg);
    await setEmail(nameless.userId, 'nameless@example.com');
    const bare = await addAccount(pg);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Handle Fallbacks' });
    await addMember(db, owner.userId, group.id, symbols.userId, 'member');
    await addMember(db, owner.userId, group.id, nameless.userId, 'member');
    await addMember(db, owner.userId, group.id, bare.userId, 'member');

    const members = await listMembers(db, owner.userId, group.id);
    const byId = new Map(members.map((entry) => [entry.userId, entry]));
    // A symbol-only name slugs to nothing, so the email local part wins.
    expect(byId.get(symbols.userId)).toMatchObject({ displayName: '!!!', handle: 'symbols' });
    // No name at all: the profile already folded the email local part into
    // displayName, and the handle follows it.
    expect(byId.get(nameless.userId)).toMatchObject({
      displayName: 'nameless',
      handle: 'nameless',
    });
    // Neither name nor email: the `member` fallback.
    expect(byId.get(bare.userId)).toMatchObject({
      displayName: null,
      email: null,
      handle: 'member',
    });
  });

  it("a member named 'Bob' cannot take the reserved bob handle", async () => {
    const owner = await addAccount(pg);
    const bob = await addAccount(pg);
    await setMetaName(bob.userId, 'Bob');
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Reserved' });
    await addMember(db, owner.userId, group.id, bob.userId, 'member');

    const members = await listMembers(db, owner.userId, group.id);
    const bobMember = members.find((entry) => entry.userId === bob.userId)!;
    expect(bobMember.handle).toBe('bob.1');
    expect(bobMember.handle).not.toBe('bob');
    // The disambiguated handle still parses as a person mention, not the assistant.
    const parsed = parseMentions('@' + bobMember.handle);
    expect(parsed.mentions).toHaveLength(1);
    expect(parsed.mentions[0]!.kind).toBe('person');
    expect(parsed.addressesAssistant).toBe(false);
  });
});