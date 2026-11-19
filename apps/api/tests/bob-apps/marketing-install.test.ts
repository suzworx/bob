import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  changeMarketingLifecycle, getMarketingInstallation, installMarketingPackage, listMarketingInstallations,
  readSelectedMarketingInstallationId, requireMarketingInstallation, resolveActiveMarketingInstallation, selectMarketingInstallation,
} from '../../src/bob-apps/marketing-install.ts';
import { deleteBobApp, getBobApp, mutateBobApp } from '../../src/bob-apps/store.ts';
import { addAccount, addSession, asDb, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { eraseAccountRow } from '../../src/account/erasure-store.ts';
import { createSpace } from '../../src/spaces/store.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });

const definition = { schemaVersion: 1, title: 'Things', lifecycle: 'keep', tables: [{ id: 'items', fields: [{ id: 'title', type: 'text' }] }], actions: [], metrics: [], views: [{ id: 'list', kind: 'table', title: 'Things', table: 'items', fields: ['title'], actions: [] }] };
const CAPABILITIES = ['campaign.draft', 'campaign.configure', 'campaign.read'];

// Race ordering by barriers, never timing: pauseAfter parks a transaction right after one statement (the erasure's
// owner-lock statement), and a queued side is proven by its backend waiting on the advisory lock in pg_stat_activity.
type Paused = { db: Db; reached: Promise<void>; release: () => void };
function pauseAfter(base: Db, matches: (sql: string) => boolean): Paused {
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let fired = false;
  const wrap = (tx: Db): Db => ({
    async query<T>(text: string, params?: unknown[]): Promise<T[]> {
      const rows = await tx.query<T>(text, params);
      if (!fired && matches(text)) { fired = true; arrive(); await gate; }
      return rows;
    },
    tx: <T>(fn: (inner: Db) => Promise<T>) => tx.tx((inner) => fn(wrap(inner))),
  });
  return { db: { query: base.query.bind(base), tx: (fn) => base.tx((tx) => fn(wrap(tx))) }, reached, release: open };
}
/** Tracks a promise without rejecting: `done` flips the moment it settles. */
function observe<T>(work: Promise<T>): { done: () => boolean; outcome: Promise<{ ok: true; value: T } | { ok: false; reason: unknown }> } {
  let done = false;
  const outcome = work.then(
    (value) => { done = true; return { ok: true as const, value }; },
    (reason: unknown) => { done = true; return { ok: false as const, reason }; },
  );
  return { done: () => done, outcome };
}
async function queuedOnAdvisoryLock(): Promise<number> {
  return withAdmin(await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName), async (sql) => {
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`;
    return rows[0]?.n ?? 0;
  });
}
/** Yields until the tracked work settles or its backend is queued on the owner lock. Bounded by turns. */
async function untilQueuedOrDone(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 2000; turn += 1) {
    if (done() || (await queuedOnAdvisoryLock()) > 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('neither finished nor queued on the owner lock');
}
const install = (owner: TestAccount, mutationId = randomUUID()) =>
  installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', mutationId }, owner.sessionId);
const change = (owner: TestAccount, id: string, operation: 'activate' | 'pause' | 'resume', expectedRevision: number, mutationId = randomUUID()) =>
  changeMarketingLifecycle(db, owner.userId, id, { operation, expectedRevision, mutationId });
const select = (owner: TestAccount, installationId: string | null, mutationId = randomUUID()) =>
  selectMarketingInstallation(db, owner.userId, { installationId, mutationId }, owner.sessionId);
const appRevision = async (owner: TestAccount, appId: string) => (await getBobApp(db, owner.userId, appId)).revision;
const sql = <T>(owner: TestAccount, text: string, params: unknown[] = []) => withUser(db, owner.userId, (tx) => tx.query<T>(text, params));
const receiptCount = async (owner: TestAccount) =>
  (await sql<{ count: number }>(owner, 'select count(*)::int as count from bob.bob_app_marketing_operations'))[0]?.count;

it('installs one draft workspace with the default config, replays the original, and rejects a changed intent', async () => {
  const owner = await addAccount(pg);
  const mutationId = randomUUID();
  const first = await install(owner, mutationId);
  expect(first).toMatchObject({ state: 'draft', revision: 1, configRevision: 1, grantedCapabilities: CAPABILITIES, config: { visibleViews: ['campaign', 'content', 'schedule', 'results'], contentGrouping: 'none', defaultChannels: ['instagram', 'linkedin'] } });
  expect(first.grantedCapabilities).not.toContain('campaign.publish');
  expect(await install(owner, mutationId)).toEqual(first);
  await expect(change(owner, first.id, 'activate', 1, mutationId)).rejects.toThrow('marketing_mutation_conflict');
});

it('lets one owner hold one installation even under simultaneous requests', async () => {
  const owner = await addAccount(pg);
  const results = await Promise.allSettled([install(owner), install(owner)]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find((result) => result.status === 'rejected');
  expect(rejected?.status === 'rejected' && String(rejected.reason)).toContain('marketing_already_installed');
  expect(await listMarketingInstallations(db, owner.userId)).toHaveLength(1);
});

it('isolates owners and rejects forged app or owner associations under forced RLS', async () => {
  const owner = await addAccount(pg); const stranger = await addAccount(pg);
  const installed = await install(owner);
  await expect(getMarketingInstallation(db, stranger.userId, installed.id)).rejects.toThrow('marketing_installation_not_found');
  expect(await listMarketingInstallations(db, stranger.userId)).toEqual([]);
  const strangerInstall = await install(stranger);
  const insert = (userId: string, appId: string) => sql(owner, `insert into bob.bob_app_installations(user_id,app_id,package_id,package_version,granted_capabilities,config) values($1,$2,'bob-marketing','1.0.0','{}','{}')`, [userId, appId]);
  await expect(insert(owner.userId, strangerInstall.appId)).rejects.toThrow();
  await expect(withUser(db, stranger.userId, (tx) => tx.query(
    `insert into bob.bob_app_installations(user_id,app_id,package_id,package_version,granted_capabilities,config) values($1,$2,'bob-marketing','1.0.0','{}','{}')`,
    [stranger.userId, installed.appId]))).rejects.toThrow();
});

it('activates, pauses and resumes only through explicit lifecycle requests, never through generic activation', async () => {
  const owner = await addAccount(pg);
  const draft = await install(owner);
  const active = await change(owner, draft.id, 'activate', 1);
  expect(active).toMatchObject({ state: 'active', revision: 2, grantedCapabilities: CAPABILITIES });
  expect(await resolveActiveMarketingInstallation(db, owner.userId, draft.id)).toMatchObject({ id: draft.id, state: 'active' });
  expect((await change(owner, draft.id, 'pause', 2)).state).toBe('paused');
  await mutateBobApp(db, owner.userId, draft.appId, { operation: 'activate', expectedRevision: await appRevision(owner, draft.appId), mutationId: randomUUID() });
  expect(await getMarketingInstallation(db, owner.userId, draft.id)).toMatchObject({ state: 'paused', revision: 3 });
  expect(await resolveActiveMarketingInstallation(db, owner.userId, draft.id)).toBeNull();
  expect((await change(owner, draft.id, 'resume', 3)).state).toBe('active');
  await expect(change(owner, draft.id, 'resume', 4)).rejects.toThrow('marketing_transition_invalid');
});

it('pauses on generic archive, clears the selection, and never resumes on restore', async () => {
  const owner = await addAccount(pg);
  const installed = await install(owner);
  await change(owner, installed.id, 'activate', 1);
  await select(owner, installed.id);
  expect(await readSelectedMarketingInstallationId(db, owner.userId)).toBe(installed.id);
  const archived = await mutateBobApp(db, owner.userId, installed.appId, { operation: 'archive', expectedRevision: await appRevision(owner, installed.appId), mutationId: randomUUID() });
  expect((await getMarketingInstallation(db, owner.userId, installed.id)).state).toBe('paused');
  expect(await readSelectedMarketingInstallationId(db, owner.userId)).toBeNull();
  await mutateBobApp(db, owner.userId, installed.appId, { operation: 'restore', expectedRevision: archived.revision, mutationId: randomUUID() });
  expect((await getMarketingInstallation(db, owner.userId, installed.id)).state).toBe('paused');
  expect(await resolveActiveMarketingInstallation(db, owner.userId, installed.id)).toBeNull();
});

it('selects only active installations, bounds the selection to an hour, and treats an expired one as null', async () => {
  const owner = await addAccount(pg);
  const installed = await install(owner);
  await expect(select(owner, installed.id)).rejects.toThrow('marketing_not_active');
  await change(owner, installed.id, 'activate', 1);
  const selection = await select(owner, installed.id);
  expect(selection).toMatchObject({ installationId: installed.id });
  const expiresAt = selection?.expiresAt ?? 0;
  expect(expiresAt).toBeGreaterThan(Date.now());
  // One hour from the database clock; a few seconds of slack covers skew between the database and this process.
  expect(expiresAt - Date.now()).toBeGreaterThan(3_600_000 - 60_000);
  expect(expiresAt - Date.now()).toBeLessThanOrEqual(3_600_000 + 5_000);
  await sql(owner, `update bob.bob_app_selection set expires_at=now()-interval '1 second' where user_id=$1`, [owner.userId]);
  expect(await readSelectedMarketingInstallationId(db, owner.userId)).toBeNull();
});

it('keeps duplicates inert and generic revisions away from grants and config', async () => {
  const owner = await addAccount(pg);
  const installed = await install(owner);
  await change(owner, installed.id, 'activate', 1);
  const before = await getMarketingInstallation(db, owner.userId, installed.id);
  const copy = await mutateBobApp(db, owner.userId, installed.appId, { operation: 'duplicate', expectedRevision: await appRevision(owner, installed.appId), mutationId: randomUUID() });
  await mutateBobApp(db, owner.userId, installed.appId, { operation: 'revise', definition: { ...definition, title: 'Changed' }, expectedRevision: await appRevision(owner, installed.appId), mutationId: randomUUID() });
  const installations = await listMarketingInstallations(db, owner.userId);
  expect(installations.map((item) => item.appId)).not.toContain(copy.id);
  expect(installations).toEqual([before]);
});

it('resolves cross-owner ids as not found, and deletion or account erasure leave nothing behind', async () => {
  const owner = await addAccount(pg); const stranger = await addAccount(pg);
  const installed = await install(owner);
  await change(owner, installed.id, 'activate', 1);
  await select(owner, installed.id);
  await expect(resolveActiveMarketingInstallation(db, stranger.userId, installed.id)).rejects.toThrow('marketing_installation_not_found');
  await deleteBobApp(db, owner.userId, installed.appId, { expectedRevision: await appRevision(owner, installed.appId), mutationId: randomUUID() });
  expect(await listMarketingInstallations(db, owner.userId)).toEqual([]);
  expect(await readSelectedMarketingInstallationId(db, owner.userId)).toBeNull();
  const again = await install(owner);
  await change(owner, again.id, 'activate', 1);
  await eraseAccountRow(db, owner.userId, Date.now());
  expect(await sql(owner, 'select id from bob.bob_app_installations')).toEqual([]);
  expect(await sql(owner, 'select mutation_id from bob.bob_app_marketing_operations')).toEqual([]);
  expect(await sql(owner, 'select user_id from bob.bob_app_selection')).toEqual([]);
});

it('refuses a write after a revocation that landed between an outer read and the locked write', async () => {
  const owner = await addAccount(pg);
  const installed = await install(owner);
  await change(owner, installed.id, 'activate', 1);
  expect(await resolveActiveMarketingInstallation(db, owner.userId, installed.id)).toMatchObject({ id: installed.id });
  await sql(owner, `update bob.bob_app_installations set granted_capabilities='{}' where id=$1`, [installed.id]);
  await expect(select(owner, installed.id)).rejects.toThrow('marketing_permission_denied');
  expect(await sql(owner, 'select user_id from bob.bob_app_selection')).toEqual([]);
});

it('never restores revoked stored grants on activation or resume', async () => {
  const owner = await addAccount(pg);
  const installed = await install(owner);
  await sql(owner, `update bob.bob_app_installations set granted_capabilities='{}' where id=$1`, [installed.id]);
  expect(await change(owner, installed.id, 'activate', 1)).toMatchObject({ state: 'active', grantedCapabilities: [] });
  await expect(select(owner, installed.id)).rejects.toThrow('marketing_permission_denied');
  await change(owner, installed.id, 'pause', 2);
  expect(await change(owner, installed.id, 'resume', 3)).toMatchObject({ state: 'active', grantedCapabilities: [] });
  await expect(select(owner, installed.id)).rejects.toThrow('marketing_permission_denied');
});

it('lists and resolves only the supported package, and refuses an unsupported version as unavailable', async () => {
  const owner = await addAccount(pg);
  const installed = await install(owner);
  // A package's app and installation are one transaction, like the real installer.
  // Otherwise the deferred generic-identity backfill correctly claims the app.
  const foreign = await withUser(db, owner.userId, async (tx) => {
    const [other] = await tx.query<{ id: string }>(`insert into bob.bob_apps(user_id,definition,state) values($1,$2::text::jsonb,'{}'::text::jsonb) returning id`, [owner.userId, JSON.stringify(definition)]);
    return (await tx.query<{ id: string }>(`insert into bob.bob_app_installations(user_id,app_id,package_id,package_version,granted_capabilities,config) values($1,$2,'other-package','1.0.0','{campaign.read}','{}'::text::jsonb) returning id`, [owner.userId, other?.id]))[0];
  });
  const foreignId = foreign?.id ?? '';
  expect((await listMarketingInstallations(db, owner.userId)).map((item) => item.id)).toEqual([installed.id]);
  await expect(getMarketingInstallation(db, owner.userId, foreignId)).rejects.toThrow('marketing_installation_not_found');
  await expect(resolveActiveMarketingInstallation(db, owner.userId, foreignId)).rejects.toThrow('marketing_installation_not_found');
  await expect(select(owner, foreignId)).rejects.toThrow('marketing_installation_not_found');
  await sql(owner, `update bob.bob_app_installations set package_version='0.9.0' where id=$1`, [installed.id]);
  expect(await listMarketingInstallations(db, owner.userId)).toEqual([]);
  await expect(getMarketingInstallation(db, owner.userId, installed.id)).rejects.toThrow('marketing_package_unavailable');
  await expect(resolveActiveMarketingInstallation(db, owner.userId, installed.id)).rejects.toThrow('marketing_package_unavailable');
  await expect(select(owner, installed.id)).rejects.toThrow('marketing_package_unavailable');
});

it('a retried installation key after app deletion stays not found and never recreates the installation', async () => {
  const owner = await addAccount(pg);
  const mutationId = randomUUID();
  const installed = await install(owner, mutationId);
  await deleteBobApp(db, owner.userId, installed.appId, { expectedRevision: await appRevision(owner, installed.appId), mutationId: randomUUID() });
  await expect(install(owner, mutationId)).rejects.toThrow('marketing_installation_not_found');
  expect(await listMarketingInstallations(db, owner.userId)).toEqual([]);
  expect((await install(owner)).state).toBe('draft');
});

// Fixture receipts are inserted through SQL so the capacity cases stay fast: 10000 keys per owner, fingerprint fixed.
const LIMIT = 10000;
const KEY_FILL = 'a'.repeat(64);
const fillReceipts = (owner: TestAccount, count: number) => sql(owner,
  'insert into bob.bob_app_marketing_operations(user_id,mutation_id,fingerprint) select $1::uuid,gen_random_uuid(),$2::text from generate_series(1,$3::int)',
  [owner.userId, KEY_FILL, count]);
const freeOneReceipt = (owner: TestAccount) => sql(owner,
  'delete from bob.bob_app_marketing_operations where ctid in (select ctid from bob.bob_app_marketing_operations where user_id=$1 and fingerprint=$2 limit 1)',
  [owner.userId, KEY_FILL]);

it('refuses new capacity-bound writes with an explicit limit, keeps old keys replayable, and never deletes keys', async () => {
  const owner = await addAccount(pg);
  const mutationId = randomUUID();
  const installed = await install(owner, mutationId);
  await fillReceipts(owner, LIMIT - 1);
  expect(await receiptCount(owner)).toBe(LIMIT);
  await expect(install(owner)).rejects.toThrow('marketing_operation_limit');
  await expect(change(owner, installed.id, 'activate', 1)).rejects.toThrow('marketing_operation_limit');
  await expect(select(owner, installed.id)).rejects.toThrow('marketing_operation_limit');
  expect(await receiptCount(owner)).toBe(LIMIT);
  expect(await install(owner, mutationId)).toMatchObject({ id: installed.id });
});

it('pauses at capacity without a new key, enforces the expected revision, and a retry after resume conflicts', async () => {
  const owner = await addAccount(pg);
  const installed = await install(owner);
  const active = await change(owner, installed.id, 'activate', 1);
  await fillReceipts(owner, LIMIT - 2);
  const pauseKey = randomUUID();
  expect(await change(owner, installed.id, 'pause', active.revision, pauseKey)).toMatchObject({ state: 'paused', revision: 3 });
  expect(await receiptCount(owner)).toBe(LIMIT);
  await expect(change(owner, installed.id, 'pause', 2)).rejects.toThrow('marketing_revision_conflict');
  expect(await change(owner, installed.id, 'pause', 3)).toMatchObject({ state: 'paused', revision: 3 });
  await freeOneReceipt(owner);
  expect(await change(owner, installed.id, 'resume', 3)).toMatchObject({ state: 'active', revision: 4 });
  await expect(change(owner, installed.id, 'pause', 2, pauseKey)).rejects.toThrow('marketing_revision_conflict');
  expect((await getMarketingInstallation(db, owner.userId, installed.id)).state).toBe('active');
});

it('refuses installs from foreign, unknown or erased sessions, and a fresh session may reinstall after erasure', async () => {
  const owner = await addAccount(pg); const stranger = await addAccount(pg);
  const installWith = (sessionId: string) => installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, sessionId);
  await expect(installWith(stranger.sessionId)).rejects.toThrow('marketing_session_inactive');
  await expect(installWith(randomUUID())).rejects.toThrow('marketing_session_inactive');
  expect(await listMarketingInstallations(db, owner.userId)).toEqual([]);
  await eraseAccountRow(db, owner.userId, Date.now());
  await expect(install(owner)).rejects.toThrow('marketing_session_inactive');
  const fresh = await addSession(pg, owner.userId);
  expect((await installWith(fresh)).state).toBe('draft');
});

it('re-checks a named installation inside the owner lock, and only for its own owner', async () => {
  const owner = await addAccount(pg); const stranger = await addAccount(pg);
  const installed = await install(owner);
  await change(owner, installed.id, 'activate', 1);
  const locked = <T>(userId: string, run: (tx: Db) => Promise<T>) => withUser(db, userId, async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 1225))', [userId]);
    return run(tx);
  });
  expect(await locked(owner.userId, (tx) => requireMarketingInstallation(tx, installed.id, 'campaign.read'))).toMatchObject({ id: installed.id });
  await expect(locked(stranger.userId, (tx) => requireMarketingInstallation(tx, installed.id))).rejects.toThrow('marketing_installation_not_found');
  await change(owner, installed.id, 'pause', 2);
  await expect(locked(owner.userId, (tx) => requireMarketingInstallation(tx, installed.id))).rejects.toThrow('marketing_not_active');
});

it('checks the session before replay: a foreign session is refused even for a replayed key, and an active session still conflicts on changed intent', async () => {
  const owner = await addAccount(pg); const stranger = await addAccount(pg);
  const mutationId = randomUUID();
  const installed = await install(owner, mutationId);
  await expect(installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', mutationId }, stranger.sessionId)).rejects.toThrow('marketing_session_inactive');
  // Session first: a foreign session with a reused key (changed intent) is a session refusal, not a fingerprint conflict.
  await expect(selectMarketingInstallation(db, owner.userId, { installationId: installed.id, mutationId }, stranger.sessionId)).rejects.toThrow('marketing_session_inactive');
  await expect(select(owner, installed.id, mutationId)).rejects.toThrow('marketing_mutation_conflict');
});

it('a queued clear behind a completed erasure writes no receipt and no selection', async () => {
  const owner = await addAccount(pg);
  const installed = await install(owner);
  await change(owner, installed.id, 'activate', 1);
  await select(owner, installed.id);
  const held = pauseAfter(db, () => true); // erasure parks after its first statement, which holds the owner lock
  const erased = observe(eraseAccountRow(held.db, owner.userId, Date.now()));
  try {
    await Promise.race([held.reached, erased.outcome]);
    const clearKey = randomUUID();
    const queued = observe(select(owner, null, clearKey));
    await untilQueuedOrDone(queued.done);
    expect(queued.done()).toBe(false); // the clear parks behind the erasure's owner lock
    expect(await queuedOnAdvisoryLock()).toBeGreaterThan(0);
    held.release();
    expect((await erased.outcome).ok).toBe(true);
    const refused = await queued.outcome;
    expect(refused.ok ? '' : String(refused.reason)).toContain('marketing_session_inactive');
    expect(await sql(owner, 'select mutation_id from bob.bob_app_marketing_operations where mutation_id=$1', [clearKey])).toEqual([]);
    expect(await sql(owner, 'select user_id from bob.bob_app_selection')).toEqual([]);
    expect(await sql(owner, 'select id from bob.bob_app_installations')).toEqual([]);
  } finally {
    held.release();
  }
});

it('drops a selection once its grant is revoked, its package version is unsupported or its package is not Marketing', async () => {
  const owner = await addAccount(pg);
  const installed = await install(owner);
  await change(owner, installed.id, 'activate', 1);
  await select(owner, installed.id);
  await sql(owner, `update bob.bob_app_installations set granted_capabilities='{campaign.draft}' where id=$1`, [installed.id]);
  expect(await readSelectedMarketingInstallationId(db, owner.userId)).toBeNull();
  expect(await resolveActiveMarketingInstallation(db, owner.userId, installed.id)).toBeNull();
  expect((await getMarketingInstallation(db, owner.userId, installed.id)).grantedCapabilities).toEqual(['campaign.draft']);
  await sql(owner, `update bob.bob_app_installations set granted_capabilities='{campaign.read}' where id=$1`, [installed.id]);
  await select(owner, installed.id);
  expect(await readSelectedMarketingInstallationId(db, owner.userId)).toBe(installed.id);
  await sql(owner, `update bob.bob_app_installations set package_version='0.9.0' where id=$1`, [installed.id]);
  expect(await readSelectedMarketingInstallationId(db, owner.userId)).toBeNull();
  await sql(owner, `update bob.bob_app_installations set package_version='1.0.0', package_id='other-package' where id=$1`, [installed.id]);
  expect(await readSelectedMarketingInstallationId(db, owner.userId)).toBeNull();
});

const FENCE_KEY = 'bob_marketing_erased_before';
const authDatabase = () => adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
async function setAppMetadata(owner: TestAccount, value: unknown): Promise<void> {
  await withAdmin(await authDatabase(), async (admin) => {
    await admin`update auth.users set raw_app_meta_data=${JSON.stringify(value) ?? 'null'}::text::jsonb where id=${owner.userId}`;
  });
}
async function admitted(owner: TestAccount, sessionId = owner.sessionId): Promise<boolean> {
  const [row] = await sql<{ active: boolean }>(owner, 'select bob_private.marketing_session_active($1::uuid) as active', [sessionId]);
  return row?.active === true;
}

it('preserves global sessions and unrelated app metadata while fencing Marketing admission at erasure', async () => {
  const owner = await addAccount(pg);
  await setAppMetadata(owner, { provider: 'email', providers: ['email'], other: 'preserved' });
  await install(owner);
  await eraseAccountRow(db, owner.userId, Date.now());
  const state = await withAdmin(await authDatabase(), async (admin) => {
    const [row] = await admin<{ metadata: Record<string, unknown>; sessions: number }[]>`select raw_app_meta_data as metadata,
      (select count(*)::int from auth.sessions where user_id=${owner.userId}) as sessions from auth.users where id=${owner.userId}`;
    return row;
  });
  expect(state).toEqual({
    metadata: { provider: 'email', providers: ['email'], other: 'preserved',
      [FENCE_KEY]: expect.any(Number), bob_push_erased_before: expect.any(Number), bob_google_native_erased_before: expect.any(Number) },
    sessions: 1,
  });
  await expect(sql(owner, 'update auth.users set raw_app_meta_data=$1::text::jsonb where id=$2', ['{}', owner.userId])).rejects.toThrow();
  expect(await admitted(owner)).toBe(false);
  const fresh = await addSession(pg, owner.userId);
  expect(await admitted(owner, fresh)).toBe(true);
  await expect(install(owner)).rejects.toThrow('marketing_session_inactive');
});

it('reads the current app fence rather than spoofed user metadata or refreshed old-session timestamps', async () => {
  const owner = await addAccount(pg);
  await withAdmin(await authDatabase(), async (admin) => {
    await admin`update auth.sessions set created_at='2000-01-01T00:00:00Z',updated_at=clock_timestamp() where id=${owner.sessionId}`;
    await admin`update auth.users set raw_app_meta_data=${JSON.stringify({ [FENCE_KEY]: 978307200 })}::text::jsonb,
      raw_user_meta_data=${JSON.stringify({ [FENCE_KEY]: 0 })}::text::jsonb where id=${owner.userId}`;
  });
  expect(await admitted(owner)).toBe(false);
  // The local sign-in helper must not rejuvenate a session when invoked again for its existing id.
  await pg.query('select bob_private.ensure_test_session($1::uuid,$2::uuid)', [owner.userId, owner.sessionId]);
  expect(await admitted(owner)).toBe(false);
  await expect(install(owner)).rejects.toThrow('marketing_session_inactive');
});

it.each([null, 'invalid', {}, [], true].map((value) => [value]))('denies Marketing for a present malformed app fence: %j', async (fence) => {
  const owner = await addAccount(pg);
  await setAppMetadata(owner, { [FENCE_KEY]: fence });
  expect(await admitted(owner)).toBe(false);
});

it.each([null, [], 'invalid', 123].map((value) => [value]))('denies Marketing for an invalid app-metadata shape: %j', async (metadata) => {
  const owner = await addAccount(pg);
  await setAppMetadata(owner, metadata);
  expect(await admitted(owner)).toBe(false);
});

it('keeps legacy sessions eligible without a fence but denies null or equally old creation times after it', async () => {
  const owner = await addAccount(pg);
  await withAdmin(await authDatabase(), async (admin) => {
    await admin`update auth.sessions set created_at=null where id=${owner.sessionId}`;
  });
  expect(await admitted(owner)).toBe(true);
  await setAppMetadata(owner, { [FENCE_KEY]: 1 });
  expect(await admitted(owner)).toBe(false);
  await withAdmin(await authDatabase(), async (admin) => {
    await admin`update auth.sessions set created_at='2000-01-01T00:00:00Z' where id=${owner.sessionId}`;
    await admin`update auth.users set raw_app_meta_data=jsonb_build_object(${FENCE_KEY}::text,
      (select extract(epoch from created_at) from auth.sessions where id=${owner.sessionId})) where id=${owner.userId}`;
  });
  expect(await admitted(owner)).toBe(false);
});

it('does not commit a Marketing fence when erasure is refused or rolled back', async () => {
  const refused = await addAccount(pg);
  await createSpace(db, refused.userId, { kind: 'group', name: 'Protected group' });
  await expect(eraseAccountRow(db, refused.userId, Date.now())).rejects.toMatchObject({ code: 'OX001' });
  expect(await admitted(refused)).toBe(true);
  const rolledBack = await addAccount(pg);
  await expect(db.tx(async (tx) => {
    await eraseAccountRow(tx, rolledBack.userId, Date.now());
    throw new Error('rollback synthetic erasure');
  })).rejects.toThrow('rollback synthetic erasure');
  expect(await admitted(rolledBack)).toBe(true);
});
