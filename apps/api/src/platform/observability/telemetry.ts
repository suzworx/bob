/**
 * POST /api/telemetry: metadata-only ingestion for
 * browser-side facts no existing route measures -- end-of-speech to first
 * audible audio, barge-in reaction time, false triggers, and mode-state
 * changes, navigation, interactions, render commits and requests. Accepted
 * events are journaled; UI events also become trace spans, bounded
 * by an account budget of 120 events refilling at two events per second.
 * `reply_feedback` and a `turn_timing` trace id attach a metric signal to the
 * server trace that produced the reply.
 * Browser durations are explicit metadata, not the ingestion span duration.
 * Only bounded numbers, enums and a view UUID are accepted: no audio, text,
 * form values, selectors, URLs, credentials or request/response payloads.
 */
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { recordObservationMetrics, type ObservationMetricSample, recordTraceSignal, toSpanAttrs, traceSpan } from '@bob/ai';
import type { z } from 'zod';
import { AnonymousTelemetryRequestSchema, TelemetryRequestSchema } from './schemas.ts';
import { type Journal, type JournalFields, moduleJournal } from '../logger.ts';
import { clientIp, createTokenBucket, hashIp } from '../http/rate-limit.ts';
import { sendError } from '../http/route.ts';
import { requestCorrelation } from './conversation-correlation.ts';

/** Browser `area` (preferred) or `page` to the server module that owns the surface. */
const WEB_MODULES: Record<string, string> = {
  chat: 'conversations', conversations: 'conversations', spaces: 'spaces', calendar: 'calendar', memory: 'memory',
  devices: 'devices', pair: 'devices', account: 'account', usage: 'account', signin: 'account', reset: 'account',
  invite: 'account', metrics: 'platform', gmail: 'google', connectors: 'google', voice: 'voice',
  productivity: 'tasks', notifications: 'notifications',
};

/** Page-less events, by event name: reply feedback rates a chat reply; the rest are voice-mode timings and states. */
const EVENT_MODULES: Record<string, string> = {
  reply_feedback: 'conversations', turn_timing: 'voice', barge_in: 'voice', false_trigger: 'voice',
  mode_state: 'voice', mode_off: 'voice',
};

/** The v2.web_telemetry journal, tagged source `web` and the module the event's area/page/name maps to (`other` when unknown). */
function webJournal(event: object): Journal {
  const { area, page, event: name } = event as { area?: string; page?: string; event?: string };
  return moduleJournal(WEB_MODULES[area ?? ''] ?? WEB_MODULES[page ?? ''] ?? EVENT_MODULES[name ?? ''] ?? 'other', 'web');
}

// The shared token bucket bounds tracked accounts at 10,000. Excess UI events
// are silently dropped so telemetry cannot consume the voice event budget.
const uiEventBudget = createTokenBucket(120);
// Window counters have their own bounded budget so detail saturation does not hide loss.
const uiWindowBudget = createTokenBucket(30);
const anonymousRequestBudget = createTokenBucket(20);
const anonymousGlobalRequests = createTokenBucket(120);
const anonymousEventBudget = createTokenBucket(120);
const anonymousGlobalEvents = createTokenBucket(1200);
type TelemetryEvent = z.infer<typeof TelemetryRequestSchema>['events'][number];

function recordWebMonitoringMetrics(event: Extract<TelemetryEvent, { event: 'web_vital' | 'ui_error' }>): void {
  if (event.event === 'ui_error') recordObservationMetrics([{ name: 'ui.error', value: 1 }]);
  else recordObservationMetrics([{ name: `ui.web_vital.${event.name.toLowerCase() as Lowercase<typeof event.name>}`, value: event.value }]);
}

function recordRequestMetrics(event: Extract<TelemetryEvent, { event: 'ui_request' }>): void {
  recordObservationMetrics([
    { name: 'ui.request.duration_ms', value: event.duration_ms },
    { name: 'ui.request.failed', value: Number(event.outcome === 'error') },
    { name: 'ui.request.aborted', value: Number(event.outcome === 'aborted') },
  ]);
  // The browser's own view of the request joins the trace it started (`traceparent`): a CLIENT span of the measured length.
  if (event.trace_id === undefined) return;
  recordTraceSignal(event.trace_id, 'ui.request.duration_ms', event.duration_ms, {
    name: `browser ${event.method} ${event.endpoint ?? 'other'}`, durationMs: event.duration_ms,
    attributes: { http_status: String(event.status), outcome: event.outcome, timing_source: 'browser' },
  });
}

