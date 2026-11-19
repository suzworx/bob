import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { isWebSocket } from 'websocket-express';
import {
  bindDiagnosticContext, currentDiagnosticTraceId, recordObservationMetrics, traceSpan, type MetricAttributes,
  updateActiveSpanMetadata, withDiagnosticContextObserver,
} from '@bob/ai';
import type { HttpRouteInventory } from './http-route-inventory.ts';

// These handlers establish a deterministic business workflow after validation.
// A random HTTP parent would override it and break browser/voice correlation.
const WORKFLOW_ROUTES = new Set([
  'POST /api/chat', 'POST /api/voice', 'POST /api/speech', 'POST /api/threads/:id/invocations',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** The edge proxy forwards a W3C `traceparent`; only a well-formed one with non-zero ids is trusted. */
function edgeTrace(request: Request): { traceparent: string; traceId: string } | undefined {
  const traceparent = request.get('traceparent');
  const match = traceparent === undefined ? null : TRACEPARENT.exec(traceparent);
  const traceId = match?.[1];
  const spanId = match?.[2];
  if (traceparent === undefined || traceId === undefined || spanId === undefined) return undefined;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { traceparent, traceId };
}

/** A request header that is a UUID, lower-cased; anything else is ignored. */
function uuidHeader(request: Request, header: string): string | undefined {
  const value = request.get(header);
  return value !== undefined && UUID.test(value) ? value.toLowerCase() : undefined;
}

/** The per-tab client session id. */
export function clientSessionId(request: Request): string | undefined {
  return uuidHeader(request, 'X-Bob-Client-Session');
}

function uiCorrelation(request: Request): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [header, key] of [['X-Bob-Ui-Action-Id', 'ui_action_id'], ['X-Bob-Ui-Request-Id', 'ui_request_id']] as const) {
    const value = uuidHeader(request, header);
    if (value !== undefined) metadata[key] = value;
  }
  return metadata;
}

/** A server-sent event stream (`/api/events`): open for minutes, closed by the client as its normal end. */
function isEventStream(response: Response): boolean {
  return String(response.getHeader('Content-Type') ?? '').startsWith('text/event-stream');
}

/**
 * The terminal facts of one response. Flags: `failed` = a 5xx, or the client abandoning a request before its
 * response finished; `client_error` = 4xx (the caller's error, not a server failure); `server_error` = 5xx.
 * An event stream is neither latency nor failure: its lifetime goes to `http.request.stream_ms`, outcome `closed`.
 */
function completion(response: Response, duration: number, route: string): { metadata: Record<string, string>; metrics: Parameters<typeof recordObservationMetrics>[0] } {
  const stream = isEventStream(response);
  const aborted = !stream && !response.writableFinished;
  const status = response.statusCode;
  const statusClass = `${Math.floor(status / 100)}xx` as NonNullable<MetricAttributes['status_class']>;
  const outcome: NonNullable<MetricAttributes['outcome']> = stream ? 'closed' : aborted ? 'aborted' : status >= 400 ? 'error' : 'ok';
  // Labels go on the latency histogram only: the 0/1 flags stay unlabelled so every event counts from 0.
  const attributes: MetricAttributes = { route, status_class: statusClass, outcome };
  return {
    metadata: { http_status: String(status), http_status_class: statusClass, outcome, duration_ms: String(duration) },
    metrics: [
      ...(duration <= 604_800_000 ? [{ name: stream ? 'http.request.stream_ms' as const : 'http.request.duration_ms' as const, value: duration, attributes }] : []),
      { name: 'http.request.failed', value: Number(aborted || (!stream && status >= 500)) },
      { name: 'http.request.aborted', value: Number(aborted) },
      { name: 'http.request.client_error', value: Number(!aborted && status >= 400 && status < 500) },
      { name: 'http.request.server_error', value: Number(!aborted && status >= 500) },
    ],
  };
}

/** Capture a workflow even when its service returns before the route writes
 * headers. The header hook also handles an externally managed streaming scope.
 * Neither hook starts an extra workflow or changes a deterministic trace id.
 */
function observeWorkflowCompletion(response: Response, record: () => void, next: NextFunction): void {
  let bound = record;
  let captured = false;
  const capture = (): void => {
    if (captured) return;
    captured = true;
    bound = bindDiagnosticContext(record);
  };
  const writeHead = response.writeHead;
  response.writeHead = function diagnosticWriteHead(this: Response, ...args: Parameters<Response['writeHead']>): Response {
    capture();
    response.writeHead = writeHead;
    return writeHead.apply(this, args);
  } as Response['writeHead'];
  response.once('finish', () => bound());
  response.once('close', () => bound());
  withDiagnosticContextObserver(capture, next);
}

/** Every HTTP response is observed exactly once, including early guards,
 * parser failures, unknown routes and streams. Generic handlers execute in an
 * active request span. Existing deterministic workflow handlers own their root;
 * their complete HTTP lifetime is recorded as a backdated workflow child.
 */
export function httpDiagnostics(inventory: HttpRouteInventory, clock: () => number = () => performance.now()): RequestHandler {
  return function diagnoseHttp(request, response, next): void {
    if (isWebSocket(response)) { next(); return; }
    const startTime = new Date();
    const started = clock();
    const route = inventory.resolve(request.method, request.path);
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(request.method) ? request.method : 'OTHER';
    const name = `http ${method} ${route}`;
    const edge = edgeTrace(request);
    const metadata = { route_template: route, http_method: method, ...uiCorrelation(request) };
    // The per-tab client session is known before auth; it labels the root without seeding its trace.
    const sessionId = clientSessionId(request);
    const client = sessionId === undefined ? {} : { sessionId };
    let recorded = false;
    let terminal: ReturnType<typeof completion> | undefined;
    const markComplete = (): void => { terminal ??= completion(response, Math.max(0, Math.round(clock() - started)), route); };
    // A client can close while the SDK resolves a workflow ID asynchronously.
    // Capture the terminal fact immediately, then report it in the opened scope.
    response.once('finish', markComplete);
    response.once('close', markComplete);
    const finish = (run: (result: ReturnType<typeof completion>) => void): void => {
      if (recorded) return;
      recorded = true;
      run(terminal ?? completion(response, Math.max(0, Math.round(clock() - started)), route));
    };
    if (WORKFLOW_ROUTES.has(`${method} ${route}`)) {
      observeWorkflowCompletion(response, () => finish((result) => {
        void traceSpan(name, {
          startTime, metadata: { ...metadata, ...result.metadata, ...(edge ? { edge_trace_id: edge.traceId } : {}) }, ...client,
        }, () => recordObservationMetrics(result.metrics)).catch(() => undefined);
      }), next);
      return;
    }
    let forwarded = false;
    const root = edge ? { traceparent: edge.traceparent } : { workflowNamespace: 'http-request', workflowId: randomUUID() };
    void traceSpan(name, { startTime, metadata, ...root, ...client }, () => new Promise<void>((resolve) => {
      const complete = bindDiagnosticContext(() => finish((result) => {
        updateActiveSpanMetadata(result.metadata);
        recordObservationMetrics(result.metrics);
        resolve();
      }));
      response.once('finish', complete);
      response.once('close', complete);
      if (terminal) complete();
      const traceId = currentDiagnosticTraceId();
      if (traceId && !response.headersSent && !response.hasHeader('X-Bob-Trace-Id')) response.setHeader('X-Bob-Trace-Id', traceId);
      forwarded = true;
      next();
    })).catch(() => {
      // Even a broken telemetry adapter must never block or replay a handler.
      if (!forwarded) next();
    });
  };
}
