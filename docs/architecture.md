# Bob Architecture

Target architecture and the boundaries that hold today. Read this before adding an interface, a
transport, or a provider.

**Two things are described here.** The *rules* are in force now and every change should respect
them. The *destination* is where the system is going and is largely unbuilt — the "Today" column
below is the honest state of the repository.

---

Diagrams for each app and the key workflows are in
[docs/diagrams/README.md](diagrams/README.md).

## Core principle

Bob's intelligence lives in one place. Clients are interfaces onto it, never implementations of
it.

A client transport or device must never become coupled to the agent implementation. That single
rule is what lets the Cardputer start on WebSockets and move to something else later without
rewriting the assistant.

## Interfaces

Three, sharing one core.

| Interface | Purpose | Transport | Suited to |
|---|---|---|---|
| **Chat** (web) | Rich text and control surface | HTTP streaming | Long answers, tool inspection, files, settings, history |
| **Converse** (web) | Natural spoken assistant | LiveKit / WebRTC | Realtime conversation, interruption, low-latency speech |
| **Cardputer** (ESP32-S3) | Portable physical client | WebSocket (`OLX2` frames) | Push-to-talk, quick commands, spoken replies |

```
                        Bob Core
                  Vercel AI SDK · agents
                 tools · memory · STT/TTS
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
   HTTP stream          LiveKit             WebSocket
        │                   │                   │
      Chat              Converse            Cardputer
```

**Do not pursue feature parity between them.** They share capabilities; presentation should differ.
A tool returning thirty calendar events becomes a table in Chat, "you have thirty events this week,
six tomorrow, first at 9 — want me to go through them?" in Converse, and "six events tomorrow,
first at 9" on the Cardputer.

## Layer boundaries

| Layer | Owns | Must not own |
|---|---|---|
| **Bob Core** | The assistant: agent behaviour, context, tools, conversation state, speech model choice | Transport specifics |
| **Supabase** | Persistence and identity: Postgres for conversations, memory, user and device state; Auth for accounts; row-level security for per-user isolation | Agent behaviour, transport |
| **Vercel AI SDK** | Model abstraction, agent loop, streaming, tool calling, structured output | Transport, session media |
| **AI Gateway** | Model routing for chat, embeddings, **transcription and speech** | Anything else |
| **LiveKit** | Realtime media and session transport for Converse | Any business logic, any speech model choice |
| **WebSocket gateway** | Cardputer transport adaptation | Agent logic |
| **Clients** | Presentation, capture, playback, local UI state | Assistant behaviour of any kind |

### Speech belongs to Core

Speech-to-text and text-to-speech are Core's, for every client, through the AI Gateway —
`@ai-sdk/gateway` exposes `transcriptionModel()` and `speechModel()`, and `ai` exposes
`transcribe`, `streamTranscribe` and `generateSpeech`. (The `experimental_`-prefixed forms of the
first and last are deprecated aliases; use the plain names.) `streamTranscribe` matters for the
Converse interface — streaming transcription is what keeps Core-owned speech from costing turn
detection quality.

This is deliberate and was decided against the alternative. LiveKit ships its own STT/TTS plugins,
and using them would mean the web and the device run different speech models — different voice,
different transcription behaviour, two places to change. Core-owned speech keeps every interface
sounding like the same assistant and keeps LiveKit as pure transport, which the boundary table
above requires of it.

### Cardputer transport

WebSocket now. LiveKit publishes an ESP32 client, so a more direct path may become available later,
but that is an optimization and **must not block** device work. The device is heavily constrained
compared with a browser; browser-shaped networking should not be forced onto it without a clear
benefit.

Core must not care which transport the Cardputer uses.

## Today versus destination

