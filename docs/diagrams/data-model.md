# Data model: one conversation model

Every message lives in one store: `conversations` / `messages` / `message_versions` / `conversation_reads`, scoped by space membership and `space.kind` (issue #756, a storage-only consolidation with the APIs unchanged). A thread is a conversation in a shared (pair or group) space and keeps `thread` as its API name; the private space is General. The two-store design it replaced is under [History (before #756)](#history-before-756).

## Decisions

- **No API change.** All external contracts (`/api/chat`, `/api/threads/*`, WebSocket refs `cnv_`/`thr_`) remain byte-for-byte identical (locked by snapshot tests, #761). ui-v2 and the Cardputer firmware needed no changes.
- **IDs are preserved.** Conversations and messages kept their UUIDs (`cnv_…` for General, `uuid` for threads) on backfill, so there is no mapping table. Backfilled thread versions got deterministic ids `ver_<message id>`.
- **Memory scope = space.** Existing rows were backfilled to the owner's private space. Personal memory is private-space memory: `allowsPersonalMemory(space.kind)` (`apps/api/src/memory/extract.ts`) lets only `private` (or a legacy row with no space) read or feed it; pair and group conversations skip both.
- **Drop happened last.** The thread tables (`threads`, `thread_messages`, `thread_reads`) and the legacy thread columns were dropped by the contract migration `supabase/migrations/20261003100000_conversation_unify_contract.sql` (#776), which first proves every old row has its unified twin and raises otherwise; it is applied to production with every precondition passing.

## HLD

One store with API contracts unchanged; memory and shared-mode behavior keyed by `space.kind`.

```mermaid
flowchart LR
  subgraph Clients["Clients (unchanged)"]
    WEB[ui-v2 General chat]
    SPC[ui-v2 Space thread panel]
    DEV[Cardputer]
  end
  subgraph API["API contracts (unchanged)"]
    CHAT["/api/chat + /api/conversations/*"]
    THR["/api/threads/* adapter<br/>thread = shared-space conversation"]
    INV["/api/threads/:id/invocations"]
    WS["/v2/cardputer<br/>cnv_ / thr_ refs"]
  end
  WEB --> CHAT
  SPC --> THR
  SPC --> INV
  DEV --> WS
  CHAT --> STORE[conversations store<br/>store.ts, messages.ts, thread-*.ts]
  THR --> STORE
  INV --> STORE
  WS --> PERSIST[cardputer-conversation.ts<br/>one persistDeviceTurn] --> STORE
  STORE --> DB[(conversations / messages / message_versions<br/>RLS: is_space_member)]
  STORE --> MODE{getConversationScope<br/>space.kind}
  MODE -->|private| MEM[memory read + extraction<br/>self-space memories]
  MODE -->|pair / group| SHARED[shared mode:<br/>member fan-out, invocation claim,<br/>no personal memory]
  PTR[(user_state<br/>active_conversation_id)] --- DB
```

## LLD

One `conversations` table with a space key; messages and versions carry `space_id` for RLS and `author_user_id` for attribution. `space_id` stays nullable on conversations, messages, versions and memories (every product insert supplies one; the owner kept it nullable, since NOT NULL broke 83 tests and no product path needs it; tightening it is a possible later step).

```mermaid
erDiagram
  SPACES ||--o{ SPACE_MEMBERSHIPS : has
  SPACES ||--o{ CONVERSATIONS : contains
  CONVERSATIONS ||--o{ MESSAGES : has
  MESSAGES ||--o{ MESSAGE_VERSIONS : has
  CONVERSATIONS ||--o{ CONVERSATION_READS : tracks
  CONVERSATIONS ||--o{ AI_INVOCATIONS : runs
  MESSAGES |o--o{ AI_INVOCATIONS : result
  USERS ||--|| USER_STATE : points
  USER_STATE |o--o| CONVERSATIONS : active_conversation_id
  SPACES ||--o{ MEMORIES : scopes
  CONVERSATIONS ||--o{ MEMORIES : source
  CONVERSATIONS ||--o{ GAME_SESSIONS : has
  CONVERSATIONS {
    text id PK "cnv_... private, uuid shared (kept)"
    uuid space_id FK "default: self space"
    uuid created_by FK
    text title
    int last_sequence
    timestamptz pinned_at
    timestamptz archived_at
  }
  MESSAGES {
    text id PK "ids kept on backfill"
    text conversation_id FK
    uuid space_id FK "composite FK with conversation"
    text role "user|assistant (actor kind)"
    uuid author_user_id "null = assistant"
    uuid device_id FK
    text origin
    int sequence "unique per conversation"
    int revision "thread API concurrency"
    text client_message_id "unique per author"
    text reply_to_message_id
    timestamptz tombstoned_at
    uuid tombstoned_by
    timestamptz updated_at "bumped on edit and tombstone"
    bool interrupted
    timestamptz memory_extracted_at
  }
  MESSAGE_VERSIONS {
    text id PK "backfill: ver_ + message id"
    text message_id FK
    uuid space_id FK
    jsonb parts "thread body = one text part"
    int version_index
    bool is_selected
  }
  CONVERSATION_READS {
    text conversation_id FK
    uuid user_id FK
    int last_read_sequence "only moves forward"
    timestamptz updated_at
  }
  AI_INVOCATIONS {
    text conversation_id FK "NOT NULL, one running per conversation"
  }
  MEMORIES {
    uuid id PK
    uuid user_id FK
    uuid space_id FK "private space only"
    text conversation_id FK
  }
```

Unread for a thread is a COUNT of the conversation's non-tombstoned messages with `sequence` above the caller's `last_read_sequence` (`apps/api/src/conversations/thread-rows.ts`), not `last_sequence` minus the cursor. The pointer (`user_state.active_conversation_id`) is cleared for a shared space by the definer `bob_private.clear_active_conversation_in_space`.

## Consolidated tables (#757)

Six tables were folded into their owners (expand migrations `20261003110000`..`20261003160000`; a contract migration drops the old tables). No API change.

| Old table | New home |
| --- | --- |
| `active_conversations`, `active_spaces`, `game_settings` | `bob.user_state`, one row per user |
| `device_settings` | ten columns on `bob.devices` |
| `timers` | `bob.reminders` with `kind in ('reminder','timer','alarm')` |
| `email_effects` | `bob.outbox.email_sent_at` + `recipient_user_id` |

`action_items.memory_id` is unique (`action_items_memory_id_key`): an action item is one-to-one with its memory (the planned merge of the two was dropped).

```mermaid
erDiagram
  USERS ||--|| USER_STATE : has
  USERS ||--o{ DEVICES : owns
  USERS ||--o{ OUTBOX : "recipient_user_id"
  SPACES ||--o{ REMINDERS : contains
  SPACES |o--o{ USER_STATE : active_space_id
  CONVERSATIONS |o--o{ USER_STATE : active_conversation_id
  MEMORIES ||--o| ACTION_ITEMS : "memory_id unique"
  USER_STATE {
    uuid user_id PK
    text active_conversation_id FK "null = no pointer"
    text conversation_surface "web_text|web_voice|device|picker|activate"
    timestamptz conversation_changed_at
    uuid active_space_id FK "trigger: caller must be a member"
    text space_surface "web|device"
    timestamptz space_changed_at
    bool games_enabled "games_* = parental controls"
    bool games_kids_mode
    text games_max_band "little|kid|grown"
    text_array games_allowed_games
    int games_daily_limit_minutes
    text games_quiet_start "HH:MM, set with games_quiet_end"
    text games_quiet_end
    timestamptz games_updated_at
  }
  DEVICES {
    uuid id PK
    smallint volume "0..10"
    bool muted
    text mode "ptt|wake|announce_only"
    bool dnd
    bool pending_push
    bool device_reported
    smallint ring_seconds "10..120"
    text ring_sound "classic|chime|pulse"
    bool ring_reported
    timestamptz settings_updated_at "null = no stored settings"
  }
  REMINDERS {
    uuid id PK
    text kind "reminder|timer|alarm"
    text title "null allowed for timer/alarm"
    timestamptz due_at
    bigint duration_ms "timer/alarm only"
    timestamptz fired_at "timer/alarm only"
    text status "reminder: active|paused|cancelled; timer/alarm: pending|fired|dismissed|cancelled"
  }
  OUTBOX {
    text effect_key
    timestamptz email_sent_at "email exactly-once marker, set before the ack"
    uuid recipient_user_id FK "cascade on user delete"
  }
  ACTION_ITEMS {
    uuid memory_id FK "unique"
  }
```

- **`user_state`:** a row appears with the first pointer or settings write. A null `games_updated_at` means no saved game settings (the `games_*` defaults stand), so a row can exist for the pointers alone. Changing `active_space_id` fires a trigger (`user_state_check_space`) that requires the caller to be a member of the new space.
- **`devices` settings:** a null `settings_updated_at` means no settings were stored, so the defaults stand. Erasure resets the ten columns on the kept, revoked device rows.
- **`reminders` kinds:** timers and alarms live in the owner's private space. Every reminder read filters `kind = 'reminder'`. Two consumers share the table: the timer scheduler (API process, `bob_private.timers_due`) reads `kind <> 'reminder'`; the reminder fanout (outbox runner, `reminder_fanout_sources`) reads `kind = 'reminder'`.
- **`outbox.email_sent_at`:** set when the email is handed to the provider, before the ack, so it is not `delivered_at`. Outbox pruning must keep rows where it is set.

## API adapter mapping

How the thread contract (unchanged) maps to the unified store.

```mermaid
flowchart LR
  subgraph Contract["/api/threads contract (unchanged)"]
    T1[thread.id uuid]
    T2[thread.space_id]
    T3[message.body]
    T4[message.revision]
    T5[message.sequence]
    T6[author_user_id null = Bob]
    T7[unread count]
    T8[device ref thr_uuid]
  end
  subgraph Store["Unified store"]
    S1[conversations.id]
    S2[conversations.space_id, kind != private]
    S3[selected message_versions.parts text]
    S4[messages.revision]
    S5[messages.sequence]
    S6[messages.author_user_id]
    S7[COUNT live messages after conversation_reads cursor]
    S8[ref prefix from space.kind]
  end
  T1 --- S1
  T2 --- S2
  T3 --- S3
  T4 --- S4
  T5 --- S5
  T6 --- S6
  T7 --- S7
  T8 --- S8
```

## Device and web persistence

Turn flow for both clients after the unified store is live.

```mermaid
sequenceDiagram
  participant C as Client (device or web)
  participant P as persist / chat / threads handler
  participant S as conversations store
  participant DB as Postgres (RLS)
  participant M as memory worker
  participant E as account/space events
  C->>P: turn or post (unchanged contract)
  P->>S: resolveConversation(ref or id, default self space)
  S->>DB: select conversation + space.kind (is_space_member)
  P->>S: appendMessage(user actor, client_message_id)
  S->>DB: insert messages + message_versions (sequence = last_sequence+1)
  P->>S: appendMessage(assistant actor) / addReplyVersion
  alt space.kind = private
    P->>M: enqueue extraction (speaker)
    P->>E: active.changed, message.appended (account)
  else pair / group
    P->>E: thread.message_appended to every member
    Note over P,M: personal memory not read or extracted
  end
```

## Migration flow

Expand, backfill, switch, gate memory, retire. Each box names its migration. 

```mermaid
flowchart TD
  Z[PR0 contract snapshot tests + data-model docs] --> A[PR1 expand: columns, conversation_reads, memories.space_id<br/>20261001100000 / 100100 / 100200]
  A --> B[Backfill: conversations.space_id = self space<br/>threads to conversations, thread_messages to messages + versions, ids kept]
  B --> C[Verify: counts, ordering, authorship, RLS isolation tests]
  C --> D[PR2 store switch behind unchanged routes<br/>20261002100000 + bob_private.unify_catch_up, 20261002140000]
  D --> E[PR3 one persistDeviceTurn, pointer = conversation_id<br/>20261002150000]
  E --> F[PR4 memory gate by space.kind<br/>20261002130000]
  F --> G[Stage A: notification prefs and invocations keyed on conversation_id,<br/>orphans deleted: 20261002160000 / 170000 / 180000]
  G --> H[PR5 retire: 20261003100000 contract<br/>prove twins, drop thread tables, pointer + invocation thread cols,<br/>notification_preferences.thread_id, unify_catch_up]
```

## History (before #756)

Two parallel schemas branched the device voice pipeline and duplicated persistence, edit and search logic: `conversations`/`messages`/`message_versions` for General chats and `threads`/`thread_messages`/`thread_reads` for shared spaces. `active_conversations` (since #757 the `user_state` row) held either a `conversation_id` or a `thread_id` + `thread_space_id` pair, the device turn chose its save path by the ref prefix, and threads never fed memory.

```mermaid
flowchart LR
  WEB[ui-v2 General chat] -->|POST /api/chat| CSTORE[(conversations / messages / message_versions)]
  SPC[ui-v2 Space thread panel] -->|/api/threads/*| TSTORE[(threads / thread_messages / thread_reads)]
  DEV[Cardputer] --> PERSIST{pointer is thr_ or cnv_?}
  PERSIST -->|cnv_| CSTORE
  PERSIST -->|thr_| TSTORE
  CSTORE --> MEM[memory extraction]
  PTR[(active_conversations, now user_state<br/>conversation_id OR thread_id)] --- CSTORE
  PTR --- TSTORE
```
