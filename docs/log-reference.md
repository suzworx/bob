# Bob Log Reference

Two log streams describe every turn: the **server journal** (JSON lines, tail
with `npm run api:monitor` which mirrors into `data/api.log`) and the **device
serial output** (`data/device.log` via `npm run device:monitor`, plain text
lines). The server-assigned `session_id` links the two streams together.
`npm run monitor` multiplexes both streams into one terminal — cardputer serial
lines prefixed `DEV ` and teed to `data/device.log`, server journal lines
prefixed `API ` and teed to `data/api.log`.

### Where the journal lives

The journal path is cwd-relative: it defaults to `data/v2-journal.log` under
the server's working directory (`BOB_V2_JOURNAL`, `platform/logger.ts:10`). Runs
through the npm workspace (`npm run dev` / `start`, and the
`deploy` workspace script) execute with `cwd = apps/api`, so they write
`apps/api/data/v2-journal.log`; a server started directly from the repo root
writes `data/v2-journal.log`. `npm run api:monitor` and `npm run monitor` pick
whichever of the two is newest at startup (`scripts/tee-log.mjs:71-86`). In the
Docker image the path is fixed to `/data/v2-journal.log` (`Dockerfile:44`).

`npm run dev:all` additionally mirrors each dev server's own console into
`data/dev-api.log` and `data/dev-ui.log`. Those carry what the journal cannot:
tsx and vite compile errors, unhandled rejections and their stacks, port-bind
advice — everything a crash prints on its way out, which otherwise existed
only in terminal scrollback.

Every log here is size-capped and rotated: at 8 MB the live file becomes
`<name>.1.log`, older generations age to `.2` and `.3`, and the fourth is
dropped (`BOB_LOG_MAX_BYTES`, `BOB_LOG_KEEP`). `npm run logs:clean` sweeps
the rotations along with the live files.

Privacy rule: neither stream ever contains audio, transcripts, agent text,
credentials, URLs, headers, or prompts. The one exception is the opt-in debug
log described at the end of this document, which records that payload
deliberately and is git-ignored for exactly that reason.

---

## Server journal — `data/v2-journal.log`

JSON lines: `{"ts":"<ISO 8601>","level":"info","event":"v2.<name>","message":"v2.<name>","source":"api","module":"<module>","...fields","trace_id":"<32 hex>","span_id":"<16 hex>"}`. `ts` is UTC.

The envelope keys are written by the logger and are reserved: a field a caller
passes under the same name is dropped. Railway's log explorer reads stdout JSON
lines, so these keys are what it shows and joins on:

| Key | Value |
| --- | --- |
| `message` | The event name again, so Railway shows a message instead of an empty row. |
| `level` | `error` when the event name ends with `_failed`, `_error` or `.error` (for example `v2.turn_failed`, `v2.turn_stage_stt_failed`, `v2.error`, `v2.ota.error`), otherwise `info`. Railway uses it as the severity. |
| `source` | Which surface wrote the line: `api` (the server), `ai` (`apps/ai`, including the opt-in debug log), `web` (browser telemetry the api accepted, `v2.web_telemetry`) or `device` (firmware diagnostics the api accepted, `v2.device_log`, `v2.device_state`, the device-reported `v2.device_settings_changed`). Always present. |
| `module` | The feature that wrote the line, so `@module:voice` isolates one area. Present on every line except those from the bare `journal` (none in `apps/api/src`). See "Modules" below. |
| `user_id` | The acting account, from the request or turn's correlation context. Absent outside one. A caller's own `user_id` wins (never duplicated). |
| `conversation_id` | The canonical conversation the line belongs to, or the literal `none`. A caller's own `conversation_id` wins. |
| `conversation_source` | How `conversation_id` was resolved: `explicit` (also when the caller passed its own id, and on a reminder or timer fire for the conversation it was created in), `client`, `device`, `active` or `none`. Reserved. Rule: [observability](observability.md). |
| `session_id` | The client session: the device's WebSocket session id, or the browser's per-tab UUID. Absent outside a session. |
| `trace_id` | The trace the line was written under, from the active OpenTelemetry span. Absent when there is no valid active span. |
| `span_id` | The span the line was written under; present exactly when `trace_id` is. |

Every other key is a filterable attribute in Railway: search `@event:v2.turn_failed`,
or `@level:error`. To read every line of one turn, take its `trace_id` and search
`@trace_id:<id>`; the same id opens the turn's trace. A line written outside any
span (boot, timers, background workers) has neither key. The console and the
file sink get the identical line, and the privacy rule above still holds: the
envelope adds ids, the event name, `source` and `module`, nothing else. The id keys
(`user_id`, `conversation_id`, `conversation_source`, `session_id`) come from the same
correlation context as the span attributes, so a line and its span always agree.

**Modules.** `module` is the folder under `apps/api/src/` that holds the code
(`account`, `calendar`, `conversations`, `devices`, `firmware`, `google`, `memory`,
`notes`, `notifications`, `platform`, `spaces`, `tasks`, `timers`, `voice`, ...),
`server` for files directly in `apps/api/src/` (boot, startup, wiring) and `ai`
for `apps/ai`. Every module file journals through `const journal =
moduleJournal('<module>')`; `apps/api/tests/platform/module-journal.test.ts`
fails a file that imports the bare `journal` or tags itself with another
folder's name. Device lines (`source=device`) are `module=devices`. Browser lines
(`source=web`) take the module that owns the page or area: `chat` →
`conversations`; `spaces`, `calendar`, `memory`, `voice`, `notifications` → the same
name; `devices`, `pair` → `devices`; `account`, `usage`, `signin`, `reset`, `invite` →
`account`; `metrics` → `platform`; `gmail`, `connectors` → `google`; `productivity` →
`tasks`; anything else → `other`. A caller field named `source` or `module` is
dropped like the other reserved keys. `v2.device_log` with a `turn_ref` is journaled
inside that turn's trace, so its `trace_id` matches the turn's other lines.

**OTLP log export.** The same lines can also be exported as OpenTelemetry log
records. It is off unless `OTEL_LOGS_EXPORTER=otlp` is set explicitly and an
endpoint is configured (`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` or
`OTEL_EXPORTER_OTLP_ENDPOINT`); stdout and the file sink are unchanged either way.
Each record has scope `bob.<module>`, a severity from `level`, the event name
as its body, every other field as an attribute under the same name as the stdout
line (`user_id`, `conversation_id`, `conversation_source`, `session_id`; never the
span names `user.id` or `bob.conversation.id`, so Railway and OpenObserve logs are
queried with the same keys), and the active trace and span.
`initTelemetry` starts it and `flushTelemetry` flushes it (`logs_flush_failed`
is reported once if that fails). The opt-in debug log never goes through it.

