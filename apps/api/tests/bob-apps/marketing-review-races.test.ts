import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { installMarketingPackage, changeMarketingLifecycle } from '../../src/bob-apps/marketing-install.ts';
import { createCampaign, createDraft, updateDraft } from '../../src/bob-apps/marketing-store.ts';
import { approveMarketingPlan, getMarketingReview } from '../../src/bob-apps/marketing-review-store.ts';
import { addMember, createSpace, revokeMember } from '../../src/spaces/store.ts';
import { setMemberRole } from '../../src/spaces/member-roles.ts';
import { deleteAccount } from '../../src/workflows/workflow-account-deletion.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addAccount, asDb, closeTestDb, createTestDb, withAdminAuth, type TestDb } from '../support/test-db.ts';

vi.mock('../../src/notifications/email-client.ts', async (original) => ({ ...(await original<typeof import('../../src/notifications/email-client.ts')>()), recipientEmail: vi.fn(async () => null) }));
let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });
function signal() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const replay of [false, true]) {
  it(`refuses a session ended while ${replay ? 'approval replay' : 'approval'} waits for the real audience lock`, async () => {
    const t = await setup();
    if (replay) await approveMarketingPlan(db, t.admin.userId, t.app.id, t.campaignId, t.input, t.admin.sessionId);
    const held = signal(); const release = signal(); const queued = signal();
    const holding = withUser(db, t.owner.userId, async (tx) => {
      await tx.query('select bob_private.lock_thread_audience_revision($1)', [t.space.id]);
      held.resolve(); await release.promise;
    });
    await held.promise;
    function observe(inner: Db): Db {
      return {
        query<T>(sql: string, params?: unknown[]): Promise<T[]> {
          const pending = inner.query<T>(sql, params);
          if (sql.includes('lock_thread_audience_revision')) queued.resolve();
          return pending;
        },
        tx<T>(work: (tx: Db) => Promise<T>): Promise<T> { return inner.tx((tx) => work(observe(tx))); },
      };
    }
    const approval = approveMarketingPlan(observe(db), t.admin.userId, t.app.id, t.campaignId, t.input, t.admin.sessionId).catch((error: unknown) => error);
    try {
      await queued.promise;
      await withAdminAuth(pg, (admin) => admin.endSession(t.admin.sessionId));
      release.resolve(); await holding;
      expect(await approval).toMatchObject({ message: 'marketing_session_inactive' });
      expect((await getMarketingReview(db, t.owner.userId, t.app.id, t.campaignId)).history).toHaveLength(replay ? 1 : 0);
    } finally { release.resolve(); await Promise.allSettled([holding, approval]); }
  });
}
function gate(base: Db, match: (sql: string) => boolean, after: boolean) {
  const reached = signal(); const released = signal(); let used = false;
  function wrap(inner: Db): Db {
    return {
      async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
        if (used || !match(sql)) return inner.query<T>(sql, params);
        used = true;
        const rows = after ? await inner.query<T>(sql, params) : undefined;
        reached.resolve(); await released.promise;
        return rows ?? inner.query<T>(sql, params);
      },
      tx<T>(work: (tx: Db) => Promise<T>): Promise<T> { return inner.tx((tx) => work(wrap(tx))); },
    };
  }
  return { db: wrap(base), reached: reached.promise, release: released.resolve };
}
async function setup() {
  const owner = await addAccount(pg); const admin = await addAccount(pg);
  const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Review race' });
  await addMember(db, owner.userId, space.id, admin.userId, 'admin');
  const draft = await installMarketingPackage(db, admin.userId, { packageId: 'bob-marketing', spaceId: space.id, mutationId: randomUUID() }, admin.sessionId);
  const app = await changeMarketingLifecycle(db, owner.userId, draft.id, { operation: 'activate', expectedRevision: draft.revision, mutationId: randomUUID() });
  const campaign = await createCampaign(db, admin.userId, app.id, { name: 'One story', goal: 'awareness', channels: ['linkedin'] }, { key: randomUUID(), scope: { source: 'ui' } });
  if (!campaign.campaignId) throw new Error('campaign missing');
  const post = await createDraft(db, admin.userId, app.id, { campaignId: campaign.campaignId, channel: 'linkedin', format: 'text', body: 'A little joy.', cta: 'none', claimIds: [], approvedAssetIds: [] }, { key: randomUUID(), scope: { source: 'ui' } });
  if (!post.draftId) throw new Error('draft missing');
  const review = await getMarketingReview(db, admin.userId, app.id, campaign.campaignId);
  return { owner, admin, space, app, campaignId: campaign.campaignId, draftId: post.draftId,
    input: { expectedReviewRevision: review.reviewRevision, snapshotHash: review.snapshotHash, mutationId: randomUUID() } };
}
type Team = Awaited<ReturnType<typeof setup>>;
type Change = 'edit' | 'demote' | 'revoke' | 'erase';
function changeGate(change: Change, changeFirst: boolean) {
  if (change === 'edit') return gate(db, (sql) => sql.includes('lock_thread_audience_revision'), changeFirst);
  if (change === 'demote') return gate(db, (sql) => sql.includes('FROM bob.spaces s') && sql.includes('FOR UPDATE'), changeFirst);
  if (change === 'revoke') return gate(db, (sql) => sql.includes('bump_membership_revision'), changeFirst);
  return gate(db, (sql) => sql.includes(changeFirst ? 'bob_private.erase_account(' : 'lock_account_app_audiences'), changeFirst);
}
function changeWork(database: Db, t: Team, change: Change): Promise<unknown> {
  if (change === 'edit') return updateDraft(database, t.owner.userId, t.app.id, t.draftId, { expectedContentRevision: 1, body: 'A changed post.' }, { key: randomUUID(), scope: { source: 'ui' } });
  if (change === 'demote') return setMemberRole(database, t.owner.userId, t.space.id, t.admin.userId, 'member');
  if (change === 'revoke') return revokeMember(database, t.owner.userId, t.space.id, t.admin.userId);
  return deleteAccount({ db: database, now: () => Date.now(), googleConnection: { revoke: vi.fn(async () => undefined) }, deviceSessions: { closeDevice: vi.fn() } }, { userId: t.admin.userId });
}

