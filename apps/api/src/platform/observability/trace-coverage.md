# Trace coverage audit (#898)

What reaches the trace backend today for a device/web/invocation turn, against the
list #898 needs to answer "where did this turn's time go" without stitching
span start/ends by hand. Present/missing/where-emitted, the first-token timing
note, and follow-ups for gaps whose emitter lives outside this unit's owns.
The backend is chosen only by standard `OTEL_*` variables; nothing below names one.

## Per-trace fields

| Field | Status | Where |
| --- | --- | --- |
| surface (device/web/invocation) | Present | `toTraceAttrs` sets `tags: [surface]`, stamped as `bob.tags` by the correlation processor (`apps/ai/src/telemetry.ts`) |
| model id | Present | `gen_ai.request.model` / `gen_ai.response.model`, set automatically by `@ai-sdk/otel` on the root `invoke_agent` and the per-call `chat` spans |
| steps count | Missing | only known at the call site (the agent result's `steps.length` in `turn/generate.ts`, `chat/http.ts`) -- see Follow-ups |
| tool names called | Partial | each tool-execution span already carries `gen_ai.tool.name` (allow-listed), but there is no trace-level rollup like the journal's comma-joined `v2.agent_tools.tools` -- see Follow-ups |
| outcome | Partial | `turn.completed`/`turn.failed`/`turn.cancelled`/`turn.empty` are 0/1 metrics recorded through `recordObservationMetrics` (`apps/api/src/platform/observability/turn-metrics.ts` `turnScores()`), which also sets `bob.metric.<name>` on the active span, not a single string attribute |
| user feedback | Present | browser `reply_feedback` event -> `recordTraceSignal(trace_id, 'user.feedback', 0 or 1)`: a `trace-signal` span inside the reply's trace carrying `bob.metric.user.feedback` |

## Per-generation fields

| Field | Status | Where |
| --- | --- | --- |
| start / end | Present | OTel span `startTime`/`endTime` |
| first-token latency | Present for streamed calls only | `gen_ai.client.operation.time_to_first_chunk` (seconds), set by `@ai-sdk/otel` on the `chat` step span -- see "Streamed-only gap" below |
| input/output/cached/reasoning tokens | Present | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`, set by `@ai-sdk/otel` on the per-call span, all allow-listed by the export scrubber (`apps/ai/src/telemetry-export.ts`) |

## Per-stage spans

| Stage | Status | Where |
| --- | --- | --- |
| STT | Present | `traceSpan('device-stt', ...)`, `apps/api/src/voice/turn/transcribe.ts` |
| context/prep | Missing | measured (`prep_ms`, `context_ms`, `space_ms`) and journaled, but never its own span -- `turn/generate.ts`, `chat/http.ts` -- see Follow-ups |
| memory retrieval | Present | `traceSpan('memory-${stage}', { observationType: 'retriever', ... })`, `apps/api/src/memory/retrieval-observability.ts` |
| each tool execution | Present | automatic `execute_tool {toolName}` span per call (`@ai-sdk/otel`) |
| each TTS piece | Present | `traceSpan('device-tts', ...)`, `apps/api/src/voice/turn/playback.ts` |
| persist | Missing | `v2.turn_persist_failed` / `v2.device_thread_saved` are journal-only, no span -- see Follow-ups |
| browser voice timing | Present | browser `turn_timing` with a `trace_id` -> `recordTraceSignal(trace_id, 'voice.eos_to_first_audio_ms', ms)` |

## Turn-level timings

| Metric | Status | Where |
| --- | --- | --- |
| first_token_ms | Present | numeric `bob.metric.*` on the active trace, `turn-metrics.ts` `turnScores()` |
| first_audio_ms (device) | Present | same |
| total_ms | Present | same |
| stt_ms / prep_ms / model_ms / tts_ms | Present (already covered, beyond the required list) | same |

## Continuing an upstream trace

A generic HTTP route whose request carries a valid W3C `traceparent` header (the
edge proxy forwards one) starts its `http <METHOD> <route>` span under that
trace, so the edge span and the API spans share a trace id. Without a valid
header the span keeps a random `http-request` workflow seed. The deterministic
workflow routes (`POST /api/chat`, `/api/voice`, `/api/speech`,
`/api/threads/:id/invocations`) keep their deterministic ids and record the edge
trace id as the `edge_trace_id` metadata attribute instead.

## Streamed-only gap: no first-token latency for generate() calls

`performance.timeToFirstOutputMs` -- the input behind
`gen_ai.client.operation.time_to_first_chunk` -- is `undefined` for non-streaming
calls (the AI SDK documents it as "Only available for streaming steps"). Two call
sites in this codebase use `agent.generate()` (never `.stream()`), so their
generations carry no first-token latency:

- **Space/thread invocations.** `apps/api/src/workflows/workflow-thread-invocation.ts`
  -- `const result = await agent.generate({ messages });`.
- **The device batch path.** `apps/api/src/voice/turn/agent.ts` (`runAgent`), reached
  whenever `canStream(agent)` is false at `apps/api/src/voice/turn/generate.ts`,
  taking the non-streamed branch.

Proposed fix (outside this unit's owns -- do not implement here): switch both
call sites to `agent.stream(...)` and fully consume the stream (as the device
path's `streamAgent` branch and the web path's `createAgentUIStreamResponse`
already do), so `@ai-sdk/otel` reports a real first-chunk latency for every
generation. If a call site must stay non-streaming, timestamp the first awaited
chunk/result manually and stamp it as trace metadata (a number, milliseconds)
via `updateActiveSpanMetadata`, the same pattern as Follow-up 1 below.

## Follow-ups (emitters outside this unit's owns -- do not fix here)

1. **Trace-level steps count + tool-names rollup.**
   - Device: the `withTraceContext(...)` callback in `apps/api/src/voice/turn/generate.ts`
     (`() => (streamed ? streamAgent(...) : runAgent(...))`) would need to become
     `async () => { const r = await (...); ...; return r; }` so it can read
     `r.steps`/`r.toolCalls` while the trace is still active.
   - Web: `apps/api/src/workflows/workflow-web-chat-turn.ts` builds the agent stream
     (`createAgentUIStreamResponse`, collecting `agentSteps` via its `onStepEnd`);
     `recordWebTurnMetric(deps, { ..., steps: agentSteps, ... })` is where the final
     count is already available, inside the `traceSpan('web-chat-turn', ...)` span
     opened by `apps/api/src/conversations/chat-stream.ts`.
   - Proposed attributes (names and numbers only, via `updateActiveSpanMetadata`):
     `steps` (the step count, as a string of digits) and `called_tools`
     (comma-joined tool names, matching the `v2.agent_tools.tools` journal
     convention). Both keys would need adding to `SAFE_METADATA` in
     `apps/ai/src/telemetry-metadata.ts`.
2. **A `turn-prep` span**, covering the work already measured as `prep_ms`/
   `context_ms`/`space_ms`.
   - Device: wrap the prep section of `apps/api/src/voice/turn/generate.ts`
     (from `const startedAt = Date.now();` to `const modelStartedAt = Date.now();`)
     in `traceSpan('turn-prep', toSpanAttrs({ surface: 'device', turnId: turnRef }), ...)`.
   - Web: wrap the same section of `apps/api/src/workflows/workflow-web-chat-turn.ts` in
     `traceSpan('web-turn-prep', toSpanAttrs({ surface: 'web', turnId }), ...)`.
   - No new attribute needed -- the span's own start/end carries the duration.
3. **Persist spans.**
   - Device: wrap `persistDeviceTurn(...)` in `apps/api/src/voice/turn/persist.ts`
     in `traceSpan('device-turn-persist', toSpanAttrs({ surface: 'device', turnId: turnRef }), ...)`.
     Stamp the outcome already known at the success journal (`v2.device_thread_saved`)
     and the failure journal (`v2.turn_persist_failed`) as an `outcome` attribute
     (`completed` or `failed`, a name, never the error message).
   - Web: wrap the `addReplyVersion(...)` calls in `persistReply`
     (`apps/api/src/workflows/workflow-web-chat-turn.ts`) in `traceSpan('web-turn-persist',
     toSpanAttrs({ surface: 'web', turnId }), ...)`, with the same `outcome` attribute
     (`v2.messages_persisted` / `v2.messages_persist_failed`) plus `bytes` (a number,
     already computed there).

## Device turn root (OBS-N9)

A device turn has one root span, `device-turn`, opened in `handleControl`
(`apps/api/src/voice/session.ts`) before the `turn_start` control span and held in
`apps/api/src/voice/turn/turn-root.ts`. It is ended exactly once, by
`handleTurnEnd` when the pipeline settles, or by `resetSession` / the socket close
hook when no pipeline is running (cancel, queue-full, disconnect mid-capture).
Failed stages (`failTurn`) or a rejected pipeline end it with ERROR / `workflow_failed`.

- `ws.control.{turn_start,turn_end,cancel}`, `ws.control.device_log` with the
  turn's `turn_ref`, `device-turn-started/ended`, `device-log`, `ws.uplink` and
  `turn-pipeline` (formerly the pipeline's `device-turn` span) are descendants of
  the root, so all carry `session.id` (the WebSocket session id), `bob.conversation.id` = `gen_ai.conversation.id` (canonical, when known; source `device`), `user.id` (paired only), `bob.turn.id`.
- No placeholder speech spans: `traceSpeechUsage` sets its attributes on the
  active provider span. Account events are `account-event` span events.
- Web turns (`web-chat-turn`) and thread invocations carry the canonical conversation (source `explicit`)
  and the acting `user.id`; `session.id` is the browser's per-tab id, inherited from the request.
- Every span carries `bob.conversation.id` and `gen_ai.conversation.id` (equal) plus
  `bob.conversation.source`; `none` for system work (outbox ticks, sweeps) and unauthenticated requests.
  A reminder fanout, timer fire, notification delivery and notification email pass the recipient's `userId`, and the
  span layer resolves their active conversation (`active`); a paired device message with no conversation of its own
  does too. Rule: docs/observability.md. The session id never seeds a trace id; only a turn id or a workflow namespace does.
- Speech spans: `ai.transcribe` -> `transcription`, `ai.generateSpeech` -> `text_to_speech`; zero costs are dropped.