/** `returned`: the handler did not return its promise, so the duration is the synchronous handler only. */
function uiActionSamples(event: Extract<TelemetryEvent, { event: 'ui_action' }>): ObservationMetricSample[] {
  const attributes = event.outcome ? { attributes: { outcome: event.outcome } } : {};
  return [
    ...(event.duration_overflow ? [] : [{ name: 'ui.action.duration_ms' as const, value: event.duration_ms, ...attributes }]),
    { name: 'ui.action.failed', value: Number(event.outcome === 'error') },
    { name: 'ui.action.aborted', value: Number(event.outcome === 'aborted') },
  ];
}

function recordUiMetrics(event: TelemetryEvent): void {
  if (event.event === 'ui_edit' || event.event === 'ui_activity') {
    recordObservationMetrics([{ name: 'ui.action.invocations', value: event.invocations }]);
  } else if (event.event === 'ui_auth') {
    recordObservationMetrics([
      ...(!event.duration_overflow ? [{ name: 'ui.auth.duration_ms' as const, value: event.duration_ms }] : []),
      { name: 'ui.auth.failed', value: Number(event.outcome === 'error') },
      { name: 'ui.auth.aborted', value: Number(event.outcome === 'aborted') },
    ]);
  } else if (event.event === 'ui_action' && event.stage === 'complete') {
    recordObservationMetrics(uiActionSamples(event));
  } else if (event.event === 'web_vital' || event.event === 'ui_error') {
    recordWebMonitoringMetrics(event);
  } else if (event.event === 'ui_request') {
    recordRequestMetrics(event);
  } else if (event.event === 'ui_render') {
    recordObservationMetrics([{ name: 'ui.render.duration_ms', value: event.duration_ms }]);
  } else if (event.event === 'ui_metrics_window') {
    recordWindowMetrics(event);
  }
}

function recordWindowMetrics(event: Extract<TelemetryEvent, { event: 'ui_metrics_window' }>): void {
  const fields = ['requests_ok', 'requests_error', 'requests_aborted', 'events_observed',
    'events_accepted', 'events_dropped', 'batches_failed', 'timing_overflow'] as const;
  recordObservationMetrics(fields.map((field) => ({ name: `ui.window.${field}` as const, value: event[field] })));
  if (event.server_dropped !== undefined) recordObservationMetrics([{ name: 'ui.window.server_dropped', value: event.server_dropped }]);
}

type UiEvent = Extract<TelemetryEvent, { view_id: string }>;
/** The tab session and open conversation the browser names in headers (the same ones every API request carries). */
type WebCorrelation = { sessionId?: string; conversationId?: string; conversationSource?: 'client' };

function uiObservationName(event: UiEvent): string {
  if (event.event === 'ui_action') return `ui-action ${event.action} ${event.stage}`;
  if (event.event === 'ui_edit') return `ui-edit ${event.action}`;
  if (event.event === 'ui_activity') return `ui-activity ${event.action}`;
  if (event.event === 'ui_auth') return `ui-auth ${event.operation}`;
  if (event.event === 'ui_request' && event.endpoint) return `ui-request ${event.method} ${event.endpoint}`;
  return event.event.replaceAll('_', '-');
}

async function exportUiEvent(event: UiEvent, userId?: string, correlation: WebCorrelation = {}): Promise<void> {
  const { duration_ms, ...metadata } = event;
  const actionId = 'action_id' in event ? event.action_id : undefined;
  const workflowNamespace = userId ? `${actionId ? 'ui-action' : 'ui-view'}/${userId}` : `ui-anonymous/${event.view_id}`;
  await traceSpan(uiObservationName(event), {
    ...toSpanAttrs({
      surface: 'web', workflowNamespace, workflowId: actionId ?? event.view_id,
      // Only the verified caller is attributed; anonymous events supply no identity.
      userId,
      metadata: {
        ...Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, String(value)])),
        ...(!userId ? { auth_state: 'anonymous' } : {}),
        browser_duration_ms: String(duration_ms), timing_source: 'browser',
      },
    }),
    ...correlation,
    detached: true,
  }, () => recordUiMetrics(event)).catch(() => { /* No exception payloads or failures in the application path. */ });
}

/** R15-style opaque account tag -- first 8 hex of the account id's sha256,
 *  never the raw id. */
function accountTag(userId: string): string {
  return `acct=${createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, 8)}`;
}

