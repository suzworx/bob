import { httpDiagnostics } from './platform/observability/http-diagnostics.ts';
import { createHttpRouteInventory, type HttpRouteInventory } from './platform/observability/http-route-inventory.ts';
import { anonymousTelemetryRoute } from './platform/observability/telemetry.ts';
/**
 * Composition root for the API process: builds AppDeps once, installs the
 * cross-cutting middleware (CORS, rate limit, auth guard, body parser), mounts
 * the feature modules (api-modules.ts) and the device socket, and starts their
 * background work once listening. Session state lives in session.ts, the turn
 * pipeline in turn/, each feature's routes in its own web-*.ts.
 * Exports createV2Server and startV2Server.
 */
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { WebSocketExpress } from 'websocket-express';
import express, { type ErrorRequestHandler } from 'express';
import { createAppDeps, type AppDeps } from './app-deps.ts';
import { apiModules } from './api-modules.ts';
import { mountModules, startModules } from './api-module.ts';
import { deviceSocketModule } from './voice/device-socket.ts';
import { type MemoryExtractionWorker } from './memory/extract.ts';
import { DEFAULT_DEBUG_PATH, DEFAULT_JOURNAL_PATH, moduleJournal } from './platform/logger.ts';
import { V2_PATH } from './voice/protocol.ts';
import { bootChecks } from './startup.ts';
import { installShutdownHandler } from './shutdown.ts';
import { createTestTokenHandler, isLoopbackHost, publicConfigHandler, resolveWebAuth } from './account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession, isWebSessionActive } from './platform/http/auth-guard.ts';
import { createFirmwareRouter } from './firmware/http.ts';
import { createOperatorFirmwareRouter } from './firmware/operator-http.ts';
import { createScopeChecker, OPERATOR_SCOPE, parseOperatorIds, requireScope } from './platform/observability/operator-gate.ts';
import { createCorsMiddleware, parseAllowedOrigins } from './platform/http/cors.ts';
import { createApiRateLimitMiddleware } from './platform/http/rate-limit.ts';
import { createStaticUiHandler, resolveUiDist, staticUiRouteTemplate } from './platform/http/static-ui.ts';
import { webErrorHandler } from './platform/http/errors.ts';
import { readActiveConversationId } from './conversations/active.ts';
import { setActiveConversationReader } from './platform/observability/conversation-correlation.ts';
import { createHealthRoute } from './web-health.ts';
import { createVersionRouter } from './web-version.ts';
import { createGoogleNativeReturnRouter } from './integrations/google-native-http.ts';
import { MAX_MESSAGE_ATTACHMENT_BYTES } from './web-schemas.ts';
import { mountApiDocs, type ApiOverrides } from './platform/http/api-docs.ts';
import { webApiDocOverrides } from './web-api-docs.ts';
import { webApiResponseDocOverrides } from './web-api-response-docs.ts';

const journal = moduleJournal('server');


/**
 * The address the server binds. Shared by the listener and the `/api/*`
 * mounting rule so the two can never disagree about whether the socket is
 * reachable off this machine.
 */
export function resolveBindHost(): string {
  return process.env.BOB_V2_HOST ?? '0.0.0.0';
}

/** Builds the WebSocketExpress app with /health and the v2 cardputer route.
 *  Async since T011: the /api/* verifier may be a boot-time local key pair
 *  (BOB_SYSTEM_TEST=1) whose generation is asynchronous. */
