# Repository Guidelines

## North star

**Bob lightens up people's moods.** This is the single most important objective. Every feature, animation and reply is judged first by whether it makes people smile: Bob is extremely adorable, the design is minimal but full of fun, and errors are shown kindly. When two good options conflict, pick the one that leaves the person feeling better.

## Architecture

`docs/architecture.md` is the target architecture and the layer boundaries in force: three
interfaces (Chat, Converse, Cardputer) over one Bob Core, the Vercel AI SDK as the orchestration
layer, LiveKit as transport only, and speech models owned by Core rather than by any transport.
Read it before adding an interface, a transport, or a provider. It also states plainly which
capabilities exist today and which are destination — do not write code or specs that assume the
destination column.

The single rule that outranks the rest: **a client transport or device must never become coupled to
the agent implementation.**

## Structure & Workspaces

npm workspaces monorepo, Node >= 22, strict TypeScript (`NodeNext`, `noEmit`), run directly with `tsx`.

- `apps/api` (`@bob/api`) — WebSocket voice server. Entry `src/server.ts`; wire contract (types, Zod DTOs, frame codec) in `src/voice/protocol.ts`; WAV helpers in `src/voice/audio/wav.ts`; STT/TTS adapters in `src/voice/audio/stt-tts.ts`; session state machine in `src/voice/session.ts`; turn pipeline in `src/voice/turn/` (device stages taking an injected `TurnDeps`) and `src/turn/` (shared by device and chat: the prep, the one ability wiring `tool-wiring.ts`, the device and chat agent builds, policy, game turns, chat store/stream/persist); `src/workflows/workflow-voice-turn.ts` is the entry point and `src/app-deps.ts` builds the production dependencies); journal in `src/platform/logger.ts`. Tests live in `tests/`. Listens on port 7444 (`BOB_V2_PORT`), path `/v2/cardputer`. Sessions are in-memory; conversations and turns persist to Supabase Postgres at `BOB_DATABASE_URL` (the local stack in Docker for dev, tests and HIL; hosted in production; the server refuses to boot without it; `src/platform/db/db.ts`), with account SQL confined behind `withUser` plus row-level security. Advertises `GET /health` (`{"ok":true,"protocol":"bob.v2","path":"/v2/cardputer"}`). Browser-facing `/api/*` routes (chat stream, conversations) sit behind the Supabase JWT guard (`src/account/auth.ts`); there is no `BOB_WEB_TOKEN` shared-secret guard and no `node:sqlite` / `BOB_DB_PATH` store anymore.
- `apps/ai` (`@bob/ai`) — agent logic: `ToolLoopAgent` (Vercel AI SDK) + AI Gateway provider; `tool()` capabilities in `src/tools.ts`. No build step (exports raw `.ts` source). Loads the repo-root `.env` in `src/firmware/github-config.ts`.
- `apps/ui-v2` (`@bob/ui-v2`) — web client. React 19 + Vite 8 on Astryx 0.6.2 design system (template-first rule in "UI: Astryx template-first" section below). App entry is `src/main.tsx`, routes in `src/app/routes.ts`, the shell, theme and stale-build reload in `src/app/`, and one folder per feature in `src/features/` (`chat/`, `voice/`, `spaces/`, `productivity/` for tasks, agenda, events and notes, `memory/`, `devices/`, `account/`, `notifications/`), each keeping its `*-api.ts` client, hooks, components and tests together. Shared code is in `src/lib/` (`auth/`, the shared hooks). Dev server serves plain HTTP on port 5173 (`BOB_WEB_PORT`). Vitest + jsdom + Testing Library, colocated. Zero workspace imports; uses `@/*` alias for `src/`. Run `npm run dev:ui` to start it; see `apps/ui-v2/README.md`.
- `apps/cardputer` (`@bob/cardputer`) — PlatformIO ESP32 firmware, a scripts-only npm workspace member (matches the `apps/*` glob) with zero dependencies and no build step; PlatformIO runs through npm scripts (`scripts/run-pio.mjs` wrapper). Own `platformio.ini`, env `m5stack-cardputer-v2-poc`, base board `m5stack-stamps3`. Firmware is modular: typed shared headers in `include/` (`config.h`, `types.h`, `protocol.h`, `network.h`, `audio_capture.h`, `audio_playback.h`, `state.h`, etc.) and implementations in `src/`. Needs `include/secrets.h` (copy the example). Flash with `npm run device:flash` from the root (`BOB_COM_PORT`, default COM3) or `npm run flash` from `apps/cardputer`; raw pio: `py -3.11 -m platformio run -e m5stack-cardputer-v2-poc --target upload --upload-port COM3` from `apps/cardputer`.
- `apps/mobile` (`@bob/mobile`) — Capacitor 8 iOS shell (scripts only) that loads ui-v2 live from https://app.heybob.xyz (`CAPACITOR_SERVER_URL` overrides it); `npm run sync|ios|assets --workspace @bob/mobile`; native builds are local (Xcode) and never part of `validate`.