/** The browser's `trace_id` is the API request's trace; the journal reserves
 *  `trace_id` for the line's own span, so it is written as `request_trace_id`. */
/** The browser's `event` kind is journaled as `ui_event`: the line's own `event` is the journal name (`v2.web_telemetry`). */
function journalFields({ trace_id, event, ...fields }: JournalFields): JournalFields {
  return { ...fields, ...(event === undefined ? {} : { ui_event: event }), ...(trace_id === undefined ? {} : { request_trace_id: trace_id }) };
}

function webCorrelation(request: Request): WebCorrelation {
  const { sessionId, conversationId } = requestCorrelation(request);
  return { ...(sessionId ? { sessionId } : {}), ...(conversationId ? { conversationId, conversationSource: 'client' as const } : {}) };
}

/** Journals one accepted event and returns the tab/conversation ids it was joined to (web monitoring events only). */
function journalAccepted(request: Request, event: TelemetryEvent, userId: string): WebCorrelation {
  const { event: kind, ...fields } = event;
  const monitoring = kind === 'web_vital' || kind === 'ui_error';
  const correlation = monitoring ? webCorrelation(request) : {};
  const line = journalFields({
    ...fields, event: kind, acct: accountTag(userId),
    ...(correlation.sessionId ? { session_id: correlation.sessionId } : {}),
    ...(correlation.conversationId ? { conversation_id: correlation.conversationId } : {}),
  });
  // A JavaScript error is journaled as `v2.web_telemetry_error`: the journal derives level `error` from the event suffix.
  if (kind === 'ui_error') webJournal(event)('v2.web_telemetry_error', line);
  else webJournal(event)('v2.web_telemetry', line);
  return correlation;
}

// Hand-written: auth comes before validation and answers missing_token.
export async function telemetryRoute(request: Request, response: Response): Promise<void> {
  const userId = request.account?.userId;
  if (userId === undefined) {
    sendError(response, 401, 'missing_token');
    return;
  }
  const parsed = TelemetryRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    sendError(response, 400, 'invalid_request');
    return;
  }
  let dropped = 0;
  for (const event of parsed.data.events) {
    const budget = event.event === 'ui_metrics_window' ? uiWindowBudget : uiEventBudget;
    if ('view_id' in event && !budget.take(userId)) { dropped++; continue; }
    // The discriminator rides along as `event`, so a log reader can tell the
    // event kinds apart; the authenticated account appears only
    // as its opaque 8-hex tag.
    const correlation = journalAccepted(request, event, userId);
    if ('view_id' in event) {
      await exportUiEvent(event, userId, correlation);
    } else {
      recordBrowserSignal(event);
    }
  }
  if (dropped > 0) response.setHeader('X-Bob-Telemetry-Dropped', String(dropped));
  response.status(204).end();
}

/** Browser facts that join a server trace by its id; bounded numbers only, no client text. */
function recordBrowserSignal(event: TelemetryEvent): void {
  if (event.event === 'reply_feedback') recordTraceSignal(event.trace_id, 'user.feedback', event.positive ? 1 : 0);
  else if (event.event === 'turn_timing' && event.trace_id !== undefined) {
    recordTraceSignal(event.trace_id, 'voice.eos_to_first_audio_ms', event.eos_to_first_audio_ms);
  }
}

/** Separate public lane, bounded by both IP and process budgets. It cannot submit
 * authenticated data or select an account namespace. Raw IPs never leave the limiter. */
export async function anonymousTelemetryRoute(request: Request, response: Response): Promise<void> {
  const ip = hashIp(clientIp(request));
  if (!anonymousRequestBudget.take(ip) || !anonymousGlobalRequests.take('anonymous')) {
    sendError(response, 429, 'rate_limited');
    return;
  }
  const parsed = AnonymousTelemetryRequestSchema.safeParse(request.body);
  if (!parsed.success) { sendError(response, 400, 'invalid_request'); return; }
  let dropped = 0;
  for (const event of parsed.data.events) {
    if (!anonymousEventBudget.take(ip) || !anonymousGlobalEvents.take('anonymous')) { dropped++; continue; }
    webJournal(event)('v2.web_telemetry', journalFields({ ...event, auth_state: 'anonymous' }));
    await exportUiEvent(event);
  }
  if (dropped > 0) response.setHeader('X-Bob-Telemetry-Dropped', String(dropped));
  response.status(204).end();
}