export async function createV2Server(deps: AppDeps = createAppDeps()): Promise<{ app: WebSocketExpress; server: Server; memoryWorker: MemoryExtractionWorker; httpRoutes: HttpRouteInventory }> {
  const { getDb } = deps;
  const app = new WebSocketExpress();
  const uiDist = resolveUiDist();
  const httpRoutes = createHttpRouteInventory(app, (method, path) => uiDist ? staticUiRouteTemplate(method, path) ?? 'unmatched' : 'unmatched');
  app.disable('x-powered-by');
  // Telemetry reads a user's active conversation (cached) to label requests and background work with it.
  setActiveConversationReader(async (userId) => readActiveConversationId(await getDb(), userId));
  app.use(httpDiagnostics(httpRoutes));
  const bindHost = resolveBindHost();
  // Web auth (T011): the JWT guard is ALWAYS mounted on /api/* (web-auth.md
  // "Production gate matrix" last row) — the BOB_WEB_TOKEN guard and the
  // loopback no-token mount rule are gone. public-config is unauthenticated
  // and mounts before the guard; test-token exists only on a loopback bind
  // with BOB_SYSTEM_TEST=1 and answers 404 otherwise.
  const webAuth = await resolveWebAuth();
  // CORS: exact-match allow-list (default empty: no cross-origin access).
  app.use('/api', createCorsMiddleware(parseAllowedOrigins()));
  // Rate-limit every /api/* request before authentication so a public
  // deployment can absorb bursts without the cost of running the guard.
  app.use('/api', createApiRateLimitMiddleware());
  // Restricted pre-auth actions have their own bounded DTO and global/IP budget.
  app.post('/api/telemetry/anonymous', express.json({ limit: 16 * 1024 }), anonymousTelemetryRoute);
  app.get('/api/public-config', publicConfigHandler);
  // Fixed native navigation relay only; linking endpoints stay behind JWT + active session.
  app.use(createGoogleNativeReturnRouter());
  // #350: which commit is live; unauthenticated like public-config, so the
  // post-deploy workflow can read it without a token.
  app.use('/api/version', createVersionRouter({ db: getDb }));
  if (isLoopbackHost(bindHost) && webAuth.testIssuer) {
    app.post('/api/test-token', express.json({ limit: 16 * 1024 }), createTestTokenHandler(webAuth.testIssuer, getDb));
  } else {
    app.post('/api/test-token', (_request, response) => { response.status(404).json({ error: { code: 'not_found' } }); });
  }
  app.use(
    '/api',
    createJwtWebAuthGuard(webAuth.verifier, [
      // GitHub issue correction (014): GET /api/invitations/:token is the
      // account-less invitation preview (web-spaces.ts, contracts/api.md
      // "Unauthenticated-safe preview") -- the one route an invited person who
      // is not yet a member, and may have no account at all, must be able to
      // reach from an email link. The blanket /api guard was rejecting it
      // before the route ever ran. Exempt ONLY this GET path: the trailing
      // "/^\/invitations\/[^/]+\/?$/" never matches
      // /api/invitations/:token/accept, which stays authenticated -- binding
      // an invitation to a real account must never be anonymous.
      { method: 'GET', pattern: /^\/invitations\/[^/]+\/?$/ },
    ], account => isWebSessionActive(getDb, account)),
  );
  // One parser serves every /api route, so its ceiling is the larger of the
  // two payloads a route may legitimately carry: base64 audio for /voice and
  // base64 attachments for /chat. Each route still enforces its own bound --
  // /voice with its 413 audio_too_large, /chat through web-schemas -- so the
  // ceiling only decides what is worth buffering, never what is accepted.
  const base64Ceiling = (bytes: number): number => Math.ceil(bytes / 3) * 4;
  const jsonLimit = Math.max(
    base64Ceiling(Number.parseInt(process.env.BOB_WEB_AUDIO_MAX_BYTES ?? '2097152', 10)) + 1024,
    base64Ceiling(MAX_MESSAGE_ATTACHMENT_BYTES) + 64 * 1024,
  );
  app.use('/api', express.json({ limit: jsonLimit }));
  // OTA: the image download authenticates with the device bearer itself (outside /api); the
  // operator controls sit behind the same gate as the other operator routes (api-modules.ts).
  app.use('/v2/firmware', createFirmwareRouter({ getDb }));
  const operatorIds = parseOperatorIds(process.env.BOB_OPERATOR_USER_IDS);
  const operatorScope = createScopeChecker(getDb);
  app.use(
    '/api/operator/firmware',
    requireScope(OPERATOR_SCOPE, async (userId) => operatorIds.has(userId.toLowerCase()) || operatorScope(userId)),
    requireActiveSession(getDb),
    createOperatorFirmwareRouter({ getDb }),
  );
  // The feature modules, in registration order (api-modules.ts).
  mountModules(apiModules, app, deps);
  const bodyErrorHandler: ErrorRequestHandler = (error, request, response, next) => {
    const bodyError = error as Error & { type?: string; status?: number };
    if (bodyError instanceof SyntaxError) { response.status(400).json({ error: { code: 'invalid_json' } }); return; }
    if (bodyError.type === 'entity.too.large' || bodyError.status === 413) {
      response.status(413).json({ error: { code: request.path === '/voice' ? 'audio_too_large' : 'invalid_request' } }); return;
    }
    next(error);
  };
  app.use('/api', bodyErrorHandler);
  // 014 (issue #152): the net under every /api route. The routers map their own
  // store errors (404/403/500 store_error); anything that escapes reaches this
  // wildcard and becomes a generic 500 -- never driver text, SQL, table or
  // constraint names, or a stack. Mounted after all /api routes and after the
  // body-error handler, which calls next(error) for anything it does not own.
  app.use('/api', webErrorHandler);
  const edgeDocument = JSON.parse(readFileSync(new URL('./web-edge-api-docs.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  const apiDocOverrides: ApiOverrides = { ...webApiResponseDocOverrides };
  for (const [key, override] of Object.entries(webApiDocOverrides)) apiDocOverrides[key] = { ...apiDocOverrides[key], ...override };
  mountApiDocs(app, httpRoutes, apiDocOverrides, edgeDocument);
  // ok/protocol/path as before, plus the schema version check (#349, web-health.ts).
  app.get('/health', createHealthRoute({ db: getDb }));
  // Serve the built ui-v2 client when present.
  if (uiDist) app.use(createStaticUiHandler(uiDist));
  // The device WebSocket, last: upgrade requests reach it after every HTTP route.
  mountModules([deviceSocketModule], app, deps);
  // Fail startup visibly if a registration cannot produce a safe route label.
  httpRoutes.routes();
  if (deps.memoryWorker === undefined) throw new Error('the memories module did not create the extraction worker');
  return { app, server: stopWorkerOnClose(app.createServer(), deps.memoryWorker), memoryWorker: deps.memoryWorker, httpRoutes };
}

/**
 * server.close() also stops the memory extraction worker this server created
 * (pending timers cancelled, in-flight runs drained) and calls back only after
 * that, so nothing the server started reaches the store once its caller has
 * closed the server and then the Db.
 */
function stopWorkerOnClose(server: Server, worker: MemoryExtractionWorker): Server {
  const close = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void): Server =>
    close((error) => {
      void worker.stop().catch(() => undefined).then(() => callback?.(error));
    });
  return server;
}

/** Opens the journal sink and starts the server on the configured port. */
export async function startV2Server(
  port = Number.parseInt(process.env.BOB_V2_PORT ?? '7444', 10),
  journalPath = process.env.BOB_V2_JOURNAL ?? DEFAULT_JOURNAL_PATH,
  debugPath = process.env.BOB_DEBUG_LOG ?? DEFAULT_DEBUG_PATH,
): Promise<Server> {
  bootChecks(port, journalPath, debugPath);
  const deps = createAppDeps();
  const { server } = await createV2Server(deps);
  const host = resolveBindHost();
  // Without this the listen failure surfaces as an unhandled 'error' event and
  // a raw stack trace that names the port but not the process holding it, nor
  // any way to free it. A startup failure should say what to do next.
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `\nPort ${port} is already in use, so the server cannot start.\n` +
          `A previous \`npm run dev\` is usually still holding it.\n\n` +
          `  npm run cleanup -- --dry   see what is holding Bob's ports\n` +
          `  npm run cleanup            release them\n`,
      );
      process.exit(1);
    }
    if (error.code === 'EACCES') {
      console.error(
        `\nPermission denied binding port ${port} on ${host}.\n` +
          `Ports below 1024 are privileged on this platform; set BOB_V2_PORT to a higher port,\n` +
          `or see "Privileged ports" in specs/001-real-agent-web-client/quickstart.md.\n`,
      );
      process.exit(1);
    }
    throw error;
  });
  server.listen(port, host, () => {
    journal('v2.listening', { port, host, path: V2_PATH, journal: journalPath });
  });
  // Background work (the extraction worker's startup scan, the timer scheduler)
  // starts with the listener and stops together inside the 1 s force-exit bound.
  const stop = await startModules(apiModules, deps);
  installShutdownHandler(undefined, undefined, undefined, { stop });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startV2Server();
