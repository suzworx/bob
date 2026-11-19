/**
 * The feature modules the server mounts, in registration order (issue #619).
 * The order is the route order: middleware and routes are matched as they were
 * registered, and tests/route-table.test.ts pins it. Each entry wraps an
 * existing router without moving its file; to add a feature, add one entry.
 * Cross-cutting middleware (CORS, rate limit, auth guard, body parser) and the
 * error handlers stay in server.ts around this list.
 */
import { ACCOUNT_ADMIN_SCOPE, createAdminRouter } from './account/admin-http.ts';
import type { WebSocketExpress } from 'websocket-express';
import { AI_STUB_MODE, createMemoryExtractor, createMemoryGate, memoryGateMode } from '@bob/ai';
import type { ApiModule } from './api-module.ts';
import type { AppDeps } from './app-deps.ts';
import { applyExtractionOps, matchMemories } from './memory/store.ts';
import { createMemoryExtractionWorker } from './memory/extract.ts';
import { listAccountsWithUnextracted, listUnextracted } from './memory/extract-queue.ts';
import { memoryAvailable } from './memory/available.ts';
import { moduleJournal } from './platform/logger.ts';
import { getAccountEvents } from './devices/pairing-service.ts';
import { requireActiveSession } from './platform/http/auth-guard.ts';
import type { Db } from './platform/db/db.ts';
import { createAccountRouter } from './account/http.ts';
import { createDevicesRouter } from './devices/http.ts';
import { createGoogleAccountsRouter } from './integrations/google-http.ts';
import { createGoogleNativeRouter } from './integrations/google-native-http.ts';
import { createGoogleCalendarRouter } from './integrations/google-calendar-http.ts';
import { createPairingRouter } from './devices/pairing-http.ts';
import { createUsageRouter } from './account/usage-http.ts';
import { createWebEventsRouter } from './account/events-http.ts';
import { approve, deny, lookupCode } from './devices/pairing-service.ts';
import { createActionItemsRouter } from './tasks/action-items-http.ts';
import { createCalendarsRouter } from './calendar/http.ts';
import { createApprovalRouter } from './conversations/approval-http.ts';
import { createNotesRouter } from './notes/http.ts';
import { createRemindersRouter } from './reminders/http.ts';
import { createTasksRouter } from './tasks/http.ts';
import { createTimersRouter } from './timers/http.ts';
import { activateConversationRoute, deleteConversationRoute, getActiveRoute, getConversationRoute, listConversationsRoute, renameConversationRoute } from './conversations/http.ts';
import { createInvocationsRouter } from './conversations/invocations-http.ts';
import { createSearchRouter } from './conversations/search-http.ts';
import { deleteMessagesFromRoute, markReplyInterruptedRoute } from './conversations/messages-http.ts';
import { webChat, webChatStop } from './conversations/chat-http.ts';
import { createExportRouter } from './account/export-http.ts';
import { createMemoriesRouter } from './memory/http.ts';
import { createNotificationsRouter } from './notifications/http.ts';
import { createPushRouter } from './notifications/push-http.ts';
import { createPublicationRouter } from './spaces/publication-http.ts';
import { createGroupChatsRouter } from './spaces/group-chat-http.ts';
import { createSpacesRouter } from './spaces/http.ts';
import { createScopeChecker, OPERATOR_SCOPE, parseOperatorIds, requireScope } from './platform/observability/operator-gate.ts';
import { createOperatorMetricsRouter } from './platform/observability/operator-metrics.ts';
import { telemetryRoute } from './platform/observability/telemetry.ts';
import { createThreadsRouter } from './spaces/threads-http.ts';
import { webSpeech, webVoice } from './voice/http.ts';
import { timerSchedulerModule } from './workflows/workflow-timer-ring.ts';
import { outboxModule } from './outbox-module.ts';
import { routineModule } from './routine-module.ts';
import { createRoutineRouter, createInsightsRouter } from './routines/http.ts';
import { createTimelineRouter } from './timeline/http.ts';
import { createToolsRouter } from './tools/http.ts';
import { createMarketingRouter } from './bob-apps/marketing-http.ts';
import { createMarketingCampaignRouter } from './bob-apps/marketing-campaign-http.ts';
import { createMarketingConfigRouter } from './bob-apps/marketing-config-http.ts';
import { openAppConversation } from './workflows/workflow-app-conversation.ts';
import { createBobAppsRouter } from './bob-apps/http.ts';
import { createBobAppRefreshRouter } from './bob-apps/refresh-http.ts';

