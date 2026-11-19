import { setToolPreference } from '../../src/tools/store.ts';
import { readFile } from 'node:fs/promises';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addGoogleAccount, deleteGoogleAccount } from '../../src/integrations/google-store.ts';
import { createRoutine, listRoutines, updateRoutine, deleteRoutine } from '../../src/routines/store.ts';
import { dispatchRoutines } from '../../src/routines/dispatch.ts';
import { startRoutineRun, publishRoutineResult, listInsights, listRoutineRuns, checkRoutineRun, listRoutineTimeline, getRoutineRun } from '../../src/routines/run-store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { InsightSchema, RoutineRunSchema } from '../../src/web-schemas.ts';
import { createRoutineRunner } from '../../src/workflows/workflow-routine-run.ts';
import { GoogleCredentialError } from '../../src/integrations/google-credentials.ts';
import { readAccountExport } from '../../src/account/export-http.ts';
import { accountTablesPresent, purgeAccountContent } from '../../src/account/store.ts';

let pg: TestDb;
let db: Db;
const now = Date.parse('2026-10-22T00:00:00Z');
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });
async function fixture(): Promise<{ owner: string; accountId: string; routineId: string }> {
  const { userId: owner } = await addAccount(pg);
  const account = await addGoogleAccount(db, owner, { installationId: randomUUID(), accountId: randomUUID(), email: 'routine@example.test' });
  await withUser(db, owner, (tx) => tx.query("update bob.google_accounts set authorization_capabilities=array['gmail.read'] where id=$1", [account.id]));
  const routine = await createRoutine(db, owner, { kind: 'daily_gmail_digest', googleAccountId: account.id, localTime: '08:00', timeZone: 'UTC', scheduledReadConsent: true }, now);
  return { owner, accountId: account.id, routineId: routine.id };
}
const digest = { summary: 'One delivery update.', messageCount: 1, partial: false, sources: [{ threadId: 'thread1', messageId: 'message1', label: 'Delivery' }] };
it('atomically dispatches once, publishes an immutable result and isolates owners', async () => {
  const first = await fixture();
  const other = await addAccount(pg);
  const due = now + 8 * 3600000;
  await Promise.all([dispatchRoutines(db, due), dispatchRoutines(db, due)]);
  const runs = await listRoutineRuns(db, first.owner, first.routineId);
  expect(runs).toHaveLength(1);
  expect(RoutineRunSchema.parse(runs[0]).status).toBe('pending');
  const runId = runs[0]?.id ?? '';
  const context = await startRoutineRun(db, runId, due);
  expect(context).toMatchObject({ owner: first.owner, coverageStart: due - 86400000, coverageEnd: due });
  if (!context) throw new Error('missing run');
  const result = await publishRoutineResult(db, context, digest, due + 1000);
  expect(result?.category).toBe('past');
  expect(InsightSchema.parse(result).sources[0]?.url).toContain('authuser=routine%40example.test');
  expect(await publishRoutineResult(db, context, digest, due + 2000)).toBeNull();
  expect(await startRoutineRun(db, runId, due + 3000)).toBeNull();
  expect(await listInsights(db, first.owner, 'past')).toEqual([]);
  expect((await listRoutineRuns(db, first.owner, first.routineId))[0]?.result?.summary).toBe(digest.summary);
  expect(await listInsights(db, other.userId, 'past')).toEqual([]);
  expect(await listRoutineRuns(db, other.userId, first.routineId)).toEqual([]);
});

it('keeps routine email delivery opt-in and persists the explicit choice', async () => {
  const f = await fixture();
  const defaultRoutine = await createRoutine(db, f.owner, {
    kind: 'daily_gmail_digest',
    googleAccountId: f.accountId,
    localTime: '08:00',
    timeZone: 'UTC',
    scheduledReadConsent: true,
  }, now);
  expect(defaultRoutine.emailResult).toBe(false);
  const optedIn = await updateRoutine(db, f.owner, defaultRoutine.id, {
    expectedRevision: defaultRoutine.revision,
    emailResult: true,
  }, now + 1);
  expect(optedIn.emailResult).toBe(true);
  expect((await listRoutines(db, f.owner)).find((routine) => routine.id === optedIn.id)?.emailResult).toBe(true);
});