for (const change of ['edit', 'demote', 'revoke', 'erase'] as const) {
  for (const changeFirst of [false, true]) {
    it(`serializes approval versus ${change} (${changeFirst ? change : 'approval'} first)`, async () => {
      const t = await setup();
      const approvalGate = gate(db, (sql) => sql.includes('lock_thread_audience_revision'), !changeFirst);
      const otherGate = changeGate(change, changeFirst);
      const approve = () => approveMarketingPlan(approvalGate.db, t.admin.userId, t.app.id, t.campaignId, t.input, t.admin.sessionId).catch((error: unknown) => error);
      const mutate = () => changeWork(otherGate.db, t, change).catch((error: unknown) => error);
      const first = changeFirst ? mutate() : approve();
      const firstGate = changeFirst ? otherGate : approvalGate;
      const secondGate = changeFirst ? approvalGate : otherGate;
      await firstGate.reached;
      const second = changeFirst ? approve() : mutate();
      try {
        await secondGate.reached;
        secondGate.release(); firstGate.release();
        const outcomes = await Promise.all([first, second]);
        const approval = outcomes[changeFirst ? 1 : 0];
        expect(outcomes[changeFirst ? 0 : 1]).not.toBeInstanceOf(Error);
        if (changeFirst) expect(approval).toBeInstanceOf(Error);
        else expect(approval).toMatchObject({ review: { state: 'approved' } });
      } finally { firstGate.release(); secondGate.release(); await Promise.allSettled([first, second]); }
      const current = await getMarketingReview(db, t.owner.userId, t.app.id, t.campaignId);
      expect(current.history).toHaveLength(changeFirst ? 0 : 1);
      expect(current.state).toBe(changeFirst || change === 'edit' ? 'needs_review' : 'approved');
      if (!changeFirst && change === 'erase') expect(current.approval?.author).toBeNull();
      if (changeFirst || change !== 'edit') await expect(approveMarketingPlan(db, t.admin.userId, t.app.id, t.campaignId, t.input, t.admin.sessionId)).rejects.toThrow();
    });
  }
}