| Capability | Today | Destination |
|---|---|---|
| Hosting | Local Node server, binds `0.0.0.0:7444` on a developer machine | Cloud-hosted |
| Users | Supabase Auth accounts, **invite-only**: signups are disabled (`enable_signup = false` in `supabase/config.toml`) and accounts are created by invite email — 6-digit OTP code, magic link, or password, via the templates in `supabase/templates` and custom SMTP. The browser authenticates with a Supabase JWT | — (realized) |
| Access control | Browser `/api/*` behind a Supabase JWT guard that verifies each bearer locally against the project's JWKS (`apps/api/src/account/auth.ts`); the Cardputer device path is per-device `olxd_` tokens minted by pairing (`apps/api/src/devices/device-auth.ts`), with an optional legacy shared-secret path and unpaired sessions capped at 3 per IP; forced row-level security on every `bob.*` table enforces per-account isolation | — (realized) |
| Persistence | Supabase Postgres: schemas `bob`/`bob_private` with forced RLS and a dedicated `bob_server` role, all account SQL behind `withUser` (`apps/api/src/platform/db/db.ts`); local dev, the tests and HIL run the local Supabase stack in Docker, the same engine and migrations; the server refuses to boot without `BOB_DATABASE_URL`. The `node:sqlite` store is retired | — (realized) |
| Conversation state | Shared across Cardputer and web through the account's Postgres store. A per-account "follow me" pointer (`bob.user_state`, the `active_conversation_id` column) is written in the **same transaction** as the change that caused it — a web or device turn, a picker selection, "continue on device", or a deletion (`apps/api/src/conversations/active.ts`; surfaces `web_text`/`web_voice`/`device`/`picker`/`activate`). It is read/written via `GET /api/active` and `POST /api/conversations/:id/activate`, and pointer changes fan out to the web over `GET /api/events` (SSE, ids-only, `apps/api/src/account/events-http.ts`) and to the device as an `active_conversation` push held until after playback (`apps/api/src/voice/device-sessions.ts`). Deleting the active conversation clears the pointer to the `{id:null,title:null}` form | Owned by Bob in Postgres, shared across interfaces (realized) |
| Memory | `bob.memories` / `bob.action_items` in Supabase Postgres behind forced RLS (`supabase/migrations/20260915200000_memory_init.sql`), retrieved through the SECURITY INVOKER hybrid function `bob.match_memories` (full-text + HNSW semantic, RRF + recency). Extraction is an async, debounced-per-account worker that embeds the persisted turn and reconciles `{add,update,supersede,noop}` off the voice path (`apps/api/src/memory/extract.ts`, `apps/ai/src/memory-extractor.ts`). Retrieval runs at turn start under a hard timeout (`BOB_MEMORY_RETRIEVAL_TIMEOUT_MS`, default 1200 = T001's measured embed p95) and injects a sanitized `[BOB MEMORY …]` system block, degrading to full-text+recency on an embed timeout (`apps/api/src/memory/retrieval.ts`); the per-account memory tools `remember`/`forget`/`list_actions`/`complete_action` are merged into the per-turn agent when memory is on (`apps/ai/src/memory-tools.ts`, `apps/api/src/memory/callbacks.ts`). Where the memory store is absent (a database behind the memory migration) or the AI is stubbed, `memoryAvailable()` returns false, so the turn proceeds exactly as before. Both turn paths (`apps/api/src/modules/voice/turn.ts`, `apps/api/src/workflows/workflow-web-chat-turn.ts`) inject the AI Gateway embedder into `createMemoryCallbacks`, so a memory written by the `remember` tool carries a vector at write time — a NULL-vector row is invisible to `match_memories`' semantic (HNSW) arm forever, and its full-text arm ANDs every query word (`websearch_to_tsquery`), so a NULL-vector row also cannot be found by anything but an exact multi-word match | — (realized) |
| Tools | Base: `currentDateTime` (`apps/ai/src/tools.ts:341`; the speech tools stay exported but are not offered, #408); the per-turn factory `createBobAgent` merges in `remember`/`forget`/`list_actions`/`complete_action` when memory is on (`apps/ai/src/memory-tools.ts`) | MCP connections, Gmail, Calendar, search, files |
| Provider | Vercel AI Gateway | — |
| Chat interface | `apps/ui-v2` (Astryx on React + Vite): notes, search, event editor, notifications, account settings; reminders, gallery, external calendar sync not yet | `/chat` |
| Voice on web | None | `/converse` over LiveKit |
| Cardputer | Working, `OLX2` over WebSocket | Unchanged in shape |
| Logging / observability | Journal `v2.*` events to the console and a rotated file (`platform/logger.ts`; 8 MB cap × 3 generations, `BOB_LOG_MAX_BYTES`/`BOB_LOG_KEEP`); an opt-in debug channel (`BOB_DEBUG`, payload under `BOB_DEBUG_PAYLOAD=1`); metadata-only Braintrust traces (`telemetry.ts`) | One correlation id (session + turn) spanning device serial, server journal, and Braintrust traces, plus a deployed log drain — not built |

Every "Destination" cell marked **realized** above exists in the code today. The
remaining destination items — MCP-style tools, the `/converse`
LiveKit voice surface — are still unbuilt; do not write code, specs, or
documentation that assumes they exist.

### Why conversation state must move to Core

Ask the Cardputer "what's my first meeting tomorrow?", get an answer, then open Chat and say "tell
me more about that meeting". That only works if the conversation belongs to Bob rather than to the
interface that started it. Today it is realized: Cardputer and web share the account's conversation
through the per-user Postgres store, and the follow-me pointer keeps both interfaces on the same
conversation (`apps/api/src/conversations/active.ts`). When the pointer moves, the web hears it
over `GET /api/events` (SSE) and the device over an `active_conversation` push
(`apps/api/src/voice/device-sessions.ts`) — the last piece of the follow-me loop landed in T029.

Since #565 the pointer can also name a space thread, and since #756 a thread is simply a conversation
in a pair or group space: one `conversations`/`messages` store, and the pointer holds only
`conversation_id` ([data-model.md](diagrams/data-model.md)). The device sees the thread as
`thr_<uuid>`, so the wire and firmware did not change. Every device turn goes through one
`persistDeviceTurn` (`apps/api/src/voice/cardputer-conversation.ts`), which reads
`getConversationScope` and, for a pair or group space, saves the account's message plus an assistant
reply (`apps/api/src/voice/device-thread.ts`); such a turn runs in SHARED mode (no personal
memory, by `allowsPersonalMemory(spaceKind)`), and reaches every member's
open tabs as `thread.message_appended`. Archiving the space, leaving it or moving the active space
elsewhere clears the thread pointer; a lost thread falls back to a new General conversation. Details:
[device-conversation.md](design/device-conversation.md).

## Family collaboration (014)

The shipped surface is called Spaces (PR #263); `group` is the space kind this spec and the table
below label "Family".

Spaces are the audience primitive. Every 014 resource — thread, task, calendar, note — belongs to
exactly one space, and membership in that space is the unit of access; there are no per-item ACLs
(explicitly out of scope for this release, `specs/014-family-collaboration/tasks.md`). A space is
`private` (the pre-014 single-owner audience, backfilled so existing conversations kept working
unchanged), `pair` (two members), or `group` (family-sized). RLS enforces this at the database layer
through one helper, `bob_private.is_space_member(space_id)`
(`supabase/migrations/20260916050000_spaces_init.sql`), which every 014 table's policies key on —
there is no second membership check to keep in sync with it.

014 domains, and where they live:

- `apps/api/src/<feature>/store.ts` — the store layer (one per feature folder);
  every table's RLS keys on `is_space_member`.
- `apps/api/src/web-{spaces,threads,tasks,calendars,invocations,notes}.ts` — REST routers mounted
  under `/api` behind the same JWT guard as everything else (`apps/api/src/server.ts`); notes are mounted (`apps/api/src/notes/http.ts` store + router on `/api/notes`).
- `apps/api/src/core/{mentions,recurrence,invocations}.ts` — `mentions.ts` is the dependency-free
  parser that decides whether a thread message addresses Bob (`@bob`, FR-008) without ever
  calling a model; `recurrence.ts` is the RRULE/DST/leap-year expansion engine calendars use;
  `invocations.ts` orchestrates one "ask Bob" run end to end (authorize as an active member, claim
  the per-thread run, build context from thread history plus the space's tasks/agenda, bind
  capability tools, run the agent, re-check authorization before committing, persist the reply).

Manual controls and the agent are two callers of the same authorized commands, not two
implementations of the feature. A person creating a task through `POST /api/spaces/:id/tasks`
(`web-tasks.ts`) and Bob creating one because a thread said "@bob add milk to the list"
(`core/invocations.ts`'s callback bag) both end up calling `tasks/store.ts`'s `createTask` — same
authorization, same RLS, same row shape. The agent path adds one more structural guarantee:
capability tools are bound fresh per invocation, closed over that invocation's `spaceId` and
`actorUserId` (`apps/ai/src/productivity-tools.ts`), so a tool's input schema has no `space_id` or
`user_id` field for the model to fill in — there is nowhere in the schema to name a different space.
Every write callback also re-checks membership before it touches the store, and a shared-space
invocation never touches personal memory: `runInvocation` passes an explicit empty memory-tool set,
so no memory retrieval or extraction is reachable from a thread invocation (contract:
`tools-and-events.md` "Shared-mode context rules").

**Not built.** Reminders (the recurrence engine is built and tested but nothing fires one — issue
#111), notifications and push, a gallery UI (the notes store and router exist; ui-v2 covers notes in `apps/ui-v2/src/features/productivity/notes-panel.tsx`), and external calendar sync (Google and iCloud are still spike stories,
not started). Do not write code or documentation that assumes any of these exist.

## Roadmap

Each is an independently shippable feature with its own spec under `specs/`.

| # | Feature | Depends on |
|---|---|---|
| 001 | Web client on the real agent; push-to-talk voice; validation gate and docs | — |
| 002 | AI Gateway migration — chat, STT and TTS through one provider and one credential | — |
| 003 | OpenAI-compatible `/v1/*` facade over the real agent, for external clients | 001 |
| 004 | Converse: hands-free voice over LiveKit, VAD turn detection, barge-in | 001, 002 |
| 005 | Cardputer and web as peer clients of one conversation service | 002, 004 |
| 006 | Cloud hosting, Supabase Auth accounts, Postgres persistence, real authentication replacing the shared token | 001, 002 |

Any work touching the database — schema, migrations, row-level security policies, indexes,
functions — should load the `supabase` and `supabase-postgres-best-practices` skills first. RLS in
particular is not optional: it is what keeps one user's conversations and memory out of another's.

The API surface is deliberately two-sided: `/api/chat` speaks the AI SDK UI-message stream natively
for Bob's own clients, and `/v1/*` presents the OpenAI shape for anything external. Neither is a
translation of the other's compromise.

008 added the follow-me, pairing, and devices surfaces to the web API, all behind the same JWT
guard (`apps/api/src/server.ts`): `GET /api/active`, `POST /api/conversations/:id/activate`,
`GET /api/events` (SSE, ids-and-metadata-only payloads), `/api/pair` (`lookup`/`approve`/`deny`,
with approve and deny under `requireActiveSession`, `apps/api/src/devices/pairing-http.ts` and `apps/api/src/workflows/workflow-device-pairing.ts`), and
`/api/devices` (`apps/api/src/devices/http.ts`): `GET` lists the account's non-revoked devices
(newest paired first; `last_seen_at` may be null), `PATCH /:id` renames (name 1–40 chars),
`DELETE /:id` revokes — under `requireActiveSession` it keeps the row and sets `revoked_at`
(`bob_private.revoke_device`, `apps/api/src/devices/pairing-store.ts`), closes the live socket with WS
code 4003 (`apps/api/src/voice/device-sessions.ts`), and publishes `device.changed`. An unknown or
other-account id answers 404 on every route; a revoked device answers 404 to rename.

### Conversation-only group chats (#1293)

Individual chat collaboration creates a snapshot in a dedicated group Space. Its
immutable `conversation_id` binds exactly one conversation; SQL rejects other
Space resources and ordinary membership/invitation mutation. The private source
remains independent. Reusable `group_chat_links` store only hashes and admit a
signed-in person through an explicit, atomic acceptance operation. Revocation
uses the existing Space membership boundary. Group invocations use shared chat
history without personal memory, private integrations or Space productivity.