it('fences an old attempt and pause before publication', async () => {
  const first = await fixture();
  const due = now + 8 * 3600000;
  await dispatchRoutines(db, due);
  const runId = (await listRoutineRuns(db, first.owner, first.routineId))[0]?.id ?? '';
  const old = await startRoutineRun(db, runId, due);
  const fresh = await startRoutineRun(db, runId, due + 1);
  if (!old || !fresh) throw new Error('missing run');
  await expect(checkRoutineRun(db, old)).rejects.toThrow('routine_run_stale');
  expect(await publishRoutineResult(db, old, digest, due + 2)).toBeNull();
  await updateRoutine(db, first.owner, first.routineId, { expectedRevision: 1, status: 'paused' }, due + 3);
  await expect(checkRoutineRun(db, fresh)).rejects.toThrow('routine_run_stale');
  expect(await publishRoutineResult(db, fresh, digest, due + 4)).toBeNull();
});
it('coalesces an offline backlog to the latest due occurrence and erases on disconnect', async () => {
  const first = await fixture();
  const due = now + 10 * 86400000 + 9 * 3600000;
  await dispatchRoutines(db, due);
  const runs = await listRoutineRuns(db, first.owner, first.routineId);
  expect(runs.filter((run) => run.status === 'pending')).toHaveLength(1);
  expect(runs.find((run) => run.status === 'pending')?.scheduledAt).toBe(now + 10 * 86400000 + 8 * 3600000);
  await deleteGoogleAccount(db, first.owner, first.accountId);
  expect(await listRoutineRuns(db, first.owner, first.routineId)).toEqual([]);
});
it('rolls back occurrence and outbox intent together', async () => {
  const f = await fixture();
  await expect(db.tx(async (tx) => { await dispatchRoutines(tx, now + 8 * 3600000); throw new Error('rollback'); })).rejects.toThrow('rollback');
  expect(await listRoutineRuns(db, f.owner, f.routineId)).toEqual([]);
  await dispatchRoutines(db, now + 8 * 3600000);
  expect(await listRoutineRuns(db, f.owner, f.routineId)).toHaveLength(1);
});
it('pauses on revoked consent after model work and publishes nothing', async () => {
  const f = await fixture(); const due = now + 8 * 3600000;
  await dispatchRoutines(db, due);
  const id = (await listRoutineRuns(db, f.owner, f.routineId))[0]?.id ?? '';
  let checks = 0;
  const run = createRoutineRunner({ db, now: () => due, digest: async () => digest,
    verifyConsent: async () => { checks += 1; if (checks === 2) throw new GoogleCredentialError('reconnect_required'); } });
  await run(id, new AbortController().signal);
  expect(await listInsights(db, f.owner, 'past')).toEqual([]);
  expect(await listRoutineRuns(db, f.owner, f.routineId)).toMatchObject([{ status: 'failed', failureCode: 'consent_unavailable' }]);
  expect(await withUser(db, f.owner, tx => tx.query('select status from bob.routines where id=$1', [f.routineId]))).toEqual([{ status: 'paused' }]);
});
it('bounds failures to three attempts with content-free persisted errors', async () => {
  const f = await fixture(); const due = now + 8 * 3600000;
  await dispatchRoutines(db, due);
  const id = (await listRoutineRuns(db, f.owner, f.routineId))[0]?.id ?? '';
  const run = createRoutineRunner({ db, now: () => due, verifyConsent: async () => undefined,
    digest: async () => { throw new Error('secret provider content'); } });
  for (let i = 0; i < 3; i += 1) await expect(run(id, new AbortController().signal)).rejects.toThrow('routine_retry');
  await expect(run(id, new AbortController().signal)).resolves.toBeUndefined();
  const runs = await listRoutineRuns(db, f.owner, f.routineId);
  expect(runs).toMatchObject([{ status: 'failed', failureCode: 'provider_unavailable' }]);
  expect(JSON.stringify(runs)).not.toContain('secret');
});
it('exports saved provenance without attempt tokens and rejects browser writes', async () => {
  const f = await fixture(); const due = now + 8 * 3600000;
  await dispatchRoutines(db, due);
  const id = (await listRoutineRuns(db, f.owner, f.routineId))[0]?.id ?? '';
  const run = createRoutineRunner({ db, now: () => due, verifyConsent: async () => undefined, digest: async () => digest });
  await run(id, new AbortController().signal);
  const exported = await readAccountExport(db, f.owner);
  expect(exported.insights).toHaveLength(0);
  expect(exported.routine_results).toHaveLength(1);
  expect(exported.routine_runs).toHaveLength(1);
  expect(JSON.stringify(exported.routine_runs)).not.toContain('attempt_token');
  await expect(withUser(db, f.owner, tx => tx.query("update bob.routine_runs set state='completed' where id=$1", [id]))).rejects.toMatchObject({ code: '42501' });
  await expect(withUser(db, f.owner, tx => tx.query('select bob_private.routine_claim($1,now())', [id]))).rejects.toMatchObject({ code: '42501' });
});
it('skips a fall-back occurrence older than the 24-hour catch-up window', async () => {
  const f = await fixture();
  await updateRoutine(db, f.owner, f.routineId, { expectedRevision: 1, localTime: '01:30', timeZone: 'America/New_York' }, Date.parse('2026-10-31T06:00:00Z'));
  await dispatchRoutines(db, Date.parse('2026-11-02T06:00:00Z'));
  expect(await listRoutineRuns(db, f.owner, f.routineId)).toMatchObject([{ status: 'skipped', failureCode: 'missed' }]);
});
it('caps catch-up coverage at seven days and preserves its cursor after retention', async () => {
  const f = await fixture(); const due = now + 8 * 3600000;
  await dispatchRoutines(db, due);
  const firstId = (await listRoutineRuns(db, f.owner, f.routineId))[0]?.id ?? '';
  const first = await startRoutineRun(db, firstId, due);
  if (!first) throw new Error('missing run');
  await publishRoutineResult(db, first, digest, due + 1);
  const later = due + 100 * 86400000;
  await dispatchRoutines(db, later);
  const pending = (await listRoutineRuns(db, f.owner, f.routineId)).find(run => run.status === 'pending');
  const next = await startRoutineRun(db, pending?.id ?? '', later);
  expect(next).toMatchObject({ coverageStart: later - 7 * 86400000, coverageEnd: later, partial: true });
  expect(await listInsights(db, f.owner, 'past')).toEqual([]);
  expect(await withUser(db, f.owner, tx => tx.query('select id from bob.routine_runs where id=$1', [firstId]))).toEqual([]);
});
it('purges saved results and outstanding dispatch references with account content', async () => {
  const f = await fixture(); const due = now + 8 * 3600000;
  await dispatchRoutines(db, due);
  const id = (await listRoutineRuns(db, f.owner, f.routineId))[0]?.id ?? '';
  const context = await startRoutineRun(db, id, due);
  if (!context) throw new Error('missing run');
  await publishRoutineResult(db, context, digest, due + 1);
  // Direct outbox SELECT is hidden by forced RLS even before deletion. Use
  // its server-only count seam to prove the dispatch reference really leaves.
  const before = await db.query<{ count: number }>('select bob_private.outbox_pending_count() as count');
  expect(before[0]?.count).toBeGreaterThan(0);
  await purgeAccountContent(db, f.owner, await accountTablesPresent(db));
  expect(await listInsights(db, f.owner, 'past')).toEqual([]);
  expect(await listRoutineRuns(db, f.owner, f.routineId)).toEqual([]);
  const after = await db.query<{ count: number }>('select bob_private.outbox_pending_count() as count');
  expect(after[0]?.count).toBe((before[0]?.count ?? 0) - 1);
  expect(await startRoutineRun(db, id, due + 2)).toBeNull();
});