const journal = moduleJournal('server');

/** A module that only mounts routes. */
const routes = (name: string, mount: (app: WebSocketExpress, deps: AppDeps) => void): ApiModule => ({ name, mount });

/** T016/T012: the memory extraction worker and the account's memories router. */
const memoriesModule: ApiModule = {
  name: 'memories',
  mount(app, deps) {
    // PATCH re-embeds corrected content through the gateway embedder (§Re-embedding
    // on correction); the embedder handle is built once at server creation.
    const memoryEmbedder = deps.embedder();
    // T012: one background extraction worker for the whole process, built with
    // the real extractor and embedder and the store functions, and threaded to
    // the turn paths through `deps.memoryWorker` (no module-global singleton). It
    // is inert here: enqueue/scanUnprocessed check memoryAvailable and do nothing
    // when memory is off. The worker's db resolves lazily through deps.getDb() so
    // creating the server never touches the store (production boot, tests).
    const lazyDb = new Proxy({} as Db, {
      get(_target, prop: string | symbol) {
        if (prop === 'then') return undefined;
        return (...args: unknown[]) => deps.getDb().then((real) => {
          const fn = (real as unknown as Record<PropertyKey, unknown>)[prop];
          if (typeof fn !== 'function') {
            throw new Error(`store.${String(prop)} is not a function`);
          }
          return (fn as (...a: unknown[]) => unknown).apply(real, args);
        });
      },
    });
    deps.memoryWorker = createMemoryExtractionWorker({
      db: lazyDb,
      extractor: createMemoryExtractor(),
      embedder: memoryEmbedder,
      listUnextracted,
      listAccounts: listAccountsWithUnextracted,
      matchMemories,
      applyExtractionOps,
      // Inert under AI_STUB_MODE. This worker's whole job is running a language
      // model over finished turns, and stub mode promises no real AI calls -- but
      // it was only ever switched off by memoryAvailable, so wherever memory WAS
      // available (dev:offline against local Supabase, which has `vector`) stub
      // mode still called the AI Gateway: three retried round-trips per turn.
      // Reporting memory as unavailable to the worker alone uses the off-switch
      // it already honours; memory retrieval and the rest are unaffected.
      memoryAvailable: AI_STUB_MODE ? () => Promise.resolve(false) : memoryAvailable,
      ...(memoryGateMode() === 'off' ? {} : { memoryGate: { score: createMemoryGate(), enforce: memoryGateMode() === 'on' } }),
      clock: Date.now,
      journal,
    });
    // DELETE /api/memories (delete-all) runs requireActiveSession inside the
    // router (plan §D); the rest sit under the JWT guard.
    app.use(
      '/api/memories',
      createMemoriesRouter({
        getDb: deps.getDb,
        embed: async (content) => {
          const values = await memoryEmbedder.embed(content);
          return { values, model: memoryEmbedder.modelId, dim: memoryEmbedder.dim };
        },
        requireActiveSession: requireActiveSession(deps.getDb),
      }),
    );
  },
  async start(deps) {
    const worker = deps.memoryWorker;
    if (worker === undefined) return async (): Promise<void> => undefined;
    // T012: the startup scan for unextracted messages runs after listen,
    // non-blocking. In environments where the accounts_with_unextracted
    // helper is absent (a database behind the migrations) it finds nothing and
    // returns an empty list without throwing -- leave that alone.
    void worker.scanUnprocessed().catch(() => undefined);
    return () => worker.stop();
  },
};

