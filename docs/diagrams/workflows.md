# Workflow sequence diagrams

Sequence diagrams for the flows that matter. Each is a separate diagram. Names
and messages are the real wire/event names from the code (`schemas.ts`,
`turn.ts`, `web-chat.ts`, `web-voice.ts`, `session.ts`, `pairing.ts`,
`state.cpp`).

## Device voice turn (OLX2 over WebSocket)

A push-to-talk turn. The device is already paired and welcomed.

```mermaid
sequenceDiagram
    participant D as Cardputer
    participant S as Server (session.ts / turn.ts)
    participant AI as @bob/ai agent
    participant STT as Gateway STT
    participant TTS as Gateway TTS

    D->>S: hello { format_id }
    S-->>D: welcome { protocol, format_id, session_id, device, active_conversation }
    D->>S: turn_start { turn_ref }
    S-->>D: (session.stage = capturing)
    loop each 10 ms PCM block
        D->>S: OLX2 audio_up (magic OLX2, kind=1, format, turn_handle, seq, payload)
        S-->>D: ack { turn_ref, credit_bytes }
    end
    D->>S: turn_end { turn_ref, seq }
    S-->>D: status { stage: thinking }
    S->>STT: transcribePcm (assemblePcm16 of chunks)
    STT-->>S: transcript
    S->>AI: agent.generate({ messages })
    AI-->>S: reply text
    S->>TTS: synthesizeMp3 / synthesizePcm
    TTS-->>S: speech audio
    S-->>D: status { stage: speaking }
    S-->>D: playback_start { turn_ref }
    loop downlink frames
        S-->>D: OLX2 audio_down (kind=2, turn_handle, seq, payload)
    end
    S-->>D: playback_end { turn_ref }
    S-->>D: status { stage: idle }
    S-->>S: persistDeviceTurn reads getConversationScope(pointer)
    alt space kind is pair or group
        S-->>S: saveSharedTurn (falls back to a new private conversation if the thread is lost)
    else private (General) or none
        S-->>S: private save into the same conversations store
    end
    S-->>S: resetSession
```

## Device thread pointer (#565)

The device points at a space thread from its picker or from the web. The wire is unchanged: the
thread travels as the conversation id `thr_<uuid>`. Since #756 a thread is a conversation in a pair or
group space and `bob.user_state` stores only its id (`active_conversation_id`); the shared behaviour
below keys off that conversation's space kind, not the `thr_` prefix.

```mermaid
sequenceDiagram
    participant D as Cardputer
    participant S as Server (session.ts / turn.ts)
    participant DB as Supabase Postgres
    participant W as Space members' web tabs

    D->>S: list_conversations
    S->>DB: getActiveSpace + listThreads (up to 5) + getActive + listConversations
    S-->>D: conversations [thr_ threads, then General, at most 10]
    D->>S: select_conversation { conversation_id: thr_uuid }
    S->>DB: one tx: getThread + setActiveSpace('device') + setActive('picker')
    S-->>W: active_space.changed + active.changed (the account's own tabs)
    S-->>D: conversation_selected { conversation_id, title }
    Note over D,S: a voice turn runs as usual, in SHARED mode (no memory, no game)
    S->>DB: postMessage (client_message_id device:session:turn_ref)
    S->>DB: claimInvocation + postAssistantMessage + setInvocationState(completed)
    S-->>W: thread.message_appended { thread_id, space_id, message_id, sequence }
    W->>W: bob:thread-message, refetch the thread
```

From the web, `PUT /api/devices/active-conversation { conversation_id: null, space_id, thread_id }`
makes the same two writes in one transaction. Archiving the space, leaving it, being removed, or
moving the active space elsewhere clears the thread pointer and publishes `active.changed` with
both fields null.

## Web text turn through `/api/chat` (with persistence)

```mermaid
sequenceDiagram
    participant B as Browser (useChat)
    participant S as API server (web-chat.ts)
    participant DB as Supabase Postgres
    participant AI as @bob/ai agent

    B->>S: POST /api/chat (Bearer JWT, { id?, message, regenerate? })
    S->>DB: getConversation / createConversation (new) + setActive('web_text')
    S->>DB: appendMessage(user message) + setActive
    S-->>DB: publish account events (message.appended / active.changed)
    S->>AI: createAgentUIStreamResponse(agent, uiMessages)
    AI-->>S: UI message stream (text-delta …)
    S-->>B: 200 SSE UI-message stream
    S->>DB: addReplyVersion(assistant parts) in same tx
    S-->>DB: publish events
    S-->>S: memoryWorker.enqueue(userId)
```

- A new conversation derives its title from the opening text (`deriveTitle`),
  writes the follow-me pointer in the **same transaction**, and returns
  `conversationId`/`title` via message metadata.
- Regenerate / edit-from resend reuse ids to avoid duplicated replies;
  `truncateAfterMessage` handles edits.

## Web voice turn

