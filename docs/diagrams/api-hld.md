# `@bob/api` — HTTP and WebSocket surface

High-level structure of the API package (`apps/api/src`). The wire contract
itself lives in `schemas.ts`; the turn pipeline in `turn.ts`; the session
state machine in `session.ts`. All names and routes here are taken from the
code, not the prose.

- HTTP server: `server.ts` (WebSocketExpress + Express).
- Device WebSocket: `ws://<host>:7444/v2/cardputer` (`V2_PATH`).
- HTTP REST: `/api/*` behind a Supabase JWT guard.
- Persistence: one `Db` port over `postgres` (Supabase: the local stack in
  development, tests and HIL, hosted in production; `platform/db/db.ts`), all
  account SQL behind `withUser` + row-level security.

## HTTP surface and guards

```mermaid
flowchart LR
    Browser["Browser client<br/>(apps/ui-v2)"] -->|"GET /health"| Health["/health<br/>no guard"]
    Browser -->|"GET /api/public-config"| PubCfg["GET /api/public-config<br/>publishable key + devSignIn<br/>NO JWT guard"]
    Browser -->|"POST /api/test-token"| TestTok["POST /api/test-token<br/>loopback + BOB_SYSTEM_TEST=1 only<br/>404 otherwise, NO JWT guard"]

    subgraph Guarded["/api/* behind JWT guard"]
        RL["createApiRateLimitMiddleware"]
        JWT["createJwtWebAuthGuard<br/>(verify bearer vs JWKS)"]
        RL --> JWT

        JWT --> Chat["POST /api/chat<br/>web-chat.ts"]
        JWT --> Conv["GET/PATCH/DELETE /api/conversations[/:id]"]
        JWT --> Active["GET /api/active"]
        JWT --> Activate["POST /api/conversations/:id/activate"]
        JWT --> Heard["PATCH /api/conversations/:id/messages/:messageId"]
        JWT --> Telemetry["POST /api/telemetry"]
        JWT --> Voice["POST /api/voice"]
        JWT --> Speech["POST /api/speech"]
        JWT --> Pair["/api/pair<br/>lookup/approve/deny"]
        JWT --> Devices["/api/devices<br/>GET/PATCH/DELETE"]
        JWT --> Events["GET /api/events<br/>SSE ids-only"]
        JWT --> Memories["/api/memories<br/>/api/action-items"]
        JWT --> SpA["/api spaces/threads/tasks/calendars/invocations"]
    end

    Browser --> Guarded
    Cardputer["Cardputer<br/>OLX2 WS"] -.->|"Auth header<br/>Bearer olxd_ / shared secret"| Ws
```

Notes:

- `GET /api/public-config` and the loopback-only `POST /api/test-token` are
  mounted **before** the guard; every other `/api/*` route sits behind it.
- `requireActiveSession` is an extra check (active Supabase session) applied
  inside `/api/pair/{approve,deny}`, `/api/devices/:id` `DELETE`,
  `/api/memories` `DELETE`, and `POST /api/conversations/:id/activate`.
- The 014 routers (`spaces/threads/tasks/calendars/invocations`) mount at the
  guard root and need no extra check.
- `POST /api/invitations/:token` accept stays authenticated; only the
  account-less preview `GET /api/invitations/:token` is guard-exempt.

## Device WebSocket route

```mermaid
flowchart LR
    Card["Cardputer"] -->|"ws:// /v2/cardputer<br/>Authorization: Bearer olxd_ or shared secret"| UA["createDeviceAuthGuard<br/>(decides session kind at upgrade)"]
    UA -->|"paired device token"| UP1["Upgrade guard<br/>device kind"]
    UA -->|"legacy shared secret"| UP2["Upgrade guard<br/>legacy kind"]
    UA -->|"unknown/revoked token"| UP3["Upgrade guard<br/>unpaired (answered pairing_required)"]
    UA -->|"no header / bad token"| UP4["Upgrade guard<br/>unpaired / 401 invalid_token"]
    UP1 --> Session["createSession<br/>session state machine"]
    UP2 --> Session
    UP3 --> Session
    UP4 --> Session

    Session -->|"JSON control DTOs"| Ctrl["handleControl<br/>(session.ts)"]
    Session -->|"OLX2 binary frames"| Bin["handleBinary<br/>(session.ts)"]
    Ctrl --> Turn["processTurn<br/>(turn.ts)"]
    Turn --> AI["@bob/ai agent"]
```

## Session state machine

```mermaid
stateDiagram-v2
    [*] --> await_hello
    await_hello --> ready: hello (sets format_id)
    ready --> capturing: turn_start (pin active conversation)
    capturing --> responding: turn_end (frames == seq-1)
    responding --> ready: processTurn completes (resetSession)
    capturing --> ready: cancel
    responding --> ready: cancel
    ready --> ready: list_conversations / select_conversation / pong
    capturing --> ready: QUEUE_FULL (accumulate overflow)
```

Stages come from `SessionStageSchema` (`await_hello | ready | capturing |
responding`). Only `hello`, `pair_request`, `pong` are legal for an **unpaired**
session; everything else answers `error { code: UNPAIRED }`.

The pinned active conversation may be a space thread, sent as `thr_<uuid>` (#565). With an active
space, `list_conversations` lists up to 5 of its threads first, then General conversations, 10 rows
at most. `select_conversation` on a thread sets the active space and the pointer in one transaction.
A thread is a conversation in a pair or group space; since #756 it lives in the same
`conversations`/`messages` tables as General. After the reply, `turn/persist.ts` makes one call,
`persistDeviceTurn` (`voice/cardputer-conversation.ts`), which reads the pinned ref's
`getConversationScope` and saves a shared turn (`saveSharedTurn` in `voice/device-thread.ts`)
or a private one by the space kind, never by the ref prefix. See
[device-conversation.md](../design/device-conversation.md) and [data-model.md](data-model.md).

## Store

```mermaid
flowchart LR
    Server["server.ts / turn.ts / web-*.ts"] --> GetDb["getDb()"]
    GetDb -->|"BOB_DATABASE_URL (required)"| Pg["postgres (Supabase Postgres)"]
    Pg --> RLS["bob.* / bob_private.*<br/>forced RLS, is_space_member"]
    GetDb --> WithUser["withUser / asServer<br/>account-scoped tx"]
    WithUser --> RLS
```

## Where the AI layer is called

`@bob/api` imports `@bob/ai` (via the `@/ai/*` path alias). Two entry
points drive the agent:

- **Device turns** (`turn.ts:runAgent`): `processTurn` → `generateReply` →
  `runAgent(messages, agent)` where `agent` is the shared `bobAgent`
  singleton, or a per-turn `createBobAgent` when memory is on.
- **Web turns** (`web-chat.ts:webChat`): `createAgentUIStreamResponse` with the
  shared `bobAgent`, or a per-turn `createBobAgent` when memory is on.

Both build the per-turn agent with `createBobAgent({ memoryContext,
memoryTools })` only when memory is available; otherwise they use the static
`bobAgent` singleton unchanged.