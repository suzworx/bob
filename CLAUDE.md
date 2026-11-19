# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**North star: Bob lightens up people's moods.** It is the single most important objective; see "North star" in `AGENTS.md`.

Bob is a modular personal AI assistant. A Cardputer ESP32 client streams push-to-talk audio to a voice server over a single WebSocket; the server runs STT → agent → TTS and streams a PCM or MP3 reply back for on-device playback.

The authoritative deep reference is `AGENTS.md` at the repo root (architecture, wire contract, style, parallel-work rules) and `README.md` (full command table). Read both before large changes. This file is the working quick-start.

## Repo shape

Single npm workspace monorepo (Node >= 22, strict TypeScript `NodeNext` with `noEmit`, run directly via `tsx`). Members under `apps/*`:

- **`apps/api`** (`@bob/api`) — WebSocket voice server. Entry `src/server.ts`, listens on port 7444 (`BOB_V2_PORT`) at `/v2/cardputer`. Session state machine in `src/voice/session.ts`, turn pipeline (STT → agent → TTS) in `src/voice/turn/` (one file per stage: `transcribe`, `context`, `tools`, `generate`, `playback`, `persist`, `failure`; `deps.ts` the injected `TurnDeps`, `src/workflows/workflow-voice-turn.ts` the turn entry point (the orchestrator), `src/app-deps.ts` the production `AppDeps` that the composition roots build once), shared device and chat turn code in `src/turn/` (prep, the one ability wiring `tool-wiring.ts`, `device-agent.ts` / `chat-agent.ts`, policy, game turns, chat store/stream/persist; every file opens with a Trigger/Steps/Outcome/Journal header; chat's entry point is `src/workflows/workflow-web-chat-turn.ts`), wire contract (Zod DTOs + OLX2 frame codec) in `src/voice/protocol.ts`, WAV helpers in `src/voice/audio/wav.ts`, STT/TTS adapters in `src/voice/audio/stt-tts.ts`. Vitest suite in `tests/`.
- **`apps/ai`** (`@bob/ai`) — pure-logic agent layer: `ToolLoopAgent` (Vercel AI SDK) + AI Gateway provider, `tool()` capabilities in `src/tools.ts`. No build step — it exports raw `.ts` sources.
- **`apps/ui-v2`** (`@bob/ui-v2`) — the web client, and the ONLY one (v1 `apps/ui` is deleted). React 19 + Vite on the **Astryx** design system, pinned at 0.6.2. **Astryx is the only source of UI and custom changes are not allowed**: scaffold from https://astryx.atmeta.com/templates, read https://astryx.atmeta.com/components, https://astryx.atmeta.com/docs/getting-started and https://astryx.atmeta.com/docs/cli, and follow Astryx's design and UX patterns — never hand-write markup, spacing or styling. Work through the CLI from `apps/ui-v2`: `npx astryx build "<idea>"` → `astryx template <name>` → `astryx component <Name>`, and `astryx docs layout` before any frame or padding decision. **`apps/ui-v2/CLAUDE.md` is the full rule and explains what ignoring it cost on 2026-09-22.**
- **`apps/cardputer`** (`@bob/cardputer`) — PlatformIO ESP32 firmware. Scripts-only workspace (no deps/build step); PlatformIO runs through npm scripts. Env `m5stack-cardputer-v2-poc`, base board `m5stack-stamps3`. Typed shared headers in `include/` (`config.h`, `types.h`, `protocol.h`, `network.h`, `state.h`, `audio_capture.h`, `audio_playback.h`), implementations in `src/`. The state machine is `src/state_core.cpp` plus one `src/state_*.cpp` per feature (turn, wake, volume, cards, pickers, pairing, connection) sharing `src/state_internal.h`; their decision logic lives in header-only policies in `include/` (e.g. `follow_up.h`, `volume_policy.h`, `card_policy.h`) with host tests in `test/host/`. Requires `include/secrets.h` (copy `secrets.example.h`). Firmware never imports secrets, DB modules, or provider SDKs.

## Key architecture facts

- **Cross-workspace import:** `apps/api` imports `apps/ai` only through the `@bob/ai` package (npm workspace symlink; entry `apps/ai/src/index.ts`). Test-only helpers (eval scorers, game engine internals, content packs) live behind `@bob/ai/testing`. Never import `apps/ai/src/*` by relative path — `vi.mock('@bob/ai', async (orig) => ({ ...(await orig()), createBobAgent: vi.fn() }))` is how tests replace the agent. Since `@bob/ai` is raw source, editing its files changes `apps/api` directly — no build step. `apps/cardputer` has zero workspace imports.
- **Wire protocol:** one WebSocket (`/v2/cardputer`) carries JSON control messages and binary `OLX2` audio frames. A frame is a 20-byte header (magic `OLX2`, version, kind `audio_up`/`audio_down`, format, channels, turn handle, sequence, payload bytes) + payload. Client lifecycle: `hello` → `turn_start` → `audio_up` frames → `turn_end` → server streams `playback_start` / `audio_down` / `playback_end`. The authoritative contract is `voice/protocol.ts`. See "Device Voice Contract" in AGENTS.md for exact format/bounds.
- **Sessions are in-memory** — the session state machine holds nothing across restarts, but conversations and turns persist to Supabase Postgres at `BOB_DATABASE_URL`, which is required: the local stack in Docker for dev, tests and HIL (`npm run dev:offline` sets it), hosted Supabase in production; there is no stand-in and the server refuses to boot without it (`apps/api/src/platform/db/db.ts`). Uplink bounded by `ACCUMULATE_MAX_BYTES` (1 MB); PCM replies capped at the 320 KB device playback buffer, MP3 at 3 MB.
- **Observability:** journal events (`v2.*`) go to the console and a cwd-relative `data/v2-journal.log` (`BOB_V2_JOURNAL`). npm workspace runs (`dev`/`start`) write `apps/api/data/`, a server started from the repo root writes `data/` — see `docs/log-reference.md`. Logs must never include audio, transcripts, agent text, credentials, URLs, or prompts. `data/` is git-ignored.
- **Offline dev:** `npm run dev:offline` runs the whole app with no internet except the AI — local Supabase in Docker (pending migrations applied on every start), a dev user, then `dev:all` with the real AI Gateway. It prints a sign-in code for `dev@bob.local` ("I already have a code"); `--code` prints a fresh one, `--stub-ai` stubs the AI (`BOB_AI_STUB=1`), `--stop` stops the stack.

## Commands

Setup: `npm install`, then `cp .env.example .env` (root `.env` is loaded by `apps/ai/src/config.ts` via dotenv).

| Purpose | Command |
| --- | --- |
| Run dev server | `npm run dev` (tsx watch; one-shot `npm run start`, inspector `npm run debug`) |
| Run offline (no internet, no AI) | `npm run dev:offline` (local Supabase in Docker + dev servers; `--stub-ai` stubs the AI, `--stop` stops the stack, `--status` shows it) |
| Health check | `http://localhost:7444/health` |
| **Root `npm test` is typecheck only** | the real Vitest suite is `npm run test:unit` (`npm test --workspace @bob/api`) |
| Watch tests | `npm run test:watch` |
| Live AI checks | `npm run test:live` (needs `AI_GATEWAY_API_KEY`) |
| Typecheck | `npm run typecheck` (or `:ai` / `:api`) |
| Fast pre-commit gate | `npm run check` (typecheck + unit tests) |
| **Full validation gate** | `npm run validate` (git whitespace + staged-ignored scan + secret-pattern scan + typecheck + unit tests + firmware compile; `-- --skip-firmware` skips the PIO build) |
| Build (typecheck + firmware) | `npm run build` |

Cardputer (needs `include/secrets.h`; port from `BOB_COM_PORT`, default COM3): `npm run device:compile` / `flash` / `monitor` / `run`. `device:monitor` tees serial to `data/device.log`; `api:monitor` tails the journal to `data/api.log`; `npm run monitor` multiplexes both. Raw pio: `py -3.11 -m platformio run -e m5stack-cardputer-v2-poc --target upload --upload-port COM3` from `apps/cardputer`.

Stub mode: `BOB_SYSTEM_TEST=1` bypasses the AI Gateway (agent replies `System test response: <input>`, STT stubbed).

## Style & process (from AGENTS.md)

- TypeScript: 2-space indent, semicolons, explicit return types, kebab-case filenames, Zod schemas for every wire boundary, `.ts` extensions in relative imports.
- Atomic commits with `feat:` / `fix:` / `docs:` / `test:` / `chore:` prefixes; never commit `.env`, keys, prompts, audio, or PII. Push completed work as small git commits to a branch and merge through a pull request, because `main` is protected. PRs target `main` (branch off `origin/main`).
- **Follow the unit SOP** in `.claude/skills/bob-dev/references/sop.md` for every unit of work (plan, implement, review, PR, merge).
- **Never deliver a change that has not passed `npm run validate`** (the persistent validation gate).
- **Load skills before working** — see "Skills for Speed & Accuracy" in AGENTS.md. Especially `esp32-firmware-engineer` for ALL Cardputer work and `websocket-development` for wire-protocol changes. Skills are always installed globally (`-g`) and searched for with `find-skills` at every stage; AGENTS.md has the rule.
- Secrets and self-hosting: `docs/secrets.md` and `docs/deploy.md`.
- `docs/log-reference.md` is the field-by-field guide to the server journal and device serial logs.
