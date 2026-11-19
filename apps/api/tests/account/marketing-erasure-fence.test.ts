// Race regression: account erasure vs Marketing installation admission (MARKETING-ERASURE-1396).
// Both sides take the owner advisory lock (salt 1225). Ordering is fixed by barriers, never by timing: pauseAfter()
// parks a transaction right after one statement completes, and a queued side is proven by its backend waiting on the
// advisory lock in pg_stat_activity. Synthetic inputs only; no content is logged.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { changeMarketingLifecycle, installMarketingPackage, selectMarketingInstallation } from '../../src/bob-apps/marketing-install.ts';
import { applyMarketingConfigProposal, proposeMarketingConfig } from '../../src/bob-apps/marketing-config-store.ts';
import { createCampaign, createDraft, saveCampaignSection, type WriteOrigin } from '../../src/bob-apps/marketing-store.ts';
import { eraseAccountRow } from '../../src/account/erasure-store.ts';
import { appendMessage } from '../../src/conversations/store.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { ensurePrivateSpace } from '../../src/spaces/store.ts';
import { addAccount, addSession, asDb, closeTestDb, createTestDb, withAdminAuth, type TestAccount, type TestDb } from '../support/test-db.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });

type Paused = { db: Db; reached: Promise<void>; release: () => void };
type Settled<T> = { ok: true; value: T } | { ok: false; reason: unknown };

/** Wraps a Db so the first statement matching `matches` completes, then its transaction parks until release(). */
function pauseAfter(base: Db, matches: (sql: string) => boolean): Paused {
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let fired = false;
  const wrap = (tx: Db): Db => ({
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const rows = await tx.query<T>(sql, params);
      if (!fired && matches(sql)) { fired = true; arrive(); await gate; }
      return rows;
    },
    tx: <T>(fn: (inner: Db) => Promise<T>) => tx.tx((inner) => fn(wrap(inner))),
  });
  return { db: { query: base.query.bind(base), tx: (fn) => base.tx((tx) => fn(wrap(tx))) }, reached, release: open };
}

/** Tracks a promise without rejecting: `done` flips the moment it settles. */
function observe<T>(work: Promise<T>): { done: () => boolean; outcome: Promise<Settled<T>> } {
  let done = false;
  const outcome = work.then(
    (value) => { done = true; return { ok: true as const, value }; },
    (reason: unknown) => { done = true; return { ok: false as const, reason }; },
  );
  return { done: () => done, outcome };
}

const databaseUrl = () => adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);

