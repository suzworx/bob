/** Local synthetic demo using real private HTTP routes, stores, outbox and
 * pg-boss. No Gmail credentials, model key, or hosted database is used. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.env.BOB_PRODUCTION === '1') throw new Error('demo_refused_in_production');
Object.assign(process.env, { BOB_SYSTEM_TEST: '1', BOB_AI_STUB: 'scripted', BOB_V2_HOST: '127.0.0.1',
  BOB_DATABASE_URL: 'postgresql://bob_server@127.0.0.1:1/bob_no_shared_db',
  OTEL_SDK_DISABLED: 'true', BOB_RATE_LIMIT_API_RPM: '3000', BOB_DEV_SIGN_IN: '1' });
// Config reads stub selection at import time: dynamic imports follow the guards.
const { acquireDatabase, PgTestDb } = await import('../apps/api/tests/support/pg-template.ts');
const { addAccount, asDb } = await import('../apps/api/tests/support/test-db.ts');
const { setSharedDb, withUser } = await import('../apps/api/src/platform/db/db.ts');
const { createAppDeps } = await import('../apps/api/src/app-deps.ts');
const { DEV_ACCOUNT_ID } = await import('../apps/api/src/account/dev-account.ts');
const { addGoogleAccount, getGoogleAccount } = await import('../apps/api/src/integrations/google-store.ts');
const { createRoutine, updateRoutine } = await import('../apps/api/src/routines/store.ts');
const { createRoutineTools } = await import('../apps/api/src/routines/tools.ts');
const { createGoogleTools } = await import('../apps/api/src/integrations/google-tools.ts');
const { createRoutineDigest } = await import('../apps/api/src/routines/digest.ts');
const { createRoutineRunner } = await import('../apps/api/src/workflows/workflow-routine-run.ts');
const { createRoutineJobQueue } = await import('../apps/api/src/platform/jobs/routine-queue.ts');
const { listRoutineResults, listRoutineRuns } = await import('../apps/api/src/routines/run-store.ts');
const { dispatchRoutines } = await import('../apps/api/src/routines/dispatch.ts');
const { createInsightRefresh } = await import('../apps/api/src/integrations/insight-refresh.ts');
const { createV2Server } = await import('../apps/api/src/server.ts');
const { startModules } = await import('../apps/api/src/api-module.ts');
const { apiModules } = await import('../apps/api/src/api-modules.ts');
const { outboxModule } = await import('../apps/api/src/outbox-module.ts');
const { createRoutineDemoAgent } = await import('./demo-routines-model.ts');
type AppDeps = import('../apps/api/src/app-deps.ts').AppDeps;

const fixture = await acquireDatabase();
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(fixture.url).hostname)) throw new Error('demo_requires_loopback_database');
process.env.BOB_DATABASE_URL = fixture.url;
const pg = new PgTestDb(fixture.url, fixture.database);
const db = asDb(pg);
setSharedDb(Promise.resolve(db));
await addAccount(pg, { id: DEV_ACCOUNT_ID });
const account = await addGoogleAccount(db, DEV_ACCOUNT_ID, { installationId: randomUUID(), accountId: 'synthetic-account', email: 'morning@example.test', name: 'Fictional morning account', connectSubject: `gc_${'d'.repeat(43)}` });
await withUser(db, DEV_ACCOUNT_ID, (tx) => tx.query("update bob.google_accounts set authorization_capabilities=array['gmail.read','calendar.read'] where id=$1", [account.id]));

const { ensurePrivateSpace } = await import('../apps/api/src/spaces/store.ts');
const { createTask } = await import('../apps/api/src/tasks/store.ts');
const demoSpace = await ensurePrivateSpace(db, DEV_ACCOUNT_ID);
await createTask(db, DEV_ACCOUNT_ID, demoSpace.id, { title: 'Synthetic timeline task: review the draft' });

const capabilities: NonNullable<AppDeps['googleConnection']>['capabilities'] = async (owner, id, signal) => {
  signal?.throwIfAborted();
  if (owner !== DEV_ACCOUNT_ID || id !== account.id || !await getGoogleAccount(db, owner, id)) throw new Error('demo_account_unavailable');
  return ['gmail.read', 'calendar.read'];
};
const unavailable = async (): Promise<never> => { throw new Error('not_available_in_synthetic_demo'); };
const connection: NonNullable<AppDeps['googleConnection']> = { capabilities, authorize: unavailable, complete: unavailable, revoke: unavailable, resolve: unavailable };

// Each searched interval gets its own fictional messages inside that interval.
let mailTime = Date.now();
const digest = createRoutineDigest({ gmail: {
  search: async (_owner, _account, input) => {
    const before = /before:(\d+)/.exec(input.query)?.[1];
    mailTime = Number(before) * 1000 - 60_000;
    return { threads: [{ id: 'demo_project', snippet: 'Fictional project update' }, { id: 'demo_lunch', snippet: 'Fictional lunch plan' }] };
  },
  readThread: async (_owner, _account, id) => ({ id, truncated: false, messages: [{ id: `${id}_${mailTime}`, threadId: id, internalDate: mailTime,
    date: new Date(mailTime).toISOString(), subject: id === 'demo_project' ? 'Project ready for review' : 'Lunch with the team', from: 'friend@example.test',
    text: id === 'demo_project' ? 'The draft is ready for your review tomorrow.' : 'Lunch is at noon. Bring your favourite story.', textAvailable: true, truncated: false }] }),
}, summarize: async ({ messages }) => ({ summary: `Synthetic demo summary: ${messages.length} emails.

## Highlights
- The project draft is ready for review tomorrow.
- The team has planned lunch at noon.

## Needs your attention
- Review the draft before tomorrow.`, messageIds: messages.map(message => message.messageId) }) });

const calendar: Parameters<typeof createInsightRefresh>[0]['calendar'] = {
  listEvents: async (_owner, _account, _calendar, input) => {
    const start = Date.parse(input.timeMin) + 86400000;
    return { items: [0, 1].map((index) => ({ id: `demo-event-${index}`, etag: `demo-${index}`, summary: index === 0 ? 'Review the project draft' : 'Team lunch', status: 'confirmed',
      start: { dateTime: new Date(start + index * 1800000).toISOString() }, end: { dateTime: new Date(start + index * 1800000 + 3600000).toISOString() } })) };
  },
};
const deps = createAppDeps({ googleConnection: connection, routineDigest: digest,
  googleTools: async context => ({
    ...await createRoutineTools({ ...context, db, getVerifiedCapabilities: capabilities }),
    ...await createGoogleTools({ ...context, db, getVerifiedCapabilities: capabilities,
      gmail: {
        search: async (owner, id) => {
          if (owner !== DEV_ACCOUNT_ID || id !== account.id) throw new Error('demo_wrong_mentioned_account');
          return { threads: [{ id: 'demo_job_update', snippet: 'Synthetic job update: interview invitation.' }] };
        }, readThread: unavailable, createReplyDraft: unavailable, reconcileReplyDraft: unavailable,
      },
      calendar: { listCalendars: unavailable, listEvents: unavailable, createEvent: unavailable, updateEvent: unavailable },
    }),
  }),
  insightRefresh: createInsightRefresh({ calendar, selectedCalendars: async () => ['demo-calendar'], history: async (owner, id) => listRoutineResults(db, owner, id) }),
});
deps.agent = createRoutineDemoAgent(account.id);
deps.turn.agent = deps.agent;

async function waitForHistory(routineId: string, count: number): Promise<void> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if ((await listRoutineRuns(db, DEV_ACCOUNT_ID, routineId)).filter(run => run.status === 'completed').length >= count) return;
    await new Promise<void>(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error('demo_history_queue_timeout');
}

// Build historical evidence through the real queue before the ordinary live
// scheduler starts. The only accelerated clocks are explicit dispatcher inputs.
const queue = createRoutineJobQueue({ connectionString: fixture.url, handle: createRoutineRunner({ db, digest,
  verifyConsent: async (owner, id, signal) => { await capabilities(owner, id, signal); } }) });
await queue.start();
deps.routineJobs = queue;
const stopOutbox = await outboxModule.start?.(deps);
const historical = await createRoutine(db, DEV_ACCOUNT_ID, { kind: 'daily_gmail_digest', googleAccountId: account.id, localTime: '07:30', timeZone: 'UTC', scheduledReadConsent: true }, Date.now() - 3 * 86400000);
if (historical.nextRunAt === null) throw new Error('demo_missing_next_run');
await dispatchRoutines(db, historical.nextRunAt);
await waitForHistory(historical.id, 1);
await dispatchRoutines(db, historical.nextRunAt + 86400000);
await waitForHistory(historical.id, 2);
await updateRoutine(db, DEV_ACCOUNT_ID, historical.id, { expectedRevision: historical.revision, status: 'paused' }, Date.now());
await stopOutbox?.();
await queue.stop();
delete deps.routineJobs;

const { server } = await createV2Server(deps);
await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(7488, '127.0.0.1', resolveListen); });
const stop = await startModules(apiModules, deps);
const output = resolve('data/routines-demo');
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, 'info.json'), JSON.stringify({ synthetic: true, api: 'http://127.0.0.1:7488', ui: 'http://127.0.0.1:5188', accountId: account.id, owner: DEV_ACCOUNT_ID, historicalRoutineId: historical.id }, null, 2));
console.log('Synthetic routines demo ready on API 7488. Real Postgres/outbox/pg-boss; fictional Google data and scripted model.');
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await stop();
  server.closeAllConnections();
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  await pg.close();
  process.exit(0);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