| Event | When | Key fields |
| --- | --- | --- |
| `v2.listening` | Server started | `port`, `host`, `path`, `journal` |
| `v2.database_url_missing` | The server refused to boot: `BOB_DATABASE_URL` is unset or empty and there is no stand-in database (`startup.ts`). It exits 1 after this line; run `npm run dev:offline` or point the URL at the local Supabase stack | — |
| `v2.database_url_unreachable_host` | A production server (`BOB_PRODUCTION=1`) refused to boot: `BOB_DATABASE_URL` points at the Supabase direct host `db.<ref>.supabase.co`, which is IPv6-only and unreachable from Railway (#1306, `startup.ts`). It exits 1 after this line; use the Session pooler connection string. The URL, host and credentials are never logged | — |
| `v2.payload_flag_error` | Error level. The server refused to boot: `BOB_PRODUCTION=1` with `BOB_TRACE_PAYLOAD=1` or `BOB_DEBUG_PAYLOAD=1`, which would send prompts, replies or transcripts to the trace backends or the logs (`startup.ts`, #1039). One line per flag set, before every other boot refusal; it exits 1 after them. Unset the flag on the deployment | `flag` (the flag name). Never a value |
| `v2.ai_key_error` | Error level. The server refused to boot on the wrong AI Gateway key (`startup.ts`, #1041): under `BOB_PRODUCTION=1` the key's fingerprint matches `BOB_DEV_KEY_FINGERPRINT`; on any other server it matches `BOB_PROD_KEY_FINGERPRINT` and `BOB_ALLOW_PROD_KEY=1` is not set. A fingerprint is the first 8 hex characters of the key's SHA-256; a malformed one also refuses. It exits 1 after this line. Use the dev/test key locally and the production key only in production | `production` (true/false). Never the key or a fingerprint |
| `v2.connected` / `v2.closed` | Socket opened / closed | `peer` (IP), `code` (close code, `1006` = abnormal). On a close the server started, `code` is the one the peer sent back: after a revoke's 4003 the Cardputer echoes `1000` (HIL run 20260929-110910-342e), and no line journals the code the server sent |
| `v2.hello` | A hello arrived (#345), before `v2.welcome` or `v2.pairing_required` | `board` (WS185-SERVER: the hello's board id, `cardputer` when absent; also on the `v2.turn_stage_*`, `v2.agent_tools` and `v2.agent_tools_degraded` events of device turns), `fw_version` (the firmware's SemVer, `unknown` when the hello has none, as older firmware sends, `invalid` when Zod rejected it: over 32 chars or not SemVer; the hello still stands), `caps_count` (only when the hello's `caps` were valid) |
| `v2.welcome` | Hello accepted, session becomes ready | — |
| `v2.update_required` | `BOB_MIN_FW_VERSION` is set and the device is below it (`welcome` carries `min_fw_version`, then `update_required` is sent). The session is not registered for pushes, and every message but `pong`, `device_state`, `check_update` and `ota_progress` gets `error` `UPDATE_REQUIRED` (a device below the minimum must still be able to fetch its update) | `reason` (`below_minimum` \| `unknown_version`), `fw_version`, `min_version` |
| `v2.min_fw_version_invalid` | `BOB_MIN_FW_VERSION` is set but not SemVer: it is ignored (no minimum), once per hello | — |
| `v2.ota.result` | A hello reported the outcome of a previous OTA attempt, journaled once per new event (a repeated hello is deduplicated) | `result` (the device-reported outcome, `ok` or a failure; `start` when the device sent `ota_progress` `start` (OTA-4B)), `board`, `from` (the running version, only on a failure), `to` (the version the attempt targeted), `reason` (failure reason code, when given) |
| `v2.ota.offer` | The device was offered a firmware version at hello or by `check_update` (OTA-4B), journaled once per new offer event (a repeat of the device's latest event is dropped) | `version` (the offered version only; never the URL, hash or key id) |
| `v2.ota.error` | An OTA step failed and was swallowed: the hello still gets its welcome (without an offer), a `check_update` is answered `offer: null`, an `ota_progress` is not recorded. Never delays or fails the session | `session`, `reason` (`hello_failed` \| `check_failed` \| `progress_failed`) |
| `v2.ota.halt` | A channel was halted for a board, by the 7-day outcome counts crossing the halt threshold (`attempts`, `rollbacks`) or by an operator (`halted`, true or false, also for a resume). Journaled only on the transition | `channel`, `board`, and `attempts`, `rollbacks` (automatic) or `halted` (operator) |
| `v2.ota.promote` | An operator pointed a channel at a release for a board (POST /api/operator/firmware/channel) | `channel`, `board`, `version`, `rollout_pct` |
| `v2.ota.download` | A firmware image response to a paired device ended (GET /v2/firmware/:board/:version.bin: 200, 206 or 304), once per response | `version`, `board`, `status` (`completed` or `aborted`), `bytes` (the body size, or bytes written before an abort) |
| `v2.message_skipped` | A message was not sent because the device's hello `caps` lack the token it needs (#345: `reply_text`). A device whose hello has no `caps` gets everything | `type`, `reason` (`no_cap`) |
| `v2.turn_started` / `v2.turn_ended` | Uplink capture open / closed | `turn_id` (the device's `turn_ref`, the same id as the turn's stage events, `v2.downlink_started` and `v2.turn_completed`, #396), `frames` (10 ms PCM frames received: uplink audio bytes / 320, since one `audio_up` message may batch several; `v2.turn_ended` only), `msgs` (`v2.turn_ended` only: the `audio_up` messages that carried them), `assistant_name` (`v2.turn_started` only: `bob` or `bob` when the device sent one in `turn_start`, absent when none, so it shows whether a selected name arrived) |
| `v2.turn_end_of_turn` | Server end-of-turn decision while the user is talking (#1365), once per decision. `sent` true on the decision that sent the turn's one `end_of_turn` control to a device with the `end_of_turn` cap; false means detected only, the device's own silence still ends the turn. `n` is the 1-based decision count this turn (above 1: the user resumed talking). Never text | `session`, `turn_id`, `sent` (bool), `audio_ms` (audio received so far), `silence_ms` (trailing silence at the decision), `n` (1-based) |
| `v2.turn_end_of_turn_failed` | Sending `end_of_turn`, its journal line, or the speculative-reply hook threw while the user talked (#1365); the uplink and the turn carry on | `session`, `turn_id`, `stage` (`send` or `hook`), `error` (the error name only) |
| `v2.audio_up` | One uplink frame accepted. Not emitted when `BOB_LEAN_UPLINK=1` (#1331); `v2.turn_ended` `frames` and `msgs` still carry the per-turn counts | `bytes` (payload bytes) |
| `v2.accumulate_full` | Turn buffer exceeded 1 MB | `bytes` → session reset with `QUEUE_FULL` |
| `v2.turn_stage_stt_started` / `v2.turn_stage_stt_completed` | Speech-to-text stage starts / finishes | `pcm_bytes`; completed adds `duration_ms`, `model` (the model whose text the turn used), `seconds`, `streamed` (true when the streaming transcript was used, `BOB_STT_STREAMING=1`), `fallback_reason` (`none` streamed; `disabled` no stream opened; `error` the stream failed or could not open; `deadline` no final within 1.5 s of turn_end; `not_ready` the provider never started reading by then; `empty` blank final for audio; every reason except `none` ran the batch STT), `stream_setup_ms` (turn_start until the provider first read audio, when it did), `stream_finals` and `stream_partials` (transcript finals and partials the stream saw), `stream_bytes_read` (audio bytes the provider read): every streamed attempt, counts only; `final_after_end_ms` (turn_end until the outcome settled, on every outcome where a final arrived, so a fallback after a late final still shows it); `from_partial: true` when the stream ended with no non-blank final but its partials had text, so the latest partial was used as the transcript and the batch STT was skipped (spec 015 FR-027; the text itself is never journaled) |
| `v2.turn_stage_prep_completed` (`interface: 'web'`) | Web chat (SIMPLIFY-U0B, spec 015 FR-003): one per `/api/chat` turn that reached the model, journaled at the model call, just before the stream opens (no `started` event; a turn refused before the model journals none). Names the web prep steps so the whole wait can be attributed | `turn_id`, `conversation_id`, `arrival_ms` (request reached the `webChat` handler → model call: the whole wait, including what `prep_ms` leaves out; also on the `turn_metrics` row), `prep_ms` (SIMPLIFY-U2B: the prep start, once the conversation is found, → model call; the same window as `v2.turn_stage_agent_completed.prep_ms` and the `turn_metrics` row's `prep_ms`), `prep_source` (always `inline`: the web turn has no early prep). `locate_ms` (finding the conversation: the Retry/regenerate lookup plus the conversation summary read) comes before the window. **Prep** (spec 015 FR-007 to FR-011): on a plain new message (text only, no integration mention) in an existing conversation every step starts at once: the app preflight and the message store (only a request that names an app waits for the preflight; otherwise only the app tools do); the scope read, then `memoryAvailable` and memory retrieval (retrieval waits for the preflight only when an app is named); the history load (without the message being stored, which is appended in memory); the game scope, capability groups and tool policy reads; the Google tools on a lazy anchor, once the scope reads a live private Space (never on a pair, group, archived or unreadable scope; discarded in an active game); the app tools (which wait for the store when an app is bound). The model starts when the history, scope, retrieval, game, capabilities, policy, Google and app tools are ready, not when the store is: every offered tool waits for the store before it executes (never after Stop or the timeout), and the reply opens and is saved only after it. A new conversation, an edit, a regenerate, a message with an attachment or an integration mention, or a request with an `appBinding` keeps the serial order (the store or truncation lands before the history is read; a generic bound app reads only the tool policy). A Stop before the store answers 409 `cancelled` and stores nothing. **Not comparable across SIMPLIFY-U2B:** from that commit the web `prep_ms`, the `turn_metrics` row's `prep_ms` and `since_prev_turn_ms` start once the conversation is found (before it, after the history load), so values before and after it do not compare. **Critical path** (each the time the turn blocked on that step, in order; they and `other_ms` sum to `prep_ms`): `app_preflight_wait_ms` (only when the request names an app), `document_wait_ms` (the document check; serial turns only), `store_wait_ms` (serial turns only), `history_wait_ms`, `scope_wait_ms` (scope plus `memoryAvailable`), `retrieval_wait_ms` (absent when memory is off), `app_tools_wait_ms`, `game_wait_ms`, `capabilities_wait_ms`, `google_wait_ms` (only on a live private turn outside an active game), `policy_wait_ms`, `build_ms` (agent and tool-map build, in process; absent with `game_wait_ms` onward when the build degraded), `other_ms` (the rest, floored at 0). **Own durations** (each from its own start to its settle; they overlap the critical path and each other; absent when the step had not settled or did not run): `app_preflight_ms`, `store_ms` (opening a new conversation with its first message, or storing the reader's message; usually absent on a plain new message, whose store settles after the model starts), `scope_ms` (`getConversationScope` plus `memoryAvailable`), `history_ms`, `app_tools_ms` (the app extension's bound or marketing tools), `game_ms`, `capabilities_ms` (private Space and the productivity, timer and late tool groups), `google_ms` (the Google tool offer and grant check; with a Google runtime only), `policy_ms`. Integer ms and the enum only, never text, a message id other than `turn_id`, a URL or a credential |
| `v2.turn_stage_prep_started` / `v2.turn_stage_prep_completed` | `cardputer` (#1331; the web event is the row above): brackets the agent stage's prep window, from the stage start to the model call, so `prep_ms` can be attributed to its sub-stages. Journaled just before `v2.agent_tools` and `v2.turn_stage_agent_started` | started: `board`, `paired` (the turn has an account context), `conversation_id`. completed: `board`, `conversation_id`, `prep_ms` (the same window as the agent event's `prep_ms`, up to that event's journal writes), `prep_source` (`early`: the prep started at `turn_start` was used, and the model started without waiting for the anchor write, each tool waiting for it instead; `inline`: no usable early prep (nothing pinned, no account context, or a scope that changed since `turn_start`), so the anchor write was awaited and one prep ran after it; absent on an unpaired turn), `snapshot_age_ms` (that prep's start → the model start; with `prep_source`). **Critical path** (each the time the turn blocked on that step, in order; they and `other_ms` sum to `prep_ms`): `history_ms` (stored history load), `retrieval_wait_ms` (the memory pack still loading after the history load), `google_wait_ms` (the Google tool offer and its grant check still running), `app_tools_wait_ms` (the app extension lookup, `appTurnTools` through `TurnDeps.appTurnTools`, still running after the Google wait; it starts with the Google tools; absent in an ACTIVE game or a degraded wiring. A turn with a bound app waits for the anchor before the model starts, because the app's tools are built against the committed message: on an `early` turn that wait shows here), `policy_ms` (the tool policy reads, serial: the conversation's, then the tool Space's when it differs), `build_ms` (agent and tool-map build, in process), `other_ms` (the rest; on an `inline` turn it includes the wait for the anchor write, and the capabilities still running). The paired-turn waits are absent on an unpaired turn, and `policy_ms` / `build_ms` on a turn whose tool wiring degraded (`v2.agent_tools_degraded`). **Own durations** (each from its own start to its settle; they overlap the critical path and each other): `prepare_ms` (the anchor write, `prepareTurn`, from the stage start; absent when the turn has none, or on an `early` turn whose write had not settled when this line was written), `context_ms` (account context, `resolveTurnMemory`, started at `turn_start`), `capabilities_ms` (game scope + Space, read in parallel), `game_ms` (the game scope read), `space_ms` (the Space read), `google_ms` (Google tool offer, grant verification per connected account), `app_tools_ms` (the app extension lookup: preflight and tool build; its own duration, overlapping the waits; the web row's `app_tools_ms` is likewise the step's own duration, and its `app_tools_wait_ms` the wait), `memory_source` (`pack`: the memory pack (standing facts, due-soon items, newest memories), read at `turn_start` on an `early` turn, no embed on the critical path; `pack+partial`: the partial recall added at least one memory the pack did not hold, merged into it; there is no per-turn query search), `partial_recall_ready` (a partial recall started on the streaming STT hypothesis, the first of 4 words or more seen on an uplink frame, never at `turn_end`, and never in an ACTIVE game; true when it had settled by the time prep read the pack, false when it was still running and the pack was used alone; never awaited; absent when none started: streaming STT off, fewer than 4 words before the last uplink frame, an ACTIVE game, or no memory pack), `partial_recall_ms` (the partial recall's own duration, embed + search; present only when it had settled). Ms, counts and flags only, never the transcript, a prompt, a tool name or a Space name. DB queries are not counted yet: they go through the shared `Db` adapter, which has no per-turn hook. `speculative: true` on both events when the run was speculated on a partial transcript (#1365; a discarded run's lines stay in the log, marked) |
| `v2.turn_stage_agent_started` / `v2.turn_stage_agent_completed` | Agent stage starts / finishes | `messages`; `web` started also (counts and byte totals only, never a filename or data): `attachments` / `attachment_bytes` (file parts on the incoming message and their decoded bytes), `history_attachments` (#416: file parts replayed to the model after bounding, ≤ `MAX_HISTORY_ATTACHMENTS` = 4, newest first) and `history_attachment_bytes` (their decoded bytes, ≤ 16 MiB); completed adds (both `cardputer` and `web`, #396): `duration_ms` (= `prep_ms` + `model_ms`), `prep_ms` (stage start → model call: history, retrieval, Space lookup, tool wiring; on `cardputer` an `inline` turn's prep also includes the wait for its anchor write, `prepare_ms`, which before the first-audio change ran unjournaled before the stage; an `early` turn's model does not wait for it), `model_ms` (model call → result; on web, until the stream ends), `model` (`response.modelId`; was always empty before #396), `input_tokens` / `output_tokens` / `tokens` — **summed over all steps from #396 on** (before, the last step only: never compare across that commit), `cached_input_tokens` (provider cache reads, 0 when none reported), `cache_write_tokens` and `reasoning_tokens` (when reported), `steps`, `tool_calls` (over all steps), `tool_failures` (`cardputer`, #999: tool results that returned `{ ok: false }` plus tool errors, over all steps; an aborted tool is a cancellation, not a failure), `called_tools` (comma-joined tool names over all steps, the `v2.agent_tools` rule), `finish_reason` (`stop`/`length`/`content-filter`/`tool-calls`/`error`/`other`), `provider` (the Gateway's routed provider, when it reports one), `since_prev_turn_ms` (since the same conversation's previous agent turn on this process; absent on the first), the prompt cache (#413: the system prompt is byte-stable, the per-turn memory / Space / date context rides one system message after the history, and the cache lever is chosen by the model prefix: `openai/*` sends a digest of the conversation id as `promptCacheKey` (the key itself is never journalled), `anthropic/*` gets explicit `cacheControl` breakpoints with `BOB_PROVIDER_CACHE=on`, `google/*` relies on implicit caching, and `BOB_GATEWAY_ORDER` (any model) sends `providerOptions.gateway.order` so implicit hits land on one backend; compare `cached_input_tokens` / `cache_write_tokens` by `model` + `provider`; `prompt_layout` was journalled until this layout became the only one). `cardputer` also: `reply_chars`, `context_ms` (account context: store, memory probe, time zone), `space_ms` (active-Space lookup, memory-on turns), and per prep step (each from its own start to its settle; they overlap, so they do not sum to `prep_ms`): `prepare_ms` (stage start → the anchor write settled; an `early` turn's model runs alongside it, an `inline` turn's prep after it), `history_ms` (stored history load), `capabilities_ms` (game scope + Space, read in parallel), `google_ms` (Google tool offer: grant verification per connected account; private turns with a Google runtime, never in an active game), `stub: true` on an AI-stub reply (no model, no tokens). `web` also: `first_token_ms` (model call → first stream chunk). `speculative: true` on both events when the run was speculated on a partial transcript (#1365; a discarded run's lines stay in the log, marked) |
| — | Agent step cap (#397) | Both agents stop the tool loop after `BOB_MAX_AGENT_STEPS` = 6 model calls (`stopWhen`, `apps/ai/src/agents.ts`). A turn that hits the cap ends with the SDK's step-limit finish: `steps` = 6 on `v2.turn_stage_agent_completed`, usually with `finish_reason` = `tool-calls`. Normal turns take 1-2 steps; a `steps` = 6 turn is a runaway loop or a longer legitimate chain, so raise the constant if it recurs |
| `v2.turn_stage_tts_started` / `v2.turn_stage_tts_completed` | Text-to-speech stage starts / finishes | `chars`; completed adds `duration_ms`, `pcm_bytes`, `source_rate` (PCM) or `mp3_bytes` (MP3), `tts_first_byte_ms` (TTS start → first synthesized audio; equals `duration_ms` on a whole-clip path), and on a reply of more than one sentence `first_sentence_ms` / `first_sentence_chars`. On the first clause's line only (#1387; chat turns and MP3 devices), the TTS split in metadata-only integer ms: `tts_headers_ms` (gateway request start → response headers), `tts_body_ms` (headers → last body byte), `tts_parse_ms` (last byte → the SDK returned the audio: JSON parse and base64; it lands in a sibling unit, so it can be absent), `tts_decode_ms` (base64 decode, WAV header and resample), `tts_encode_ms` (lamejs MP3 encode of the head, about 1 s of audio, which is what first sound waits on; the whole clip when it is shorter), `tts_encode_tail_ms` (the rest of a progressive encode, run in slices while the head plays; absent for a clip with no tail, #1391). A cache hit, a template asset or a prewarmed first clause carries none of the five, and neither does a server before #1387; `obs:rca` reads them with `v2.downlink_started` (first audio handed to the socket). `filler_ms` appears only on lines from servers that still played the "Hmm…" filler (#1361, removed: the device's cabin chime is the only acknowledgement now). On a turn that had a game prewarm (the previewed lines' first clauses synthesized while the model ran), `prewarm_lines` (lines started) and `prewarm_hits` (lines this reply used) |
| `v2.tts_cache_hit` | With `BOB_TTS_CACHE=on` (default off), a short TTS text (≤ 200 chars) was served from the in-process cache: no provider call, resample or MP3 encode. Repeats are the empty-turn reply, a reminder fanned out to several devices and short sentences. Bounded to 128 entries, 1 h TTL | `kind` (`pcm` \| `mp3` \| `encoded`), `chars`. Never the text |
| `v2.speech_asset_hit` | With `BOB_SPEECH_ASSETS_DIR` or `BOB_SPEECH_ASSETS_URL` set, an exact template reply assembled reviewed PCM clips server-side, then encoded once: no provider call. Misses fall back to ordinary TTS and journal nothing, so routine replies stay quiet. Server assembly still downloads audio; it does not eliminate downlink traffic | `kind` (`pcm` \| `mp3`), `chars`, `pcm_bytes`, `duration_ms`, `responses`, `cached_entries`. Never the text |
| `v2.speech_assets_loaded` / `v2.speech_assets_load_failed` | Once per process at boot, with `BOB_SPEECH_ASSETS_DIR` or `BOB_SPEECH_ASSETS_URL` set: the speech pack loaded, or did not and every reply uses ordinary TTS. With a URL the hosted pack was downloaded to a fresh temp directory (`voice/speech-assets-remote.ts`); it is never fetched again during turns, and until it lands replies use ordinary TTS | `pack_source` (`dir` \| `url`), `build`, `duration_ms`; loaded adds `responses`, `clips`, `pack_bytes`; failed adds `reason` (`http` \| `timeout` \| `network` \| `too_large` \| `invalid_manifest` \| `unsafe_path` \| `checksum` | `disk` | `invalid_pack`)\| `invalid_pack`). Never the URL or path |
| `v2.turn_stage_input_failed` / `v2.turn_stage_stt_failed` / `v2.turn_stage_agent_failed` / `v2.turn_stage_tts_failed` | A stage failed; the turn aborts at the failing stage (`input_failed` is web voice only, with `reason`, see below) | `kind`, `error_name`, `upstream_status` (when upstream), `timed_out` (on timeout), `duration_ms` |
| `v2.turn_stage_input_completed` | The turn ends with the fixed "I did not hear anything" reply: no audio, too little audio, a blank transcript, an STT 4xx on the clip, or the provider returning no transcript at all (`AI_NoTranscriptGeneratedError`, #898) | `empty: true` |
| `v2.turn_too_short` | The turn's audio is under `MIN_STT_PCM_BYTES` (9,600 bytes = `MIN_STT_AUDIO_MS` 300 ms of PCM16 16 kHz mono, `voice/audio/stt-tts.ts` / `voice/turn-core.ts`); STT is never called and the turn ends like an empty one (CP-SRV-SHORT) | `session`, `turn_id`, `pcm_bytes` |
| `v2.turn_stt_rejected` | The STT provider refused the clip itself: `upstream_status` on the allow-list 400/413/415/422 (`kind` `upstream_error`, or `invalid_input` for a typed `GatewayInvalidRequestError`); the turn ends like an empty one instead of `INTERNAL`. Every other status (401/403, 404 wrong model id, 408, 424, 429, 5xx), a timeout or no status stays `v2.turn_failed`. Preceded by `v2.turn_stage_stt_failed`. The web `/api/voice` route applies the same rule: `v2.turn_stage_input_failed` with `reason` `too_short` (a WAV under 300 ms, `audio_ms`; compressed formats are not measured) or `stt_rejected` (`kind`, `upstream_status`), answered 422 `no_speech_detected` instead of 502 | `session`, `turn_id`, `kind`, `error_name`, `upstream_status` |
| `v2.turn_metric_failed` | The fire-and-forget per-turn metrics write (`bob_private.record_turn_metric`, `platform/observability/turn-metrics.ts`) failed; the turn is unaffected and the row is dropped. Never carries the row or any text | `error` (the error class name only), `code` (the Postgres SQLSTATE, e.g. `22023`, when there is one) |
| `v2.operator_metrics_read` | An operator metrics read missed the 60-second memo and ran the database aggregate (`platform/observability/operator-metrics.ts`); one line per uncached read | `page`, `range`, `bucket`, `duration_ms` (no account, user or tag) |
| `v2.operator_scope_check_failed` | The operator gate could not read the `metrics.operator` scope (database error); the request was answered 404 (fails closed; `platform/observability/operator-gate.ts`) | `error` (the error name only; no account, scope holder or message) |
| `v2.agent_tools` | The tool registry offered to the agent for this turn, journalled once per turn at the point the agent is built (S18; `turn/generate.ts`, `workflows/workflow-web-chat-turn.ts`). Memory-off turns journal the base tools only; when the spaces store is unavailable the productivity tools are omitted from the set | `interface` (`cardputer`/`web`), `turn_id`, `tools` (comma-joined tool names — never arguments, results, or user text), `conversation_id` (when one was resolved); `cardputer` also `scope` (`private`/`space`). #396 section sizes, lengths only: `tool_count`, `tools_chars` (name + description + JSON schema of every offered tool), `instructions_chars` (the base instructions), `memory_chars` (the retrieved memory block, 0 when none), `context_chars` (other appended context: the active-Space line, 0 when none), `history_messages` / `history_chars` (the messages before the current one, and their text characters; on `cardputer` a stored reply that ran tools replays as its model messages -- tool call, tool result, text -- and their parts count as JSON characters), `history_attachment_bytes` (attachment bytes replayed with them; 0 on `cardputer`) |
| `v2.downlink_started` | Reply streaming begins | `turn_id` (#396), `mp3_bytes` or `pcm_bytes`, `total_ms` (STT→agent→TTS latency, from the turn's start in `processTurn`), `lead: 'filler'` only on lines from servers that still played the removed "Hmm…" filler (#1361: there `mp3_bytes` and `total_ms` are the filler's). `obs:turns` still reads such historical lines: a filler's downlink precedes the answer's TTS start, so it gets no `tts_started → downlink_started` segment and is left out of the stage-share breakdown (`breakdown_excluded_filler` counts them). Its `filler→synth` and the `synth ready` column are server synthesis-ready intervals: `tts_started` + the first synthesized answer audio's readiness (`first_sentence_ms` of a multi-sentence reply; `tts_first_byte_ms` only when `sentences` is 1; otherwise unknown), measured from turn end and from this row. They say when the first synthesized answer audio became ready, not when it was played; no speaker onset is measured server-side. A missing readiness value, or an interval that comes out negative, is shown as unknown, never zero |
| `v2.downlink_trimmed` | Reply PCM exceeded `MAX_DOWNLINK_PCM_BYTES` (320 KB; the server constant is 320 × 1024 bytes, `turn/pacing.ts`) | `original_bytes`, `trimmed_bytes` |
| `v2.downlink_aborted` | TCP backpressure persisted >10 s; remaining frames dropped | `buffered_bytes`, `frames_sent`, `frames_total` |
| `v2.turn_completed` | Reply fully streamed | `turn_id` (#396), `frames` (uplink 10 ms PCM frames: audio bytes / 320), `msgs` (the uplink `audio_up` messages that carried them), `reply_bytes`, `down_frames` (downlink frames handed to the socket, not queued), `conversation_id` (when one was resolved), `first_audio_ms` (#396: the turn's start in `processTurn` → the first `audio_down` frame handed to the socket; always ≥ `v2.downlink_started.total_ms`; absent when no frame went out); a streamed reply (every MP3 device turn whose agent streams; PCM devices take the batch reply) adds `streamed: true`, `first_token_ms` (turn start → the agent's first text delta), `sentences` (sentences whose audio went out), `tts_ms_per_sentence` (comma-joined synthesis ms, in order; the first is the first-audio TTS cost), and `partial` / `chars_capped` when they apply, `tool_calls` / `tool_failures` / `action_outcome` (#999: the pipeline completing is not the action succeeding; `action_outcome` is `none` with no tool call or no agent run, `ok` when every tool call worked, `failed` when any returned `{ ok: false }` or threw, e.g. a `set_alarm` that could not be set; counts and the enum only, never tool arguments, outputs, transcript or reply text). `speculation` (#1365): `used` when a reply speculated on the partial transcript was spoken, else `discarded` or `none`; `speculation_reason` on `discarded` and `none`: `mismatch` (the final transcript differed), `kept_talking`, `superseded`, `aborted` (cancel, disconnect, new turn), `error`, `no_transcript`, `no_end_of_turn`, `not_eligible` (no paired conversation or no early prep), `limit`; `saved_ms` on `used`: model time hidden inside the end-of-turn window; `eot_source` (#1384): who closed capture. `server` when this server sent `end_of_turn` before the turn's `turn_end` and turn_end arrived within 400 ms of it, else `device`. `eot_basis` here is always `order`: an inference from message order and turn_end timing, not the device's own timing (`v2.device_turn_timing` carries the device-timing verdict, which overrides this in obs:rca). `eot_lag_ms`: turn_end receipt minus the `end_of_turn` send, ms, present only when the server sent `end_of_turn` for the turn (absent otherwise; `end_of_turn` is never sent after turn_end). Enum values and ms only |
| `v2.turn_failed` | Turn aborted | `stage`, `kind` (`invalid_input`/`upstream_error`/`internal`), `error_name` (error class, never the message), `upstream_status` (when upstream), `timed_out` (on timeout), `conversation_id` |
| `v2.ai_budget_exhausted` | A provider call answered HTTP 402: the AI Gateway key's budget is spent, and every AI, STT and TTS call fails until it is raised (#1041). Journaled at most once per 10 minutes per process (`platform/observability/budget-alarm.ts`); the `ai.budget_exhausted` counter counts every 402. The OpenObserve alert `bob-realtime-ai-budget-exhausted` fires on it. The device turn ends on the out-of-credit reply card (reply_text then status idle, no `INTERNAL`); at `tts` the card is a speech note followed by the agent's reply, and a streamed reply cut mid-way by a 402 gets the same card before `playback_end`. Web chat and the web voice routes (`/api/voice`, `/api/speech`) answer 503 `out_of_credit` (chat mid-stream: an SSE error part with that text). The failure's own `v2.turn_failed` / `v2.turn_stage_*_failed` line still carries `upstream_status` 402 | `surface` (`device`/`web_text`/`web_voice`), `stage` (`stt`/`agent`/`tts`) |
| `v2.error` | Error DTO sent to device | `code` (`BAD_MESSAGE`, `BAD_AUDIO`, `STATE_VIOLATION`, `FRAME_TOO_LARGE`, `SEQUENCE_GAP`, `QUEUE_FULL`, `INTERNAL`, `SPACE_NOT_FOUND` for a refused `select_space`) |
| `v2.cancelled` | Device cancelled the turn. An in-flight turn is aborted and awaited; `v2.turn_cancelled` follows (#315) | `session`, `stage` |
| `v2.turn_cancelled` | A cancel stopped the turn. `stage` is `stt`/`agent`/`tts` (nothing streamed, only `status idle` sent) or `stream` (`playback_end` + `status idle` sent; the reply is saved cut to `heard_chars` and flagged interrupted) | `session`, `stage`, `conversation_id`; `stream` adds `down_frames`, `heard_chars` |
| `v2.device_presence` | A paired device came online (its `welcome`) or went offline (socket closed and no reconnect within 500 ms); `device.changed` published so an open Devices page re-reads "Connected now" | `session`, `state` (`online` / `offline`) |
| `v2.device_presence_failed` | Publishing a presence `device.changed` threw; the welcome and the session are unaffected, only the Devices page misses that refresh | `session` |
| `v2.devices_connected` | Open device WebSocket sessions changed (socket opened, paired or closed); written at most once a minute, when the count differs from the last line. Answers "how many devices are connected" where metrics are not ingested (Railway) | `paired`, `unpaired` |
| `v2.device_state` | The device reported its settings (#314/#330); kept on the session, persisted per device, `device.changed` published. Ring firmware (#389) also reports its timer ring settings; older firmware reports neither and keeps the stored ones. Wake-word firmware (cap `wake_word`) also reports its wake word. Health-capable firmware adds `rssi_dbm`, `heap_free`, `heap_largest`, `log_dropped` (each journaled and spanned as a `device-health` observation only when reported) | `session`, `volume`, `muted`, `mode`, `dnd`; ring firmware adds `ring_seconds` (10..120), `ring_sound` (`classic`/`chime`/`pulse`); wake-word firmware adds `wake_word` (`bob`/`bob`) |
| `v2.device_log` | Accepted metadata-only diagnostic from an authenticated device/legacy session after hello; at most one accepted per session per second, excess silently dropped. Negotiated firmware emits only fixed events (`welcome_accepted`, `turn_started`, `turn_ended`, `playback_started`, `turn_cancelled`, `server_error`, `capture_failed`, `downlink_stalled`, `audio_down_seq_gap`); never free-form device journal content. Also creates a server-side `device-log` span | `session`, optional `turn_id`, `device_event`, `uptime_ms`, `heap_free`, `heap_largest` (unsigned 32-bit numeric counters) |
| `v2.device_turn_timing` | A negotiated device's `turn_timing` summary (#1004) joined to a turn this session started, within its window (180 s running, 60 s after it unwound or was cancelled); also a detached `device-turn-timing` span (docs/observability.md "Device turn timing"). Offsets are device-clock ms from that turn's capture start, never comparable with server time; `speaker_submission_ms` is the speaker API accepting samples, not audible onset | `session`, `turn_id`, `board` (the hello's board id, e.g. `waveshare-s3-185c`; `cardputer` when the hello named none), `activation_source` (`ptt`/`wake`/`follow_up`; not `source`, which is the logger's reserved envelope key and always `api`), `end_reason`, `outcome` (`drained`/`empty`/`interrupted`/`failed`/`cancelled`), `muted`; each of `capture_end_ms`, `first_up_ms`, `turn_end_ms`, `playback_start_ms`, `first_down_ms`, `decoder_ready_ms`, `speaker_submission_ms`, `playback_end_ms` is a number (measured), `skipped` (did not happen) or absent (unknown); `stop_to_speaker_ms` = `speaker_submission_ms` - `capture_end_ms` (you stop to Bob speaking, the same interval as the `device.turn.end_to_speaker_ms` metric; absent unless both are measured and in order); `up_frames`, `down_frames`. From a firmware that sends them (an older one omits them, and the line leaves them out): `speech_end_ms` (device-clock offset of the last voiced frame, `skipped` when the turn had no speech); `speech_end_to_speaker_ms` = `speaker_submission_ms` - `speech_end_ms` (your last word to Bob speaking: the felt wait, which excludes the endpointer's trailing silence that `stop_to_speaker_ms` counts; absent unless both are measured and in order); `uplink_backlog` (uplink frames still queued when capture ended), `mic_fps` (microphone frames per second over the capture), `tx_busy` (audio writes refused because the socket send buffer was full), `tx_busy_max_ms` (the longest such refused streak); `eot_source` and `eot_basis` (#1384): who closed capture, `server` or `device`. Basis `device` uses the device's own capture timing (`end_reason` `silence`, not push-to-talk, with capture ending under 950 ms after the last voiced frame, and the server's `end_of_turn` sent before turn_end); basis `order` is an inference from message order and timing, not proof. Enum values only |
| `v2.device_turn_timing_ignored` | A `turn_timing` summary was dropped; the device is never answered | `session`, `turn_id`, `reason` (`not_negotiated`, `unknown_turn` = never started on this session, e.g. from before a reconnect, `expired`, `duplicate`, `out_of_order`) |
| `v2.device_settings_synced` | Stored and device settings agree again (#327). Every web change is stored pending; sent is not applied. `to_device`: the device reported exactly the pending values (pushed live, or as `device_control` after welcome and once more if the session's first `device_state` predates it). `from_device`: nothing was pending, so the session's first `device_state` was stored as the truth (key changes made offline survive). `device_override`: a differing report after the session's one re-push was stored and cleared the pending change (the device wins, so a clamped value never stays pending) | `session`, `direction` (`to_device`/`from_device`/`device_override`); `to_device` adds `ack_ms` (ms from the last `device_control` sent to this session, when one was). Never a settings value |
| `v2.device_settings_changed` | Stored settings changed. `web`: a PATCH stored them pending (then pushed if connected). `device`: a `device_state` changed stored values (not on a `to_device` confirmation) | `fields` (sorted names only, e.g. `ring_seconds,volume`); the envelope `source` says who changed it (`web`/`device`); `web` adds `delivered`, `device` adds `session`. Never a settings value |
| `v2.device_announce` | POST `/api/devices/:id/announce` (#668 U4) handed a notice card to one device's outbox, or found it not connected | `outcome` (`sent`, `held` = busy or DND, `no_device` = 409, nothing queued), `ring`. Never the title or body |
| `v2.device_activity_listed` | GET `/api/devices/:id/activity` (#668 Recent) answered the owner with a device's recent turns and the account's fired timers | `count` (items returned). Never a heard excerpt, title, timer label or id |
| `v2.device_settings_read_failed` / `v2.device_settings_write_failed` | hello could not seed the stored settings / a `device_state` could not be persisted. The session keeps the reported state | `session`, `error` (name only) |
| `v2.device_model_refresh_failed` | hello named a board (Bob's Waveshare) whose model could not be stored over the paired one. The device keeps its paired model label | `session`, `error` (name only) |
| `v2.device_follower_read_failed` | A deferred follower lookup for a broad device push failed. The per-account delivery chain stays usable, so the next queued delivery still runs; only the failed push misses its followers | none: the event carries no fields, never the error, ids, titles, SQL or other PII |
| `v2.express` / `v2.scene` | `express` (Bob's feeling) / `scene` (action scene of a succeeded tool call) sent to a device with the `express` / `scene` cap | `session`, `emotion` or `scene`, `seconds` (never the label or value) |
| `v2.device_control` / `v2.device_control_undelivered` | `device_control` sent to a session (web, `set_volume`/`set_mode`, or a pending web change pushed on reconnect with every stored field; `ring_seconds`/`ring_sound` only to firmware that has reported them, #389; `wake_word` only when the user picked it on the web and the device has not confirmed it, and only to a socket whose hello caps list `wake_word`: a reported or default wake word is never sent, #1228) / no connected session to send it to | `session` (sent only), `fields` (names of the changed settings, never values beyond them) |
| `v2.announce_queued` | An announcement entered the account's outbox (#319) | `kind`, `ring`, `sessions` (registered sessions of the account). Never title, body or speech |
| `v2.announce_sent` | `announce` sent to a session | `session`, `kind` |
| `v2.announce_held` | Undelivered announcements held for a session | `session`, `reason` (`busy` = capturing/responding, `dnd`), `count` |
| `v2.announce_duplicate` / `v2.announce_dropped` / `v2.announce_expired` | Same `announce_id` again (dropped) / outbox over its 20 cap (oldest dropped) / expired before delivery or ack | `kind` / `reason` (`outbox_full`) / `count` |
| `v2.announce_acked` | `announce_ack` from the device | `session`, `action` (`played`/`dismissed`/`snoozed`/`missed`; `missed` = the ring ran its full `ring_seconds` with no dismiss, #389), `known` (was still pending). Never the label |
| `v2.announce_played` | The speech after a `ring:false` announcement ended (`ann_<id>` playback) | `session`, `kind`, `outcome` (`played`/`cancelled`/`tts_failed`), `mp3_bytes` |
| `v2.timer_fired` | The timer scheduler fired a timer or alarm; `announceTimer` rings the account's devices | `kind` |
| `v2.timer_scheduler_failed` | The timer scheduler could not start (store unreachable at boot); timers stay stored but unannounced until the next start | `error` (name only) |
| `v2.timers_state` | `timers_state` sent (#457): the account's running timers (soonest 4) for the device's Ready countdown. `welcome`: to the welcomed session, right after `welcome`, only when a timer is running (the device clears its list at every welcome). `changed`: after a timer create, cancel or fire, to every session of an account whose list moved (an unchanged account gets nothing) | `reason` (`welcome`/`changed`), `count` (timers sent, 0..4); `welcome` adds `session`, `changed` adds `sessions`. Never a label or id |
| `v2.timers_state_failed` | The pending timers could not be read; nothing sent, the device keeps its last list | `reason` (`welcome`/`changed`), `error` (name only) |
| `v2.reminder_fanout` | A reminder fan-out tick found due occurrences | `due`, `enqueued`, `failed`, `delivery_failed` (occurrences journalled as `v2.reminder_delivery_failed`), `announced` (devices rung, #321), `announce_failed`, `stale` (occurrences due more than 24 h ago: recorded as handled, never notified, emailed or rung) |
| `v2.socket_error` | Socket-level error | `error` |
| `v2.conversation_listed` / `v2.conversation_list_failed` | Cardputer picker requested the conversation list | `count`; `_list_failed` adds `error` (name only) |
| `v2.conversation_selected` / `v2.conversation_select_failed` | Cardputer picker selected the active conversation | `conversation_id`; `_select_failed` adds `error` (name only) |
| `v2.new_conversation` | Cardputer `new_conversation` cleared the active pointer; the next device turn creates the conversation (#302). Preceded by `v2.active_changed {surface:device}`; a failed write journals `v2.active_write_failed {surface:device}` and answers `INTERNAL` | `session` |
| `v2.new_conversation_duplicate` | A repeated `request_id` on the same session; the cached `conversation_cleared` ack is re-sent and nothing is written or published | `session` |
| `v2.space_listed` / `v2.space_list_failed` | Cardputer `list_spaces` answered with live member Spaces, capped at 10 (#301). On a store outage `_list_failed` is journaled and an empty list is sent | `session`, `count`; `_list_failed` has `session`, `error` (name only). Never a Space name |
| `v2.active_space_changed` | The account's active-Space pointer moved from the device. This is a `select_space` success, or a hello that found the stored Space archived, deleted or revoked and cleared it. `active_space.changed` was published | `session`, `surface` (`device`). Never a Space id or name |
| `v2.active_space_write_failed` | `select_space` pointer write failed for a reason other than not-found. The device gets `INTERNAL`, and the pointer is unchanged | `session`, `surface` (`device`), `error` (name only) |
| `v2.active_space_resolve_failed` | hello could not read the active-Space pointer. `welcome` omits `active_space`, and the conversation pointer is unaffected | `session`, `error` (name only) |
| `v2.auth_rejected` | Browser `/api/*` request refused by the JWT guard before any body handling | `surface` (`web`), `reason` (`missing_token`/`invalid_token`/`expired_token`) |
| `v2.web_auth_unconfigured` | No auth issuer configured at startup; the guard mounts but rejects everything | `reason` (`no_issuer`) |
| `v2.web_auth_system_test_refused` | `BOB_SYSTEM_TEST=1` under `BOB_PRODUCTION=1` or with a non-local `BOB_DATABASE_URL`; the test-token issuer is never built | — |
| `v2.device_authenticated` | Device upgrade accepted at `/v2/cardputer` | `kind` (`device`/`legacy`/`unpaired`); `device_id` when `device`; `reason` (`none`/`unknown`/`revoked`) when `unpaired` |
| `v2.device_refused` | Device upgrade rejected before accept | `reason` (`invalid_token`/`store_unavailable`/`unpaired_limit`); `error_name` (store outage), `ip_hash` (cap exceeded) |
| `v2.pairing_required` | Hello from an unpaired socket; the session answers `pairing_required` | `reason` (`none`/`unknown`/`revoked`) |
| `v2.unpaired_idle_close` | Unpaired session idle-closed after 11 min (`BOB_UNPAIRED_IDLE_MS`) | — |
| `v2.pair_issued` | A pairing code was issued to an unpaired socket | `pairing_id` |
| `v2.pair_rejected` | Pairing code lookup refused | `reason` (`rate_limited`/`not_found`); `acct` (8-hex tag) or `ip_hash` |
| `v2.pair_delivered` | `paired` (device token) delivered to the waiting socket | `pairing_id`, `device_id` |
| `v2.pair_approved` | A user approved a pairing on the web | `acct`, `device_id` |
| `v2.pair_denied` | A user denied a pairing; `pair_denied` pushed to the device | `acct`, `pairing_id` |
| `v2.active_changed` | The account's active-conversation pointer moved | `surface` (`web_text`/`web_voice`/`device`/`picker`/`activate`/`delete`) |
| `v2.active_write_failed` | The pointer write failed (journaled, never fatal to the turn) | `surface`, `error` (name only) |
| `v2.turn_conversation_ignored` | A `turn_start` carried a `conversation_id` (#880) the server did not use; the turn keeps the server-resolved conversation | `session`, `reason` (`not_found`: the account cannot open it; `lookup_failed`: the store read failed; `unpaired`: no account) |
| `v2.conversation_resolve_failed` | The store could not resolve the account or its active pointer; turns fall back to in-memory | `error` (name only) |
| `v2.turn_persist_failed` | A completed turn could not be persisted after the reply streamed | `conversation_id`, `error` (name only) |
| `v2.turn_prepare_failed` | The device user-message anchor could not be prepared; provider tools remain unavailable | `session` |
| `v2.turn_release_failed` | The prepared device message could not be released from its extraction hold | none |
| `v2.device_thread_saved` | A Cardputer turn whose pointer names a space thread (#565) was saved there: the account's message, then the assistant reply; `thread.message_appended` published to every active member. SHARED: no memory extraction is queued | `session`, `thread_id`, `space_id`, `user_message_id`, `reply_message_id` (absent when no reply was saved), `created`, `outcome` (`completed`/`busy`/`duplicate`/`unheard`), `published` (event count) |
| `v2.device_thread_lost` | The pinned space thread is gone, archived or the account lost membership; the turn falls back to a new General conversation and queues no extraction. Since #756 it is journaled AFTER that fallback save has succeeded (one `persistDeviceTurn`), immediately before `v2.active_changed {surface:device}`; a failed save journals `v2.turn_persist_failed` instead | `session`, `thread_id` |
| `v2.accept_failed` | A WebSocket upgrade could not be accepted (`server.ts:143`) | `error_name` |
| `v2.control_failed` | An inbound control/audio handler threw; the per-message chain caught it (`server.ts:176`) | `error` (name only) |
| `v2.heartbeat_timeout` | The device missed 2 heartbeats; its socket is terminated (`server.ts:220`) | `missed` |
| `v2.rate_limited` | A request refused by a token bucket before handling (`platform/http/rate-limit.ts:93,114,119`) | `route` (`/api`/`/v2/cardputer`), `ip_hash`; `reason: concurrency` on the device route |
| `v2.speech_config` | Journaled once at boot, after the database and auth checks pass (`startup.ts`): which TTS/STT models serve every turn, invisible in the per-turn events | `tts_model`, `tts_voice`, `tts_voice_bob` (the voice a Bob session speaks in), `tts_format` (always `mp3`), `stt_model`, `tts_timeout_ms`, `stub` (true under `BOB_AI_STUB`/`BOB_SYSTEM_TEST`: the names above are configured, not actually serving turns) |
| `v2.tts_voice_bob_error` | Error level, at boot just before `v2.speech_config`: `BOB_TTS_VOICE_BOB` named no known MAI-Voice-2.1 en-US voice (en-US-Ethan, -Grant, -Jasper, -Sage, -Harper, -Iris, -Olivia), so it was refused and Bob keeps the default. Fix the variable's spelling | `fallback_voice` (the voice Bob speaks in). Never the refused value |
| `v2.production_mode` | Server started with `BOB_PRODUCTION=1` (`server.ts:310`) | — |
| `v2.ai_stub_mode` | Server started with the AI stubs on (`server.ts:311-312`): canned transcript, test-tone TTS, "System test response" replies | `source` (`BOB_AI_STUB` or `BOB_SYSTEM_TEST`) |
| `v2.conversation_created` | A web chat created a conversation (`workflows/workflow-web-chat-turn.ts`) | `id` |
| `v2.conversation_opened` | A conversation restored in full (`conversations/http.ts:79`) | `id`, `messages` |
| `v2.conversation_renamed` | A conversation renamed (`conversations/http.ts:108`) | `id` |
| `v2.conversation_deleted` | A conversation deleted, incl. a concurrent delete (`conversations/http.ts:167`) | `id`, `messages` (cascade size) |
| `v2.conversation_pinned` | `PATCH /api/conversations/:id` set or cleared the pin (CU-CHAT-1, `conversations/http.ts`) | `id`, `pinned` |
| `v2.conversation_archived` | `PATCH /api/conversations/:id` set or cleared the archive (CU-CHAT-1, `conversations/http.ts`) | `id`, `archived` |
| `v2.conversation_flags_unavailable` | A pin/archive PATCH answered `feature_unavailable`: the hosted store lacks the `pinned_at`/`archived_at` columns until the migration is pushed (CU-CHAT-1) | `reason` (`undefined_column`) |
| `v2.messages_deleted` | A user message and every later one deleted ("delete from here", `conversations/messages-http.ts`) | `id` (conversation), `messages` (rows deleted) |
| `v2.messages_persisted` | A web reply's versions saved to the store (`workflows/workflow-web-chat-turn.ts`) | `id`, `versions`, `bytes` |
| `v2.messages_persist_failed` | A web reply could not be saved after it rendered (`workflows/workflow-web-chat-turn.ts`) | `id` |
| `v2.reply_interrupted` | A web reply cut off by barge-in was truncated to the heard portion (013 R6, `conversations/messages-http.ts`) | `heard_chars` (the client's measured offset), `truncated` (whether a truncation landed this call) |
| `v2.memory_extracted` | The background extraction worker finished a turn's extraction (010 R11, `memory/extract.ts`) | `count`, `conversation_id`, `message_id` (#758: which turn wrote this), `reason` (#758: `no_ops`/`deduped`/`applied` — `deduped` means the store's own duplicate check, not just the extractor's, turned at least one op into a noop), `ops_deduped` (#758: how many ops that was), `embed_model` (the embedder; named `model` before #396), `extract_model` (the model that answered the extraction call, `response.modelId`), `extract_input_tokens` / `extract_output_tokens` (that call, all steps), `extract_ms` (the extraction call alone, not the embeds or writes), `confidence_bucket` (`low`/`medium`/`high`), `ops_add`, `ops_update`, `ops_supersede`, `ops_noop` (#758: these four count what the store actually wrote, after its own dedupe — not just what the extractor proposed), `adds_fact` / `adds_preference` / `adds_intent` / `adds_action_item` (#406: the `add` ops per memory kind, counts only), `dropped_secret`, `dropped_sensitive`, and from #406 the pre-filter verdict (a `skip` never reaches this event unless `BOB_MEMORY_PREFILTER_ENFORCE=0`, which restores shadow mode): `prefilter_version` (the rules-list constant, e.g. `rules-v2`), `prefilter_verdict` (`skip`/`keep`), `prefilter_reason` (`ack`/`control`/`empty`/`short` are skips; `confirmation` — "sure", "ok", "go ahead" and the like, which can accept an assistant offer — and `none` are always `keep`; `short` is a single letter only, never a lone digit), `user_chars_bucket` (`0-10`/`11-40`/`41-120`/`120+`, the user text length), and `gate_score` (only with `BOB_MEMORY_GATE` = `shadow`/`on`: the gate model's 0..1 probability that the turn is worth remembering, two decimals) — metadata only, never memory or message text (FR-013) |
| `v2.memory_skipped` | Extraction degraded or not applicable: the store was unavailable, a turn's extraction failed after `maxAttempts` retries (010 R11, S10-FIX3, `memory/extract.ts`), the turn's conversation is in a pair or group space (#756, marked done with no ops), it was a game turn (#460, marked done with no ops), the #406 pre-filter verdict was `skip` (marked done with no ops), or the memory gate scored it below 0.2 with `BOB_MEMORY_GATE=on` (marked done with no ops) | `reason` (`store_unavailable` \| `extract_failed` \| `shared_space` \| `game_turn` \| `prefiltered` \| `gated`); `prefiltered` adds `prefilter_version`, `prefilter_reason`, `user_chars_bucket`; `gated` adds `gate_score`; `extract_failed` adds `attempts` (tries used) and `error_name` (the failing call's error class), plus `error_status` (numeric status) when the provider supplied one — never the error message, prompt, or user text |
| `v2.reply_interrupted_unavailable` | The heard-portion PATCH answered `feature_unavailable`: the hosted store lacks the `interrupted` column (migration not yet pushed) | `reason` (`undefined_column`) |
| `v2.web_telemetry_error` | An accepted browser JavaScript error (`ui_event=ui_error`, level `error`): `kind` (`error`/`rejection`), `error_name` (class name, `[A-Za-z]+`), optional `frame` (`file:line:col`, basename of a file in the app's own bundle), `route` template, `session_id`, `conversation_id`, `acct`. | Never the message, stack text or a URL. Same ingestion and budgets as `v2.web_telemetry`; the `error` level comes from the event-name suffix. |
| `v2.web_telemetry` | An accepted metadata-only browser event (`platform/observability/telemetry.ts`); one journal line per accepted event, subject to bounded ingestion budgets | The browser's kind is the `ui_event` field (`event` stays the journal name). Voice kinds `turn_timing`, `barge_in`, `false_trigger`, `mode_state`, `mode_off`; UI kinds `ui_navigation`, `ui_interaction`, `ui_render`, `ui_request`, `ui_action`, `ui_edit`, `ui_activity`, `ui_auth`, `ui_metrics_window`, and `web_vital` (`name` LCP/INP/CLS/FCP/TTFB, integer `value` in ms, CLS times 1000, `rating`, `route`, `session_id`, `conversation_id`); a `ui_navigation` on first load also has `dom_content_loaded_ms`, `load_ms`, `ttfb_ms`. Only fixed catalogs/enums, bounded timings/counts/outcomes and opaque view/action/request UUIDs; authenticated events include `acct` (8-hex tag), anonymous events include `auth_state=anonymous` without an account. A `ui_request` event's `request_trace_id` is the trace id of the API request the browser made (the browser sends it as `trace_id`; the journal reserves `trace_id` for the line's own span), so `@request_trace_id:<id>` finds the browser line that belongs to a request's trace. No content, DOM values, credentials or raw URLs. Callback and auth outcomes, request timing and sampling semantics are in [observability](observability.md). |
| `v2.device_revoked` | A device revoked on the web; its socket closes 4003 (`devices/http.ts:125`) | `device_id` |
| `v2.admin_invitation_queued` | Account provisioning completed and its Bob invitation was queued, already recorded as sent, or could not be queued; the account is not rolled back | `outcome` (`queued`/`sent`/`failed`) only; no address or mail content |
| `v2.admin_account_managed` | An authorized site administrator attempted a fixed sign-in or site-admin change | `action` (`enable`/`disable`/`grant_admin`/`revoke_admin`) and bounded `outcome` (`updated`/`forbidden`/`invalid_action`/`not_found`/`self_protected`/`last_admin`). Never target identities, email addresses or search text |
| `v2.admin_account_provisioned` | An authorized account administrator completed a provisioning attempt through `POST /api/admin/accounts`; skipped or failed attempts return 503, never success | `outcome` (`created`/`exists`/`skipped`/`failed`) only. Never the submitted email or provisioned account identity; normal request trace correlation is preserved |
| `v2.account_deleted` | `DELETE /api/account` finished (`account/http.ts`) | `conversations`, `memories`, `google_accounts`, `notification_preferences`, `notifications`, `devices_revoked`, `provider_revoke_failed`, all counts only |
| `v2.erasure` | `eraseAccount` committed (`account/erasure-service.ts`) | `anonymized`, `assignmentsCleared`, `privateSpacesDeleted`, `membershipsRevoked`, `jobsInvalidated` |
| `v2.account_deleted_email_failed` | The `account-deleted` email could not be sent before erasure removed the address; the deletion goes on (`account/http.ts`) | — |
| `v2.account_exported` | `GET /api/export` streamed the account's data (`account/export-http.ts`) | `spaces`, `conversations`, `messages`, `memories`, `tasks`, `notes`, `events`, `reminders`, `timers` (all counts), `duration_ms` |
| `v2.account_export_failed` | The export could not be read (answered 500 `store_error`), or the client went away mid-write | `stage` (`read`/`write`), `error_name` (the error class, or `client_closed`) |
| `v2.web_error` | The `/api` error handler answered 500 `internal` for an unhandled error (`platform/http/errors.ts`) | `error` (error class only), `operation` (the HTTP method; never the path) |
| `v2.schema_check` | Once at boot, the health route compared the applied schema with the migrations it expects (`web-health.ts`) | `schema_status` (`ok`/`schema_behind`/`schema_ahead`/`unknown`; `schema_behind` blocks `/health` when `strict`), `schema_version` / `schema_expected` (migration version ids, absent when unknown), `strict` (`BOB_SCHEMA_STRICT=1`) |
| `v2.agent_tools_degraded` | Building the productivity tools failed; the turn goes on with the base tools only (`turn/device-agent.ts`, `workflows/workflow-web-chat-turn.ts` via `turn/chat-agent.ts`) | `interface` (`cardputer`/`web`), `turn_id`, `error` (name only) |
| `v2.game_guard_replaced` | A game reply was replaced before TTS (`voice/game-tools.ts`): it failed the kid-safe check, went off script, or (one-step turns) did not say the tool's line | `reason`: a `KidSafeReason` class such as `blocked_word`/`url`, or `off_script` (no tool line; the guard advanced the round), `no_tool` (the model spoke a previewed line but called no tool; the guard ran it), `one_step` (the reply did not contain the called tool's line, so that line was spoken); `advanced` (1 when the guard ran the tool, on `off_script`/`no_tool`); `count` (1). Never the text |
| `v2.timers_listed` | `GET /api/timers` returned the pending timers (`timers/http.ts`) | `count`, `duration_ms` |
| `v2.timer_cancelled` | `DELETE /api/timers/:id` cancelled a timer (`timers/http.ts`) | `timer_id`, `remaining` (count), `duration_ms` |
| `v2.reminder_fanout_failed` | The fan-out tick could not read the due occurrences (`workflows/workflow-reminder-fire.ts`, `count` 0), or the tick threw (`outbox-module.ts`, `error` name only); the next tick retries | `count` or `error` |
| `v2.reminder_fanout_tick` | The reminder tick (`outbox-module.ts`, in the web server or the runner) enqueued deliveries (only when `count` > 0) | `count` |
| `v2.reminder_delivery_failed` | One due occurrence could not be delivered to its recipient; the tick carries on (`workflows/workflow-reminder-fire.ts`) | `reason` (`preferences_unreadable`/`enqueue_failed`/`record_failed`), `reminder_id`, `user_id` |
| `v2.telemetry_export_failed` | A telemetry batch (traces, logs or metrics, to the primary or the extra OTLP destination) could not be exported; once per kind per process (`server.ts`, specs/009 D3) | `kind` (`telemetry_init_failed`, `logs_init_failed`, `otlp_flush_failed`, `logs_flush_failed`, `otlp_extra_flush_failed`, `otlp_extra_logs_flush_failed`, `otlp_extra_metrics_flush_failed`, `cost_rates_invalid` (an `BOB_COST_RATES` snapshot that fails validation; its value is never logged)) |
| `v2.shutting_down` | SIGTERM/SIGINT received; buffered Braintrust spans are flushed before exit (`server.ts`) | `signal` |
| `v2.memory_retrieved` | Memory retrieval ran at turn start (010, T011): the hybrid top-k matched (or degraded), due-soon items fetched, and the `[BOB MEMORY ...]` block assembled — metadata only, never content | `count`, `latency_ms`, `source_full_text`, `source_semantic`, `source_both`, `degraded` (bool), `standing_count`; `pack: true` on a memory-pack read (no query, no embed); `partial: true` on a voice turn's partial recall (the query search on the streaming STT hypothesis, beside that turn's pack: no standing, due-soon or top reads, and no root `rag.skipped` / `rag.fallback` / `rag.result_count` samples, so a turn's root RAG metrics are counted once; filter it out when counting retrievals per turn); when the #406 pre-filter skipped the search (a greeting, thanks or control turn: no embed, no match query, standing and due-soon context still attached) also `prefiltered: true`, `prefilter_version`, `prefilter_reason` |
| `v2.memory_skipped` | Memory retrieval skipped or returned nothing: the store is unavailable, or a retrieval store failure returned no memories (FR-008) | `reason` (`store_unavailable`) |
| `v2.memory_listed` | `GET /api/memories` returned a page (010, `memory/http.ts`) | `count`, `has_cursor` |
| `v2.memory_corrected` | `PATCH /api/memories/:id` corrected a memory and re-embedded it (010, `memory/http.ts`) | `memory_id`, `kind`, `reembedded` (bool) |
| `v2.memory_deleted` | `DELETE /api/memories/:id` deleted one memory (010, `memory/http.ts`) | `memory_id` |
| `v2.memories_deleted` | `DELETE /api/memories` deleted every memory; action items follow the cascade (010, `memory/http.ts`) | `count` |
| `v2.memory_created` | `POST /api/memories` added a memory by hand, or matched an identical one (G18, `memory/http.ts`) | `memory_id`, `kind`, `outcome` (`added`/`unchanged`), `embedded` (bool) |
| `v2.memory_refused` | `POST /api/memories` or `PATCH /api/memories/:id` refused secret-like text (FR-018, `memory/http.ts`) | `route` (`create`/`correct`), `reason` (`labelled`/`token`) — never the text |
| `v2.action_items_listed` | `GET /api/action-items` returned the list (010, `tasks/action-items-http.ts`) | `count`, `status` |
| `v2.action_item_updated` | `PATCH /api/action-items/:id` changed an item's status (010, `tasks/action-items-http.ts`) | `action_item_id`, `status` |
| `v2.memory_written` | #758: one journal line per write decision the store made, from `remember`, the extractor, or `POST /api/memories` alike (`memory/store.ts`, `applyExtractionOps`) — the one place every memory write is decided, so a duplicate can be traced to the op that caused it or the check that caught it | `memory_id` (the row the op ended on, or the existing row for a deduped noop), `op` (`add`/`update`/`supersede`/`noop`), `target_id` (the op's own target: the memory id for an update/supersede/noop op, absent for add), `dup_of` (the current row a duplicate landed on, when `guard` caught one), `path` (`remember`/`extract`/`manual` — which caller wrote this), `guard` (`none`/`find_duplicate`/`unique_index`/`judge` — `find_duplicate` is the store's own check under its per-account advisory lock, `unique_index` is the `(user_id, content_key)` backstop catching a write that raced past it, `judge` is `remember`'s memory judge naming a held paraphrase), `conversation_id`, `message_id`, `kind` (add/supersede only), `surface` |
| `v2.memory_remembered` | The `remember` tool stored or matched a memory (010 T021, `memory/callbacks.ts`) | `memory_id`, `kind`, `outcome` (`add`/`supersede`/`noop`), `reason` (`new`; `duplicate` — the store's lexical check; `judge_same` / `judge_updates` — the memory judge found the fact already held, or a held fact it replaces), `conversation_id`, `message_id` |
| `v2.memory_judged` | `remember` found current memories within cosine distance 0.35 of the new one and asked the memory judge whether it is the same fact, a change of one, or new (`memory/callbacks.ts`, `@bob/ai` `memory-judge.ts`). Not emitted when no row is that close (no model call) | `verdict` (`same`/`updates`/`different`), `memory_id` (the held row the verdict names; absent for `different`), `candidates` (count, at most 3), `top_distance` (cosine, 3 dp), `judge_ms` |
| `v2.memory_reconciled` | `npm run memory:reconcile -- --apply` retired a memory stored twice before the judge existed (`memory/reconcile.ts`); printed by the script, not the server journal | `memory_id` (the retired row, now `superseded_by` the kept one), `kept_id`, `verdict` (`same` keeps the older row, `updates` the newer) |
| `v2.memory_judge_failed` | The judge threw or exceeded 5 s; `remember` stored the memory as new, as it did before the judge existed | `error_name` (class only), `judge_ms` |
| `v2.memory_forgotten` | The `forget` tool deleted a memory by id or query (`memory/callbacks.ts`) | `memory_id` |
| `v2.memory_forget_candidates` | `forget` by query did not delete: either no hit scored above the targeting floor (`DEFAULT_TARGET_FLOOR`, any text-rank hit), or the match was ambiguous (the best hit did not beat the runner-up by `DEFAULT_MATCH_MARGIN` = 1.5x); the top candidates are offered for disambiguation (`memory/callbacks.ts`) | `count`, `reason` (enum: `below_floor` \| `ambiguous`) |
| `v2.memory_gate_failed` | The memory gate's evaluation call threw or timed out (5 s); the turn is extracted as if the gate were off (`memory/extract.ts`) | `error_name`, plus `error_status` when the provider supplied one — never the error message or turn text |
| `v2.memory_embed_failed` | The `remember` tool's embed call threw; `remember` still stores the memory, with a NULL vector — invisible to semantic retrieval until corrected (S10-FIX3, `memory/callbacks.ts`) | `error_name` (the failing embedder call's error class) — never the error message or the memory content |

The four `remember`/`forget`/`memory_embed_failed` events above fire when a
journal is supplied to `createMemoryCallbacks`; both turn paths pass one today
(`createMemoryCallbacks(...)` in `apps/api/src/voice/turn/generate.ts` and
`apps/api/src/workflows/workflow-web-chat-turn.ts` (through `turn/chat-agent.ts`) supply `embedder` and `journal`, so the events do
appear in the running journal). The per-turn tool registry is recorded
separately by `v2.agent_tools` (see above).
Every `v2.memory_*` / `v2.action_item_*` event above carries ids, counts,
statuses, latency, or an error class/status code only — never memory content,
transcripts, or prompts (FR-013).

**Reading a broken memory pipeline:** a `v2.memory_retrieved` line with
`count:0` and `source_semantic:0` even though the account has memories means
those rows carry no embedding vector, not that none matched. A
`v2.memory_skipped` or `v2.memory_embed_failed` line with `error_name` set
names the provider call that is failing — the class only, never its message.

**Tracing a memory (#758):** given a `memory_id` (from the Memories page's
export, or a duplicate `memory:dupes` reported), `grep` the journal for it.
Every write that touched the row is a `v2.memory_written` line, in order:
`path` says which caller wrote it (`remember`, `extract`, `manual`), `op` says
what happened (`add`/`update`/`supersede`/`noop`), and on a `noop` the `guard`
says why (`find_duplicate` — the store's own check matched a current row
before any insert; `unique_index` — the insert raced past that check and the
`(user_id, content_key)` index caught it instead) with `dup_of` naming the row
it landed on. `conversation_id`/`message_id` tie the write back to the turn
in the conversation/messages tables. A memory with more than one
`v2.memory_written` line and every one of them `op:"add"` is the #758 bug
recurring — it means the duplicate check did not fire; open an issue with the
`path`/`guard` sequence, never the memory content.

008 hardened the redaction rule above: accounts appear only as
`acct=<first 8 hex of the account id's sha256>`, pairing codes/claims and
device tokens only as their SHA-256 hashes, and rate-limit keys as `ip_hash` —
never the raw values (`apps/api/src/devices/pairing-service.ts`,
`apps/api/src/devices/device-auth.ts`). `v2.telemetry_export_failed` is journalled
from the span-export failure hook in `apps/ai` (`onTelemetryError`),
once per kind per process, subscribed at server startup (specs/009 plan D3,
`apps/api/src/startup.ts`).

Every line carries `session` (the session id) and most carry `stage`
(`await_hello` → `ready` → `capturing` → `responding`).

The `v2.turn_stage_<stage>_<outcome>` family replaces the old
`v2.stt_*`/`v2.agent_*`/`v2.tts_*`, `v2.web_chat_*`/`v2.web_voice_*`/
`v2.web_speech_*`, and `v2.turn_empty` events. Every event in the family
carries `interface` (`cardputer`/`web`), `turn_id`, `stage`
(`input`/`stt`/`agent`/`tts`), and `outcome`
(`started`/`completed`/`failed`); `completed`/`failed` add `duration_ms`;
`conversation_id` is present when a conversation was resolved/created (absent
for web voice/speech). `failed` events add `kind`
(`invalid_input`/`upstream_error`/`internal`), `error_name` (the error class,
never its message), plus `upstream_status` and/or `timed_out` when applicable.
`input_completed` marks an empty turn (`empty: true`); web `input_failed`
carries `reason` (`unsupported_format`/`audio_too_large`/`invalid_audio`/
`no_speech_detected`/`invalid_request`). Stage-specific metadata is unchanged
from the old rows (e.g. `pcm_bytes`, `messages`, `chars`).

**Tracing a turn:** each line the journal writes inside a span also carries that
span's `trace_id` and `span_id` (the journal is JSON on stdout as well as in the
file, with `level` and `message`; a failed or errored event is `error`). In
Railway's log explorer, `@trace_id:<id>` lists a trace's lines; open the same id in
the Traces tab. The turn's spans carry the same `turn_id` as the attribute
`bob.turn.id` (`apps/ai/src/telemetry.ts`). Grep the journal for the id, then
search spans for `bob.turn.id`:

```
grep '"turn_id":"<id>"' data/v2-journal.log
```

**Metrics:** each sample is an OTel instrument and an `bob.metric.<name>` span
attribute, so a backend without metrics ingestion can still aggregate them from
spans. Dashboards cover AI/API workflows, UI experience, and Cardputer/voice. Filter
on the `deployment.environment.name` resource attribute before comparing results:
development, synthetic checks and stub HIL runs are not production traffic.
Workflow spans cover instrumented workflows, not every Express endpoint or
WebSocket message. The attribute vocabulary is in `docs/observability.md`.

The database turn metrics (`bob.turn_metrics`, one privacy-safe row per turn, written through
`bob_private.record_turn_metric`) carry `arrival_ms` from `20261107000000_turn_metrics_arrival.sql`
(SIMPLIFY-U0B): on web chat rows, ms from the request reaching the `webChat` handler to the model call,
always ≥ `prep_ms` (integer, nullable, 0..600000; null on device rows and on rows from before the
column). The recorder probes `pg_catalog.pg_attribute` once per process and sends `arrival_ms` only
when the column exists, so a server ahead of its database's migrations keeps recording rows without it.

Numeric samples (names below) supplement the journal and database turn metrics:

| Scores | Meaning |
| --- | --- |
| `turn.completed`, `turn.failed`, `turn.cancelled`, `turn.empty` | One 0/1 sample per recorded terminal turn for each outcome; handled failures count even when the root span does not throw. Mean is a fraction of recorded turns, sum is a count. |
| `ai.budget_exhausted` | Counter: one per provider call refused with HTTP 402 (spent AI Gateway budget, #1041), on every surface. Exists at 0 from start-up. |
| `turn.stt_ms`, `turn.prep_ms`, `turn.model_ms`, `turn.tts_ms`, `turn.total_ms` | Available stage and whole-turn durations; missing stages emit no sample. |
| `turn.first_token_ms`, `turn.first_audio_ms` | Time from turn start to first token/audio, including preparation. This is not provider-only time to first token. |
| `ui.request.duration_ms`, `ui.render.duration_ms` | Browser-measured fetch-to-response-headers and React commit work, respectively. Request timing does not measure streamed body completion; ingestion span duration does not measure browser latency. |
| `ui.web_vital.lcp`, `.inp`, `.fcp`, `.ttfb`, `.cls` | One sample per reported Web Vital. Milliseconds, except `cls`, which is unitless and recorded times 1000 as an integer. |
| `ui.error` | One sample (1) per reported JavaScript error or unhandled rejection (class name and own-bundle frame only). |
| `http.request.duration_ms`, `http.request.stream_ms` | Server time per HTTP request. A server-sent event stream (`/api/events`, `Content-Type: text/event-stream`) is not a request latency: its lifetime goes to `stream_ms` (span `outcome=closed`), never to `duration_ms`. |
| `http.request.failed`, `.aborted`, `.client_error`, `.server_error` | 0/1 flags (counters): `failed` = a 5xx, or the client abandoning a request before its response finished; `aborted` = that abandonment; `client_error` = 4xx (the caller's error, not a failure); `server_error` = 5xx. A closed event stream sets none of them. |
| `ui.request.failed`, `ui.request.aborted` | Separate 0/1 samples for each captured request. Means describe captured requests, including cancellations in the denominator. |
| `ui.window.requests_ok`, `ui.window.requests_error`, `ui.window.requests_aborted` | Counts before browser detail sampling, summed across received collection windows. |
| `ui.window.events_observed`, `ui.window.events_accepted`, `ui.window.events_dropped`, `ui.window.batches_failed`, `ui.window.timing_overflow` | Collection coverage and known delivery failures. Accepted means queued by the browser, not confirmed persisted. Counts exclude lost windows; server budgets can also discard events. Timing overflow counts measurements beyond the 120-second UI cap. |
| `device.heap_free_bytes`, `device.heap_largest_bytes`, `device.uptime_ms` | Server-recorded numeric diagnostics from existing device messages. Minimum heap values expose pressure; uptime is a sampled gauge, not availability. |

UI journal events also include `ui_navigation`, `ui_interaction`, `ui_render`,
`ui_request`, and `ui_metrics_window`. Fields are bounded enums, numbers and a
random view UUID; no URLs, form values, request bodies or credentials are
captured. A missing metric means no measurement, never an inferred zero. Model
costs retain their native `gen_ai.usage.*` fields; feedback fractions describe
submitted ratings, not unobserved response quality.

---

## Family collaboration events (014) — `data/v2-journal.log`

Spaces, threads, tasks, calendars and notes (feature 014) each own a router under `/api` and journal
through the same `journal()` helper as everything above. As of this writing
`spaces/http.ts`, `spaces/threads-http.ts`, `tasks/http.ts`, `calendar/http.ts` and
`conversations/invocations-http.ts` are mounted in `server.ts`; `notes/http.ts` (store +
router, S14-T016) exists but is **not yet mounted**, so its events do not
appear in a running journal until a later task wires it in.

Every field below is an id, a count, a boolean, a revision number, or a
bounded status/outcome enum defined in a Zod schema — never a space, thread,
task, note or calendar's title/name/body, an attendee's email, an invitation
token, or a search query. That is the stated rule in each router's file
docstring, confirmed here by reading every one of the 53 call sites below.

### Spaces, membership and invitations (`spaces/http.ts`)

| Event | When | Key fields |
| --- | --- | --- |
| `v2.spaces_listed` | `GET /api/spaces` | `count` |
| `v2.space_created` | `POST /api/spaces` | `space_id`, `kind` (always `group` since 2026-10-06; spaces have no type) |
| `v2.member_removed` | `DELETE /api/spaces/:id/members/:userId` | `space_id`, `target_user_id` |
| `v2.member_role_changed` | `PATCH /api/spaces/:id/members/:userId`; no user identity and no raw error is logged | `space_id`, `role` (`admin` or `member`), `changed` (boolean; `false` when the member already had that role) |
| `v2.owner_transferred` | `PUT /api/spaces/:id/owner` | `space_id` |
| `v2.space_renamed` | `PATCH /api/spaces/:id`; the name is never logged | `space_id` |
| `v2.space_archived` | `DELETE /api/spaces/:id` | `space_id`, `invitations_revoked` |
| `v2.space_restored` | `PATCH /api/spaces/:id` with `{ archived: false }` | `space_id` |
| `v2.active_space_clear_failed` | Archiving a space, or removing a member, could not clear an active-Space pointer that named it; the request still succeeds | `space_id`, `error` (name only) |
| `v2.space_access_publish_failed` | A committed membership or role change could not publish its cache invalidation; server access checks remain authoritative | `error` (name only; no account or space identifiers) |
| `v2.invitation_created` | `POST /api/spaces/:id/invitations`; the raw token is returned once in the response body and never logged | `space_id`, `invitation_id` |
| `v2.invitation_revoked` | `DELETE /api/invitations/:id` | `invitation_id` |
| `v2.invitation_previewed` | `GET /api/invitations/:token` — the one account-less route a non-member may reach | — |
| `v2.invitation_accepted` | `POST /api/invitations/:token/accept` | `outcome` (`accepted`/`already_accepted`/`already_member`/`expired`/`revoked`/`email_mismatch`/`not_found`) |

### Threads and messages (`spaces/threads-http.ts`)

Posting a message never invokes the model (FR-008); addressing Bob is the
separate invocations route below.

| Event | When | Key fields |
| --- | --- | --- |
| `v2.threads_listed` | `GET /api/spaces/:spaceId/threads` | `space_id`, `count` |
| `v2.thread_created` | `POST /api/spaces/:spaceId/threads` | `thread_id`, `space_id` |
| `v2.thread_read` | `GET /api/threads/:id` | `thread_id` |
| `v2.thread_renamed` | `PATCH /api/threads/:id` | `thread_id` |
| `v2.thread_archived` | `DELETE /api/threads/:id` | `thread_id` |
| `v2.thread_pointer_clear_failed` | Archiving a thread could not list its space's members, or could not clear one member's active pointer that named it; the archive still succeeds and the next `getActive` read clears it | `thread_id`, `error` (name only) |
| `v2.messages_listed` | `GET /api/threads/:id/messages` | `thread_id`, `count`, `has_cursor` |
| `v2.thread_message_posted` | `POST /api/threads/:id/messages` (a HUMAN message) | `thread_id`, `message_id`, `sequence`, `deduped` (a retried `client_message_id` returned the existing row instead of creating one) |
| `v2.thread_message_edited` | `PATCH /api/messages/:id` | `message_id`, `revision` |
| `v2.thread_message_tombstoned` | `DELETE /api/messages/:id` | `message_id`, `thread_id`, `moderator` (true when tombstoned by someone other than the author) |
| `v2.thread_message_revisions_read` | `GET /api/messages/:id/revisions` | `message_id`, `revision` |
| `v2.thread_read_cursor` | `PUT /api/threads/:id/read` | `thread_id`, `last_read_sequence` |

### Tasks, checklists and subscribers (`tasks/http.ts`)

| Event | When | Key fields |
| --- | --- | --- |
| `v2.tasks_listed` | `GET /api/spaces/:spaceId/tasks` | `space_id`, `count` |
| `v2.task_created` | `POST /api/spaces/:spaceId/tasks` | `task_id`, `space_id`, `parent` (bool: has a `parent_task_id`) |
| `v2.task_read` | `GET /api/tasks/:id` | `task_id` |
| `v2.task_updated` | `PATCH /api/tasks/:id` | `task_id`, `revision` |
| `v2.task_trashed` | `DELETE /api/tasks/:id` (trash, not purge) | `task_id` |
| `v2.task_restored` | `POST /api/tasks/:id/restore` | `task_id` |
| `v2.task_items_listed` | `GET /api/tasks/:id/items` — checklist items are child tasks | `task_id`, `count` |
| `v2.task_item_created` | `POST /api/tasks/:id/items` | `task_id`, `item_id` |
| `v2.task_item_moved` | `PATCH /api/tasks/:id/items/:itemId` | `task_id`, `item_id`, `revision` |
| `v2.task_subscribers_listed` | `GET /api/tasks/:id/subscribers` | `task_id`, `count` |
| `v2.task_subscriber_added` | `POST /api/tasks/:id/subscribers` | `task_id`, `user_id` |
| `v2.task_subscriber_removed` | `DELETE /api/tasks/:id/subscribers/:userId` | `task_id`, `user_id` |

### Reminders (`reminders/http.ts`)

Ids and counts only, never a title. A reminder and its recipients are written
in one transaction, so a refused create leaves nothing behind.

| Event | When | Key fields |
| --- | --- | --- |
| `v2.reminders_listed` | `GET /api/spaces/:spaceId/reminders` | `space_id`, `count`, `duration_ms` |
| `v2.reminder_created` | `POST /api/spaces/:spaceId/reminders` | `reminder_id`, `space_id`, `recipients` (count), `recurring` (bool) |
| `v2.reminder_create_refused` | The same POST named a recipient who is not an active member (400, nothing written) | `space_id`, `reason` (`recipient_not_member`) |
| `v2.reminder_updated` | `PATCH /api/reminders/:id` — a timing or rule change bumps `schedule_revision`, so occurrences queued under the old revision produce nothing | `reminder_id`, `schedule_revision` |
| `v2.reminder_cancelled` | `POST /api/reminders/:id/cancel` | `reminder_id` |
| `v2.reminder_occurrence_snoozed` | `POST /api/reminders/:id/occurrences/snooze` — the caller's own occurrence only | `reminder_id`, `occurrence_id` |

### Notifications from writes (`notifications/notify.ts`)

A write that should reach someone else's inbox enqueues the item in the same
request, after the write commits (the outbox fanout is not built yet). The item
carries ids, a type and a revision only. A failed enqueue never fails the
write; it journals a count and the request carries on. Producers:

- `assignment`: `POST /api/spaces/:spaceId/tasks`, `POST /api/tasks/:id/items` or `PATCH /api/tasks/:id` sets an assignee other than the actor (a PATCH that keeps the same assignee adds nothing).
- `mention`: `POST /api/threads/:id/messages` @mentions members other than the author (`@bob` and unknown handles never notify; a retried post adds nothing).
- `task_update` (#511): `PATCH /api/tasks/:id` changes a task's status, assignee or due. Each follower who is still an active member of the space gets one item per task revision. The actor gets none, and neither does a follower who was just assigned the task, because they already get the `assignment`. A title-only or notes-only edit adds nothing. The item goes to the inbox only, never to email.

| Event | When | Key fields |
| --- | --- | --- |
| `v2.notifications_enqueued` | a producer above had at least one recipient | `type`, `count` (items enqueued), `muted` (recipients skipped by their own mute preference) |
| `v2.notifications_enqueue_failed` | the preference read or the enqueue threw; the write still succeeded | `type`, `count` (intended recipients) |
| `v2.usage_read` | `GET /api/me/usage` answered (`account/usage-http.ts`) | `range`, `active_days`, `turns` (counts only) |
| `v2.notifications_listed` | `GET /api/notifications` returned a page of the inbox (`notifications/http.ts`) | `count`, `unread_count`, `describe_failed` (items whose about could not be read, other than gone or hidden) |
| `v2.push_delivery` | A remote-notification outbox item completed its device deliveries (`notifications/push-delivery.ts`) | `sent`, `invalid` (counts only; no tokens, accounts, message text or provider response bodies) |
| `v2.notifications_marked_read` | `PUT /api/notifications/read` | `moved` (count of items marked read) |
| `v2.notification_preferences_listed` | `GET /api/notification-preferences` | `count` |
| `v2.notification_preference_upserted` | `PUT /api/notification-preferences` stored one preference | `preference_id` |

### Transactional email (`notifications/email-client.ts` and its callers)

Every email goes through `sendTemplateEmail`, which journals the template
name and an outcome only: never an address, a subject or template data. The
callers add a count-only line of their own; none of them fails the request
that triggered the email.

| Event | When | Key fields |
| --- | --- | --- |
| `v2.email_sent` | notify-email accepted the send | `template` |
| `v2.email_skipped` | no email endpoint configured; nothing sent | `template`, `reason` (`not_configured`) |
| `v2.email_send_failed` | the send timed out, failed on the network, or was refused | `template`, `code` (`timeout`/`network`/`http_<status>`) |
| `v2.space_email_sent` / `v2.space_email_failed` | a space email (`space-invite`, `space-member-removed`, `space-ownership-transferred`, `space-archived`) went out to some recipients / failed for some (`spaces/emails.ts`) | `template`, `count` (recipients) |
| `v2.event_cancelled_emailed` | `DELETE /api/events/:id` mailed `event-cancelled` to the attendees (`calendar/http.ts`) | `event_id`, `sent`, `failed` (counts) |
| `v2.google_unlinked_email` | unlinking a Google account mailed `google-account-unlinked` (`apps/api/src/integrations/google-http.ts`) | `code` (`sent`/`no_address`/`send_failed`), `count` (0 or 1) |
| `v2.invitee_account` | an invitation made sure the invited address has an account, through the invite-account function, so the invitee can sign in and accept (`account/provisioning.ts`; never the address) | `outcome` (`created`/`exists`/`skipped`/`failed`); `reason` (`not_configured`) when skipped; `code` (`timeout`/`network`/`bad_response`/`http_<status>`) when failed |

### Outbox worker and notification email (`outbox-module.ts`, `notifications/email.ts`)

The web server runs the outbox worker and the reminder fan-out itself
(`outbox-module.ts`), because production runs only that process and only it
holds the device sessions a reminder rings. Each inbox notification is also mailed
once. The mail handler records every sent effect in `bob.email_effects`
before the row is acked, so a row reclaimed after its send acks without mailing
again (#506). A notification older than 24 h is acked without sending
(`stale`).

| Event | When | Key fields |
| --- | --- | --- |
| `v2.outbox_worker_started` | the web server started delivery work | `owner` (hostname:pid) |
| `v2.routine_queue_error` | Routine queue startup or pool operation failed; no raw driver error is recorded | `code` (`queue_unavailable`), `reason` (driver code classified by `platform/db/db-error.ts`: `auth_failed`, `host_not_found`, `connection_refused`, `connection_lost`, `timeout`, `permission_denied`, `schema_missing`, `unknown`) |
| `v2.routine_dispatch_tick` | Due routines created durable run intents for the existing outbox | `count` |
| `v2.routine_dispatch_failed` | Routine discovery failed; the next non-overlapping tick retries | `code` (`dispatch_unavailable`), `reason` (same values as `v2.routine_queue_error`) |
| `v2.outbox_worker_failed` | the web server could not start the delivery work (store unreachable at boot); the server keeps serving, nothing drains until the next start | `error` (name only) |
| `v2.outbox_tick` | a drain tick claimed rows or failed (`platform/outbox/worker.ts`); idle ticks are counted in the `outbox.poll-summary` span only | `claimed`, `acked`, `released` (incl. rows with no handler), `parked`. Counts only. `lane` when the tick ran on a named outbox lane (the catch-all default lane carries none) |
| `v2.outbox_tick_failed` | reclaiming or claiming a batch threw; the next tick retries | `error_name`; `lane` on a named outbox lane |
| `v2.outbox_release_failed` | a row's handler failed and releasing it for retry also threw (a store outage); the row stays leased under the heartbeat until `stop()` releases it | `error_name` (the handler's error code); `lane` on a named outbox lane |
| `v2.email_notification_sent` | a notification email was handed to notify-email and recorded as sent | `template` |
| `v2.email_notification_skipped` | the row acked without sending | `reason` (`not_configured`, `bad_key`, `already_sent` (a reclaimed row whose email already went out), `gone`, `read`, `inbox_only` (a type that is never mailed: `task_update`), `no_address`, `stale` (the notification is more than 24 h old)), `template` when known |

### Calendars, events, attendees and agenda (`calendar/http.ts`)

| Event | When | Key fields |
| --- | --- | --- |
| `v2.calendars_listed` | `GET /api/spaces/:spaceId/calendars` | `space_id`, `count` |
| `v2.calendar_created` | `POST /api/spaces/:spaceId/calendars` | `calendar_id`, `space_id` |
| `v2.events_listed` | `GET /api/calendars/:id/events` | `calendar_id`, `count` |
| `v2.event_created` | `POST /api/calendars/:id/events` | `event_id`, `calendar_id` |
| `v2.event_updated` | `PATCH /api/events/:id` | `event_id`, `scope` (`this`/`this_and_following`/`series`) |
| `v2.event_cancelled` | `DELETE /api/events/:id` | `event_id`, `scope` |
| `v2.attendee_added` | `POST /api/events/:id/attendees` | `event_id` |
| `v2.attendee_removed` | `DELETE /api/events/:id/attendees` | `event_id` |
| `v2.rsvp_set` | `PUT /api/events/:id/rsvp` | `event_id`, `response` (`needs_action`/`accepted`/`declined`/`tentative`) |
| `v2.agenda_listed` | `GET /api/agenda` | `count` |

### AI invocations (`conversations/invocations-http.ts`, orchestrated by `workflows/workflow-thread-invocation.ts`)

The explicit "ask Bob in a thread" route (FR-008 split); ordinary
`POST /messages` never reaches the model. `workflows/workflow-thread-invocation.ts` itself emits
no journal events — it returns an `InvocationResult` that the router journals.

| Event | When | Key fields |
| --- | --- | --- |
| `v2.invocation_created` | `POST /api/threads/:id/invocations` | `thread_id`, `state` (the run's outcome, or the `busy`/`duplicate` reason) |
| `v2.invocation_responded` | Same request, once `runInvocation` returns (unless busy, which is a 409 with no journal line) | `outcome` (`completed`/`cancelled`/`failed`/`duplicate`) |
| `v2.invocation_read` | `GET /api/invocations/:id` | `invocation_id`, `state` |
| `v2.invocation_cancelled` | `DELETE /api/invocations/:id` | `invocation_id`, `state` |

### Notes (`notes/http.ts`; not yet mounted, see above)

| Event | When | Key fields |
| --- | --- | --- |
| `v2.notes_listed` | `GET /api/spaces/:spaceId/notes` | `space_id`, `count` |
| `v2.note_created` | `POST /api/spaces/:spaceId/notes` | `note_id`, `space_id` |
| `v2.note_read` | `GET /api/notes/:id` | `note_id` |
| `v2.note_updated` | `PATCH /api/notes/:id` | `note_id`, `revision` |
| `v2.note_trashed` | `DELETE /api/notes/:id` (trash, not purge) | `note_id` |
| `v2.note_restored` | `POST /api/notes/:id/restore` | `note_id` |
| `v2.approval_created` | `POST /api/approvals` | `proposal_id`, `steps` |
| `v2.approval_decided` | `POST /api/approvals/:id/approve`, `POST /api/approvals/:id/decline` | `proposal_id`, `decision`, `status` |
| `v2.note_pinned` | `PUT /api/notes/:id/pin` | `note_id` |
| `v2.note_unpinned` | `DELETE /api/notes/:id/pin` | `note_id` |
| `v2.note_revisions_listed` | `GET /api/notes/:id/revisions` | `note_id`, `count` |
| `v2.notes_searched` | `GET /api/spaces/:spaceId/notes/search?q=` | `space_id`, `count` (the query text `q` is never logged) |

No violation of Principle II was found across these 53 events: ids, counts,
booleans, revisions and the bounded enums above (`kind`, `outcome`, `state`,
`scope`, `response`) are the only field values that appear. Names, emails,
tokens, titles, bodies and search text are consistently excluded by
construction — each router narrows its store objects to summary DTOs before
the response, and the journal calls pull from the request/response ids, never
from the DTO's content fields.

### Publication (`spaces/publication-http.ts`, `spaces/publication-service.ts`)

Copying a private note into a space, or promoting a remembered action into a
task. Types and counts only, never the copied title or body.

| Event | When | Key fields |
| --- | --- | --- |
| `v2.publication` | the copy and its provenance row committed | `source_type` (`note`/`memory`), `published_type` (`note`/`task`) |
| `v2.publication_route` | `POST /api/notes/:id/publish` or `POST /api/memories/:id/promote` answered 201 | `published_type` (`note`/`task`), `field_count` (fields copied: 1, or 2 when a note's body came along) |

### Search (`conversations/search-http.ts`)

| Event | When | Key fields |
| --- | --- | --- |
| `v2.search` | `GET /api/search` | `count`, `scope` (`space` when `space_id` was given, else `all`); the query text is never logged |

### Operational metrics (S14-METRICS) — `apps/api/src/platform/observability/metrics.ts`

Issue #145's metrics surface: an in-process counter/duration registry with
bounded labels, read through `createMetrics().snapshot()` — a JSON summary
`{ counters, durations }` of numbers only, never a sample or a last-value
string. No `prom-client`, no scrape endpoint; a Prometheus exposition can wrap
the registry later. No producer is wired to these metrics yet — the registry
and its enforcement are the deliverable, and each metric below is the
operator-facing contract.

Label rules: every label admits only the allowlisted values below. A value
outside the set throws under vitest and is dropped to the reserved `unknown`
label in production, so cardinality cannot grow with data. Identifiers are
never label values — a uuid, an email, a token prefix (`olxd_`, `sk-`, `sb_`)
or a URL is rejected the same way (FR-036, issue #145 AC2).

| Metric | Measures | Labels (allowlisted values) |
| --- | --- | --- |
| `bob_commands_total` | Device command rate by operation and status | `operation` (`hello`, `turn_start`, `audio`, `turn_end`, `cancel`, `pong`, `list_conversations`, `select_conversation`, `new_conversation`, `list_spaces`, `select_space`, `pair_request`), `status` (`ok`, `refused`, `failed`) |
| `bob_outbox_retries_total` | Outbox delivery retries by event type | `event_type` (`reminder.due`, `notification.pushed`, `invitation.delivered`, `publication.sent`, `task.completed`) |
| `bob_outbox_due_lag_ms` | Outbox delivery due-lag (duration) by event type | `event_type` (same allowlist) |
| `bob_outbox_worker_in_flight` | Worker saturation: rows currently leased/in flight, from the drain loop's `health()` (`platform/outbox/worker.ts`) | — |
| `bob_outbox_worker_parked` | Worker saturation: rows parked past `maxAttempts`, from the drain loop's `health()` | — |
| `bob_provider_sync_lag_ms` | Provider sync lag (duration) by provider and status — defined now although no provider adapter exists yet | `provider` (`google`, `apple`, `native`), `status` (`ok`, `failed`, `empty`) |

The `event_type` allowlist is the family's declared delivery effects; extend
it deliberately as producers land, never by letting data choose a label value.

---

## Device serial — `data/device.log`

Plain text lines: `<uptime_ms> INFO v2.<event> state=<STATE> [session=<id>]
[detail=...]`. `uptime_ms` is milliseconds since boot; `STATE` is the device
state machine: `BOOT` → `WIFI` → `SOCKET` → `READY` → `LISTEN` (capturing) →
`WAIT` (awaiting reply) → `ERROR`, plus `SELECT`, `NEWCHAT`, `PAIR`, `HELP` and
`ANNOUNCE` (an announcement card).

Every line the firmware prints is one of these, or a `T> ` console reply in
the HIL build: nothing else writes to serial (HIL `cleanSerial` checks it). A
line like `[BOB-DIAG] readCb ok bytes=2 elapsed=N` came from a hand-patched
WebSockets copy left in a checkout's `.pio/libdeps`; the build now installs
libraries into `.pio/libdeps-pristine` and sets `-DNODEBUG_WEBSOCKETS`
(`platformio.ini`), so a rebuild drops it. The Arduino core's own
`[I][...]`/`[W][...]` lines are compiled out too (`-DCORE_DEBUG_LEVEL=1`,
#669); only a core error (`[E][...]`) can still reach serial.

| Event | When | Detail fields |
| --- | --- | --- |
| `boot` | Firmware started (once, after the config check) | `fw` (`kFirmwareVersion`, from the build since #345: `x.y.z` for a release build, `<next x.y.z>-dev+<sha>` for a local one, `0.0.0-dev` with no version flags; see `scripts/release/fw-version.mjs`), `build` (short git sha from `-DBOB_BUILD_ID`, `dev` in a build without it). The same `fw … build …` shows small and dim on the boot/connecting screens and as the last line of HELP |
| `settings_migrated` | First boot of the #675 settings store (once per namespace; never again after its schema is written). On a developer build the compiled `secrets.h` network becomes saved slot 0 and the compiled host becomes the Dev profile (or Production when it is exactly `api.heybob.xyz:443` TLS); the pre-#675 `dev_tok` is copied to that profile's token and left in place | `net` (1 = saved networks initialised), `srv` (1 = server profile initialised), `seeded` (1 = slot 0 came from `secrets.h`), `token_profile` (`prod`/`dev`/`custom` the legacy token was copied to, or `none`) |
| `config_missing` | No saved Wi-Fi network at boot. Since #677 this is not a dead end: the screen says NO WI-FI SAVED and `[,]` opens Settings | — |
| `wifi_scan` | A scan for the saved networks finished (#676): after the boot or re-plan direct try failed (since #707 boot joins the top saved network first, with no scan, so on a good boot there is no `wifi_scan` at all), after every saved network failed, or after a drop outlasted the 30 s grace | Every `wifi_scan` line (done or failed) ends with `disc=<n> st=<n>` (#707), both taken at scan start: `disc` the last ESP-IDF disconnect reason (0 = none yet), `st` the Arduino `WiFi.status()` (0 idle, 1 no SSID, 3 connected, 4 connect failed, 5 connection lost, 6 disconnected); `found` (access points seen), `saved_visible` (saved networks among them), `ms` (scan start to the results being read), `done_ms` (scan start to the driver's scan-done event; `none` if it never came; `ms` well above `done_ms` means the results sat unread), and `late=1 failed_at_ms=<n>` when the results came after the core had already called the scan failed (#686: the core gives up at 6 s, but the driver's scan-done can come later; only that timeout is waited on, 4 s more). A failed scan is `failed=1 ms=<n> failed_at_ms=<n> done_ms=<n/none> started=<0/1> rescan=<0/1>`: `started=0` the scan could not start at all; `failed_at_ms` below 6000 means the core lost the scan early, with no wait; otherwise no results came within the core's 6 s plus the 4 s wait (so `ms` is near 10000). `rescan=1`: the device scans again at once (no radio reset); `rescan=0`: this was the second failure in a row and the round ends as `wifi_all_failed tried=0`, then the usual back-off. `found=0` is a real empty scan, never a failure. From Settings (`state=SETTINGS`, the Choose Wi-Fi list; it scans while connected) the line is `found=<n> listed=<n>` (`listed`: networks shown, merged by name, the strongest 12), or `failed=1 listed=0` when the scan failed even after the same late-results grace (#739; before it, a Settings scan past the core's 6 s timeout was logged as `found=0`) |
| `wifi_try` | Joining a saved network (15 s limit). At boot and on a Settings re-plan the first `wifi_try` comes before any `wifi_scan`: `direct=1` (#707) joins the top saved network straight away (on a re-plan, after a 400 ms settle), with no scan; if it fails, the next line after its `wifi_join_failed … direct=1` is a `wifi_scan`, never a blind try of the next network | `slot` (the saved network's stable id 0-4; never its name), `rank` (0 = first in the plan), `rssi` (from the scan; 0 for a hidden network and on a direct try), `direct=1` only on the direct try |
| `wifi_joined` | The join succeeded (also after a drop, when the same network came back). A `wifi_roam` follows it; after `moved=1` a second `wifi_joined` shows the stronger node | `slot`, `rssi`, `channel` |
| `wifi_roam` | Once per join, right after its `wifi_joined` (#717; not after the reconnect that follows a `wifi_dropped`): the joined channel is scanned for the same network (~0.3 s), because the driver joins the first node of a mesh it hears, not the strongest. `moved=1`: another node was 8 dB or more stronger, so the device leaves and, after a 400 ms settle, joins that node by its hardware address | `from` (the joined rssi), `to` (the strongest other node of the network on that channel; 0 when none), `ch` (the channel), `found` (the network's nodes the scan saw, the joined one included), `moved` (0/1). Never a network name or hardware address |
| `wifi_join_retry` | An auth or handshake disconnect (2, 15, 202-205) on a join; after a 400 ms settle the same network is joined again with a fresh 15 s limit. An access point still holding the previous association often refuses the first join once, so one `wifi_join_retry reason=202` at boot followed by `wifi_joined` is normal. After 2 retries the next disconnect is a `wifi_join_failed` (a wrong password: `result=auth` after 3 tries). `no_ap` and the 15 s limit are never retried | `slot`, `reason` (the ESP-IDF disconnect reason), `retry` (1 or 2) |
| `wifi_join_failed` | The join failed; the next planned network is tried. After a direct try (`direct=1`, #707) a scan starts instead, and the failure is not stored as the network's last result (the scanned round judges it) | `slot`, `result` (`auth` wrong password or handshake, `no_ap` not found, `timeout`), `reason` (the ESP-IDF disconnect reason; 0 = the 15 s limit), `direct=1` only for the direct try |
| `wifi_all_failed` | Every planned network failed. The Wi-Fi screen says NO WI-FI ([Enter] tries now); the device never reboots | `tried` (networks in the plan; 0 = none of the saved ones in range), `next_retry_ms` (60000, 120000, then 300000) |
| `wifi_driver_cfg_cleared` | At Wi-Fi start, before the first join (#707): the Wi-Fi driver still held its own copy of a station network in flash (builds before this one let it persist; the device's saved networks are kept apart and untouched), so it was erased. Written once per upgraded device; every later boot finds nothing and logs nothing. The `wifi` and `factory` resets erase that copy too, with no line of their own | `ok` (1 erased; 0 the erase failed, so it is tried again next boot). Never the network's name |
| `wifi_test` | Settings verifies a network before saving it (#677: a join test; nothing is saved when it fails) | `started=1`, then `result` (`ok`, `auth`, `no_ap`, `timeout`) and on failure `reason` |
| `reset` | A reset option from Settings -> Reset ran (#680). Each clears only its scope: `wifi` every saved network (then Setup opens, `setup_entered reason=forgot_all_wifi`); `server` Local dev/Custom and the unlock, back to Production, every token kept; `unpair` the active profile's token (the device reconnects and pairs); `factory` everything, after typing RESET, then the firmware's only restart and a first boot | `scope` |
| `profile_set` | Settings switched the server profile (#679); the socket reconnects to it when Settings closes, with that profile's token | `profile` (`prod`/`dev`/`custom`; never the host), `tls` |
| `profile_refused` | A server profile could not be used: at boot a stored profile this build may not use falls back to Production (`reason=not_allowed_on_this_build`, e.g. plain ws:// on the retail build, or `invalid_endpoint`); in Settings a switch that failed its check (`reason` = the error number) | `profile`, `reason` |
| `dev_options` | `developer` was typed on About on a build without developer options (#679): the Custom profile (TLS only) is available, or no longer | `unlocked` (1/0) |
| `setup_entered` | Settings opened by itself at boot (#678) instead of `settings_opened` | `reason` (`first_boot`: no saved network, so the guided Setup starts on its Welcome screen; `rescue_chord`: Fn+`` ` `` was held at power-on, so Settings opens on the Wi-Fi list and nothing is erased) |
| `settings_opened` / `settings_closed` | Settings opened with `[,]` (Ready or a Wi-Fi screen) / closed (`` ` `` on its home, or 2 minutes idle). Voice is off while it is open | closed: `changed` (`wifi` when the saved networks or the link changed, which re-plans the Wi-Fi; else `none`) |
| `net_saved` / `net_updated` / `net_forgot` / `net_reordered` | A saved network was added (after a verified join; it goes first in line), its password changed, it was forgotten, or the priority order changed | `slot`, `count` / `slot`, `fields=pass` / `slot`, `count` / `order` (slot ids, highest priority first) |
| `wifi_dropped` | The joined network was lost; the same one gets 30 s before a new scan | `slot` |
| `net_probe` | The internet check after a join, Production only: HTTPS `/health` with the bundled roots, then plain HTTP | `result` (`online`; `captive` a sign-in page answered: NEEDS SIGN-IN, re-checked every 5 min or on [Enter]; `no_dns`, `no_route`, `tls_fail`: NO INTERNET), `ms` (timed on the probe's own task since #710, so the main loop keeps running), `stack` (bytes of the probe task's stack never used; 0 when the probe ran inline), `heap_min` (lowest free heap since boot) |
| `net_probe_stale` | A probe that began before a Wi-Fi re-plan or a Settings pause finished (#710): its result is ignored and a fresh probe starts | `result`, `ms` |
| `net_probe_inline` | The probe task could not be created (no heap), so the probe ran on the main loop as before #710 and blocked it for the `ms` of the `net_probe` line that follows (with `stack=0`) | `free`, `largest` (heap, bytes) |
| `wifi_state` / `wifi_connected` | Wi-Fi driver status changes (kept alongside the #676 events above; `wifi_reconnect` is gone: the connection manager decides what to join) | `status`, `rssi`, `channel` |
| `wifi_heartbeat` | Every 10 s | `status` (3 = connected), `rssi` (dBm) |
| `socket_connect` / `socket_connected` | WS handshake started / done | — |
| `hello_sent` | `hello` control sent | `format=pcm16_16k_mono` or `format=mp3_16k_mono` (MP3 is the default), `fw` (the `fw_version` sent), `caps` (how many capability tokens were sent) |
| `hello_format_forced` | HIL build only: `T hello pcm\|mp3` set the format of every later hello (RAM only) and the socket reconnects so the next `hello_sent` uses it (#611 `pcm-reply`) | `format=pcm16_16k_mono` or `format=mp3_16k_mono` |
| `update_required` | The server's minimum firmware is above this build (#345). The device shows UPDATE NEEDED ("Needs firmware <min>"), starts no turns, and BTN GO reconnects | `fw`, `min` (empty when `reason=refused`), `reason` (`below_minimum` \| `unknown_version` \| `refused`: an `error` `UPDATE_REQUIRED` arrived) |
| `update_required_bad` | An `update_required` whose `min_version` was missing or over 32 chars; UPDATE NEEDED is shown anyway | — |
| `welcome_accepted` | Server welcomed the session | `session=<session_id>`, `format` |
| `socket_retry` | Socket re-attempted after the reconnect backoff | `delay_ms` |
| `socket_closed` / `socket_error` | Connection dropped / error | `code`; `socket_closed` also carries `clean` (1/0) and `retry_ms` |
| `socket_retry_requested` | User pressed BTN GO to retry | — |
| `turn_started` | The turn reached the server: the wake word was heard, speech started in the follow-up window, or BTN GO has been held 300 ms (`kGoMinHoldMs`; the mic opened at the press) | `mode=<ptt\|wake\|announce_only>` (the stored setting), or `mode=followup` with `pre_roll_frames` (frames from up to 300 ms before the speech onset, sent first, in messages numbered from 0); after GO also `held_frames` (frames captured during the hold). Every frame of a turn goes through the uplink queue (`include/uplink_queue.h`, 160 frames): each loop sends the frames it captured plus up to 8 older ones, in `audio_up` messages of 4-8 frames (40-80 ms; any shorter tail once the mic closed), numbered per message, stops after 30 ms in the socket, and leaves whatever the socket would not take (the network task holds the client, or the TCP send buffer has no room) queued, in order, for the next loop — never skipped, never one burst; `spk_ms`, `tone_wait_ms`, `mic_ms` (how long the press spent installing the speaker and starting the tone, waiting for the tone, opening the mic) |
| `turn_tap_ignored` | BTN GO released before 300 ms: a tap, not a turn. Nothing was sent; "Hold GO to talk" toast; READY. Cardputer only | `held_ms` |
| `turn_tap_hands_free` | Waveshare: BOOT released before 300 ms. The tap becomes a hands-free turn: `turn_start` goes out with the frames held so far and the VAD ends it (`turn_ended end_reason=silence`, 1000 ms of silence on this board, `kVadQuickEndSilenceMs`) (#1063) | `held_ms` |
| `touch` | Waveshare: a finished gesture meant a round-screen action (`touch::intentFor`, #1063). Gestures that only press keys (chips, lists, fields) are not journaled. Never a coordinate | `gesture` (`tap`, `long_press`, `swipe_up`, `swipe_down`, `swipe_left`, `swipe_right`), `action` (`go`: talk hands-free on READY, send now while listening, stop and listen again while the reply is in flight, close HELP or an announcement, retry an error; `bob`: a giggle; `bob_info`: a giggle, then the info view; `close_info`; `volume`; `chips`: the shortcut chips show), `gap_ms` (the largest gap between consecutive panel samples during the gesture; the sampler task reads every 33 ms, so healthy is ~33-45; over 100 means the sampler task starved and a swipe may have been read as a tap) |
| `touch_dropped` | Waveshare: the touch sampler task found its 16-slot queue full and dropped the newest sample (poll() was stalled for over ~0.5 s with a finger down). Journaled when the count changes. Healthy is none | `total` (cumulative samples dropped since boot; healthy 0) |
| `touch_sampler` | Waveshare: once, about a second after the touch sampler task starts: how much of its stack was never used (`uxTaskGetStackHighWaterMark`) | `stack_free` (bytes left of the 4096; keep above 512), `core` (1), `prio` (2) |
| `info_opened` / `info_closed` | Waveshare: the READY info view (paired name, conversation, Space, mode, volume, battery, links) opened 750 ms after a tap on Bob, and closed by a tap or a swipe right; it no longer closes by itself (#1063) | `source` (`bob`; the closing gesture) |
| `reply_shown_live` | Waveshare: `reply_text` for the turn in flight arrived and its words show over the speaking Bob, three lines a page, turning every 4.2 s or by swipe; the card keeps the page through the follow-up window (#1063) | — |
| `turn_trouble` | Waveshare: a server `error` failed the turn; Bob looks confused for 4 s with a caption naming the kind instead of a toast (#1063) | `kind` (`no_internet`: Wi-Fi down; `busy`: `INTERNAL`; `not_heard`: `BAD_AUDIO`, `SEQUENCE_GAP`, `FRAME_TOO_LARGE`, `QUEUE_FULL`; `other`). A hands-free turn heard as nothing (`wake_rejected`, or an empty `reply_text`) shows the `not_heard` caption "Didn't catch that" without this event |
| `audio_up` | One uplink frame sent | `seq` |
| `turn_ended` | The uplink closed: BTN GO released, or a hands-free (wake / follow-up) turn ended by the VAD or by GO | `end_reason`: `release` (GO let go), `silence` (the VAD: 1200 ms with no speech after the talking, `kVadEndSilenceMs`, 1000 ms on the Waveshare, `kVadQuickEndSilenceMs`, never within 1500 ms of the speech onset), `max` (15 s, `kVadMaxTurnMs`), `key` (GO pressed during a hands-free turn), `uplink` (the uplink queue filled: the socket took nothing for ~1 s; see `uplink_backlog_full`); `speech_ms`: speech onset to the end of the last speech frame, dips under 150 ms between syllables bridged (0 = no onset; push-to-talk turns report it too). A hands-free turn cut mid-sentence shows `end_reason=silence` with a short `speech_ms` (2026-09-24, #392: ~2.5 s under the old 700 ms rule); `frames` (uplink frames of the turn: sent plus still queued); `backlog` (frames still queued when the mic closed: `turn_end` goes out after the last of them, see `turn_end_sent`); `tx_busy` (audio writes held back this turn because the TCP send buffer had no room: the socket was not writable, so the frame stayed queued instead of the loop blocking in the write) and `tx_busy_max_ms` (the longest time the socket took nothing: ~1,000-1,330 ms is a lost segment waiting for lwIP's retransmission timeout, measured in HIL run 20260924-195519-54b4 as matching gaps in the server's own frame arrivals); `fps`: 10 ms frames the mic delivered per second since it opened (97-103 when capture is gap-free, 82-88 before CP-WAKE-MIC); `tx_wait_max_ms` / `tx_send_max_ms`: this turn's slowest uplink send, waiting for the socket mutex / in the socket write itself. A write over ~50 ms means the TCP send buffer was full and the main loop stalled on it (a one-shot ~6 KB burst did that for up to 10 s, 2026-09-24) |
| `turn_timing` | The turn's timing record closed (#1004): after the reply drained, a stop, a server error, or a woken turn with no speech; the same values go to a negotiated server as `turn_timing` (not sent to an older server). Not written for a GO tap, a capture failure or a lost socket | `outcome`, `source`, `end_reason`, `muted` (1/0), then each milestone as device-clock ms from capture start or `=skipped` (unknown ones are left out): `capture_end_ms`, `first_up_ms`, `turn_end_ms`, `playback_start_ms`, `first_down_ms`, `decoder_ready_ms`, `speaker_submission_ms` (the speaker API took the first samples; not audible onset), `playback_end_ms`; `first_up_ms` is the socket taking the first batch (4 frames, so about 30 ms later than a single frame was); `up_frames`, `down_frames`; then, once the mic closed through `turn_ended` (left out for a woken turn with no speech): `speech_end_ms` (end of the VAD's last voiced frame, moved to capture start, so a follow-up turn's pre-roll is taken off; `=skipped` when no speech onset was heard), `uplink_backlog`, `mic_fps`, `tx_busy`, `tx_busy_max_ms` (as on `turn_ended`). On the wire these five are best effort: dropped when the message would reach 512 bytes |
| `playback_started` | Reply starts arriving | `format` (1 = PCM16, 2 = MP3) |
| `audio_down` | Downlink frame received (every 25 frames up to 100, then every 100th) | `frames` (received so far) |
| `downlink_stalled` | No downlink frame for 3 s while reply active | `frames`, `free` (heap), `largest` (heap block), `stack` (loop task high-water) |
| `playback_overflow` | The downlink ring filled and bytes were dropped (once per reply): the server sent faster than the speaker drains (PCM: the 48 KB ring, `format=pcm16`) | `dropped_bytes`, `format` (PCM only) |
| `playback_completed` | Reply played | PCM (#674, streamed through the 48 KB ring): `samples` (accepted by the speaker; 16000 per second), `down_frames`, `ring_avail`, `ring_peak`, `dropped_bytes` (ring overflow), `underruns` (ring and speaker ran dry mid-reply, then 0.5 s rebuffered: an audible gap), `playraw_drops`, `seq_gaps`, `format=pcm16`; MP3: `down_frames`, `ring_avail`, `ring_peak`, `overflow`, `seq_first`, `seq_last`, `seq_gaps`, `mp3_exit`, `decode_cpu_ms`, `out_*`, `ws_stack`, `decode_stack` plus the rx counters |
| `server_error` | Error DTO for the turn in flight (e.g. `INTERNAL` when STT, agent or TTS failed): the turn is dropped, "Something went wrong. Try again." toast, back to READY (keys, modes and Always awake work). Pairing codes are handled by the pairing flow; only connection, config and mic faults use `ERROR` | `code` |
| `mic_begin_failed` / `capture_failed` | Audio capture problems | — |
| `picker_opened` | `c` pressed in READY; conversation picker entered | — |
| `picker_cancelled` | `` ` `` pressed in SELECT; back to READY | — |
| `conversation_select_sent` | Enter pressed on a listed conversation; `select_conversation` sent | — |
| `conversations_received` | Server replied with the conversation list | `count` |
| `conversation_selected` | Server confirmed the selection; back to READY | — |
| `conversation_not_found` | Selected conversation no longer exists; selection unchanged | — |
| `picker_unavailable` | Server rejected the picker (e.g. old server `BAD_MESSAGE`); back to READY | — |
| `picker_timeout` | No `conversations` reply within 5 s; back to READY | — |
| `conversation_selected_ignored` | `conversation_selected` while not in the picker | — |
| `new_conversation_opened` | `n` pressed in READY; NEWCHAT confirmation shown | — |
| `new_conversation_sent` | Enter pressed in NEWCHAT; `new_conversation` sent (repeat Enter while awaiting the ack is ignored) | — |
| `new_conversation_acked` | Server sent `conversation_cleared`; local active conversation cleared, back to READY ("New conversation") | — |
| `new_conversation_cancelled` | `` ` `` pressed in NEWCHAT; nothing sent, back to READY | — |
| `new_conversation_failed` | Error DTO while in NEWCHAT; old conversation kept, Enter retries with the same request id | — |
| `new_conversation_timeout` | No `conversation_cleared` within 5 s; same as `_failed` | — |
| `new_conversation_ack_ignored` | `conversation_cleared` outside NEWCHAT or with nothing pending | — |
| `space_picker_opened` | Space picker entered from READY; `list_spaces` sent (#301) | — |
| `spaces_received` | Server replied with the Space list (at most 10) | `count` |
| `space_select_sent` | A listed Space (or "no Space") confirmed; `select_space` sent | — |
| `space_selected` | Server acked with `space_selected`; local active Space updated, back to READY | — |
| `space_select_failed` | Error DTO (e.g. `SPACE_NOT_FOUND`, `INTERNAL`) or no ack while selecting; previous Space kept | — |
| `active_space_applied` | An `active_space` push (or the welcome's `active_space`) was applied to the header | — |
| `active_space_held` | An `active_space` push arrived during capture or playback; held and applied after playback ends | — |
| `board_detected` | Boot: the board id and speaker config M5Unified detected | `board`, `spk_mag`, `spk_rate`, `i2s_port`, `dma_len`, `dma_count` |
| `loop_slow` | Main loop iteration over 100 ms | `ms`, `free` (heap) |
| `auto_turn_started` | `BOB_AUTO_TURN` build began an automated turn | — |
| `server_status` | Server `status` control received | `stage` |
| `playback_start_duplicated` | A second `playback_start` while one is active | — |
| `playback_end_received` | `playback_end` control received | — |
| `playback_buffer` | PCM ring allocated for this reply (48 KB ring plus 12 KB of speaker chunks, freed at `playback_completed`) | `capacity_bytes` |
| `playback_buffer_failed` | PCM ring allocation failed: the reply is not played, its frames are ignored and `playback_end` still returns to READY | `free`, `largest` (heap block), `format=pcm16` |
| `playback_ending` | MP3 teardown begins | `frames` |
| `mp3_ring_ready` | First MP3 chunk arrived; the decoder starts | `avail`, `eof`, `free` |
| `mp3_oom` | Decode heap critically low; playback bails cleanly | `free` |
| `mp3_began` | MP3 decoder began | `ok` |
| `mp3_begin_failed` | MP3 decoder failed to begin | — |
| `mp3_generator_stopped` | Decoder stopped mid-stream | — |
| `mp3_loop_ended` | Decode loop ended (EOF or early) | — |
| `mp3_drain_timeout` | Decoder wedged past the drain budget | `ring_avail` |
| `mp3_task_abandoned` | Decoder task never exited; its objects are leaked | `ring_avail` |
| `tone_play` | `BOB_TONE_TEST` speaker-clock probe | `ms`, `expect` or `alloc_failed` |
| `audio_down_bad` | A binary frame failed the OLX2 header parse | `bytes` |
| `audio_down_seq_gap` | Frame sequence not +1 from the previous one (once per reply) | `seq`, `expected` |
| `audio_down_ignored` | Downlink frames while nothing is playing (a stopped turn's stream still arriving, even during the next turn's capture): dropped before any sequence bookkeeping, one line per reply | `bytes` (of the first one) |
| `pairing_required` | Server asked the device to pair | `reason` |
| `pairing_started` | Entered PAIRING; a `pair_request` was sent | — |
| `pair_request_sent` | `pair_request` control sent | — |
| `pair_code_received` | `pair_code` received; pairing pending | — |
| `device_token_saved` | `paired` token stored in NVS | — |
| `device_token_save_failed` | Token could not be saved | — |
| `device_token_erased` | The active server profile's NVS token erased (reason `unknown`/`revoked`, or `unpair` from Settings -> Reset, #680); other profiles' tokens are kept (#675) | `reason`, `profile` (`prod`/`dev`/`custom`) |
| `pair_expired` | Server pushed `pair_expired` | — |
| `pair_denied` | The user denied the pairing on the web | — |
| `pair_request_after_deny` | A key press retried after a denial | — |
| `pairing_rate_limited` | Server answered `PAIRING_RATE_LIMITED`; backoff started | — |
| `pair_code_expired_local` | Local code deadline passed; a fresh code is requested | — |
| `unpaired_error` | A restricted message while unpaired; back to pairing | — |
| `active_conversation_applied` | Follow-me `active_conversation` push applied | — |
| `active_conversation_held` | Follow-me push held until playback ends | — |
| `ws_mode` | Socket set up: transport, server profile and auth kind | `tls` (1/0), `profile` (`prod`/`dev`/`custom`; never the host), `auth` (0 none, 1 legacy secret, 2 NVS token of the active profile) |
| `rx_text_dropped` | A server control (text) message never reached the main loop. A full event queue makes the network task wait up to 500 ms for room first (the main loop drains the whole queue every iteration), so this means the loop was stalled that long, the heap was exhausted, or the message was oversize. Every drop is counted (`T state` `rxt_drop`); each is journaled unless the 8-deep report queue overflows, and then the lost reports are counted and journaled as `rx_drop_reports_lost=<n>` | `reason` (`queue_full`, `alloc`, `too_long`), `type` (the wire type only, `unknown` if unreadable); or `rx_drop_reports_lost` (reports that did not fit) |
| `tx_audio_dropped` | Once per turn, when its capture ends: uplink frames given up on (only the tail after `uplink_drain_timeout`; a busy socket no longer drops frames, they wait in the uplink queue) | `count` |
| `tx_write_slow` | An audio write took over 100 ms although the socket was writable (the write itself blocked inside lwIP or the WiFi driver); at most one line per loop | `ms`, `bytes`, `queued` (frames still waiting), `rssi` |
| `uplink_backlog_full` | The uplink queue (160 frames, ~1.6 s) filled while capturing: the socket took nothing for that long. The turn ends cleanly at once (`turn_ended … end_reason=uplink`) with every frame queued so far, so the server never sees a gap | `queued`, `sent` |
| `uplink_drain_timeout` | The mic closed but the queue would not drain for 3 s (`kUplinkDrainTimeoutMs`): the rest (the tail only) is discarded and `turn_end` names the last frame sent | `dropped`, `sent` |
| `turn_end_sent` | The turn's `turn_end` was queued for the socket, after its last audio frame (at once when nothing was waiting) | `frames` (frames the server got), `msgs` (the `audio_up` messages they went in) |
| `log_dropped` | Journal lines were dropped instead of blocking: the USB serial TX ring (4 KB) was full because the host was not reading (or read too slowly). Printed before the next line that fits | `lines`, `bytes` (since the last report) |
| `control_dropped` | An outbound control message never reached the socket. Controls are queued and sent by the network task (8 messages / 2 KiB FIFO, plus one latest-wins `device_state` slot sent only when the FIFO is empty, so a `cancel` never waits behind one) | `reason` (`queue_full`, `too_long`, `disconnected` = still queued when the socket closed, `send_failed`), `type` (the wire type only, e.g. `cancel`, `device_state`, `announce_ack`) |
| `playback_start_ignored` | `playback_start` while not awaiting, or for another (stopped) turn | — |
| `playback_aborted` | MP3 playback torn down early (a stop, a disconnect) | `frames` |
| `server_error_ignored` | Error DTO outside a turn; the screen is left alone | `code` |
| `settings_loaded` | Boot: saved settings read from NVS (#314/#330) | `volume`, `muted`, `mode`, `dnd` |
| `volume_changed` | `-` or `=` in READY/WAIT; also unmutes (#314) | `level`, `source=key` |
| `mute_changed` | `m` in READY/WAIT toggled mute (#314) | `muted` (1/0), `source=key` |
| `mode_changed` | `k` in READY, or a server `device_control`, set the listening mode (#330) | `mode` (`ptt`/`wake`/`announce_only`), `wake_fallback` (1 = Always awake failed, GO only), `source` (`key`/`server`) |
| `dnd_changed` | A server `device_control` changed Do not disturb | `dnd` (1/0), `source=server` |
| `device_control_applied` | Server `device_control` handled (volume/mute and the ring settings at once; mode/DND may be held) | `volume`, `muted`, `mode`, `dnd`, `ring_s`, `sound` (`-` = not in the message) |
| `device_control_held` | Mode/DND arrived mid-turn or mid-announcement; applied at READY | — |
| `device_control_bad` | `device_control` failed to parse | — |
| `device_state_sent` | `device_state` report sent (debounced, or in answer to `device_control`). It reports what applies: while Always awake has fallen back, `mode=ptt` although the stored setting stays `wake` | `volume`, `muted` (1/0), `mode` (as reported), `wake_fallback` (1/0), `dnd` (1/0), `ring_s` (ring length in seconds), `sound` (`classic`/`chime`/`pulse`), `battery` (percent, -1 unknown), `charging` (1/0, -1 unknown) |
| `settings_saved` | Changed settings written to NVS: 2 s after the last change, at most once every 2 s, never during a turn or playback | `fields` (`volume`, `muted`, `mode`, `dnd`, `wake_word`, `ring_seconds`, `ring_sound` joined with `+`), `volume` (the level) |
| `battery` | Battery level or charging moved enough to report | `pct` (-1 unknown), `charging` |
| `turn_blocked` | GO in `announce_only` mode, or no heap for the turn's uplink queue (54 KB); no turn | `mode=announce_only`, or `reason=heap` with `free`, `largest` |
| `turn_cancelled` | `x` or GO stopped a reply in WAIT; `cancel` sent, speaker silenced, back to READY (#315). Waveshare: a tap that means GO (`touch`) or a wake word over the reply (`wake`, #1364) stops it the same way | `source` (`key`/`btn`/`touch`/`wake`), `down_frames` |
| `barge_in` | Waveshare: the wake word was heard over the reply (`stage=reply`) or an announcement (`stage=announce`). It stops the reply or dismisses the announcement, then opens a hands-free turn (#1364) | `stage`, `ms_into` (ms since playback began, or since the announcement's playback began; absent when no playback stamp was set), `max_p` (the wake model's peak score, 2 decimals) |
| `barge_ignored` | Waveshare: a wake word arrived in a state where barge-in does nothing (not WAIT or an announcement) | `state` |
| `barge_listening` | Waveshare: the wake model started listening during playback, so a barge-in can be heard (#1364) | `stage`, `word` (the wake word), `arena_in` (the model's tensor arena, bytes) |
| `barge_stats` | Waveshare: every 5 s while the wake model listens during playback. Aggregates only, never audio | `erle_db` (echo cancellation, dB), `mic_db`, `ref_db` (mic and playback reference levels, dB), `max_p` (peak wake score in the window), `frames`, `underruns`, `suppressed`, `near_end` |
| `barge_unavailable` | Waveshare: barge-in could not listen during playback (the wake model or the duplex path is unavailable) | — |
| `duplex_begin` | Waveshare: the echo-cancelled duplex path opened for a reply | — |
| `duplex_loop` | Waveshare: the duplex loop's periodic timing summary | — |
| `duplex_fallback` | Waveshare: the duplex path gave up and playback went on without echo cancellation | — |
| `duplex_end_timeout` | Waveshare: the duplex path did not end within its deadline | — |
| `duplex_pcm_stall` | Waveshare: the playback PCM feed stalled during a duplex reply | — |
| `duplex_pcm_first` | Waveshare: the first PCM frame reached the duplex path | — |
| `duplex_stats` | Waveshare: once per reply, when it ends. Aggregates only, never audio | `erle_db`, `mic_db`, `ref_db`, `frames`, `underruns`, `overflows`, `frozen` (frame count the echo canceller was frozen for the reply), `cpu_avg_us`, `cpu_max_us`, `xfer_max_us`, `aec_resets`, `dt` (the double-talk threshold ratio), `delay` (the bulk delay, samples), `res_gain_db`, `stack_free` |
| `aec_cal` | Waveshare: the echo canceller's delay calibration finished (`duplex::calibrate()`, also `T aec cal` on the hil console). Aggregates only, never audio | `delay` (the delay found, samples), `peak` (the correlation peak), `ms` (how long the calibration took) |
| `turn_heap` | Once per turn at its end or stop | `free`, `min`, `largest` (bytes) |
| `reply_text_received` | The reply_text for the turn in flight arrived and will be the card (#318); the text is never logged | `heard_len`, `reply_len`, `kept=1` |
| `reply_text_ignored` | A reply_text that must not become the card, so the current card is left alone | `reason` (`cancelled_turn` = for a stopped turn, `other_turn` = for an earlier turn, `not_in_turn` = outside a turn) |
| `reply_text_bad` | reply_text failed to parse | — |
| `reply_card_shown` | The reply card was drawn on READY: when playback ended, or, in Always awake, when the follow-up window closed without a turn (while the window is open the card is not on screen) | `lines` |
| `reply_card_closed` | A key (or `` ` ``) closed the reply card | — |
| `help_opened` | `h` or `?` in READY; HELP shown (#311) | — |
| `help_closed` | `` ` `` or GO in HELP; back to READY | — |
| `announce_shown` | An announcement card is up (#319); a ring starts, or a chime | `announce_id`, `kind` (`timer`/`alarm`/`reminder`/`notice`), `ring` (1/0) |
| `announce_held` | Announcement arrived while busy; queued | `announce_id`, `depth` |
| `announce_queue_full` | Queue full; not acked, so the server replays it | `announce_id` |
| `announce_duplicate` / `announce_bad` | Already seen / failed to parse | `announce_id` (duplicate only) |
| `announce_playback_started` / `announce_playback_ignored` | The spoken part of an announcement started / arrived unexpected | `announce_id` (started only) |
| `announce_acked` | `announce_ack` sent | `announce_id`, `action` (`played`/`dismissed`/`missed`) |
| `announce_closed` | Card closed, back to READY | `source` (`key`/`btn`/`played`) |
| `ring_started` | A timer or alarm started ringing (#389), right after `announce_shown` | `kind` (`timer`/`alarm`), `ring_s` (how long it will ring), `sound` (`classic`/`chime`/`pulse`) |
| `timers_state` / `timers_state_bad` | The running timers arrived (#457; after `welcome` when any are running, then on every change) and replaced the last list (`welcome` itself clears it); READY counts the soonest down locally, no per-second traffic / failed to parse or over the bounds (over 4 timers, a label over 24 chars): the last list is kept | `count` (0..4; 0 clears the countdown) (`timers_state` only). Never a label |
| `ring_stopped` | The ring ended: a key or GO (`dismissed`), or it ran its full `ring_s` (`missed`: the card says "Missed timer" and the ack is `missed`). Muted, the ring is silent but still times out | `reason` (`dismissed`/`missed`), `ring_ms` (how long it rang) |
| `wake_listening` | Always awake (#313): model and mic running in READY | `word` (`alexa`/`bob`, the model loaded; `jarvis` in an `BOB_WAKE_MODEL_JARVIS` build), `held` (arena + frontend bytes), `arena_used` (what the model planned of the 28 KB arena: the measured need), `free`, `largest` |
| `wake_word_changed` | `w` in READY switched the wake word (CP-WAKE-BOB). Device-local: saved to NVS, never in `device_state`. A running model stops (`wake_stopped`) and the other one starts on the next loop (`wake_listening`) | `word` (`alexa`/`bob`), `source` (`key`, or `test` for the HIL console's `T wake word`) |
| `wake_unavailable` | Always awake could not start; GO-only with a notice until the mode is entered again | `reason` (`begin`/`mic`/`record`); for `begin` also `error` (`model_rejected`/`arena_alloc_failed`/`model_init_failed`); `free`, `largest` |
| `wake_stats` | Every 5 s while wake listening | `frames` (10 ms frames the model got in the window), `fps` (their rate: 97-103 when capture is gap-free; the 82-88 of the pre-CP-WAKE-MIC 12 ms timer means lost audio), `max_p` (largest model output in the window, 0-255; detection needs the 5-output window sum over 5 x the model cutoff: 229 for alexa, 251 for bob), `peak_db` (loudest frame, dB re one LSB: ~45 is a quiet room, speech at arm's length should reach 60+; int16 full scale is ~90), `floor_db` (the adaptive noise floor). No audio content |
| `wake_stopped` | Wake listening stopped (a turn, a mode change, an announcement) | `max_invoke_us`, `free`, `largest` |
| `wake_detected` | The wake word was heard; a turn opens | `max_invoke_us` |
| `wake_rejected` | Woken, then no speech onset within 8 s (`kVadNoSpeechMs`; speech is a frame over 38 dB and 12 dB over the noise floor, 50 ms of it); the turn is cancelled | `frames` |
| `followup_opened` | A reply finished playing in Always awake (not fallen back, DND off): 250 ms after the speaker drained (`playback_completed`; the device stays in WAIT meanwhile) the listen earcon plays and the mic opens for the follow-up window, without the wake word model (its arena stays free). Screen "Listening... (say more, or wait)"; 200 ms of speech (`kFollowUpOnsetMs`, 20 frames; a wake turn needs 50 ms) then opens a turn with no wake word, so a reply echo, cough or key click does not. Speech starts 12 dB over the noise floor and continues while frames stay 8 dB over it | `window_ms` (6000, `kFollowUpWindowMs`), `guard_ms` (250, `kFollowUpGuardMs`), `since_drain_ms` (measured: the speaker drained to the mic opening, the guard plus the earcon, so ~400), `pre_roll` (1 = the ~10.5 KB pre-roll buffer was allocated, 0 = the turn starts at the onset), `free`, `largest` |
| `followup_closed` | The follow-up window ended. Anything but `speech` closes the mic; wake listening (`wake_listening`) resumes with the active wake word (`w` picks it) and the reply card, if any, is back with the strip "Say <phrase> to talk" (the active word's phrase, e.g. "Say Alexa to talk"; `w` in the open window only closes it) (the open window's strip is "Listening... just talk") | `reason`: `speech` (a turn opens: `turn_started … mode=followup`), `timeout` (6 s with no speech; the listen-stop earcon), `key` (any key, which does nothing else, or GO, which then starts its hold-to-talk), `stop` (`x`), `announce` (an announcement or ring took over), `mode` (the mode or DND changed), `disconnect`, `mic` (the mic failed while the window was open). A timeout waits up to 300 ms past the 6 s while a speech run is under way (`kFollowUpOnsetGraceMs`) |
| `followup_failed` | A window was due but could not open (no `followup_opened`, no `followup_closed`); wake listening resumes | `reason`: `heap` (no heap for the uplink queue, checked before the earcon; with `free`, `largest`) or `mic` (the mic did not start; it can only be tried after the earcon, they share GPIO 43) |
| `followup_skipped` | Always awake, but no window after this reply: the chain allows no more (`limit`: `kMaxFollowUpsPerWake` = 2 follow-ups per wake or GO turn; `ended`: a follow-up heard as nothing, `reply_text` `heard_len=0`, or a failed turn), an announcement is queued (`announce`: it goes first, with no earcon or mic), or `x` / GO during the 250 ms guard (`key` / `btn`: the turn was already complete, so no `cancel` is sent; GO then starts a normal turn) | `reason` (`limit`, `ended`, `announce`, `key`, `btn`) |

### HIL test console lines (`m5stack-cardputer-hil` only)

The hil build (`docs/cardputer/hil.md`) also answers `T …` commands on the
same serial port with one line each, starting `T> `: `pong fw=<version>
build=<short sha|dev> id=<12 hex>` (a hash of the MAC, never the MAC), `ok`, `state=<STATE> mode=<mode> vol=<0-10>
muted=<0|1> dnd=<0|1> rssi=<dBm> rxq_max=<n> rxt=<n> rxt_drop=<n> att_drop=<n> ws_loop_max=<ms> log_drop=<n> loop_max=<ms> tx_drop=<n>`
(since boot: receive-queue high-water mark, text messages received and
dropped, connect attempts whose end event was lost, slowest network-task
pass, journal lines dropped, slowest main-loop iteration, uplink frames
given up on; `ws_loop_max` is the slowest `client_.loop()` pass on
`ws_net`, where a TLS handshake shows as one long pass (#710), so it tells a
starved main loop from a slow one; `T state reset` sets `loop_max`,
`ws_loop_max` and `tx_drop` back to 0),
`free=<b> min=<b> largest=<b>`, or `err <reason>`
(`unknown`, `too_long`, `tone_ms`, `word` for a `T wake word` name that
is not `alexa`/`bob`, `not_listening` for `T wake fire`
outside Always awake listening; otherwise that command acts as one wake
word detection). `T token backup|forget|restore` (#611) answer `ok
saved|kept|none`, `ok`, `ok restored`, or `err nvs|no_backup|action`; no
reply or line ever carries the token. `T hello pcm|mp3` answers `ok` or
`err format`. `T rig server-restart` is answered by
the rig (`ok rig` or `err server_not_healthy|server_restart`), never the
device. The product build has no console and
prints none of these. The runner writes `T server …` commands to
`serial.log` too, but they go to the server harness, which journals
`v2.hil_command` (`command`, `outcome`; for `thread` (#565) the outcome is
`pointed`/`failed_http_<status>` after `thread seed`,
`archived`/`failed_not_seeded` after `thread archive`, or `failed` plus
`error_name` when the store threw; for `pair` (#611) `manual`/`auto`, or
`approved`/`failed_no_pending`/`failed_http_<status>` after `pair approve`;
for `device` `renamed`/`revoked`, `failed_not_paired` before a
`pair approve`, or `failed_http_<status>`), and for `slow_turn`
`v2.hil_slow_turn_holding` / `v2.hil_slow_turn_released` (`ms`). The
harness also journals `v2.hil_fail_turn_injected` (`code`) when
`fail_next_turn` fails a turn, and `v2.hil_token_adopted` (`outcome`:
`adopted`/`not_claimed`/`failed`, plus `error_name` when it failed) when it
registers a token the device already holds, and `v2.hil_pairing_held` (no
fields) when `pairing hold` (#681, outcome `armed`) strips the Authorization
header from the device's next connection. After `burst_next_reply` it
journals `v2.hil_reply_burst` (`writes`: how many socket writes, from
`playback_start` through `playback_end`, it held and then sent back to back).
No audio and no text.

`mp3_began ok=0` then `mp3_begin_failed` with no `playback_aborted` before
it drops the reply (`playback_completed mp3_exit=n/a,decode_cpu_ms=0`). It
used to follow `playback_ending` whenever the whole reply was buffered
before the decode task started, because playback_end closed the MP3 source
and the decoder refuses a closed source (MP3-BEGIN-RACE, fixed: playback_end
now only marks end-of-data). After `playback_aborted` it is the expected
clean end of a stopped reply.

---

## Reading a healthy turn (side by side)

| Device serial | Server journal | Meaning |
| --- | --- | --- |
| `turn_started state=LISTEN … held_frames=13` | `v2.turn_started` | PTT held 300 ms: the turn opens with the frames captured so far |
| `audio_up seq=0..466` (467 lines) | `v2.audio_up` ×467 | 467 uplink frames ≈ 4.7 s of audio |
| `turn_ended state=WAIT frames=467` | `v2.turn_ended` | PTT released, turn sent |
| — | `v2.turn_stage_stt_completed` → `v2.turn_stage_agent_completed` → `v2.turn_stage_tts_completed` | Transcript → reply → speech |
| `playback_started state=WAIT speaker=1` | `v2.downlink_started` | Reply streaming begins |
| `audio_down frames=1..205` | `v2.turn_completed down_frames=205` | Reply frames arrive (~10 ms apart) |
| `playback_completed samples=... started=1` | — | Speaker playback finished |

## Reading a turn's timeline (`npm run turn:timeline`)

`npm run turn:timeline -- <conversation_id>` (or `latest`, the conversation of
the newest device STT stage in the log) reads that conversation's journal
events and writes one timing waterfall per voice turn to
`data/turn-timeline/<conversation_id>.html` (`scripts/turn-timeline.mjs`).

- **Source.** The local journal (`apps/api/data/v2-journal.log`, then
  `data/v2-journal.log`) by default.
- **`--file <log>`** reads a saved log instead: journal lines, or a `.json`
  array of flat search hits exported from a log store. With `--file` and no
  conversation id, every turn in the file is rendered. `--out <dir>` picks
  another folder.

Each turn shows recording, the end-of-turn send, speech-to-text, preparation
(with `retrieval_ms`), the model (`model_ms`, `steps`, `called_tools`), speech
generation (`tts_ms_per_sentence` when streamed) and Bob speaking. Device
offsets from `v2.device_turn_timing` are placed on the server clock by putting
the device's `turn_end_ms` at the server's STT start (its completion `ts` minus
`duration_ms`); a turn with an unmeasured (`skipped`) offset is left out. The
red dashed lines mark "you stop" and "Bob speaks"; a pill flags a wait between
them over 5 s and a recording that ended by `end_reason=max`. The header gives
the turn count, the median wait and how many waits passed 5 s. The page holds
numbers, enums and model ids only.

## Correlating streams

- Match `session=<id>` on device lines (after `welcome_accepted`) with the
  `session` field in server journal lines.
- Server `ts` is UTC; device times are boot-relative milliseconds — align via
  the welcome handshake instant.
- A healthy turn ends with `v2.turn_completed` on the server and
  `playback_completed ... started=1` on the device.

## Common symptoms

| Symptom | Likely cause |
| --- | --- |
| `socket_closed` right after `playback_started` + 1 `audio_down` | Old server build bursting downlink frames (fixed: 10 ms pacing) — update the server |
| Repeated `socket_closed` → `socket_connected` → `welcome_accepted` | Server down or restarting; device auto-reconnects |
| `socket_closed` → `socket_retry` | Server unreachable (wrong `BOB_V2_HOST`, firewall, server not running); the device reconnects on the backoff |
| `playback_overflow` | The 48 KB MP3 ring filled and frames were dropped. Not simply "a long reply": the server sends 1024 B every 20 ms (50 KB/s) regardless of bitrate, while a 64 kbps clip drains at ~7.9 KB/s, so the ring saturates after ~57 frames of *any* reply. Compare `turn.downlink_frames.fill_bytes_per_sec` against the clip's bitrate |
| `playback_completed ... started=0` | `playRaw` failed (buffer/volume issue) — device needs a reboot |
| `v2.turn_failed` with `kind=upstream_error` / `upstream_status` | Gateway / STT / TTS provider error — check the `error_name` field |
| `v2.turn_stage_stt_failed` with `upstream_status` 400 | The STT model rejected the request outright. Since CP-SRV-SHORT the device hears "I did not hear anything" and `v2.turn_stt_rejected` follows instead of `v2.turn_failed`. The journal cannot say why (the provider's message is response payload); re-run under `npm run dev:debug` and read `ai.stt_failed`. A 400 seconds after the request usually means the audio container — the configured `fish-audio/transcribe-1` decodes wav, mp3, m4a and ogg but not webm |
| `v2.turn_stage_tts_failed` | Same shape for the TTS leg — `ai.tts_failed` in the debug log carries the provider's reason |
| `v2.error code=SEQUENCE_GAP` | Frame or control ordering violated (firmware/server version mismatch) |
| Device `server_error state=READY code=INTERNAL` | The server failed that turn (see `v2.turn_failed`); the device is already READY again |
| Device `turn_tap_ignored` | GO was tapped, not held; no turn reached the server |
| New session id appears every time without a reset | Downlink stall → heartbeat death (~16 s) → device logs `socket_closed state=ERROR` and reconnects; check the last `audio_down` frame count and `downlink_stalled` (frames/heap/stack) in `data/device.log` |

## Debug mode (`npm run dev:debug`)

The journal above is deliberately redacted: it never carries audio,
transcripts, agent text, credentials, URLs, prompts, conversation titles, or
attachment filenames and bytes — an attachment shows up only as a count and a
byte total on `v2.turn_stage_agent_started`. That guarantee is what
makes it safe to keep and share — but it also means a whole class of faults
(wrong language, a reply that is too long for TTS, a prompt regression) leaves
no trace in it.

Debug mode is the opt-in second channel for those cases.

| | journal | debug log |
| --- | --- | --- |
| Path | `data/v2-journal.log` | `data/v2-debug.log` |
| Enabled | always | only when `BOB_DEBUG=1` |
| Carries transcripts / reply text / prompts | never | yes, by design |
| Credentials | never | never (redacted unconditionally) |

Run it with `npm run dev:debug` (add `-- --once` to skip watch/restart).
Override the path with `BOB_DEBUG_LOG`. Turning debug mode on does **not**
change journal output in any way — `apps/api/tests/platform/debug.test.ts` pins that.
Debug lines use the journal envelope (`ts`, `level`, `event`, `message`, `source=ai`,
`module=ai`, trace ids); a debug field that collides with a reserved key is written as
`debug_<name>`, and the console copy has no `[debug] ` prefix.

**The debug log contains real user speech and model output.** It lives under
`data/`, which `.gitignore` already excludes, and it must never be committed,
pasted into an issue, or shipped.

### Debug events

| Event | Answers |
| --- | --- |
| `server.config` | Effective config: models, voice, format, and whether an STT language was pinned |
| `ai.agent_configured` | The system prompt and tool registry actually in force |
| `ai.stt_request` | `language_sent` — false means the provider is auto-detecting the language |
| `ai.stt_response` | The transcript, so a misheard or wrong-language utterance is visible before the agent runs; `language_detected` and `language_mismatch` show what the provider decided against the pin |
| `ai.stt_failed` | Why the provider rejected the audio, in its own words, plus `upstream_status`. The journal has only the error class and the status digits, which distinguish a bad key from a rate limit but never name the fault |
| `turn.transcript` | Transcript plus uplink PCM bytes and decoded duration |
| `turn.agent_reply` | Reply text, token usage, tool calls with arguments and results, and the message history sent to the model |
| `ai.tts_request` | Reply text and voice/model/format; `text_chars` is the input that drives TTS latency |
| `ai.tts_response` | `audio_bytes`, `elapsed_ms`, plus the detected `media_type`, `format` and a `warnings` count |
| `ai.tts_failed` | The synthesis counterpart to `ai.stt_failed`: the provider's message and `upstream_status` |
| `turn.downlink_frames` | Frame count, chunk size, and `fill_bytes_per_sec` — compare against the clip's own bitrate to spot ring overflow |
| `turn.completed` | Whole-turn totals; `down_frames` short of `frame_count` means the stream was cut |
| `turn.failed` | The complete error, name, stack, and cause (the journal keeps only a 64-character slice) |

### Transport, session, and audio events

`BOB_DEBUG_FRAMES=1` additionally emits one line per audio frame
(`session.audio_up_frame`, `turn.audio_down_frame`). That is hundreds of lines
per turn, so it is off even in debug mode — turn on only when frame sequencing
itself is in question.

| Event | Answers |
| --- | --- |
| `server.connected` | Peer address, port, and headers — distinguishes two devices behind one NAT from one device reconnecting |
| `server.closed` | Close code with `abnormal` set for 1006, plus bytes still buffered and frames sent |
| `server.control_rejected` | The raw text of a message that failed schema validation |
| `server.socket_error` | Full error, name, and stack |
| `session.control_in` | Every inbound control DTO in full |
| `session.hello` | The device's complete hello payload |
| `session.turn_start` / `session.turn_end` | Turn boundaries with uplink frame count, bytes, and decoded duration |
| `session.error_sent` | Which error code went back, and the session state that produced it |
| `session.accumulate_full` | Uplink exceeded `ACCUMULATE_MAX_BYTES` |
| `audio.stt_input` | PCM/WAV sizes and rate; `language_pinned` is false while STT auto-detects |
| `audio.tts_pcm` | Provider rate vs target rate — a wrong source rate is heard as chipmunk or slow-motion speech |
| `audio.tts_mp3` | MP3 size, and how many downlink frames it will become |
| `audio.mp3_capped` | The reply exceeded `MAX_DOWNLINK_MP3_BYTES` and was truncated |
| `turn.backpressure_start` / `_end` | The device stopped draining its TCP window, and for how long. Brief stalls never reach the journal, which logs only aborts |
| `turn.downlink_socket_closed` | The socket died mid-stream. This is why `down_frames` can come up short with no `downlink_aborted` beside it |