Swappable seams (AI agent, speech, tools, notify channels) are ports in `apps/api/src/voice/` (`agent-port.ts`, `speech-port.ts` and their adapters), decided in `docs/adr/0002-ports.md`. A stub flag is read once, at the composition root (`apps/api/src/app-deps.ts`), and becomes an adapter; call paths never check it. Only `SpeechPort` is built so far.

## Cross-Workspace Imports

`apps/api` imports `apps/ai` only through the `@bob/ai` package (public API in `apps/ai/src/index.ts`; test-only helpers in `@bob/ai/testing`), never by relative path into `apps/ai/src/`. Tests mock `@bob/ai` with `vi.mock('@bob/ai', async (orig) => ({ ...(await orig()), … }))`. Editing `apps/ai` files directly changes `apps/api`. `apps/cardputer` has no workspace imports at all (scripts-only). Device code must never import secrets, DB modules, or provider SDKs.

## Module boundaries

`scripts/check-boundaries.mjs` (run by `npm run validate` and `npm run check`, ~0.2 s, no dependency) fails on a layering violation and prints each offending edge as `from -> to`:

1. A file in a feature folder that is not an HTTP router never imports `web-*.ts` or `server.ts` (see rule 10).
2. (The old core, store and domain folders no longer exist: their files live in the feature folder or `platform/` that owns them.)
3. Only files in `voice/` import the device wire contract (`voice/protocol.ts`), plus root files, `web-schemas.ts` and the e2e fake Cardputer.
4. `apps/api` imports `apps/ai` only through `@bob/ai` / `@bob/ai/testing`, never a path into `apps/ai/src`.
5. `apps/ai` must not import `apps/api` or a DB driver (`postgres`).
6. `apps/ui-v2` may import from `apps/api` only `web-schemas.ts`.
7. `apps/cardputer` TypeScript files import nothing from other workspaces.
8. `getDb` and `getDeviceSessions` are imported only by the composition roots (`server.ts`, `app-deps.ts`) and their own modules; everything else receives them through `AppDeps` (`src/app-deps.ts`) or a narrower `Pick` of it. Tests build their own with `createAppDeps()` after pointing the shared database at a test instance.
9. **Flat feature folders** (`apps/api/src/<feature>/`, ADR `docs/adr/0003-flat-feature-folders.md`): one level, no barrels. Features import each other's files directly; root files (`server.ts`, `api-modules.ts`, `app-deps.ts`, `outbox-module.ts`, `web-*.ts`) wire everything together.
10. Inside a feature folder, every file except `http.ts`, `<part>-http.ts` and `schemas.ts` (store, service, tools, scheduler, fan-out, recurrence, emails) never imports an HTTP router, the transport or (outside `voice/`) the device wire contract. In `voice/` the session, its `handle-*.ts` handlers, `turn/` and `device-socket.ts` are the transport.

11. `apps/api/src/platform/**` (shared infrastructure: `db/`, `logger.ts`, `http/` incl. the JWT `auth-guard.ts`, `observability/`, `outbox/`, `ids.ts`, `id-schemas.ts`, `unambiguous-match.ts`) imports only `platform/**` from `apps/api/src`.
12. Workflows (`workflows/`, one `workflow-<name>.ts` per cross-module orchestration) sit above the feature folders: no feature, store, service, tool, scheduler or `platform/**` file imports them (`features-never-import-workflows`), and a workflow never imports a `web-*.ts` route, `server.ts` or an HTTP router (`workflows-below-http`).