```mermaid
sequenceDiagram
    participant B as Browser (useVoice / VAD)
    participant S as API server
    participant STT as Gateway STT
    participant TTS as Gateway TTS

    B->>B: MediaRecorder capture (push-to-talk or VAD hands-free)
    B->>S: POST /api/voice { audio (base64 WAV/WebM), format }
    S->>STT: transcribeAudio
    STT-->>S: text
    S-->>S: noteAcceptedVoiceTurn → setActive('web_voice')
    S-->>B: 200 { text }
    B->>S: POST /api/chat { message: transcript, origin voice }
    S-->>B: UI message stream (reply)
    B->>S: POST /api/speech { text } (when reply should be spoken)
    S->>TTS: synthesizeSpeech (mp3)
    TTS-->>S: audio
    S-->>B: 200 audio/mpeg
    B-->>B: AudioPlayer autoplay
```

## Device pairing

```mermaid
sequenceDiagram
    participant D as Cardputer
    participant S as API server (device-auth / pairing)
    participant W as Web app (PairPage)
    participant DB as Supabase Postgres

    D->>S: ws:// /v2/cardputer (Authorization: Bearer olxd_)
    S-->>D: pairing_required { reason: none|unknown|revoked } (unpaired)
    D->>S: pair_request { model, fw_version, claim, resume? }
    S-->>D: pair_code { pairing_id, user_code, verification_uri, expires_in: 600 }
    D-->>W: (user reads XXXX-XXXX code off the device screen)
    W->>S: POST /api/pair/lookup { user_code }
    S-->>W: { pairing_id, device_model, … }
    W->>S: POST /api/pair/approve { pairing_id, name } (requireActiveSession)
    S->>DB: mint olxd_ token, insert device row
    S-->>D: paired { device_id, device_token olxd_…, name }
    D-->>D: saveDeviceToken(NVS)
    D-->>D: network.start() to reconnect (no reboot)
    D->>S: reconnect with stored token → welcome (device kind)

    Note over W,S: Revoke
    W->>S: DELETE /api/devices/:id (requireActiveSession)
    S->>DB: bob_private.revoke_device (keep row, set revoked_at)
    S-->>D: close WS code 4003
    D->>S: reconnect with stored token → pairing_required { reason: revoked }
    D-->>D: eraseDeviceToken(NVS)
```

## Cross-session memory

Extraction after a turn, then retrieval + `[BOB MEMORY]` injection on a
later turn.

```mermaid
sequenceDiagram
    participant T as turn (turn.ts / web-chat.ts)
    participant W as MemoryExtractionWorker (memory/extract.ts)
    participant DB as Supabase Postgres
    participant Emb as Gateway embedder
    participant AI as createBobAgent

    T->>DB: persist user+assistant turn
    T->>W: memoryWorker.enqueue(userId) (debounced, off the reply path)
    W->>DB: listUnextracted
    W->>Emb: embed(userText)
    Emb-->>W: vector
    W->>DB: matchMemories (hybrid, top-5 similar)
    W->>W: extractor(userText, assistantText, existing)
    W->>Emb: embedMany(op contents)
    W->>DB: applyExtractionOps (add/update/supersede/noop) + mark memory_extracted_at

    Note over T,AI: Next turn
    T->>Emb: startMemoryRetrieval → embed(query) (overlaps history load)
    Emb-->>T: vector (or timeout → full-text+recency degrade)
    T->>DB: matchMemories + listDueSoon
    T-->>T: buildMemoryBlock → [BOB MEMORY …] block (or null)
    T->>AI: createBobAgent({ memoryContext: block, memoryTools: createMemoryTools(…) })
    AI-->>T: reply (memory tools remember/forget/list_actions/complete_action available)
```

The memory block is a **system** section (never a user message), sanitized and
delimited; retrieval failures/timeouts omit the block rather than fail or
delay the turn.

Both halves run only in a private space (#756): the web chat and the device turn read the
conversation's `getConversationScope` and skip retrieval and enqueueing unless
`allowsPersonalMemory(spaceKind)`. The worker checks again: `listUnextracted` selects private
conversations only, and a turn from a pair or group space is marked done with no ops and journaled
`v2.memory_skipped { reason: shared_space }`.

## Sign-in

```mermaid
sequenceDiagram
    participant B as Browser (SignIn)
    participant S as API server
    participant Supa as Supabase Auth

    B->>S: GET /api/public-config
    S-->>B: { supabaseUrl, supabasePublishableKey, pairingUrl, devSignIn }

    alt Emailed code path (Supabase configured)
        B->>Supa: signInWithOtp({ email, shouldCreateUser:false })
        Supa-->>B: emailed 6-digit code / magic link
        B->>Supa: verifyOtp({ email, token, type:'email' })
        Supa-->>B: session (JWT)
        B->>S: GET /api/chat … (Authorization: Bearer JWT)
        S-->>B: guarded reply
    else Loopback dev-token path (devSignIn true)
        B->>S: POST /api/test-token { userId }
        S-->>B: { token, expiresAt }
        B-->>B: store token, devSession snapshot
        B->>S: GET /api/chat … (Authorization: Bearer test token)
        S-->>B: guarded reply
    end
```

`devSignIn` is `true` only when the server binds a loopback host with
`BOB_SYSTEM_TEST=1`; `POST /api/test-token` answers 404 otherwise.