it('keeps archived history and paginates same-time routines without leaking another owner', async () => {
  const f = await fixture(); const other = await fixture(); const due = now + 8 * 3600000;
  const second = await createRoutine(db, f.owner, { kind: 'daily_gmail_digest', googleAccountId: f.accountId,
    localTime: '08:00', timeZone: 'UTC', scheduledReadConsent: true, name: 'Job updates', gmailQuery: 'subject:interview',
    instructions: 'Focus on next steps', summaryStyle: 'detailed', weekdays: [4] }, now);
  await dispatchRoutines(db, due);
  const runId = (await listRoutineRuns(db, f.owner, second.id))[0]?.id ?? '';
  const context = await startRoutineRun(db, runId, due);
  expect(context).toMatchObject({ gmailQuery: 'subject:interview', instructions: 'Focus on next steps', summaryStyle: 'detailed' });
  if (!context) throw new Error('missing run');
  await publishRoutineResult(db, context, digest, due + 1);
  await deleteRoutine(db, f.owner, second.id, { expectedRevision: 1 });
  expect((await getRoutineRun(db, f.owner, second.id, runId))?.result).toMatchObject({ title: 'Job updates', summary: digest.summary });
  expect(await getRoutineRun(db, other.owner, second.id, runId)).toBeNull();
  await expect(updateRoutine(db, f.owner, second.id, { expectedRevision: 2, status: 'active' }, due)).rejects.toThrow('routine_not_found');
  const page = await listRoutineTimeline(db, f.owner, { limit: 1 });
  expect(page.runs).toHaveLength(1); expect(page.nextCursor).not.toBeNull();
  const next = await listRoutineTimeline(db, f.owner, { ...page.nextCursor, limit: 1 });
  expect(next.runs).toHaveLength(1); expect(next.runs[0]?.id).not.toBe(page.runs[0]?.id); expect(next.nextCursor).toBeNull();
  expect(new Set([...page.runs,...next.runs].map(run => run.routineId))).toEqual(new Set([f.routineId,second.id]));
});
it('configuration edits fence an in-flight summary', async () => {
  const f = await fixture(); const due = now + 8 * 3600000;
  await dispatchRoutines(db, due);
  const id = (await listRoutineRuns(db, f.owner, f.routineId))[0]?.id ?? '';
  const context = await startRoutineRun(db, id, due);
  if (!context) throw new Error('missing run');
  await updateRoutine(db, f.owner, f.routineId, { expectedRevision: 1, gmailQuery: 'label:jobs', weekdays: [1,3,5] }, due);
  expect(await publishRoutineResult(db, context, digest, due+1)).toBeNull();
  await expect(checkRoutineRun(db, context)).rejects.toThrow('routine_run_stale');
});

