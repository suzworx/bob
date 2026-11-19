# Observability: traces, logs and metrics (vendor-neutral)

No provider is named in the logging or telemetry code. Bob emits three signals
and the environment decides where they go:

| Signal | Shape | Where it lands |
| --- | --- | --- |
| Traces | OTLP spans, one trace per agent turn, HTTP request, UI action or workflow | Any OTLP backend |
| Logs | The journal as JSON lines on stdout (`level`, `message`, `trace_id`, `span_id`, plus the event's fields) | Your platform's log explorer, or a collector tailing the journal file |
| Metrics | OTel instruments (0/1 outcome flags such as `turn.failed` are counters, everything else a histogram; `bob.device.connected` is an observable gauge with `paired` true/false), plus the same samples as `bob.metric.<name>` span attributes | Any OTLP metrics backend; the span attributes work where metrics are not ingested |

Traces and logs join on the trace id: filter your log explorer on
`trace_id`; a trace's id is on every journal line written inside one of its
spans. A line written outside any span carries neither id.

## Backends

The backend is chosen only by the standard `OTEL_*` variables; changing it never
touches code. Tracing starts when an OTLP traces endpoint is configured
(`OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) and
`OTEL_TRACES_EXPORTER` is not `none`. Every ended span goes through one privacy
scrub (the attribute allowlist, exception payloads removed, `BOB_TRACE_PAYLOAD`
honoured) exactly once, then the same scrubbed span is handed to each exporter.

- **A platform that injects OTLP variables.** Some hosts inject the OTLP endpoint,
  protocol, headers, service name and version themselves; the exporter reads them
  as is. When a host's edge sends a trace-id header, the app records it as
  `edge_trace_id` on the request's span.
- **Any OTLP backend.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` (and
  `OTEL_EXPORTER_OTLP_HEADERS` when it needs auth; that header is a secret). Use
  `OTEL_SERVICE_NAME` and `OTEL_SERVICE_VERSION` to name the service. The resource
  carries only the service name and version (else the deployed commit) and the
  deployment environment, nothing about the host, user or process arguments.
- **Fan-out.** Run an OpenTelemetry Collector in front and add exporters there. The app never
  fans out on its own except for one optional extra destination for traces and
  logs: `BOB_OTLP_EXTRA_TRACES_ENDPOINT` plus `BOB_OTLP_EXTRA_TRACES_HEADERS`
  and `BOB_OTLP_EXTRA_LOGS_ENDPOINT` plus `BOB_OTLP_EXTRA_LOGS_HEADERS` (any
  vendor's full OTLP traces and logs URLs and their auth headers, secrets). It
  receives the same scrubbed spans as the primary and the same journal lines as the
  primary log bridge. Logs need no `OTEL_LOGS_EXPORTER`; that variable only drives
  the primary. A failing extra destination reports once as
  `otlp_extra_flush_failed` (traces) or `otlp_extra_logs_flush_failed` (logs) and
  never stops the primary.
- **Metrics.** Instruments are exported only when an endpoint is set and
  `OTEL_METRICS_EXPORTER` is unset or `otlp`; `none` turns them off.
  `OTEL_METRIC_EXPORT_INTERVAL` tunes the interval. When the extra destination
  (`BOB_OTLP_EXTRA_METRICS_*`) is the only one, metrics are
  delta: each export carries only the series recorded since the last one. With
  both on, both stay cumulative (the readers share one collector).
- **Compression.** The extra traces, logs and metrics exporters send gzip; the
  primary follows the standard `OTEL_EXPORTER_OTLP_COMPRESSION`.

Export failures are reported once per kind as `v2.telemetry_export_failed`
(kinds include `otlp_flush_failed` and `telemetry_init_failed`).

### Span attribute vocabulary

Only these reach any backend (everything else is dropped by the scrub):

| Attribute | Meaning |
| --- | --- |
| `user.id` | The acting, server-verified account of the request or turn; absent for anonymous telemetry and unpaired devices |
| `bob.conversation.id` | The canonical conversation id (`conv_...`; conversation == thread) on EVERY span: human-only threads, web, device, background work. The literal `none` when no conversation applies |
| `gen_ai.conversation.id` | Always the same value as `bob.conversation.id`, for AI tooling (set on non-AI spans too) |
| `bob.conversation.source` | How the conversation was resolved: `explicit`, `client`, `device`, `active` or `none` (see "Conversation resolution") |
| `session.id` | The CLIENT session: device = the WebSocket session id (`session_...`); web = the per-tab UUID the browser sends as `X-Bob-Client-Session` (new tab = new session) |
| `bob.session.id` | The same client session, on every span. AI spans (those with `gen_ai.operation.name`) carry ONLY this name: some backends replace `gen_ai.conversation.id` with `session.id` on AI spans, which would group a conversation's model calls by tab or socket instead of by conversation |
| `bob.turn.id` | The turn id, the same value as the journal's `turn_id` |
| `bob.trace.name` | The trace's name (`device-turn`, `web-chat-turn`, `thread-invocation`, `http ...`, `ui-...`) |
| `bob.tags` | Surface tags (`device`, `web`, `invocation`) |
| `bob.observation.type` | `span`, `evaluator`, ... (the kind of operation) |
| `bob.ai.span_type` | The AI SDK span's role: `operation` (the whole call), `languageModel` or `embedding` (one provider call), `step`, `tool`. An embed is an `operation` span over an `embedding` span with the same name; only the inner one carries usage and counts as a call |
| `bob.<metadata>` | Bounded metadata keys from a fixed allowlist (route, outcome, stage, model, ...) |
| `bob.metric.<name>` | A numeric sample (`turn.total_ms`, `rag.duration_ms`, ...); see `docs/log-reference.md` |
| `edge_trace_id` | Metadata key carrying the hosting edge's trace id for the request, joining the app span to the edge |
| `gen_ai.*` | Model, operation, finish reason and token usage from the AI SDK |
| `bob.speech.input_units` | Speech usage on the `speech-stt-provider` / `speech-tts-provider` wrapper span: provider-reported audio seconds for STT, locally counted UTF-16 characters of the capped input for TTS |
| `bob.cost.*` | Provider-call cost estimates from a configured rate snapshot; see "Usage and cost" below |

Some backends (OpenObserve, for example) rewrite two of these at ingest, so query the Bob names instead:

- `gen_ai.operation.name` keeps `chat`, `embeddings`, `invoke_agent` and `execute_tool`. Every other value becomes `chat`, including `transcription` and `text_to_speech`. Classify spans by the first word of `operation_name` (`chat`, `embeddings`, `evaluate`, `ai.transcribe`, `ai.generateSpeech`).
- `gen_ai.conversation.id` is replaced with `session.id` on AI spans that carry one, so AI spans export the session only as `bob.session.id` Filter on `bob_conversation_id` either way.

A device turn's `bob.metric.turn.*` values sit on its `turn-pipeline` span, not on the `device-turn` root, so latency and failure panels select `bob_metric_turn_completed is not null` (`${MEASURED}`) rather than the root.

## Traces

### Browser UI traces

Signed-in browser sessions send metadata-only UI events through authenticated
`POST /api/telemetry`. A build-time transform instruments source-owned callbacks,
menu actions and links. The generated action catalog and route catalog are checked
against the source in tests, so a new action or route cannot silently miss coverage.
Names identify the feature, source component, control and callback; they never use
DOM text, labels, values, selectors or user-created IDs. Text-entry callbacks are
coalesced into `ui-edit` summaries; frequent keyboard/drag callbacks use `ui-activity`
summaries with invocation counts. Native listeners have an explicit inventory with
named user-action bridges and documented passive lifecycle exclusions. Matched
command-palette shortcuts get named actions; individual keys are never exported.
Playback `onTimeUpdate`
uses existing voice timing measurements rather than a span per progress tick.

`ui-action <action> start` and `ui-action <action> complete` share a random
`action_id`. Completion distinguishes synchronous return, Promise resolution,
error and abort. This measures callback execution, not business success. Nested
forwarding callbacks share the identifier; it is not a count of unique user intent.
The action ID and a per-request UUID join eligible same-origin browser requests
to server HTTP observations. Correlation follows explicit synchronous causality;
unrelated async continuations are never joined merely because they happened nearby.

**User attribution.** Authenticated HTTP and UI traces carry the verified caller's
Supabase account UUID as `user.id`, matching AI-turn attribution, so recorded web
activity can be filtered per account without an AI turn.
The id comes from the server's verified account, never a client-supplied identity field.
Anonymous telemetry, including the auth-outcome lane below, and requests rejected
before authentication carry no user id. Emails, names, tokens and session credentials
are never exported.

Requests carry only registered endpoint templates, method, status and outcome.
`ui-request METHOD /template/:id` durations stop at response headers, so streaming
bodies are neither buffered nor consumed. External requests and telemetry endpoints
are excluded. Navigation uses fixed route templates and page categories. A random
`view_id` identifies a page visit; authenticated view/action traces are scoped to
the account. React render observations measure the root subtree, including the
production profiling renderer; this adds profiling overhead.

Sign-in/reset/invitation actions have a separate strict, rate-limited anonymous
ingestion lane at `POST /api/telemetry/anonymous`. Seven explicit Supabase methods
also produce `ui-auth <operation>` observations: OTP send/verify, password sign-in,
password-reset request, user update, sign-out and session refresh. These record
returned provider errors as well as throws/rejections, preserve the original result
and Promise, and never inspect credentials or provider response bodies. Auth outcome
delivery survives sign-in/sign-out transitions without selecting an account identity
or inventing a page attribution. These are client-reported outcomes, not audited
identity-provider logs. The anonymous route accepts neither arbitrary actions nor
authenticated identities and has both per-IP and process-wide budgets.

Browser timing samples (`bob.metric.*` attributes and instruments), not
ingestion-span duration, measure client execution.
`ui.action.duration_ms`, `ui.action.failed` and `ui.action.aborted` use terminal
non-summary callback samples; `ui.action.invocations` counts coalesced text edits
and repeated activity callbacks, distinguished by their observation name prefix.
`ui.auth.duration_ms`, `ui.auth.failed` and `ui.auth.aborted` measure provider
operations separately. Render/request scores and collection-window counters remain.
Capture is bounded and best-effort. Detail, edit and summary budgets keep frequent
typing from starving button actions; server drops are returned in a response header
and recorded in `ui.window.server_dropped`. Sign-out discards authenticated queues;
anonymous auth reporting continues without account ownership. Missing UUID support
disables collection without interrupting the product. No browser secret key exists.

Find `ui-*` observations by stable name, `action_id`, `request_id` or `view_id`.
The same events are journaled as `v2.web_telemetry`; `npm run api:monitor` follows
them. Accepted means queued, not persisted. Lost final-page batches, missing windows,
rate limiting and export failures prevent treating these as lossless analytics.

### Web monitoring (vendor-neutral)

Frontend monitoring runs through Bob's own `/api/telemetry`: no vendor SDK, no
token in the browser, authenticated lane only.

Collected: every same-origin API request carries a W3C `traceparent` (random trace
and span id, sampled); its trace id is the `trace_id` of that request's `ui_request`
event, and the server records a CLIENT span `browser <METHOD> <endpoint>` of the
browser-measured duration in that trace (generic routes continue the trace; workflow
routes keep their seeded id and record the browser's as `edge_trace_id`). Web Vitals
(`LCP`, `INP`, `CLS`, `FCP`, `TTFB`, with the browser's rating and the route template)
become `web_vital` events and `ui.web_vital.*` metrics. `window` `error` and
`unhandledrejection` become `ui_error` events (error class name and, only when the
top frame is in the app's own bundle, `file:line:col` with the file reduced to its
basename) and the `ui.error` metric; at most 10 a minute per tab, identical class and
frame once. The first load adds `dom_content_loaded_ms`, `load_ms` and `ttfb_ms` from
`PerformanceNavigationTiming` on one extra `ui_navigation` event. The events are
joined by the tab session and open conversation, which the batch request carries as
`X-Bob-Client-Session` / `X-Bob-Conversation`; the server stamps the user.

Never collected: error messages, stack text, URLs or query strings, anything typed
by the user, page content, session replay. The anonymous lane rejects vitals and errors.

### Real User Monitoring

The one place a vendor appears in the browser (the OpenObserve RUM SDK). It lives only in
`apps/ui-v2/src/lib/observability/rum.ts` (a test guards that `@openobserve/*` is imported
nowhere else) and starts for a signed-in session only when `/api/public-config` carries `rum`.

- **Collected**: page views, resources, long tasks, user interactions (click targets), web
  vitals, uncaught errors and console errors (via the logs SDK). `console.log/info` are not
  forwarded. Events carry `service=bob-web`, `env`, the short commit, the account id
  (`user.id` only: no name, no email), and `session_id` / `conversation_id` as context.
- **Masking**: `defaultPrivacyLevel: 'mask'`, so typed and page text is masked.
- **No replay**: `sessionReplaySampleRate: 0`; session replay is never started.
- **No trace headers**: the SDK adds none; the app's own `traceparent` is unchanged.
- **Token**: `BOB_RUM_CLIENT_TOKEN` is a public, ingest-only browser token. Together with
  `BOB_RUM_SITE` and `BOB_RUM_ORG` it is served unauthenticated by `/api/public-config`; no other secret is.
- **Turn it off**: unset any of the three variables
  and redeploy; `rum` is then omitted and the SDK never loads its config.
- **Source maps**: production serves none. To get source frames, rebuild the deployed commit
  with `BOB_SOURCEMAP=hidden` (byte-identical JS) and upload the maps to your RUM backend
  out of band; never deploy them.

### Metric dashboards

Metrics are fixed numeric samples. Each one is an OTel instrument and also an
`bob.metric.<name>` attribute on the active span, so a backend that ingests no
metrics can still search and aggregate them from spans. Dashboards
for AI/API health, UI experience and Cardputer/voice combine these with the native
model latency, usage and cost fields. Recorded terminal-turn outcomes include handled
failures; unhandled trace errors remain a separate measure. Turn first-token and
first-audio samples start at the beginning of the turn, including preparation. Device
memory and uptime samples come from the existing server-side diagnostic handler, with
no device SDK. See `docs/log-reference.md` for names, units and denominators. Missing values
mean unmeasured, not zero; filter out development/synthetic/HIL data when assessing production.

The 0/1 outcome flags (`*.failed`, `*.aborted`, `*.completed`, ...) are counters. Every one of them is
created at 0 when the metrics start, so a series exists before its first event, and `increase()`/`rate()`
count that first event. Every other metric is a histogram. `metricKinds()` in
`apps/ai/src/observation-metrics.ts` is the list, pinned by a snapshot test.

Breakdown labels sit on the histograms that need them, never on the 0/1 counters (a labelled series starts at
its first event, so counters stay unlabelled to count every event from 0). Values pass an allow-list in
`checkedMetricAttributes`; anything else is dropped, and a route with an id-like segment, a query string or an `@`
never passes:

| Metric | Labels |
|---|---|
| `http.request.duration_ms`, `http.request.stream_ms` | `route` (Express template), `status_class` (`2xx`…`5xx`), `outcome` (`ok` `error` `aborted` `closed`) |
| `turn.*_ms` | `surface` (`device` `web_text` `web_voice` `analytics`) |
| `speech.duration_ms` | `stage` (`stt` `tts`) |
| `ui.action.duration_ms` | `outcome`: `resolved` (the handler returned its promise: full action time), `returned` (handler only), `error`, `aborted` |

Histogram buckets follow the unit (`bucketsFor` in the same file): durations up to 10 min in 5 ms … 600 000 ms
steps, longer durations add 1 h / 6 h / 24 h / 7 d, bytes go from 1 KB to 4 GB in ×4 steps, and counts use
0, 1, 2, 5 … 1 000 000. `ui.web_vital.cls` (×1000) stops at 1 000; a device up more than 7 days and a layout shift
above 1.0 land in `+Inf` on purpose. Read latency percentiles from `_bucket`
(`histogram_quantile`); `_min`/`_max` are since process start, not per time window.

### Subsystem diagnostics

Use these views, built in whatever backend holds the spans, to find the operation
responsible for a regression. Each should show the exact recorded sample count
beside its percentiles or failure fraction; fractions are 0–1, durations are ms,
and costs are USD. Filter on the `deployment.environment.name` resource attribute
(`production` or `development`) so local/synthetic runs stay out of production
numbers. Historical spans do not gain newly added samples.

| View | First question | Drill-down |
| --- | --- | --- |
| API routes and WebSocket | Which method/route has slow p50/p95/p99 or rising 4xx, 5xx or disconnect fractions? | Filter observations by the exact `http METHOD /route/:id` or `ws.control.<type>` name, then open its trace. |
| RAG and memory | Is time spent embedding, searching or loading standing/due-soon context? Is retrieval degraded or deliberately skipped? | Open `memory-retrieval` and its child stages. Successful empty searches, thrown stage failures and fallbacks have separate denominators. |
| Tool execution | Which registered tool is slow, returns a handled failure, throws, or is cancelled? | Filter `tool-result.<name>` completion observations; use the SDK TOOL span in the same trace for execution structure. |
| Turn action outcome | Did a completed turn's actions work, or did a tool fail behind a clean reply? | Read `action_outcome` / `tool_failures` on `v2.turn_completed` (#999): `failed` means a tool returned `{ ok: false }` or threw while the pipeline still completed. Counts and the enum only. |
| STT and TTS | Are provider calls slow/failing, or is cache behavior changing? | Compare `speech-stt-provider`, `speech-tts-provider` and `speech-tts-cache`, then inspect successful billing observations separately. |
| Workflow operations | Which background operation or delivery stage is slow, failing or rejected? | Filter by the exact operation name and inspect its children. Idle outbox polls have separate summary counts. |
| UI actions and authentication | Which callback, API endpoint or auth operation is slow/failing? Are samples being dropped? | Compare callback outcomes with server HTTP and auth provider outcomes; inspect action/request IDs. Text edit counts and collection losses have separate tables. |

**HTTP semantics.** Every registered method/route is discovered from the running
Express registration tree and checked by an exhaustive inventory test. Actual router
mount paths are captured during registration, without manual prefix annotations.
Generic handlers run inside an active HTTP root until finish/close, parenting their
child operations. Chat, speech, voice and invocation retain their deterministic
business workflow roots; a captured workflow scope parents the HTTP completion
observation even when the service returns before headers are written.
The monotonic duration score excludes
wall-clock jumps and is bounded to seven days; traffic counts use outcome samples
and still include longer requests. In-flight requests are absent. SSE duration is
the response lifetime, not handler execution time or time to first byte. A close
before finish is an abort. The 4xx/5xx numerators count completed responses of that
class; their denominator is all recorded terminal attempts, with zero contributed
by aborts. Auth/body-parser/rate-limit rejections retain the registered route template.
Implicit HEAD/OPTIONS and CORS preflight are measured; unknown requests use
`unmatched`, and static resources use fixed categories. No request URL, query,
headers or body is exported. Browser-supplied UUIDs are correlation metadata only;
they cannot select an HTTP root identity.

**WebSocket semantics.** All 16 control DTO variants are accounted for: 15 dispatch
operations plus pong in a bounded heartbeat/session summary. Dispatch latency
excludes queue wait. `ws.control.failed` measures throws; `ws.control.rejected`
also measures handled wire errors. Invalid controls have their own rejection name
without exporting their unvalidated type/content. Upgrade acceptance/rejection,
abandonment, socket errors and close reasons are measured. Accepted/rejected uplink
frames and bytes are summarized per turn/reset/close, never one span per audio frame.
Turn and device lifecycle spans retain the voice workflow.

**Coverage boundaries.** Coverage means all current route registrations, UI action
sites and server workflow entry points are instrumented. It does not promise delivery
of every event through bounded queues or during outages. It does not create a span
for each store/helper function. Native model/tool spans, RAG stages, speech stages
and fixed workflow operations provide useful internal detail. Coverage tests guard
the catalogs. Payload capture remains opt-in; transport headers, provider blobs and
raw exceptions stay excluded. Opting in exports intended model/tool content verbatim,
so private values present in that content are not automatically redacted.

**Retrieval semantics.** `rag.duration_ms` and `rag.failed` exist per stage.
Embedding deadline expiry has its own `rag.timeout` sample. Successful search and
auxiliary lookups emit `rag.result_count` and `rag.empty`; failed searches do not
invent successful empty-result samples. Root `rag.skipped` includes unavailable
memory and enforced prefilter skips. Root `rag.fallback` measures tolerated
embedding/search/auxiliary failures among available-memory retrievals. Standing
counts precede character-budget selection. Root wall time includes overlapping
stages: adding stage times or percentiles gives the wrong critical-path latency.
Hit counts measure retrieval behavior, not relevance or answer accuracy.

**Tools and speech.** Tool completion scores distinguish returned `{ ok: false }`,
thrown errors and cancellation without recording arguments or results. The SDK
TOOL span remains the execution span; a result companion is not another tool call.
Speech provider timings measure the whole buffered SDK call, not first audio.
TTS character counts refer to capped provider input; STT audio length is reported
by the provider on successful responses only. Cache hit/miss fractions include
eligible requests only; hits include callers sharing an in-flight synthesis.
Bypass fractions include all requests through the cache wrapper. A cache hit does
not create another billable provider call. Speech usage (`gen_ai.request.model`,
`bob.speech.input_units`) is set as attributes on the speech wrapper span
(`speech-stt-provider` / `speech-tts-provider`) after the SDK's `ai.transcribe` /
`ai.generateSpeech` child has ended; the child carries no usage and is not a second
call. There are no separate `tts-synthesis` / `stt-transcription` spans.

**Usage and cost (#999).** Each provider call is priced once, on its own span:
an AI SDK `languageModel` or `embedding` span (never its `operation` parent, which
repeats the same usage) or a speech wrapper span (never its SDK child).

| Unit | Source | Reported by the provider |
| --- | --- | --- |
| `input_tokens` | `gen_ai.usage.input_tokens` minus cache reads and writes (uncached input) | yes |
| `cache_read_tokens` | `gen_ai.usage.cache_read.input_tokens` | yes, when the provider caches |
| `cache_write_tokens` | `gen_ai.usage.cache_creation.input_tokens` | yes, when the provider caches |
| `output_tokens` | `gen_ai.usage.output_tokens` (absent on embeddings) | yes |
| `audio_seconds` | `bob.speech.input_units` on `speech-stt-provider` | yes, on a successful response |
| `characters` | `bob.speech.input_units` on `speech-tts-provider` | no: counted locally, so never `complete` |

Prices come only from a versioned snapshot in `BOB_COST_RATES` (JSON, empty by
default, so nothing is priced and every call is `unknown`):

```json
{ "version": "2026-10-a", "pricingDate": "2026-10-01", "currency": "USD",
  "rates": [{ "provider": "example", "model": "example/stt-model", "unit": "audio_seconds", "perUnit": 0.0 }] }
```

`provider` is the model id's namespace before `/` (otherwise `gen_ai.provider.name`)
and `model` is the full `gen_ai.request.model`. An invalid snapshot is reported once
as `v2.telemetry_export_failed kind=cost_rates_invalid` (never its value) and prices
nothing. The example is a placeholder, not a price. The repo holds no verified
provider price: the paused Langfuse project's Fish Audio STT rate was owner-supplied,
and its `openai/tts-1` entry no longer matches the configured TTS model.

| Attribute | Span | Meaning |
| --- | --- | --- |
| `bob.cost.status` | provider call | `complete` (every unit priced and provider-reported), `partial` (some unit unpriced or not provider-reported), `unknown` (nothing priced) |
| `bob.cost.estimate` | provider call | Estimated cost in `bob.cost.currency`; absent when `unknown`, never 0 for a missing price |
| `bob.cost.provider_calls` | local root | Provider calls under this local root that ended before it |
| `bob.cost.total_status` | local root | `complete` only when every call is; `partial` when any is priced; `unknown` otherwise |
| `bob.cost.total_estimate` | local root | Sum of the priced calls' estimates; absent when none is priced |
| `bob.cost.currency`, `bob.cost.rates_version`, `bob.cost.pricing_date` | any span with an estimate | The snapshot that produced it |

Totals are per local root (no parent, or a remote one), not per trace: web voice
runs the chat turn and each sentence's synthesis as separate roots in one seeded
trace, so sum `bob.cost.total_estimate` over a trace's roots for the trace. A root
with no provider call gets no total: absent means unknown, not zero. A TTS retry makes
two provider calls inside one wrapper but counts its characters once (already `partial`). A
speech asset or cache hit makes no synthesis call, so its turn total covers STT and
the model only. A provider call that ends after its root (detached work has its own
trace) is not in the root's total. Cost is never derived from durations or transport
time. Backend-computed `gen_ai.usage.cost*` values, where a backend adds them, are
separate and unverified. Account events appear as
`account-event` span events (attribute `bob.account_event`, the type only) on
the span that published them, not as spans of their own.

**Device-turn trace shape.** A device turn is one trace with exactly one root,
`device-turn`, opened at `turn_start` and ended once when the turn ends
(completed, empty, failed, cancelled, or the socket closing mid-turn; ERROR with
`workflow_failed` on failure). Its trace id is the same deterministic id as
before (`{ session.id, turn_ref }`). Every span of the turn is its descendant and
carries `session.id` (the WebSocket session id), `bob.conversation.id` / `gen_ai.conversation.id` (the active conversation when known, source `device`), `user.id` (omitted when unpaired),
`bob.turn.id` and `bob.trace.name=device-turn`:

```
device-turn
├─ ws.control.turn_start ─ device-turn-started
├─ ws.control.device_log ─ device-log        (per turn_ref)
├─ ws.uplink
├─ ws.control.turn_end ─ device-turn-ended
└─ turn-pipeline ─ STT, agent, TTS, playback spans
                  └─ ws.downlink        (one per reply; an announcement's nests under device-announcement)
```

`ws.uplink` is the server's receive window: it starts at the first counted
audio frame (accepted or rejected) and ends when `turn_end` is accepted. Its
metrics are `ws.uplink.accepted_frames` (10 ms PCM frames, accepted bytes / 320,
since one `audio_up` message may batch several), `ws.uplink.rejected_frames`
(rejected messages: a rejected one carries no counted bytes) and
`ws.uplink.bytes`. The window is measured on the server clock and is neither
microphone capture time nor one-way network time. STT, the agent and playback
fall outside it. Frames that arrive after `turn_end` (or in a cancelled or
disconnected turn) are exported at reset as a separate `ws.uplink` span.

`ws.downlink` covers one reply's audio, measured on the server clock. It
starts when the first `audio_down` frame is handed to the socket and ends once
the last frame has been sent, cut off, or abandoned. `metadata.outcome` is one
of:

- `completed`: every frame was handed to the socket.
- `cancelled`: a cancel stopped the stream.
- `socket_closed`: the socket closed mid-stream.
- `stalled`: backpressure outlasted 10 s.
- `cut`: a streamed reply stopped at a sentence boundary, at the size cap or
  on a TTS failure.

When no frame went out (a stall or cancel before the first frame), the span
starts at the moment it is flushed.

Metrics: `ws.downlink.frames`, `ws.downlink.bytes`,
`ws.downlink.pacing_wait_ms` (waiting on the device-ring model or the fixed
interval) and `ws.downlink.backpressure_wait_ms` (held because the socket
buffer was above its watermark). A frame held by backpressure is sent once the
pressure clears; it is never skipped. Handing a frame to the socket is not
device receipt or playback, which only the device can report (#1004). The
turn's `first_audio_ms` keeps its meaning: the first frame handed to the
socket after the pipeline started.

### Device turn timing (`device-turn-timing`, #1004)

The device's side of a turn arrives after the turn: one `turn_timing`
summary (wire contract in `apps/api/src/voice/protocol-timing.ts`), sent only
by firmware whose hello advertised cap `turn_timing` and whose welcome
acknowledged it, after the reply drained, was stopped or failed. The server
exports it as its own **detached** span `device-turn-timing` with
`bob.trace.name=device-turn`, the turn's `session.id`, `bob.turn.id`,
`user.id` and conversation: joined to the turn by those ids, never nested
under or written into the turn's root (which has already ended and never
waits for the device).

Every value is whole milliseconds on the **device's** monotonic clock
(`millis()`), measured from that turn's capture start (the mic opened; for a
follow-up turn, the speech onset that opened it). Subtracting one device
offset from another is a valid same-clock interval; subtracting a device
offset from any server timestamp is not, and nothing does.

| Metric `device.turn.*` | The device-clock moment |
| --- | --- |
| `capture_end_ms` | the mic closed (`end_reason`) |
| `first_up_ms` | the socket took the first `audio_up` frame |
| `turn_end_ms` | `turn_end` was queued for the socket |
| `playback_start_ms` | this turn's `playback_start` control was accepted |
| `first_down_ms` | the first `audio_down` frame reached playback |
| `decoder_ready_ms` | the MP3 decoder's `begin()` succeeded (PCM has none: skipped) |
| `speaker_submission_ms` | the speaker API (`playRaw`) accepted the first reply samples |
| `playback_end_ms` | the reply was torn down: drained, stopped or failed |
| `end_to_speaker_ms` | `speaker_submission_ms - capture_end_ms` (same clock) |
| `up_frames`, `down_frames` | frames the socket took, frames playback received |

`speaker_submission` is not audible onset: the I2S DMA and the amplifier
follow it, and acoustic onset stays unknown (not measured). A muted reply
(`metadata.muted=true`: muted at capture start, `playback_start` or the end) is still submitted, at gain 0. DND silences only earcons and announcements, never a reply, so it is not recorded. There is no RTT and no
one-way network time in the summary.

Missing values are explicit: a number is measured (0 is real), `null` means
the step did not happen this turn (listed in `metadata.skipped_milestones`),
and an absent key means unknown (`metadata.unknown_milestones`, e.g. more
than 10 minutes after capture start). Other metadata: `activation_source`
(`ptt` | `wake` | `follow_up`), `board` (the hello's board id, e.g.
`waveshare-s3-185c`), `capture_end_reason` (`release` | `silence` |
`max` | `key` | `uplink` | `no_speech` | `error`), `outcome` (`drained` |
`empty` | `interrupted` | `failed` | `cancelled`) and `format` (`mp3` |
`pcm16`).

Correlation is bounded: per session at most 8 expected turns, each for 180 s
while running and 60 s after its pipeline unwound or was cancelled. A summary
for a turn the session never started (a wrong ref, or one from before a
reconnect: a new socket is a new session), an expired, duplicate or
out-of-order one is journaled as `v2.device_turn_timing_ignored` and
otherwise dropped. The server never answers a summary, since a device error
mid-turn would fail its next turn. The payload has only enums, booleans and
bounded integers: no audio, transcript, prompt or free-form device text.
Roll back by not acknowledging the cap (old servers never do) or by
restoring firmware without it.

Spans not tied to a turn (hello, device_state, pings) keep their own roots but carry the same
three ids. User, conversation and session are independent dimensions, never derived from one
another: a conversation (incl. a shared space thread) has many users and sessions, and `user.id`
is always the acting account of that request or turn.

**Conversation resolution.** Every span and journal line names a conversation, resolved in this
order, and `bob.conversation.source` (journal `conversation_source`) says which rule won:

1. `explicit`: the conversation the interaction is about (a turn, message, invocation, a
   `/api/conversations/:id` or `/api/threads/:id` route, a space thread). Background work created in a
   conversation names it too: a reminder, timer or alarm stores the conversation it was created in
   (`bob.reminders.origin_conversation_id`, from the `explicit`/`client`/`device` correlation at create
   time), and its fire (reminder fanout delivery for the recipient who created it, `timer-fire`) carries it
   as `explicit`, even after the user moved to another conversation.
2. `client`: web only, the conversation open in the browser, sent on every API request as
   `X-Bob-Conversation` (canonical-id format check; telemetry only, never authorization or data access).
3. `device`: the device session's active conversation.
4. `active`: for a span that has a user and no conversation (a web request without the header, background
   work for a user such as the reminder fanout, timer fires, notification delivery and notification email; a
   paired device message with no conversation of its own), the user's active-conversation pointer. One
   mechanism in `@bob/ai`: `traceSpan`/`traceWorkflow` resolve it once through the cached reader
   (`setActiveConversationResolver`; 5 s per-user cache, primed by `getActive`/`setActive`), so background
   code only states whose work it is by passing `userId`. The reminder fanout and the timer sweep resolve
   the fallback for their rows without an originating conversation in ONE read per pass
   (`bob_private.active_conversation_ids`), and pass `none` for a user with no pointer, so no job looks
   one up on its own. The request path never waits for it: the auth guard
   stamps the request root when the lookup resolves, while the root is still open. A caller that knows there
   is none passes `conversationSource: 'none'` (device `turn_start`, which reads the pointer itself).
5. `none`: the literal `none` for system work (outbox, sweeps, startup) and anything before
   sign-in or pairing (auth, pairing).

The browser's per-tab session id (`X-Bob-Client-Session`, a UUID, otherwise ignored) is stamped
as `session.id` on the request root and everything below it, also on unauthenticated requests.

A cross-origin client (the Capacitor app) may send `X-Bob-Client-Session`, `X-Bob-Conversation`,
`X-Bob-Ui-Action-Id`, `X-Bob-Ui-Request-Id` and `X-Bob-Expected-Updated-At`; `cors.ts` lists them in
`Access-Control-Allow-Headers` for allowed origins only.

**Speech spans.** `ai.transcribe` spans are labelled `gen_ai.operation.name = transcription` and
`ai.generateSpeech` spans `text_to_speech` (matched on the AI SDK operation id); only real language-model
calls stay `chat`. The label is set when the span starts and the empty-cost drop happens when it
ends, both in `CorrelationSpanProcessor`; the scrub only allowlists. A `gen_ai.usage.cost*` of 0 or -0
on a span with no token usage is dropped.

Trace history from before 2026-10-08 lives in the paused Langfuse project until it
is deleted; nothing reads or writes it any more.

Recorded telemetry is bounded and best-effort. Missing samples and exporter loss
prevent interpreting these fractions as an availability SLO; compare each metric's
own count, and inspect individual traces before attributing an incident.

### AI turns

Every agent turn — device, web chat, or thread invocation — produces one trace
(one trace per turn, grouped by `bob.conversation.id` and `session.id`,
tagged by surface in `bob.tags`: `device`, `web`, `invocation`). Each span carries
`bob.turn.id`: the same id as the journal's `v2.turn_stage_*` `turn_id` for that
turn (the device's `turn_ref`), and journal lines written inside the turn carry the
span's `trace_id`, so a trace joins back to the journal by either id (see
`docs/log-reference.md`).

By default a trace carries **metadata only**:

- model id, latency, and token counts (cost where the gateway reports it);
- tool calls by name (never their arguments);
- finish reason and error class.

No prompt, transcript, reply text, or tool argument leaves the machine in the
default configuration.

### Privacy switches

| Switch | Effect |
| --- | --- |
| `BOB_TRACE_PAYLOAD=1` | Capture prompts, replies, and tool payloads in spans. Off by default (metadata-only). Development only: prompts and replies would leave over OTLP to every configured backend, so with `BOB_PRODUCTION=1` the server refuses to boot and journals `v2.payload_flag_error` (#1039). |
| `BOB_DEBUG_PAYLOAD=1` | With `BOB_DEBUG=1`, print transcripts and tool payloads to stdout, which is the platform log. Development only: production refuses to boot with it, the same way (#1039). |

The secret scan flags a real value bound to `OTEL_EXPORTER_OTLP_HEADERS`,
`OTEL_EXPORTER_OTLP_TRACES_HEADERS` or `BOB_OTLP_EXTRA_TRACES_HEADERS` (they carry
auth), and to a legacy tracing-vendor secret key (stale `.env` files may still hold it),
so none of them reaches a commit.

## One context across all surfaces

Every surface injects the same context (`ObservabilityContext`,
`apps/ai/src/telemetry.ts`): `surface`, `turnId`, `sessionId`,
`userId`, `workflowId`, `workflowNamespace`, and short `metadata`. Turn paths convert it with `toTraceAttrs`
(device, web chat, thread invocations); milestone paths (welcome, presence,
announcements, OTA, pairing) convert it with `toSpanAttrs` and open it with
`traceSpan`, which isolates instrumentation failures while preserving application
results and errors.

- **Server** imports the context only through `@bob/ai`; the turn id is
  exported as `bob.turn.id`, the journal's `turn_id`.
- **Browser** takes zero workspace imports and runs no tracing or vendor SDK. It
  sends metadata-only UI events and feedback (Helpful/Unhelpful) through the
  authenticated `POST /api/telemetry` route; the server creates their spans.
  Client voice timings such as end-of-speech to first audio arrive the same way and
  become `bob.metric.*` samples on the server-created turn trace. Existing
  operator metrics and state transitions continue through journal analytics.
- **Cardputer** speaks the context as `session_id` + `turn_ref` on the wire
  (`apps/api/src/voice/protocol.ts`); the server stamps both into
  spans on the device's behalf. No SDK runs on firmware.

## Browser workflows and feedback

Browser voice sends one validated workflow UUID through transcription, chat
and speech requests. The server scopes that identity to the authenticated
account and returns the actual trace ID. Regeneration starts a new execution.
The browser reports end-of-speech to first-audio timing against that trace and
Helpful/Unhelpful reply feedback through `POST /api/telemetry`; the server records
both as `bob.metric.*` samples on the trace. No browser key or vendor API exists.
Session reply versions retain their trace IDs; historical replies loaded
without trace metadata have no feedback controls. No historical IDs are
invented. Samples are best-effort and cannot block a reply.

## Stage and background spans

Device transcription and synthesis have dedicated stage spans under the turn
workflow. Memory extraction and outbox delivery open detached roots, so work
started by a timer cannot inherit an unrelated request context. Invocation
journal events include `turn_id` alongside `invocation_id`.

Fixed workflow operations cover timer sweep/fire/refresh, reminder fanout, memory
scan/account/extract/write, pairing expiry, notification channels and actual email
sends, outbox dispatch/retry/heartbeat, account events, device pushes/announcements,
presence and module/server lifecycle. `workflow.duration_ms`, `workflow.failed`
and `workflow.rejected` include explicit handled outcomes. Skipped work and thrown
failures remain distinguishable in metadata. Empty outbox polling is coalesced into
`workflow.polls.empty` minute summaries and excluded from actual work latency.
Synchronous callbacks stay synchronous; detached roots clear both native OTel and
Bob workflow context so scheduler work cannot become a stale request child.
The standalone outbox entry also reports startup, once-per-minute health and
shutdown. Its final telemetry flush has a one-second deadline; stalled drains keep
their failure exit and are not awaited during supervisor restart.

Auxiliary model calls have purpose spans `bob-memory-embedding`,
`bob-memory-embedding-batch`, `bob-memory-extractor`, `bob-memory-judge`
and `bob-eval-judge`. Their native SDK children carry actual usage/cost. Purpose
spans are not additional billable model calls. Every call uses the same explicit
input/output capture flags. SDK resource detection is disabled and service name
is fixed to `bob`, preventing default process-path metadata.

Delivery operations wrap real work, while a few existing journal companions retain
bounded count/reason metadata (`apps/api/src/platform/observability/delivery-span.ts`).
Operation metrics do not copy arbitrary journal fields. No recipient, title,
notification text or URL is exported.

| Span | Journal line | Metadata |
| --- | --- | --- |
| `reminder-fanout` | `v2.reminder_fanout` / `_failed` | Actual sweep duration and `ok`, `failed` or `skipped` outcome; detailed counts remain in the journal. |
| `outbox-tick` | `v2.outbox_tick` / `_failed` | Actual work/error batch duration and outcome; idle polls have separate summaries, detailed counts remain in the journal. |
| `outbox-release-failed` | `v2.outbox_release_failed` | Bounded `error_name` journal companion. |
| `email-notification` | `v2.email_notification_sent` / `_skipped` | `outcome` (`sent`, `skipped`), `template`, `reason` |
| `email-send` | `v2.email_sent` / `v2.email_send_failed` | Actual send duration and `ok`, `failed` or `skipped` outcome; provider responses are not captured. |
| `notifications-enqueued` | `v2.notifications_enqueued` | `type`, `count`, `muted` |

## Bounded device diagnostics

Firmware sends `device_log` only when the server welcome advertises support.
The payload contains a fixed event enum and unsigned numeric uptime/free-heap/
largest-heap counters, with an optional validated turn reference. It never
forwards free-form journal text, audio, prompts, URLs or credentials.
Both firmware and server limit acceptance to one event per second; only
authenticated device/legacy sessions are accepted after hello.

Diagnostics use a 320-byte stack buffer and the existing control queue only
when empty. They are best-effort, with no retry queue, SDK or persistent log
buffer; normal device traffic takes priority. Old servers do not advertise
support and receive no new message type. The initial static RAM delta was
8 bytes; firmware memory gates and physical HIL remain delivery requirements.

## Operator access (scopes)

The operator metrics API (`/api/operator`) is open only to accounts holding the
scope `metrics.operator` (table `bob.user_scopes`, read by
`apps/api/src/platform/observability/operator-gate.ts`). Everyone else, and
every request when the check cannot be answered, gets the same 404 an unknown
route gets, so the surface is never advertised. A database error fails closed
and writes one `v2.operator_scope_check_failed` line carrying the error name only.
The answer is memoised per account for 60 seconds, so a grant or revoke takes
effect within a minute.

Grant, revoke and list with the admin CLI (`scripts/user-scope.mjs`), which runs
as the database admin through the Supabase CLI. `--local` or `--linked` is
required, and `grant` and `revoke` refuse without `--yes`:

```
node scripts/user-scope.mjs grant  --email you@example.com --scope metrics.operator --yes --local
node scripts/user-scope.mjs revoke --email you@example.com --scope metrics.operator --yes --linked
node scripts/user-scope.mjs list   --email you@example.com --linked
```

`list` prints the scope names the account holds. If the Supabase CLI fails with
a config error about `SEND_EMAIL_HOOK_SECRET`, export a throwaway value
`v1,whsec_<base64>` for that command only. Optional emergency override:
`BOB_OPERATOR_USER_IDS` (comma-separated account uuids) lets those accounts in
as well as scope holders. Leave it unset, the default, for scopes only.

## Relationship to the server journal

Traces and the server journal (`docs/log-reference.md`) are joined two ways. By
trace id: every journal line written inside a span carries that span's `trace_id`
and `span_id`. By turn: every
span carries `bob.turn.id` (`apps/ai/src/telemetry.ts`) and every
`v2.turn_stage_*` line carries `turn_id`. To find a turn's trace, grep the journal
for its `turn_id`, then search spans for `bob.turn.id`. Traces obey the same
Constitution II rule as the journal — metadata only; payload capture needs
`BOB_TRACE_PAYLOAD=1`.

## On deployment

Tracing works unchanged on a hosted server: set the `OTEL_*` variables (secret
headers as secrets), or let a platform that injects them do so. No code or provider name changes either
way. The server flushes buffered spans when it receives
SIGTERM/SIGINT (`v2.shutting_down`). Flushing is best-effort and bounded by a forced-exit
deadline; a restart or exporter outage can lose the tail. Export failures land in the journal as
`v2.telemetry_export_failed { kind }` instead of dying silently. Deployed
traces are metadata-only by construction: payload capture is development-only, and a
production server with `BOB_TRACE_PAYLOAD=1` or `BOB_DEBUG_PAYLOAD=1` refuses to
boot (`v2.payload_flag_error`, #1039).

## Running evals

The suites live in `apps/ai/evals/` with synthetic fixtures in
`apps/ai/evals/data/` — never real conversations.

- `npm run eval` — runs every suite in-process and prints per-scorer means;
  nothing is uploaded.
- `npm run eval:local` — runs the same suites.

Both need `AI_GATEWAY_API_KEY` (the judge scores through the AI Gateway); a
suite refuses to run without it rather than score stub output. Live suites are
on-demand only — they are not part of `npm run validate`.

### What each suite scores

| Suite | Scorer(s) | What it measures |
| --- | --- | --- |
| `voice-reply` | `lengthCap700`, `endsAtSentence`, `noMarkdown`, `isEnglish` | The reply rules the device depends on: ≤ 700 characters, ends at a sentence boundary, no markdown, English. |
| `tools` | `toolNameMatch` | Whether the agent called the tool the fixture expects. |
| `continuity` | judge ("uses the fact from earlier turns") | Using a fact introduced two turns earlier — the follow-me behaviour 008 depends on. |
| `quality` | judge ("factual agreement") + `noMarkdown` | Overall answer quality against a reference, on speakable replies. |

## Baseline

First real run (2026-09-11):

| Suite | Score |
| --- | --- |
| continuity | 77.5% |
| quality | 100% / 100% (judge / noMarkdown) |
| tools | 87.5% |
| voice-reply: `lengthCap700` | 90% |
| voice-reply: `endsAtSentence` | 100% |
| voice-reply: `noMarkdown` | 80% |
| voice-reply: `isEnglish` | 100% |

Re-run with the recreated fixtures (2026-09-14):

| Suite | Score |
| --- | --- |
| continuity | 75% |
| quality | 98% / 100% (judge / noMarkdown) |
| tools | 90% |
| voice-reply (all scorers) | 100% / 100% / 100% / 100% |

The 2026-09-14 run used fresh synthetic fixtures (the original
`apps/ai/evals/data/*.json` had never been committed — the root `data/`
gitignore rule hid them; `.gitignore` now negates the eval fixtures).

`noMarkdown` and `lengthCap700` are the known gaps. The agent prompt needs a
tighter instruction to keep replies under 700 characters and free of markdown —
a prompt change, then re-run `npm run eval:local` to compare against this
baseline before shipping.