/** Backends of this database parked on the owner advisory lock (pg_stat_activity). */
async function queuedOnAdvisoryLock(): Promise<number> {
  return withAdmin(await databaseUrl(), async (sql) => {
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`;
    return rows[0]?.n ?? 0;
  });
}

/** Yields to the event loop until the work settles or its backend is queued on the owner lock. Bounded by turns. */
async function untilQueuedOrDone(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 2000; turn += 1) {
    if (done() || (await queuedOnAdvisoryLock()) > 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('neither finished nor queued on the owner lock');
}

/** Rows the owner still has, counted as the database owner (bypasses forced RLS, so a hidden row still counts). */
async function rowCounts(userId: string) {
  return withAdmin(await databaseUrl(), async (sql) => {
    const [row] = await sql<{ installations: number; apps: number; operations: number; selections: number }[]>`
      select (select count(*)::int from bob.bob_app_installations where user_id = ${userId}) as installations,
             (select count(*)::int from bob.bob_apps where user_id = ${userId}) as apps,
             (select count(*)::int from bob.bob_app_marketing_operations where user_id = ${userId}) as operations,
             (select count(*)::int from bob.bob_app_selection where user_id = ${userId}) as selections`;
    return row!;
  });
}

const NO_ROWS = { installations: 0, apps: 0, operations: 0, selections: 0 };
const install = (base: Db, owner: string, sessionId: string) =>
  installMarketingPackage(base, owner, { packageId: 'bob-marketing', mutationId: randomUUID() }, sessionId);

it('an install admitted before erasure commits first, and erasure then purges its rows and fences Marketing admission', async () => {
  const owner = await addAccount(pg);
  const held = pauseAfter(db, (sql) => sql.includes('insert into bob.bob_app_marketing_operations'));
  const installed = observe(install(held.db, owner.userId, owner.sessionId));
  try {
    await Promise.race([held.reached, installed.outcome]); // admitted: session checked, rows written, commit held
    const erased = observe(eraseAccountRow(db, owner.userId, Date.now()));
    await untilQueuedOrDone(erased.done);
    expect(erased.done()).toBe(false); // erasure waits behind the install's owner lock
    expect(await queuedOnAdvisoryLock()).toBeGreaterThan(0);
    held.release();
    expect((await installed.outcome).ok).toBe(true);
    expect((await erased.outcome).ok).toBe(true);
    expect(await rowCounts(owner.userId)).toEqual(NO_ROWS);
    expect(await withAdminAuth(pg, (admin) => admin.sessionExists(owner.sessionId, owner.userId))).toBe(true);
    await expect(install(db, owner.userId, owner.sessionId)).rejects.toThrow('marketing_session_inactive');
  } finally {
    held.release();
  }
});

it('erasure that takes the owner lock first refuses a queued install with the old session and leaves no rows', async () => {
  const owner = await addAccount(pg);
  const held = pauseAfter(db, () => true); // parks after the erasure transaction's first statement
  const erased = observe(eraseAccountRow(held.db, owner.userId, Date.now()));
  try {
    await Promise.race([held.reached, erased.outcome]); // erasure now holds the owner lock (its first statement)
    const queued = observe(install(db, owner.userId, owner.sessionId));
    await untilQueuedOrDone(queued.done);
    expect(queued.done()).toBe(false); // the install parks until erasure releases the lock
    expect(await queuedOnAdvisoryLock()).toBeGreaterThan(0);
    held.release();
    expect((await erased.outcome).ok).toBe(true);
    const refused = await queued.outcome;
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : String(refused.reason)).toContain('marketing_session_inactive');
    expect(await rowCounts(owner.userId)).toEqual(NO_ROWS);
    expect(await withAdminAuth(pg, (admin) => admin.sessionExists(owner.sessionId, owner.userId))).toBe(true);
  } finally {
    held.release();
  }
});

it('a fresh session can reinstall and select Marketing while the retained old session stays fenced', async () => {
  const owner = await addAccount(pg);
  await eraseAccountRow(db, owner.userId, Date.now());
  await expect(install(db, owner.userId, owner.sessionId)).rejects.toThrow('marketing_session_inactive');
  await expect(selectMarketingInstallation(db, owner.userId, { installationId: null, mutationId: randomUUID() }, owner.sessionId)).rejects.toThrow('marketing_session_inactive');
  const fresh = await addSession(pg, owner.userId);
  const installed = await install(db, owner.userId, fresh);
  expect(installed.state).toBe('draft');
  await changeMarketingLifecycle(db, owner.userId, installed.id, { operation: 'activate', expectedRevision: installed.revision, mutationId: randomUUID() });
  expect(await selectMarketingInstallation(db, owner.userId, { installationId: installed.id, mutationId: randomUUID() }, fresh)).toMatchObject({ installationId: installed.id });
  await expect(install(db, owner.userId, owner.sessionId)).rejects.toThrow('marketing_session_inactive');
  for (const installationId of [installed.id, null]) {
    await expect(selectMarketingInstallation(db, owner.userId, { installationId, mutationId: randomUUID() }, owner.sessionId)).rejects.toThrow('marketing_session_inactive');
  }
  expect(await withAdminAuth(pg, (admin) => admin.sessionExists(owner.sessionId, owner.userId))).toBe(true);
});

/** Real service writes populate every new Marketing child table, including pending and applied configuration. */
async function populateMarketing(owner: TestAccount): Promise<void> {
  const installed = await install(db, owner.userId, owner.sessionId);
  await changeMarketingLifecycle(db, owner.userId, installed.id, { operation: 'activate', expectedRevision: installed.revision, mutationId: randomUUID() });
  await selectMarketingInstallation(db, owner.userId, { installationId: installed.id, mutationId: randomUUID() }, owner.sessionId);
  const space = await ensurePrivateSpace(db, owner.userId);
  const conversationId = `conv_${randomUUID()}`;
  const turnId = `msg_${randomUUID()}`;
  await withUser(db, owner.userId, (tx) => tx.query('insert into bob.conversations (id,user_id,space_id,title) values ($1,$2,$3,$4)',
    [conversationId, owner.userId, space.id, 'Synthetic campaign']));
  await appendMessage(db, owner.userId, conversationId, { id: turnId, role: 'user', parts: [{ type: 'text', text: 'Synthetic campaign request' }] });
  const origin = (tool: string): WriteOrigin => ({ key: randomUUID(), scope: { source: 'tool', conversationId, turnId, tool } });
  const campaign = await createCampaign(db, owner.userId, installed.id, { name: 'Synthetic campaign', goal: 'curiosity', channels: ['instagram', 'linkedin'] }, origin('create_campaign'), conversationId);
  if (campaign.campaignId === null) throw new Error('Campaign fixture was not created');
  await saveCampaignSection(db, owner.userId, installed.id, campaign.campaignId, { section: 'brief', content: 'Synthetic brief', expectedRevision: 1 }, origin('save_plan_section'));
  await createDraft(db, owner.userId, installed.id, { campaignId: campaign.campaignId, channel: 'instagram', format: 'image', body: 'Synthetic draft', approvedAssetIds: ['bob-playful'], claimIds: [], cta: 'none' }, origin('save_draft'));
  const proposed = await proposeMarketingConfig(db, owner.userId, installed.id, { mutationId: randomUUID(), expectedConfigRevision: 1,
    config: { visibleViews: ['campaign', 'content'], contentGrouping: 'pillar', defaultChannels: ['instagram'] } }, { conversationId, turnId });
  if (proposed.proposal === null) throw new Error('Config fixture was not proposed');
  await applyMarketingConfigProposal(db, owner.userId, installed.id, { mutationId: randomUUID(), proposalId: proposed.proposal.id, hash: proposed.proposal.canonicalHash, expectedConfigRevision: 1 });
  await proposeMarketingConfig(db, owner.userId, installed.id, { mutationId: randomUUID(), expectedConfigRevision: 2,
    config: { visibleViews: ['campaign', 'content', 'results'], contentGrouping: 'channel', defaultChannels: ['instagram', 'linkedin'] } }, { conversationId, turnId });
}

/** Admin counts bypass RLS: hidden rows would still fail erasure, even when the auth user is retained. */
async function marketingChildCounts(userId: string): Promise<Record<string, number>> {
  return withAdmin(await databaseUrl(), async (sql) => {
    const [row] = await sql<Record<string, number>[]>`select
      (select count(*)::int from bob.bob_app_campaigns where user_id=${userId}) as campaigns,
      (select count(*)::int from bob.bob_app_campaign_sections where user_id=${userId}) as sections,
      (select count(*)::int from bob.bob_app_campaign_drafts where user_id=${userId}) as drafts,
      (select count(*)::int from bob.bob_app_campaign_selection where user_id=${userId}) as selections,
      (select count(*)::int from bob.bob_app_campaign_operations where user_id=${userId}) as "campaignOperations",
      (select count(*)::int from bob.marketing_config_proposals where user_id=${userId}) as "configProposals",
      (select count(*)::int from bob.marketing_config_versions where user_id=${userId}) as "configVersions",
      (select count(*)::int from bob.marketing_config_operations where user_id=${userId}) as "configOperations",
      (select count(*)::int from auth.sessions where user_id=${userId}) as sessions`;
    if (!row) throw new Error('Marketing count query returned no row');
    return row;
  });
}

it('erasure removes campaign artifacts, configuration history and receipts while retaining another owner intact', async () => {
  const owner = await addAccount(pg);
  const other = await addAccount(pg);
  await addSession(pg, owner.userId);
  await populateMarketing(owner);
  await populateMarketing(other);
  const saved = { campaigns: 1, sections: 1, drafts: 1, selections: 1, campaignOperations: 3, configProposals: 2, configVersions: 2, configOperations: 3, sessions: 1 };
  expect(await marketingChildCounts(owner.userId)).toEqual({ ...saved, sessions: 2 });
  expect(await marketingChildCounts(other.userId)).toEqual(saved);
  const otherInstallationRows = await rowCounts(other.userId);

  await eraseAccountRow(db, owner.userId, Date.now());

  expect(await marketingChildCounts(owner.userId)).toEqual({ campaigns: 0, sections: 0, drafts: 0, selections: 0, campaignOperations: 0, configProposals: 0, configVersions: 0, configOperations: 0, sessions: 2 });
  await expect(install(db, owner.userId, owner.sessionId)).rejects.toThrow('marketing_session_inactive');
  await expect(selectMarketingInstallation(db, owner.userId, { installationId: null, mutationId: randomUUID() }, owner.sessionId)).rejects.toThrow('marketing_session_inactive');
  expect(await rowCounts(owner.userId)).toEqual(NO_ROWS);
  expect(await withAdminAuth(pg, (admin) => admin.getUser(owner.userId))).not.toBeNull();
  expect(await marketingChildCounts(other.userId)).toEqual(saved);
  expect(await rowCounts(other.userId)).toEqual(otherInstallationRows);
});