/** The feature modules, in the order their routes are registered. */
export const apiModules: readonly ApiModule[] = [
  routes('bob-apps', (app, deps) => {
    app.use('/api/bob-apps', createMarketingRouter({ getDb: deps.getDb }));
    app.use('/api/bob-apps', createMarketingCampaignRouter({ getDb: deps.getDb }));
    app.use('/api/bob-apps/marketing', createMarketingConfigRouter({ getDb: deps.getDb }));
    app.use('/api/bob-apps', createBobAppsRouter({ getDb: deps.getDb, openAppConversation: async (actor, appId) => openAppConversation(await deps.getDb(), actor, appId) }));
    app.use('/api/bob-apps', createBobAppRefreshRouter({ getDb: deps.getDb }));
  }),
  routes('timeline', (app, deps) => { app.use('/api/timeline', createTimelineRouter(deps)); }),
  routes('tools', (app, deps) => { app.use('/api/tools', createToolsRouter(deps)); }),
  routes('chat', (app, deps) => {
    app.post('/api/chat', webChat(deps));
    // #466: an explicit Stop; closing the tab no longer cancels a turn.
    app.post('/api/chat/stop', webChatStop);
  }),
  routes('conversations', (app, deps) => {
    app.get('/api/conversations', listConversationsRoute(deps));
    app.get('/api/conversations/:id', getConversationRoute(deps));
    app.patch('/api/conversations/:id', renameConversationRoute(deps));
    app.delete('/api/conversations/:id', deleteConversationRoute(deps));
    // T028 follow-me routes: the pointer read and the "continue on device"
    // pointer write. Both sit under the JWT guard; neither is one of the four
    // requireActiveSession actions (plan §C).
    app.get('/api/active', getActiveRoute(deps));
    app.post('/api/conversations/:id/activate', activateConversationRoute(deps));
  }),
  routes('messages', (app, deps) => {
    // 013 R6 (S13): the heard-portion PATCH, under the JWT guard with the other
    // conversation routes.
    app.patch('/api/conversations/:id/messages/:messageId', markReplyInterruptedRoute(deps));
    // CU-CHAT-4 (G20): "delete from here" -- a user message and everything after it.
    app.delete('/api/conversations/:id/messages/:messageId', deleteMessagesFromRoute(deps));
  }),
  // 013 R8 (S13): metadata-only telemetry ingestion, under the JWT guard with
  // the same /api rate limiting as every other route.
  routes('telemetry', (app) => { app.post('/api/telemetry', telemetryRoute); }),
  routes('voice', (app, deps) => {
    app.post('/api/voice', webVoice(deps));
    app.post('/api/speech', webSpeech(deps));
  }),
  // T019's pairing router (approve and deny additionally run requireActiveSession inside it).
  routes('pairing', (app, deps) => {
    app.use('/api/pair', createPairingRouter({ getDb: deps.getDb, pairing: { lookupCode, approve, deny }, requireActiveSession: requireActiveSession(deps.getDb) }));
  }),
  // T033: the account's devices; DELETE additionally runs requireActiveSession
  // inside the router and closes the live device socket with WS code 4003.
  routes('devices', (app, deps) => {
    app.use('/api/devices', createDevicesRouter({
      getDb: deps.getDb,
      requireActiveSession: requireActiveSession(deps.getDb),
      events: getAccountEvents(),
      deviceSessions: deps.deviceSessions,
    }));
  }),
  // T029: the account event stream, opened under requireActiveSession.
  routes('events', (app, deps) => {
    app.use('/api/events', createWebEventsRouter({ getDb: deps.getDb, events: getAccountEvents() }));
  }),
  memoriesModule,
  routes('action-items', (app, deps) => { app.use('/api/action-items', createActionItemsRouter({ getDb: deps.getDb })); }),
  routes('google-accounts', (app, deps) => {
    app.use('/api/google-accounts/native', createGoogleNativeRouter({ getDb: deps.getDb, connection: deps.googleConnection?.native }));
    app.use('/api/google-accounts', createGoogleAccountsRouter({ getDb: deps.getDb, connection: deps.googleConnection }));
    if (deps.googleAgenda) app.use('/api/google-accounts', createGoogleCalendarRouter({ service: deps.googleAgenda }));
  }),
  routes('routine-routes', (app, deps) => {
    app.use('/api/routines', createRoutineRouter({ getDb: deps.getDb, connection: deps.googleConnection }));
    app.use('/api/insights', createInsightsRouter({ getDb: deps.getDb, connection: deps.googleConnection, refresh: deps.insightRefresh }));
  }),
  // 014 spaces/threads/tasks/calendars (S14): mounted under the /api JWT guard
  // with the same rate limiting and body parsing as every other account router.
  // Each router's internal paths are distinct at /api, so all mount at the guard
  // root. Spaces' DELETE (archive) and PUT .../owner (ownership transfer)
  // additionally run requireActiveSession inside the router: both are durable,
  // account-level actions that must not survive a revoked session's token.
  routes('spaces', (app, deps) => { app.use('/api', createSpacesRouter({ getDb: deps.getDb, requireActiveSession: requireActiveSession(deps.getDb) })); }),
  routes('group-chats', (app, deps) => { app.use('/api', createGroupChatsRouter({ getDb: deps.getDb, events: deps.turn.accountEvents(), requireActiveSession: requireActiveSession(deps.getDb) })); }),
  routes('threads', (app, deps) => { app.use('/api', createThreadsRouter({ getDb: deps.getDb, events: deps.turn.accountEvents() })); }),
  routes('tasks', (app, deps) => { app.use('/api', createTasksRouter({ getDb: deps.getDb })); }),
  routes('reminders', (app, deps) => { app.use('/api', createRemindersRouter({ getDb: deps.getDb })); }),
  // #457: the caller's running timers and alarms; a cancel re-arms the scheduler.
  routes('timers', (app, deps) => { app.use('/api', createTimersRouter({ getDb: deps.getDb, onChange: deps.timersChanged })); }),
  routes('calendars', (app, deps) => { app.use('/api', createCalendarsRouter({ getDb: deps.getDb, projectGoogleAgenda: deps.googleAgenda?.project })); }),
  // 014 invocations (S14-T009): the explicit "ask Bob in a thread" route; run
  // defaults to the real invocation runner.
  routes('invocations', (app, deps) => { app.use('/api', createInvocationsRouter({ getDb: deps.getDb, agent: deps.agent, events: deps.turn.accountEvents(), appTurnTools: deps.appTurnTools })); }),
  routes('notes', (app, deps) => { app.use('/api', createNotesRouter({ getDb: deps.getDb })); }),
  // Ask Bob proposals (#1191): create, read, approve, decline. No step executors are wired yet, so
  // approving a proposal in production records a failed outcome until the actions are connected.
  routes('approvals', (app, deps) => { app.use('/api', createApprovalRouter({ getDb: deps.getDb, executors: {} })); }),
  // 014 publication (issue #142): publish a private note copy into a space and
  // promote a remembered action into a task; works with memory unavailable.
  routes('publication', (app, deps) => { app.use('/api', createPublicationRouter({ getDb: deps.getDb })); }),
  // 014 notifications (S14-INBOX-API): the durable inbox and per-type preferences.
  routes('notifications', (app, deps) => { app.use('/api', createNotificationsRouter({ getDb: deps.getDb })); }),
  routes('push', (app, deps) => { app.use('/api', createPushRouter({ getDb: deps.getDb })); }),
  // G6 (issue #143) self-service account deletion, then #514 the account export
  // download. Both run requireActiveSession inside their routers.
  routes('account', (app, deps) => {
    app.use('/api/account', createAccountRouter({
      getDb: deps.getDb,
      googleConnection: deps.googleConnection,
      requireActiveSession: requireActiveSession(deps.getDb),
      deviceSessions: deps.deviceSessions,
    }));
    app.use('/api/account', createExportRouter({ getDb: deps.getDb, requireActiveSession: requireActiveSession(deps.getDb) }));
  }),
  // 014 search (CU-SEARCH-1): scoped search across tasks, notes, events and
  // threads; authorization lives in the query (RLS), so an inaccessible space
  // answers an empty list, never a 403.
  routes('search', (app, deps) => { app.use('/api', createSearchRouter({ getDb: deps.getDb })); }),
  // ANL-U1: the signed-in user's own usage, counts and times only.
  routes('usage', (app, deps) => { app.use('/api/me', createUsageRouter({ getDb: deps.getDb })); }),
  routes('admin', (app, deps) => {
    app.use('/api/admin', createAdminRouter({
      getDb: deps.getDb,
      requireActiveSession: requireActiveSession(deps.getDb),
      checkAccess: createScopeChecker(deps.getDb, { scope: ACCOUNT_ADMIN_SCOPE, ttlMs: 0 }),
    }));
  }),
  // Aggregate monitoring accepts metrics.operator or accounts.admin; firmware remains separate.
  routes('operator', (app, deps) => {
    const ids = parseOperatorIds(process.env.BOB_OPERATOR_USER_IDS);
    const scopeChecker = createScopeChecker(deps.getDb);
    const adminChecker = createScopeChecker(deps.getDb, { scope: ACCOUNT_ADMIN_SCOPE, ttlMs: 0 });
    const allowed = async (userId: string): Promise<boolean> => ids.has(userId.toLowerCase()) || await scopeChecker(userId) || await adminChecker(userId);
    app.use('/api/operator', requireScope(OPERATOR_SCOPE, allowed), requireActiveSession(deps.getDb), createOperatorMetricsRouter({ getDb: deps.getDb }));
  }),
  timerSchedulerModule,
  routineModule,
  // Reminder fanout + outbox drain (email): production runs only this process.
  outboxModule,
];
