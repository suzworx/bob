/**
 * The client telemetry HTTP contract (POST /api/telemetry): Zod DTOs shared by the telemetry route and, through
 * web-schemas.ts, by the web client. Moved out of web-schemas.ts (issue #625); shapes unchanged.
 */
import { z } from 'zod';
import actions from './ui-action-catalog.json' with { type: 'json' };
import routes from './ui-route-catalog.json' with { type: 'json' };
import endpoints from './ui-endpoint-catalog.json' with { type: 'json' };

// --- Telemetry DTOs (013 R8, contracts/voice-mode.md) ------------------------

/** The seven conversation-mode states (013 R10). */
const VoiceModeStateSchema = z.enum([
  'off',
  'listening',
  'hearing_you',
  'thinking',
  'speaking',
  'muted',
  'paused',
]);
type VoiceModeState = z.infer<typeof VoiceModeStateSchema>;

/** One ms value in a telemetry event: an integer 0..120000. */
const telemetryMsField = z.number().int().min(0).max(120000);
const telemetryCountField = z.number().int().min(0).max(1_000_000);
const traceIdField = z.string().regex(/^[0-9a-f]{32}$/);

const uiEventFields = {
  page: z.enum(['chat', 'apps', 'spaces', 'calendar', 'memory', 'metrics', 'devices', 'gmail', 'connectors', 'pair', 'invite', 'reset', 'account', 'usage', 'other', 'signin']),
  view_id: z.uuid(),
  duration_ms: telemetryMsField,
  route: z.enum([...routes, 'signin']).optional(),
};

/** First-load page timings from PerformanceNavigationTiming, only on the one navigation that carries them. */
const navigationTimings = {
  dom_content_loaded_ms: telemetryMsField.optional(), load_ms: telemetryMsField.optional(), ttfb_ms: telemetryMsField.optional(),
};

const actionTriggers = new Map(actions.map(({ id, trigger }) => [id, trigger]));
const actionFields = {
  event: z.literal('ui_action'), ...uiEventFields,
  action: z.enum(actions.map(({ id }) => id)),
  action_id: z.uuid(),
  trigger: z.enum([...new Set(actions.map(({ trigger }) => trigger))]),
  stage: z.enum(['start', 'complete']),
  outcome: z.enum(['returned', 'resolved', 'error', 'aborted']).optional(),
  duration_ms: z.number().int().min(0).max(604_800_000),
  duration_overflow: z.boolean().optional(),
};
const authFields = {
  event: z.literal('ui_auth'), view_id: z.uuid(),
  operation: z.enum(['signInWithOtp', 'verifyOtp', 'signInWithPassword', 'resetPasswordForEmail', 'updateUser', 'signOut', 'refreshSession']),
  outcome: z.enum(['ok', 'error', 'aborted']),
  duration_ms: z.number().int().min(0).max(604_800_000),
  duration_overflow: z.boolean().optional(), action_id: z.uuid().optional(),
  events_dropped: telemetryCountField.optional(), batches_failed: telemetryCountField.optional(),
};
const windowFields = {
  requests_ok: telemetryCountField, requests_error: telemetryCountField, requests_aborted: telemetryCountField,
  events_observed: telemetryCountField, events_accepted: telemetryCountField, events_dropped: telemetryCountField,
  batches_failed: telemetryCountField, timing_overflow: telemetryCountField, server_dropped: telemetryCountField.optional(),
};
const editFields = {
  event: z.literal('ui_edit'), ...uiEventFields,
  action: z.enum(actions.filter(({ category }) => category === 'edit').map(({ id }) => id)),
  action_id: z.uuid(), trigger: actionFields.trigger,
  invocations: z.number().int().min(1).max(1_000_000),
  failed_invocations: telemetryCountField, aborted_invocations: telemetryCountField,
  duration_ms: actionFields.duration_ms, duration_overflow: z.boolean().optional(),
};
function validAction(event: { action: string; trigger: string; stage: string; outcome?: string }): boolean {
  return actionTriggers.get(event.action) === event.trigger && (event.stage === 'complete') === (event.outcome !== undefined);
}
const activityFields = { ...editFields, event: z.literal('ui_activity'), action: z.enum(actions.filter(({ category }) => category === 'activity').map(({ id }) => id)) };
function validSummary(event: { action: string; trigger: string; failed_invocations: number; aborted_invocations: number; invocations: number }): boolean {
  return event.failed_invocations + event.aborted_invocations <= event.invocations && actionTriggers.get(event.action) === event.trigger;
}

/**
 * One telemetry event (FR-034): bounded numbers, enums and a view UUID,
 * with no free-text fields that could carry audio, a transcript, form values
 * or assistant text. Each member is strict,
 * so any unknown key is a 400 rather than being silently dropped.
 */