**Where does X live?** Each feature is one folder under `apps/api/src/`, usually `store.ts` + `http.ts` + `schemas.ts` (DTOs, re-exported by `web-schemas.ts`):
- `account/`: JWT auth (`auth.ts`), provisioning, account store and routes, usage, account events (`events-bus.ts`, `events-http.ts`), erasure (`erasure-service.ts`, `erasure-store.ts`), the export route (`export-http.ts`) and the dev account.
- `devices/`: device-token auth (`device-auth.ts`), pairing (`pairing-{http,service,store}.ts`), the device registry and settings (`settings.ts`, `settings-store.ts`), activity and the device conversation pointer (`conversation-ref.ts`).
- `integrations/`: provider account connections, credentials, capability grants, clients, services and operation receipts; Google modules use the `google-` filename prefix.
- `routines/`: scheduled routines (schedule, dispatch, runner, digest), their runs and insights store, routes (`http.ts`) and assistant tools (`tools.ts`).
- `spaces/`: spaces, membership, active space, invitations, space emails, handles, publication (`publication-*.ts`), thread routes (`threads-http.ts`) and `mentions.ts`.
- `conversations/`: the web chat turn (`chat-*.ts`), conversations, their messages and the active pointer (`http.ts`, `messages-http.ts`, `store.ts` — the one store for conversations and messages — and `active.ts`, which holds only `conversation_id`), the thread store (`thread-store.ts`; a thread is a conversation in a pair or group space, in the same `conversations`/`messages` tables), `scope.ts` (`getConversationScope`, which shared mode and the personal-memory gate key on), invocations (`invocations-*.ts`, @Bob in threads) and search (`search-*.ts`).
- `memory/`: memories store, retrieval, extraction worker and queue, tool callbacks, availability, prefilter. The ambiguity rule for targeting a row by query is `platform/unambiguous-match.ts` (shared with action items).
- `notifications/`: `store.ts` (inbox and preferences), `notify.ts` (the "notify X" API), `email.ts`, `email-client.ts`, `http.ts`.
- `firmware/`: releases, channels, offers (`device-offer.ts`), GitHub ingest (`github-config.ts`, `ingest-github.ts`), `http.ts` and `operator-http.ts`.
- `tasks/` (with action items, `action-items-*.ts`, and `agent-callbacks.ts`, the one `bindPrivateCallbacks` used by both the web chat and the device turn), `notes/`, `calendar/` (with `recurrence.ts`), `reminders/` and `timers/` (the timer ring loop is `workflows/workflow-timer-ring.ts`).
- `voice/` (the Cardputer's whole server side): `protocol.ts` (the **device wire contract**, the one authoritative source), `session.ts` (the state machine entry: `handleControl` dispatches every control message through one `Record<type, handler>` table) and `session-handlers.ts` (the handlers plus shared session state and wire helpers), `turn/` (the STT -> agent -> TTS pipeline stages; the entry point is `src/workflows/workflow-voice-turn.ts`), the ports (`agent-port.ts`, `speech-port.ts`, their adapters, ADR 0002), `audio/` (STT/TTS adapters, WAV, MP3), `device-sessions.ts`, `device-tools.ts`, `voice-tools.ts`, `game-tools.ts`, `games-store.ts`, the device conversation history bridge (`cardputer-conversation.ts`, with the one `persistDeviceTurn` every device turn saves through; its shared-space half is `device-thread.ts`), `turn-core.ts`, `turn-journal.ts`, `http.ts` (web voice and speech routes) and `device-socket.ts`.
- `platform/`: `db/` (`db.ts`), `logger.ts`, `http/` (`route` — the one request wrapper and `sendError` — plus `rate-limit`, `cors`, `static-ui`, `errors`, `auth-guard`), `observability/` (`metrics`, `telemetry`, telemetry DTOs), `outbox/` (transactional outbox store and worker; here, not in `notifications/`, because stores in other features enqueue into it).
- `workflows/`: one `workflow-<name>.ts` per cross-module orchestration.

What is left at the root is the composition roots (`server.ts`, `app-deps.ts`, `api-modules.ts`, `outbox-module.ts`), the web contract barrel (`web-schemas.ts`) and the `web-*.ts` routes.

There is no allowlist and no exception list: every rule must pass, and the check prints `no exceptions`. (Edges into `platform/` are fine because no rule bans depending on platform.)

## Dead code gate

`npm run lint:dead` (knip, ~3 s; run by `npm run validate`) fails on an unused file, export or exported type. `knip.jsonc` lists the real entry points, and **tests are entry points**: an export used only by a test is a test seam and stays. An export used only inside its own file should not be exported. Remove dead code, or keep it with a reason in `knip.jsonc`. Every dependency an app imports must be declared in that app's `package.json` (knip fails on an unlisted one; Deno `jsr:`/`npm:` imports and external CLIs such as `rg` and `netstat` are the only ignores).

`npm run check:docs` (`scripts/check-doc-paths.mjs`, part of `validate`) fails when `AGENTS.md`, `CLAUDE.md`, `README.md` or `docs/log-reference.md` names a backticked file or folder that no longer exists; runtime-only paths (`data/`, `.env*`, `secrets.h`) are listed in the script.

## Code quality gates

`npm run check:quality` (`scripts/check-quality.mjs`, ~0.5 s; part of `npm run check` and `validate`) keeps the code easy to read, change and debug. It runs Biome (`biome.jsonc`) and reads `scripts/quality-baseline.json`:

- **Zero tolerance:** `any`, `==`, untyped `let`, an assignment inside a condition, a useless `catch`, a switch fall-through, an unused import. Fix them; there is no allowlist.
- **Ratchets (a number may fall, never rise; a new file starts at zero):** functions over **cognitive complexity 15**, non-null assertions (`!`), unused variables, source files over **1,000 lines** (schema files and tests exempt), and import cycles. When you improve one, run `node scripts/check-quality.mjs --update` and commit the baseline; `--update` refuses to raise a number.
- **Strict typing** is `tsc`: `strict`, `noUncheckedIndexedAccess` (api, ai), `noImplicitOverride`, `noImplicitReturns` and `noFallthroughCasesInSwitch`, all through `npm run typecheck`.

To cut complexity, extract a named function, return early, and flatten nesting. Deno code in `supabase/functions` is linted by `deno lint`, not Biome's `noExplicitAny`.

## Commands

- Install: `npm run setup` (verifies Node, creates `.env` from the example when missing, installs deps, then checks `.env` keys — advisory except hard errors); manual equivalent: `npm install`, then `cp .env.example .env`; root `.env` read by apps/ai/src/config.ts (dotenv).
- Dev server: `npm run dev` (tsx watch); one-shot: `npm run start`; with inspector: `npm run debug` (health: http://localhost:7444/health, journal apps/api/data/v2-journal.log).
- Offline dev (no internet except the AI): `npm run dev:offline` — local Supabase in Docker + the dev servers; `--stub-ai` stubs the AI, `--stop` stops the stack, `--status` shows it.
- **Root `npm test` is typecheck only.** The real Vitest suite is `npm run test:unit` (alias of `npm test --workspace @bob/api`). Watch mode: `npm run test:watch`. Live AI checks (need AI_GATEWAY_API_KEY): `npm run test:live`.
- Build/verify: `npm run typecheck` (or :ai/:api) → `npm run check` (fast pre-commit gate: typecheck + unit tests) → `npm run validate` (git whitespace + staged-ignored scan + secret-pattern scan + typecheck + unit tests + firmware compile; `-- --skip-firmware` to skip the PIO build) → `npm run build` (typecheck + device:compile).
- Cardputer (env m5stack-cardputer-v2-poc, base m5stack-stamps3, needs include/secrets.h copied from the example): `npm run device:compile` | `device:flash` | `device:monitor` | `device:run`; port from env BOB_COM_PORT, default COM3. Equivalent app-level scripts in apps/cardputer: `npm run compile|flash|monitor|run|debug`; raw pio: `py -3.11 -m platformio run -e m5stack-cardputer-v2-poc --target upload --upload-port COM3` from apps/cardputer. `npm run device:monitor` logs serial output to `data/device.log`; `npm run api:monitor` tails the journal to the console and `data/api.log`; `npm run monitor` multiplexes both streams into one terminal (`DEV ` / `API ` prefixed).
- App-level scripts: `@bob/api` — dev, debug, start, build (= typecheck), check (= test), deploy (detached start via apps/api/scripts/deploy.mjs; journal lands in apps/api/data/v2-journal.log, cwd-relative per logger.ts:10), typecheck, test (vitest + typecheck), test:watch; `@bob/ai` — typecheck, test (= typecheck), test:live, build (= typecheck), check (= typecheck).
- Stub mode: `BOB_SYSTEM_TEST=1` bypasses the AI Gateway — agent replies `System test response: <input>`, STT stubbed. It requires a local database (`BOB_DATABASE_URL` unset or on 127.0.0.1/localhost/::1); the server refuses to boot otherwise, because its test sign-in creates `auth.users` rows.

## Device Voice Contract

`ws://<host>:7444/v2/cardputer` carries JSON control messages and binary `OLX2` audio frames on one socket. Frame = 20-byte header (magic `OLX2`, version, kind `audio_up`/`audio_down`, format, channels, turn handle, sequence, payload bytes) + payload. The client negotiates the format in `hello`: `format_id` 1 is PCM16 16 kHz mono (uplink and PCM downlink frames carry 320-byte / 10 ms payloads), `format_id` 2 is MP3 (downlink chunks are 1024-byte compressed frames decoded on-device). Uplink frames ≤ 4096 bytes. Client lifecycle: `hello` → `turn_start` → `audio_up` frames → `turn_end` → server streams `playback_start` / `audio_down` / `playback_end`. `turn_start.payload` may carry `conversation_id` (#880, an opaque id, 8..64 of `[A-Za-z0-9_-]`): the conversation the device shows; firmware advertises hello cap `turn_conversation`, the server answers `welcome.turn_conversation: true`, and only then does firmware send it (when it has an active conversation; omitted otherwise). Older firmware never sends it and an older server never answers the cap, whose strict `turn_start` would refuse the key. The server pins the turn to it (root span, journal, persisted messages; the account's pointer is not moved) only after the picker's access check passes; otherwise the server's own resolution stands and `v2.turn_conversation_ignored` is journaled. It authorizes nothing else. Uplink is bounded by `ACCUMULATE_MAX_BYTES` (1 MB, `QUEUE_FULL` beyond it); the server caps PCM replies to the 320 KB device playback buffer and MP3 replies to 3 MB. Once per turn, after its reply drained, was stopped or failed, firmware that advertised hello cap `turn_timing` and got `welcome.turn_timing: true` sends one `turn_timing` control (#1004, schema and field order in `apps/api/src/voice/protocol-timing.ts`): enums plus bounded device-clock offsets from capture start (a number is measured, `null` skipped, absent unknown), never answered by the server and never compared with server time; see docs/observability.md "Device turn timing". The authoritative contract is `apps/api/src/voice/protocol.ts`.

### Upgrade authentication (008)

The WebSocket upgrade itself now decides the session kind from the
`Authorization` header (`apps/api/src/devices/device-auth.ts`), before any session
exists:

- `Bearer olxd_<43>` — a paired device. Unknown, revoked, or disabled tokens
  are accepted as **unpaired** (answered `pairing_required` at hello), never 401.
- `Bearer <DEVICE_SHARED_SECRET>` — legacy shared-secret path, only when
  `BOB_LEGACY_DEVICE_OWNER` is set; the session acts as that account
  (`kind: legacy`).
- Any other bearer — **401 `invalid_token`** at the upgrade.
- No header — **unpaired** (`reason: none`).
- A store outage is refused with **503 `auth_unavailable`** — undecidable,
  never guessed as unpaired.

Unpaired sessions are capped at **3 sockets per IP** (the 4th upgrade is 503
`too_many_unpaired`), may only send `hello`, `pair_request`, and `pong` (every
other control gets the `UNPAIRED` error), and are idle-closed after 11 minutes
(`BOB_UNPAIRED_IDLE_MS`). `pair_request` is rate-limited to 5/min
(`BOB_PAIR_REQUEST_RPM`).

### Pairing and follow-me messages (008)

Server → device, additive: `pairing_required { reason: none|unknown|revoked }`
(answers a hello from an unpaired socket), `pair_code { pairing_id, user_code
XXXX-XXXX, verification_uri, expires_in: 600 }`, `paired { device_id,
device_token olxd_..., name }`, `pair_expired { pairing_id }` (defined, but the server never sends it: an expired code is refused when looked up), `pair_denied
{ pairing_id }`, and `active_conversation { id, title }` — whose **null form**
(`{ id: null, title: null }`) means the active conversation was deleted ("New
conversation"). Device → server, additive: `pair_request { model,
fw_version, claim, resume? }`. New error codes: `UNPAIRED`,
`PAIRING_RATE_LIMITED`. `welcome` gains optional `device: { id, name } | null`
and `active_conversation: { id, title } | null` (device/legacy sessions);
absent fields mean null. The authoritative DTOs are `voice/protocol.ts`
(`PairRequestDtoSchema` … `ActiveConversationDtoSchema`).

**Space selection (#301).** The device can pick the account's active Space. This
pointer is separate from the active conversation, and it does not change how
turns start yet. Device → server: `list_spaces {}` and `select_space { space_id:
uuid | null }`, where null clears it. Server → device: `spaces { spaces: [{ id,
name }] }` (live member Spaces only, at most `SPACES_LIST_CAP` = 10),
`space_selected { space_id, name }` (the ack), and the push `active_space { id,
name }`. The pointer ids and names are both null together. The key is always
`name`, never `title`, and a name is 1..60 characters. `welcome` gains optional
`active_space: { id, name } | null` after `active_conversation`. It is omitted
when the store is unavailable, and a stale Space is cleared and sent as null.
The new error `SPACE_NOT_FOUND` is sent when a Space is unknown, the device's
account is not a member of it, or it is revoked or archived. Both messages need
the `ready` stage. `active_space` is pushed from the account event
`active_space.changed` and follows the same hold-until-`playback_end` rule as
`active_conversation`, in its own pending slot. The journal never records a
Space name.

**Device control and announcements (epic #311).** Strict DTOs in `voice/protocol.ts`,
server payload keys in exactly this order (the firmware parser is
order-sensitive). `mode` is `ptt | wake | announce_only`, volume an integer
0..10. Device → server: `device_state { volume, muted, mode, dnd, battery_pct
(0..100|null), charging (bool|null), fw_version (1..16) }` after `welcome` and
on every local change, in any paired stage (kept on the session and in the
registry, persisted in the settings columns of `bob.devices`, seeds the next hello, publishes
`device.changed`); `announce_ack { announce_id, action: played|dismissed|snoozed }`;
`cancel {}` now aborts the in-flight turn (AbortSignal through STT, agent, TTS
and stream; `playback_end` only if playback started, then `status idle`; a
cut reply is saved truncated and `interrupted`; `cancel` waits for the turn to
unwind so a queued `turn_start` finds `ready`). Server → device:
`device_control { volume?, muted?, mode?, dnd? }` (at least one; sent at once,
even mid-turn); `reply_text { heard (0..200), reply (0..700) }` with `turn_ref`
on the envelope, before `playback_start`, never journaled; `express {
emotion (one of the 47 in `EXPRESS_EMOTIONS`), seconds 1..15 }` (the `express`
agent tool; Bob shows a feeling) and `scene { scene, seconds 1..20, label? (<=24),
value? (int) }` (sent when a turn's tool call succeeds, chosen by tool in
`apps/api/src/voice/scene-table.ts`, never by phrase; `label` never journaled), each only to a
device whose hello caps list `express` / `scene`; `end_of_turn {}` with `turn_ref` on the envelope is sent only to a device whose hello caps list `end_of_turn`, when the server's streaming-STT end of turn fires (#1365): the device closes capture with end reason "server" and its silence timer stays the fallback (device half pending, #1365); `announce {
announce_id (8..60), kind: timer|alarm|reminder|notice, title (1..28), body
(0..200), ring, expires_at }`. A `ring:false` announcement with speech is
followed (MP3 sessions only) by `playback_start {turn_ref: "ann_<announce_id>"}`
/ `audio_down` / `playback_end`. Announcements live in a per-account in-memory
outbox (`voice/device-sessions.ts`, cap 20): held while capturing/responding or
in DND, deduped by id, replayed on reconnect until acked or expired. Timers
ring via `startTimerScheduler` → `announceTimer` (`server.ts`); due reminders
announce from `workflows/workflow-reminder-fire.ts` (the fan-out) without touching the inbox/email path.
Device turns bind the account time zone (`bob_private.account_time_zone()`),
timers, voice tools and `set_volume`/`set_mode` (`voice/device-tools.ts`); web
turns get timers and voice tools, and device tools only with a connected device.

**Close code 4003** is the revoke close: `DELETE /api/devices/:id`
(`apps/api/src/devices/http.ts`) revokes the device under `requireActiveSession`,
closes its live socket with 4003 via `voice/device-sessions.ts closeDevice`, and
the device reconnects immediately with its stored token and is answered
`pairing_required { reason: 'revoked' }`. **NVS erase rule**:
the device erases its stored `olxd_` token only on an explicit
`pairing_required { reason: unknown|revoked }` — never on close code 4003, a
401 upgrade rejection, reboot, or `pair_expired`
(`apps/cardputer/src/state_pairing.cpp`).

Journal events (`v2.*`) go to the console and `data/v2-journal.log` (`BOB_V2_JOURNAL`). Logs must never include audio, transcripts, agent text, credentials, URLs, or prompts.

## Style & Process

- Migrations: never push unmerged migrations to a hosted database; preview with `supabase db push --dry-run` and apply only what is on `main` (`docs/deploy.md`).
- Secrets: see `docs/secrets.md`; never commit a filled env file and never pass a secret value as a command-line argument.

- TypeScript, 2-space indent, semicolons, explicit return types, kebab-case filenames, Zod schemas for every wire boundary, `.ts` extensions in relative imports.
- Atomic commits with `feat:`, `fix:`, `docs:`, `test:`, `chore:` prefixes; PRs include verification. Never commit `.env`, keys, prompts, audio, or PII.
- **Persistent validation gate before delivery: run `npm run validate` (or `npm run validate -- --skip-firmware` when the PIO build is not required) on every change before reporting it done. Never deliver a change that has not passed the validation gate.**
- **Attest the pass so CI does not repeat it: commit, run `npm run validate`, push, then `npm run attest`.** `npm install` points git at `.githooks` (`scripts/install-hooks.mjs`), whose `pre-push` hook attests automatically once the push lands; `BOB_HOOK_STRICT=1` makes it run the gate first and block a push that fails, `BOB_SKIP_HOOKS=1` skips it. A full `npm run validate` records the pass against the git tree hash (`data/validate-pass.json`); `attest` publishes it as the `local/validate` commit status, and CI's validate job then skips the suite for that exact content (`scripts/validate-attested.mjs`). Anything unattested still runs the full suite in CI. Never post an attestation for content the gate did not pass here.
- Deliver completed work as small git commits grouped by objective, pushed to a branch and merged through a pull request, because `main` is protected.
- Standing observability requirement: telemetry is vendor-neutral and chosen only by `OTEL_*` variables (any OTLP backend, stdout JSON logs joined by `trace_id`, metrics as OTel instruments plus `bob.metric.<name>` span attributes; see `docs/observability.md`). Never name a provider in logging or telemetry code, with ONE exception: the browser RUM SDK (`@openobserve/*`) lives only in `apps/ui-v2/src/lib/observability/rum.ts` and runs only when `BOB_RUM_*` is configured. New features should keep logs/metrics/spans free of PII, raw prompts, and secrets, with bounded labels.

## Skills for Speed & Accuracy

Skills are the default acceleration mechanism for every agent in this repo. Load the matching skill BEFORE starting work — never after a failure or a second guess.

- **Load a skill whenever a task matches its description** (Skill tool). High-value skills for this repo: `esp32-firmware-engineer` (firmware write/review/debug, panic triage, RTOS/heap/stack, I2S, WiFi recovery — load for ALL Cardputer work), `websocket-development` (the wire protocol in protocol.ts), `ai-sdk` (agent loop in apps/ai), `api-testing-patterns` / `javascript-testing-patterns` (test authoring; not installed by default, install from `proffesor-for-testing/agentic-qe@api-testing-patterns` and `wshobson/agents@javascript-testing-patterns`), `html-testing-checklist` (verification plans; not installed and the map has no source for it, so search with `find-skills`), `find-skills` (discover new capabilities).
- **Task → skill map (load before starting; install any that are missing).** Repo skills live in `.claude/skills/`. The rest are user-level, so on a new machine install them once with `npx skills add <source> -g -y`:

  | When you are… | Load | Install source (if missing) |
  | --- | --- | --- |
  | Changing Cardputer firmware, reading panics, heap/RTOS | `esp32-firmware-engineer` (repo), `embedded-systems` | `adamlipecz/esp32-firmware-engineer-skill@esp32-firmware-engineer`, `jeffallan/claude-skills@embedded-systems` |
  | Changing the wire protocol (`protocol.ts`, OLX2 frames) | `websocket-development` (repo) | — |
  | Writing or fixing Vitest tests, especially anything timer- or clock-based (use fake timers, never wall-clock waits) | `vitest` | `antfu/skills@vitest` |
  | Writing or fixing Playwright e2e, or chasing a flaky e2e. Pin dates with `page.clock`; never pick days relative to "today" without handling month ends | `playwright-best-practices`, `e2e-testing-patterns`, `webapp-testing` | `currents-dev/playwright-best-practices-skill@playwright-best-practices`, `wshobson/agents@e2e-testing-patterns`, `anthropics/skills@webapp-testing` |
  | Taking a PR from opened to merged: watching CI, retrying flakes, keeping the branch up to date under the `main` ruleset | `babysit-pr`, `gh-cli` | `openai/codex@babysit-pr`, `trailofbits/skills@gh-cli` |
  | Debugging any failure before changing code | `systematic-debugging` | `obra/superpowers@systematic-debugging` |
  | Running parallel units in git worktrees | `using-git-worktrees` | `obra/superpowers@using-git-worktrees` |
  | About to say "done" | `verification-before-completion` (run `npm run validate`, and HIL for firmware) | `obra/superpowers@verification-before-completion` |
  | Shrinking Cardputer flash or static RAM, re-basing `memory-budget.json`, reading a linker map | `esp32-firmware-engineer` (memory-optimization reference), `embedded-systems`, `binary-analysis-patterns` | `wshobson/agents@binary-analysis-patterns` |
  | Changing `apps/api` routes, stores or the session/turn pipeline, and their tests | `api-testing-patterns`, `javascript-testing-patterns`, `vitest` | `proffesor-for-testing/agentic-qe@api-testing-patterns`, `wshobson/agents@javascript-testing-patterns` |
  | Changing the agent loop, tools or model calls in `apps/ai` | `ai-sdk`; `claude-api` (built in) for Anthropic model ids, caching and tool use | `vercel-labs/ai@ai-sdk` |
  | Changing the database: migrations, RLS, SQL functions, Supabase auth or storage | `supabase`, `supabase-postgres-best-practices` | `supabase/agent-skills@supabase`, `supabase/agent-skills@supabase-postgres-best-practices` |
  | Changing `apps/ui-v2`. The Astryx CLI and `apps/ui-v2/CLAUDE.md` come first and win: design skills (`impeccable`, `design-taste-frontend`, `high-end-visual-design`, `ui-ux-pro-max`, `shadcn`) must never change Astryx markup, spacing or styling | `vercel-react-best-practices`; `ux-writing` for copy | `vercel-labs/agent-skills@vercel-react-best-practices`, `content-designer/ux-writing-skill@ux-writing` |
  | Editing GitHub Actions workflows | `github-actions-templates` | `wshobson/agents@github-actions-templates` |
  | Resolving a merge or rebase conflict | `resolving-merge-conflicts` | `mattpocock/skills@resolving-merge-conflicts` |
  | Reviewing a change, or acting on review feedback; anything touching auth, tokens or secrets | `code-review`, `requesting-code-review` / `receiving-code-review`; `security-review` (built in) | `mattpocock/skills@code-review`, `obra/superpowers@requesting-code-review`, `obra/superpowers@receiving-code-review` |
  | Adding new behaviour or fixing a bug test-first | `tdd` | `mattpocock/skills@tdd` |
  | Deploying to Vercel | `deploy-to-vercel`, `vercel-cli-with-tokens` | `vercel-labs/agent-skills@deploy-to-vercel` |
  | Working on LiveKit voice agents | `livekit-agents`, `livekit-simulations` | `livekit/agent-skills@livekit-agents` |
  | Picking the agent for a change, or adding a lesson to one | "Dev agents (domain-owned)" below; `bob-dev` (repo) | — |
  | Adding, changing or removing HTTP APIs, schemas, auth or Edge Functions; maintaining Swagger coverage | `bob-api-docs` (repo) | — |
  | Looking for a capability not listed here | `find-skills` | `vercel-labs/skills@find-skills` |

- **Shared hardware.** A Cardputer (`BOB_COM_PORT`) and the :7444 dev API may be shared by several sessions on one machine. Before `node scripts/hil/run.mjs`, check that no other process holds the serial port (another session's serial driver re-opens it and makes flashing fail with "Access is denied") and who owns :7444. Stop another session's processes only with its owner's OK, and by PID. Restart the dev API afterwards.
- **Mobile (`apps/mobile`)**: the `capacitor-best-practices`, `debugging-capacitor`, `capacitor-deep-linking` and `capacitor-push-notifications` skills (cap-go/capgo-skills, installed user-level) cover the WebView shell. Two of their assumptions are wrong for us: the push skill routes everything through Firebase, while decision D3 sends **direct to APNs** with no Firebase, and its iOS setup edits a `Podfile`, while Capacitor 8 builds this project with **Swift Package Manager**. Take their client-side plugin guidance; ignore their server and project setup.
- **Install skills globally**: `npx skills add <owner/repo@skill> -g -y`, then confirm it landed in `~/.claude/skills/`, so agents in other worktrees can see it too. `skills-lock.json` records the third-party skills this repo uses.
- **Search for skills at every stage, not once**: run `find-skills` when planning, before building against an unfamiliar API or tool, when designing validation, and after a failure or review exposes a gap. Prefer known sources and 1K+ installs; say so when nothing meets the bar instead of installing a weak skill. Every work order names the skills the worker must load.
- **Firmware size and memory work** (flash/RAM budget, linker map, trimming the image): load `esp32-firmware-engineer` (its memory-optimization reference), `embedded-systems` and `binary-analysis-patterns`, all installed globally.
- **A skill is a contract, not a suggestion**: follow its workflow, references, and checklists (e.g. `esp32-firmware-engineer` references: panic-log-triage, memory-optimization, rtos-patterns). When a skill's guidance conflicts with this file or repo conventions, repo conventions and the validation gate win.
- **Faster and more accurate by construction**: skills turn hard-won lessons (crash triage, memory tuning, protocol checks) into repeatable steps, so agents do not re-derive them per task. Loading a skill is mandatory for the domains listed above, not optional polish.
- **Create a skill when a pattern repeats**: when a task takes multiple turns or two or more steps to converge (e.g. a recurring crash class, a debugging flow, a build-gate procedure), encode the lesson as a small skill. New skills must be focused (single domain), prescriptive, and validated on a real task before being relied on.
- **Do not weaken skills for speed**: if a skill workflow is skipped, the change is not "done" until it is either followed or explicitly waived by the primary agent with a recorded reason.

### The Bob dev lifecycle skills

Start every piece of Bob work with `bob-dev`, the entry point. It holds the lifecycle map, the ground rules and the shared facts (branches, npm scripts, test commands, shared hardware, the work-order template, the review checklist). It then hands off to one skill per stage: `bob-plan`, `bob-develop`, `bob-test`, `bob-validate`, `bob-review`, `bob-release`.

## UI: Astryx template-first (ui-v2)

Astryx templates ship every page, block and component Bob needs. Scope: `apps/ui-v2` and any new web UI. Principles: DRY, KISS, YAGNI — no repeated pattern, no clever version, nothing nobody asked for. **Astryx is the only source of UI and custom changes are not allowed**: never hand-write markup, spacing or styling. If a screen seems to need something bespoke, the answer is an Astryx template, component or pattern you have not found yet.

Read these, every time, before writing a line: https://astryx.atmeta.com/docs/working-with-ai#overview (**first** — it is written for agents, not humans), https://astryx.atmeta.com/templates, https://astryx.atmeta.com/components, https://astryx.atmeta.com/docs/getting-started, https://astryx.atmeta.com/docs/cli, plus Astryx's **design patterns** and **UX patterns** — the pattern says which components go together, the component page only says what props exist.

Workflow, in order: `cd apps/ui-v2 && npx astryx build "<what the screen is for>"` (closest page + blocks + components) → `npx astryx template <name> [--skeleton]` → adapt the scaffold → `npx astryx component <Name> --dense` for every component used. Cross-check with the Astryx MCP (`https://astryx.atmeta.com/mcp`, tools `search` / `get`); it serves latest docs. CLI is pinned to 0.6.2 and wins on conflicts.

Hand-code only when `astryx search` finds nothing, and then compose Astryx components only: no raw div/span, no `style={{}}`, no `className`, no CSS of our own. Never run `astryx swizzle` (it writes component copies into the repo). Work orders for UI work name the template/component to use. Pointers: `apps/ui-v2/AGENTS.md` (CLI-generated block), `apps/ui-v2/CLAUDE.md` (Bob additions).

## Dev agents (domain-owned)

Every unit is built by a Claude Code subagent that owns its files. Each agent follows the shared contract in
`.claude/skills/bob-dev/references/agent-contract.md`.

- **Routing**: send each unit to the ONE domain agent (`bob-<domain>`) whose `owns` cover every file it
  changes. Split a unit that spans two domains into two units. Shared seams (schemas, registries, the app
  shell, migration ordering) are `bob-platform` units. Logging, metrics and traces go to `bob-observability`.
- **Generated, not hand-written**: `.claude/domains.json` (domains: owns, tests, skills, MCP, docs, gates)
  and `scripts/agent-roles/` (role agents) are the sources. Edit one of them, then run `npm run gen:agents`;
  the `.claude/agents/bob-*` files are output. `npm run check:agents` (part of `validate`) fails on drift,
  on a tracked file no domain owns, and on a file two domains own.
- **Protected paths**: Claude Code refuses agent writes to `.claude/**` and `.mcp.json` (the project MCP
  servers). Workers draft the change in their report; the lead applies it. Treat a refusal as the answer.
- **Agents evolve**: every deviation becomes a lesson on the agent that owns the files: a reviewer or
  validator FAIL, an eval miss, an escaped defect, an RCA finding, a CI failure on `main`. Accept the lesson
  only when `npm run eval:agents -- --agent <name>` does not regress; that eval replays real single-domain
  fixes and scores the run with the fix's hidden tests.
- **Role agents**:

  | Agent | Use it |
  | --- | --- |
  | `bob-test-engineer` | first: writes the red test before the domain agent changes code |
  | `bob-validator` | before anything is called done: runs the gates and the real path |
  | `bob-reviewer` | before merge: the review checklist against the diff |
  | `bob-log-rca` | on any failed real-path or HIL run: timeline and ranked root causes from the logs |