it('backfills existing run insights without losing their IDs or leaking content', async () => {
 const f = await fixture(); const other = await fixture(); const due = now + 8 * 3600000;
 await dispatchRoutines(db,due);
 const id = (await listRoutineRuns(db,f.owner,f.routineId))[0]?.id ?? '';
 const context = await startRoutineRun(db,id,due);
 if (!context) throw new Error('missing run');
 const result = await publishRoutineResult(db,context,digest,due+1);
 if (!result) throw new Error('missing result');
 const database = (await db.query<{ name: string }>('select current_database() as name'))[0]?.name;
 if (!database) throw new Error('missing database');
 const migration = await readFile(new URL('../../../../supabase/migrations/20261023070000_routine_timeline.sql', import.meta.url),'utf8');
 const backfill = migration.match(/insert into bob\.routine_results select \* from bob\.insights where run_id is not null;/)?.[0];
 if (!backfill) throw new Error('missing backfill');
 await withAdmin(await adminDatabaseUrl(database), async admin => {
   await admin.unsafe('insert into bob.insights select * from bob.routine_results where id=$1',[result.id]);
   await admin.unsafe('delete from bob.routine_results where id=$1',[result.id]);
   await admin.unsafe(backfill);
 });
 expect((await getRoutineRun(db,f.owner,f.routineId,id))?.result).toMatchObject({ id: result.id, summary: digest.summary });
 expect((await getRoutineRun(db,f.owner,f.routineId,id))?.insightId).toBe(result.id);
 expect(await listInsights(db,f.owner,'past')).toEqual([]);
 expect(await getRoutineRun(db,other.owner,f.routineId,id)).toBeNull();
 await expect(withUser(db,f.owner,tx => tx.query('update bob.routine_results set summary=$1 where id=$2',['changed',result.id]))).rejects.toMatchObject({ code: '42501' });
});