const TelemetryEventSchema = z.discriminatedUnion('event', [
  z.object(activityFields).strict().refine(validSummary),
  z.object(editFields).strict().refine((event) => event.failed_invocations + event.aborted_invocations <= event.invocations && actionTriggers.get(event.action) === event.trigger),
  z.object(authFields).strict(),
  z.object(actionFields).strict().refine(validAction),
  z.object({
    event: z.literal('ui_metrics_window'), ...uiEventFields,
    ...windowFields,
  }).strict(),
  z.object({ event: z.literal('ui_navigation'), ...uiEventFields, ...navigationTimings }).strict(),
  z.object({
    event: z.literal('web_vital'), ...uiEventFields, route: z.enum(routes),
    name: z.enum(['LCP', 'INP', 'CLS', 'FCP', 'TTFB']),
    // Milliseconds; CLS is unitless, sent times 1000 as an integer.
    value: telemetryMsField,
    rating: z.enum(['good', 'needs-improvement', 'poor']),
  }).strict(),
  z.object({
    event: z.literal('ui_error'), ...uiEventFields, route: z.enum(routes),
    kind: z.enum(['error', 'rejection']),
    error_name: z.string().regex(/^[A-Za-z]{1,40}$/),
    // Basename of a file in the app's own bundle: never a URL, query or message.
    frame: z.string().regex(/^[A-Za-z0-9._-]{1,80}:\d{1,6}:\d{1,6}$/).optional(),
  }).strict(),
  z.object({
    event: z.literal('ui_interaction'), ...uiEventFields,
    target: z.enum(['button', 'link', 'input', 'select', 'form', 'other']),
  }).strict(),
  z.object({
    event: z.literal('ui_render'), ...uiEventFields,
    phase: z.enum(['mount', 'update', 'nested-update']),
  }).strict(),
  z.object({
    event: z.literal('ui_request'), ...uiEventFields,
    area: z.enum(['chat', 'voice', 'conversations', 'spaces', 'devices', 'account', 'memory', 'productivity', 'notifications', 'other']),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'OTHER']),
    status: z.number().int().min(0).max(599),
    outcome: z.enum(['ok', 'error', 'aborted']),
    endpoint: z.enum([...new Set(endpoints.map(({ path }) => path)), 'other']).optional(),
    action_id: z.uuid().optional(),
    request_id: z.uuid().optional(),
    trace_id: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  }).strict(),
  z
    .object({
      event: z.literal('turn_timing'),
      eos_to_first_audio_ms: telemetryMsField,
      stt_ms: telemetryMsField.optional(),
      agent_first_token_ms: telemetryMsField.optional(),
      tts_first_audio_ms: telemetryMsField.optional(),
      trace_id: traceIdField.optional(),
    })
    .strict(),
  z
    .object({ event: z.literal('reply_feedback'), trace_id: traceIdField, positive: z.boolean() })
    .strict(),
  z
    .object({
      event: z.literal('barge_in'),
      reaction_ms: telemetryMsField,
    })
    .strict(),
  z
    .object({
      event: z.literal('false_trigger'),
      count: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      event: z.literal('mode_state'),
      from: VoiceModeStateSchema,
      to: VoiceModeStateSchema,
    })
    .strict(),
  z
    .object({
      event: z.literal('mode_off'),
      reason: z.enum(['idle', 'user', 'hidden', 'lock_denied', 'error']),
    })
    .strict(),
]);

/** POST /api/telemetry body: one batch of 1..20 events, strict. */
export const TelemetryRequestSchema = z
  .object({ events: z.array(TelemetryEventSchema).min(1).max(20) })
  .strict();

type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
type TelemetryRequest = z.infer<typeof TelemetryRequestSchema>;

const anonymousFields = {
  ...uiEventFields,
  page: z.enum(['signin', 'reset', 'invite']),
  route: z.enum(['signin', '/reset', '/invite/:token']),
};
const anonymousActions = actions.filter(({ id }) => /^(account\.(sign-in|reset-page)|spaces\.invite-page)\./.test(id)).map(({ id }) => id);

/** Public ingestion accepts only the code-owned authentication surface catalog.
 * No account identity, generic requests, payloads, error text or browser render tree. */
export const AnonymousTelemetryRequestSchema = z.object({
  events: z.array(z.discriminatedUnion('event', [
    z.object({ ...activityFields, ...anonymousFields, duration_ms: activityFields.duration_ms }).strict().refine((event) => anonymousActions.includes(event.action) && validSummary(event)),
    z.object({ ...editFields, ...anonymousFields, duration_ms: editFields.duration_ms }).strict().refine((event) => anonymousActions.includes(event.action) && event.failed_invocations + event.aborted_invocations <= event.invocations && actionTriggers.get(event.action) === event.trigger),
    z.object(authFields).strict(),
    z.object({ event: z.literal('ui_navigation'), ...anonymousFields, ...navigationTimings }).strict(),
    z.object({ ...actionFields, ...anonymousFields, duration_ms: actionFields.duration_ms, action: z.enum(anonymousActions) }).strict().refine(validAction),
    z.object({ event: z.literal('ui_metrics_window'), ...anonymousFields, ...windowFields, page: z.enum(['signin', 'reset', 'invite', 'other']) }).strict(),
  ])).min(1).max(10),
}).strict();
