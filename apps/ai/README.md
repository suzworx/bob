# AI

The AI workspace is the agent layer: it owns the tool loop (`ToolLoopAgent` on the Vercel AI SDK),
the AI Gateway provider, the tool set, and the STT/TTS adapters. It is a library, not a server —
`@bob/api` imports it as raw `.ts` source, so there is no build step and it must never be run on
its own.

## Run it

From the repo root, `npm run dev:api` starts the API that imports this workspace. The workspace's
own scripts (`npm run <script> --workspace @bob/ai`):

| Command | What it does |
| --- | --- |
| `npm run typecheck` / `build` / `check` / `test` | `tsc -p tsconfig.json --pretty false` (all four are the typecheck) |
| `npm run test:live` | `tsx src/test.ts` — provider-backed smoke test, needs `AI_GATEWAY_API_KEY` |

Root alias: `npm run typecheck:ai` and `npm run test:live` (the live suite).

## Configuration

Loaded from the repo-root `.env` by `src/firmware/github-config.ts` (dotenv). Never put these in browser or device
files; never print a real secret value (use a placeholder).

| Variable | Default | When unset |
| --- | --- | --- |
| `AI_GATEWAY_API_KEY` | unset | No provider — `test:live` and provider-backed evals refuse |
| `BOB_GATEWAY_BASE_URL` | unset | Provider default endpoint |
| `BOB_CHAT_MODEL` | `openai/gpt-4o` | The agent's chat model |
| `BOB_STT_MODEL` | `fish-audio/transcribe-1` | STT model (decodes wav, mp3, m4a, ogg — not webm) |
| `BOB_STT_LANGUAGE` | `en` | STT language pin; also sent as a prompt backstop |
| `BOB_TTS_MODEL` / `BOB_TTS_VOICE` | `microsoft/mai-voice-2.1-flash` / `en-US-Harper` | TTS model and voice |
| `BOB_TTS_VOICE_BOB` | `en-US-Sage` | TTS voice for a device whose assistant name is Bob (`ttsVoiceFor`); Bob or no name uses `BOB_TTS_VOICE`. A value outside the MAI en-US voice ids is refused at boot (`v2.tts_voice_bob_error`) |
| `BOB_MAX_TTS_CHARS` | `700` | Hard cap on TTS input, at a sentence boundary |
| `BOB_TTS_TIMEOUT_MS` / `BOB_STT_TIMEOUT_MS` | `8000` / `8000` | Provider call timeouts; the STT one covers the backup request too |
| `BOB_STT_HEDGE_MS` | `2500` | When the STT model has not answered by then (or failed sooner), the same audio goes to `BOB_STT_BACKUP_MODEL`; first success wins, the other is aborted. `0` = off (#1331) |
| `BOB_STT_BACKUP_MODEL` | `openai/gpt-4o-mini-transcribe` | The hedged STT backup; equal to `BOB_STT_MODEL` means no backup |
| `BOB_SYSTEM_TEST` | unset | `1` stubs the agent and STT for a keyless turn |
| `BOB_AI_STUB` | unset | `1` stubs the AI without the test sign-in |
| `BOB_SYSTEM_TEST_REAL_TTS` | unset | `1` keeps TTS real inside system-test mode |
| `BOB_SYSTEM_TEST_TTS_SECONDS` / `BOB_SYSTEM_TEST_TRANSCRIPT` | `1` / `system test transcript` | Stub TTS length and stub transcript |
| `BOB_PRODUCTION` | unset | `1` refuses telemetry payload export |
| `BOB_TRACE_PAYLOAD` | unset | `1` includes prompt and reply text in exported spans; development only, production refuses to boot with it (#1039) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` (or `_TRACES_ENDPOINT` / `_METRICS_ENDPOINT`) | unset | Standard OTLP destination; traces and metrics are off without one |
| `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_SERVICE_NAME` / `OTEL_SERVICE_VERSION` | unset / `bob` / unset | Backend credentials and service identity |
| `BOB_OTLP_EXTRA_TRACES_ENDPOINT` / `BOB_OTLP_EXTRA_TRACES_HEADERS` | unset | Optional second OTLP traces destination: a full http(s) traces URL, and `k=v,k2=v2` headers (values URL-decoded). It receives the same scrubbed spans as the primary; neither value is ever logged |
| `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER` | unset | `none` switches that signal off |

Debug-only flags: `BOB_DEBUG`, `BOB_DEBUG_PAYLOAD`, `BOB_DEBUG_FRAMES`, and
`BOB_MEMORY_EXTRACT_MODEL` / `BOB_EVAL_JUDGE_MODEL` for model overrides.

## How it fits

`@bob/api` imports this workspace through the `@bob/ai` package (its `exports` point at raw
`src/index.ts`) and the `@/ai/*` path alias. Core modules: `agents.ts` (the agent factory),
`config.ts` (provider and model selection), `tools.ts` plus `memory-tools.ts` and
`productivity-tools.ts` (the `tool()` capabilities), `memory-extractor.ts` / `embeddings.ts`
(memory), and `telemetry.ts` (OpenTelemetry traces and metrics over standard OTLP; the backend
is chosen only by the `OTEL_*` variables). It calls out to the AI Gateway for inference and to
the configured OTLP endpoint for telemetry. `docs/` holds the target architecture; no diagram directory exists yet.

## Tests

`npm run test --workspace @bob/ai` is the typecheck only — this workspace ships no unit suite.
Its real coverage runs under `@bob/api`'s Vitest, since the API imports these modules directly.
`npm run test:live` is the live provider check and needs `AI_GATEWAY_API_KEY`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `test:live` refuses to run | No `AI_GATEWAY_API_KEY` in the root `.env` | Add the key, then rerun |
| Phantom type errors in `apps/ai` | A git worktree resolves `@bob/ai` to the parent checkout's `apps/ai` | `npm install` inside the worktree |
| STT 400 "audio could not be decoded" for a browser capture | The client uploaded a WebM blob; the model does not decode webm | Re-encode to 16 kHz mono WAV before upload |