it('stops scheduled execution when an account tool is disabled before publication', async () => {
 const f = await fixture(); const due = now+8*3600000;
 await dispatchRoutines(db,due);
 const id = (await listRoutineRuns(db,f.owner,f.routineId))[0]?.id ?? '';
 const run = createRoutineRunner({ db, now: () => due, verifyConsent: async () => undefined,
  digest: async () => {
   await setToolPreference(db,f.owner,{ scope: 'integration', scopeId: f.accountId, toolId: 'google_gmail_search', enabled: false });
   return digest;
  } });
 await run(id,new AbortController().signal);
 expect(await listRoutineRuns(db,f.owner,f.routineId)).toMatchObject([{ status: 'failed',failureCode: 'consent_unavailable',result: null }]);
});
it('changes accounts only with consent and preserves the old result provenance', async () => {
 const f = await fixture(); const due = now+8*3600000;
 const account = await addGoogleAccount(db,f.owner,{ installationId: randomUUID(),accountId: randomUUID(),email: 'second@example.test' });
 await withUser(db,f.owner,tx => tx.query("update bob.google_accounts set authorization_capabilities=array['gmail.read'] where id=$1",[account.id]));
 await dispatchRoutines(db,due);
 const id = (await listRoutineRuns(db,f.owner,f.routineId))[0]?.id ?? '';
 const context = await startRoutineRun(db,id,due);
 if (!context) throw new Error('missing run');
 await publishRoutineResult(db,context,digest,due+1);
 await expect(updateRoutine(db,f.owner,f.routineId,{ expectedRevision: 1,googleAccountId: account.id },due)).rejects.toThrow();
 const updated = await updateRoutine(db,f.owner,f.routineId,{ expectedRevision: 1,googleAccountId: account.id,scheduledReadConsent: true },due);
 expect(updated.googleAccountId).toBe(account.id);
 expect((await getRoutineRun(db,f.owner,f.routineId,id))?.result?.sources[0]?.url).toContain('authuser=routine%40example.test');
 expect(await withUser(db,f.owner,tx => tx.query('select last_coverage_end from bob.routines where id=$1',[f.routineId]))).toEqual([{last_coverage_end:null}]);
});

it('dispatches a weekday schedule and advances to the next selected weekday across DST', async () => {
 const f = await fixture(); const start = Date.parse('2026-10-26T15:00:00Z');
 const saved = await updateRoutine(db,f.owner,f.routineId,{ expectedRevision: 1, localTime: '09:00', timeZone: 'America/Los_Angeles', weekdays: [1] },start);
 expect(saved.nextRunAt).toBe(Date.parse('2026-10-26T16:00:00Z'));
 await dispatchRoutines(db,Date.parse('2026-10-26T16:00:00Z'));
 const rows = await withUser(db,f.owner,tx => tx.query<{ next_run_at: Date }>('select next_run_at from bob.routines where id=$1',[f.routineId]));
 expect(new Date(rows[0]?.next_run_at ?? 0).toISOString()).toBe('2026-11-02T17:00:00.000Z');
 expect(await listRoutineRuns(db,f.owner,f.routineId)).toMatchObject([{ scheduledAt: Date.parse('2026-10-26T16:00:00Z'),status: 'pending' }]);
});
