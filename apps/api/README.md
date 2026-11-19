# Bob Voice Server (apps/api)

WebSocket voice server for Bob, the modular personal AI assistant. Listens on port 7444 (`BOB_V2_PORT`) at `/v2/cardputer`. Runs Cardputer over the device wire protocol (OLX2 frames), handles sign-in and account management, persists conversations and turns to Supabase Postgres, and delivers agent replies over the wire in real time.

## Folder Structure

```
src/
  server.ts              — startup and shutdown
  api-modules.ts         — mount all routes in order
  app-deps.ts            — production dependency injection (composition root)
  outbox-module.ts       — transactional outbox scheduler
  web-schemas.ts         — HTTP contract re-exports

  platform/              — shared infrastructure (never imports features)
    db/                  — Supabase Postgres, RLS, migrations
    http/                — route() request wrapper, rate limit, CORS, JWT auth guard
    cache/ outbox/       — caches and transactional job queue
    logger.ts observability/  — journal, metrics, telemetry

  account/               — auth, sessions, provisioning, erasure
  devices/               — pairing, device auth, settings, conversation pointer
  google/                — Google account connector
  spaces/                — shared spaces, membership, invitations, threads
  conversations/         — chats, history, search, invocations (@Bob)
  tasks/ notes/          — productivity items
  calendar/ reminders/   — events and reminders with recurrence
  timers/                — device timers and scheduler
  memory/                — memory extraction, retrieval, embeddings
  notifications/         — inbox, email, preferences
  firmware/              — OTA offers, manifests, verification
  voice/                 — device sessions, STT/TTS, turn pipeline
    turn/                — turn orchestration (transcribe → agent → TTS)
    audio/               — WAV, MP3, speech adapters
```

See `docs/adr/0003-flat-feature-folders.md` for the structure decision.

## HTTP Request Path

```
client → CORS + rate limit (platform/http)
      → JWT auth guard (platform/http/auth-guard.ts)
      → router (feature/http.ts), each handler wrapped in route()
      → store (feature/store.ts)
      → Postgres + RLS (platform/db)
```

`route()` (platform/http/route.ts) validates query and body (400 `invalid_request`), then the account (401 `invalid_token`), then path params (400), and hands store errors to the router's own `mapError`, which picks the status. A stale `revision` on a PATCH answers 409 with `current_revision`.

## Device Turn Path

```
device (Cardputer)
  ↓ audio frames (OLX2, 320-byte / 10ms PCM chunks)
  ↓ protocol.ts parses wire, session validates auth
  ↓ turn/transcribe (STT)
  ↓ turn/context (memories, system prompt)
  ↓ turn/tools (agent iteration)
  ↓ turn/generate (TTS)
  ↓ turn/playback (encode MP3 or PCM)
  ↓ turn/persist (save to Postgres)
  ↓ audio frames (OLX2 back to device)
```

Latency: 2–4 s typical (STT + agent + TTS).

## Background Loops

1. **Outbox worker and reminder fan-out** (`outbox-module.ts`): the worker (`platform/outbox/worker.ts`) drains the transactional outbox (notification email); the reminder fan-out ticks every 60 s and rings devices.
2. **Device timers** (`timers/device-scheduler.ts`): fires due timers on the device that set them.
3. **Memory extraction** (`memory/extract-queue.ts`): extracts memories from finished turns in the background.

Firmware releases are ingested on demand by an operator route (`firmware/operator-http.ts`), not polled.

## Finding Code

- **Turn latency?** `turn/metrics.ts` records per-stage time; journal `v2.turn_<stage>` events.
- **Device message X not handled?** `voice/protocol.ts` has the DTOs; `voice/session.ts` has the one dispatch table, and the handlers are in `voice/session-handlers.ts`.
- **Store of concept X?** `<feature>/store.ts` is the data API.
- **HTTP route for X?** `<feature>/http.ts` exports one `create<Feature>Router()`.
- **Outbox job X?** `outbox-module.ts` registers a handler per `event_type`; `platform/outbox/worker.ts` delivers them.
- **RLS rule for X?** `supabase/migrations/` SQL.

## Glossary

**Turn:** One exchange: the user's speech or text, then the agent's reply. Saved as messages in its conversation (`bob.messages`); per-stage timing goes to `bob.turn_metrics`.

**Session:** One device's live WebSocket connection. State machine in `voice/session.ts`; held in memory only, so a restart drops it.

**Announcement:** A one-way notice card pushed to a connected device (a reminder, a timer, a notice). See `voice/turn/announce.ts`.

**Effect key:** The unique key on an outbox row naming one side effect, so it is enqueued and delivered at most once (`bob.outbox.effect_key`).

**Outbox:** A transactional queue: a row is enqueued in the same transaction as the change it reports, and the worker delivers it by `event_type` with leases and retries.

**Occurrence:** One instance of a recurring event or reminder. An edited instance is stored as an exception keyed by `original_occurrence_start` (`bob.event_exceptions`).

**Invocation:** An @Bob call in a shared space's conversation. Rows in `bob.ai_invocations`.

---

See `AGENTS.md` for module boundaries. `docs/log-reference.md` lists every journal event.