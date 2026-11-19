# Escaped defects: why a green validate missed them

Baseline: `npm run validate` passed 12/12 on main2 8026995 (about 4,700 tests). Every defect below was found afterwards by a
read-only audit or by CI on main2. Owner rule (2026-09-27): each one is a test gap. Remedies are in
[test-strategy.md](test-strategy.md). The class letters below are used in both docs.

## Gap classes

| Class | Name | Short form |
|---|---|---|
| A | Double drift | A hand-written double of a third-party API matches our guess, not the library |
| B | Test config differs from prod | The test takes a path that production never takes (no store, no pairing), so a gate that only prod reaches is never run |
| C | Cross-version wire | Server and firmware are only tested at the same commit, never new against old |
| D | Unbounded input and growth | No bounds, time budget or growth test on route inputs, loops, fan-out or in-memory maps |
| E | Mode transitions | Only steady states are tested (active, none), not paused, resumed or quiet |
| F | One path guarded | A safety check runs on one write path or view but not on its siblings |
| G | Cross-member scope | Family and Space tests check one account, never "member B's data stays out" |
| H | Enumeration drift | A hand-kept list (export tables) falls behind the schema |
| I | Merge train | Each PR ran CI on an older main2; the combination was never tested |
| J | Stateful environment | A test passes on a dev DB that has data and fails on a fresh stack |
| K | Gate authoring | The brief's gate used the wrong runner or command |
| L | Real clock and zone | A test derives its dates from the real clock and the machine's time zone, so it passes or fails by the day and place it runs |
| M | End event, not outcome | A step waits for the event that ends a flow (`playback_completed`) and never checks the field that says whether it worked (`mp3_exit=eof`), so a failure that still ends cleanly passes |

## Defects

**1. `turn.ts:318` did not await `ToolLoopAgent.stream()`** (async in ai@7.0.71). Class A.
- Caught by: audit (L-109), after HIL and dev showed nothing (masked by #2).
- Missed because: `tests/voice/turn-streaming.test.ts` mocks `@bob/ai` with `stream: vi.fn()` returning a sync
  `{ stream, toolCalls, steps }` object. That is the shape we assumed. The `as unknown as AgentStreamResult` cast hid it
  from typecheck. 14 test files hand-roll `generate: vi.fn(` doubles; only 10 use `ai/test`.
- Regression test: `apps/api/tests/voice/turn-streaming-sdk.test.ts` ("streamAgent on a real ToolLoopAgent (#502)"). It runs a
  real `ToolLoopAgent` on `MockLanguageModelV4`, and covers errors, a cancelled turn and an error after audio started.

**2. Streaming skipped for every paired device turn** (`gameTurn === null` at turn.ts:759; `resolveGameScope` always
returns a turn state). Class B, and E.
- Caught by: audit, while it was looking into #1.
- Missed because: the streaming suite runs with no store (the in-memory fallback), so `memory === null` and the game scope
  is never resolved. Every paired production turn has a store. No test asserted "a paired turn with no game streams".
  This bug hid #1 from HIL too, so a real-path check could not find it.
- Regression test: STREAM-FIX adds `pairedSession(mode)` to `turn-streaming.test.ts`, with `resolveGameScope` mocked
  per mode (none, paused, active). The condition is now `!gameActive`.

**3. main2 firmware's hello `{format_id, fw_version, caps}` is refused by the production `.strict()` schema**
(origin/main schemas.ts:71), so the device retries forever. `BOB_MIN_FW_VERSION` also locked out firmware that sends no
version. Class C.
- Caught by: audit.
- Missed because: `apps/api/tests/voice/wire-fixtures.test.ts` and the firmware host tests share `test/fixtures/wire`, but both
  sides are checked at the same commit. Nothing ran the new firmware bytes against the deployed (origin/main) schema.
  The min-version test used the "invalid" sentinel, not an absent field.
- Regression tests: `schemas.test.ts` "strips unknown hello payload keys..."; `session.test.ts` "never gates an absent
  version"; host `test_hello_fallback.cpp` (6 cases, bare-hello fallback once per connection). There is still no
  old-vs-new test: the fix is a policy (`.strip()` plus a fallback), not a gate.

**4. `GET /api/reminders/preview` with a huge `from` blocks the event loop for tens of minutes** (recurrence.ts steps one
period at a time). Class D.
- Caught by: audit.
- Missed because: recurrence tests use realistic dates. Route tests check that bad input gets a 400, not how long valid but
  extreme input takes. Zod allowed any positive int.
- Regression tests: `core-recurrence.test.ts` "skipping ahead to the window (PREVIEW-BOUND)" (window equals the full
  expansion, far `from` on every frequency is fast); `web-reminders.test.ts` "refuses a due or from centuries away, fast".

**5. Games.** Classes E, F, D.
- Paused game keeps the kids filter and cue guard on for 24 h (E): tests covered active and none, not paused or resumed.
  Test: `games-scope.test.ts` "a paused game is not a game turn".
- Web guard only changed the stored copy while the raw text streamed (F): the guard was tested on the stored reply, and
  no test read the SSE bytes. Test: `web-chat-games.test.ts` "web game stream gate (finding 2)" (5 cases).
- The game's title counted as an off-script cue (F/E): cue tests used invented commands only. Test:
  `game-simon-says.test.ts` "a reply that only names the game is on script".
- Paused games stopped memory extraction (E): the extraction gate read `ended_at === null`. Test:
  `memory-extract-games.test.ts` (4 cases: in play, paused and quiet, idle past the window, ended).
- `recentlyEnded` grew forever (D): no test counts in-memory map size. Test: `game-tools.test.ts` "a write sweeps every
  entry older than the play_again window".

**6. Memory.** Class F.
- `remember` trusted the model's `sensitive` flag: `memory-tools.ts` runs `isSecretLike` but not `sensitiveCategory`. The
  extractor (`memory-extractor.ts` `filterOps`) runs both. Each path was tested alone against its own checks.
- Card numbers and SSNs pass `isSecretLike`: the pattern table has no PII rows, and there is no shared table of hostile
  samples run against every write path.
- Memory text is framed as system instructions: no prompt-layout test puts a hostile memory in the block.
- Regression tests: missing. There is no `fw/MEM-SAFE` ref in this repo yet.

**7. Timers.** Classes D, G, H.
- `pushTimersState` read every connected account on each change (D): the tests used one account. Test:
  `device-timers.test.ts` "with three connected accounts, one account's change reads and pushes only that account".
- Voice cancel-reminder with no id or text cancelled a family member's reminder (G): voice tests had one member.
  Tests: `voice-tools.test.ts` (ai) "requires an id or text"; api `voice-tools.test.ts` "reminders in a group Space
  are only those of the caller" and "a cancel naming nothing cancels nothing".
- The export missed game data (H): `web-export.ts` keeps its own list of tables. Test: `web-export.test.ts` "carries
  my game sessions, settings, usage and action-item status".

**8. A resumed game's device reply streamed past the kids filter and cue guard** (turn.ts `generateReply` set
`streamed = ... && !gameActive` before the model ran; LIVE in production). Class E, and F.
- Caught by: the #579 `TG-GAME-MODES` table (`game-modes.test.ts`, row `resumed`), which recorded the bug as
  `streamed: true`. The web path already held that row.
- Class of defect: a per-turn decision made before tool calls can change the turn's mode. A paused game is not `active`,
  so the turn streamed; when the model called `resume_game`, `openedHere` set the turn's `GameTurnState`, but the reply was
  already going to TTS sentence by sentence, so it was guarded only in the stored copy.
- Missed because: the table's audio mock had no `createReplySplitter`, so every streamed device turn failed inside the
  table unseen, and its `streamed` column only checked that `stream()` was called, not what the device heard.
- Fix: `streamAgent` takes a `hold()` read from `GameTurnState.gameTurn`. Once it is true nothing more reaches the device;
  the held rest is guarded and goes through the batch path, or joins the playback already started when text streamed
  before the game opened (one `playback_start`, one `playback_end`). Text after a tool call waits for the step's end.
- The other pre-model decisions in `generateReply` that read game state: the memory tools and the S3 capability tools
  (notes, timers, productivity, Space) offered to a paused or no-game turn. These now refuse (`{ refused: true, reason:
  'game_active' }`) once a game opens in the turn. The memory block already in the prompt cannot be taken back.
- Web side closed (GAME-TOOL-GATE-WEB): web chat (`web-chat.ts`) made the same pre-model tool choice. The gate is now one
  helper, `closedOnceGameOpens` in `core/game-tools.ts` beside `keepForActiveGame`, keyed on `GameTurnState` and shared
  by both surfaces; web chat applies it to its capability, late and memory tools in a paused or no-game turn.
- Regression tests: `game-modes.test.ts` row `resumed` (now `streamed: false`, `held: true`; `held` also reads every
  device TTS input). `turn-game-resume.test.ts` (5 cases on the real-SDK harness): kids filter and cue guard after
  `resume_game`, text before `resume_game` then the guarded rest in one playback, a memory tool refusing after the resume,
  and a non-game tool between sentences still streaming. `web-chat-game-resume.test.ts` (real-SDK harness): a web turn's
  memory tool refuses without running after `resume_game`, and still runs when no game opens. `game-tools.test.ts`: the
  helper's own cases.

**9. `calendar-page.test.tsx` failed on CI on the 29th of the month** (PR #637, both runs on 2026-09-29 UTC). Class L.
- Caught by: CI on #637 ("shows the empty state for a picked day with nothing due"); it passed the same day in
  America/Los_Angeles, where it was still the 28th.
- Missed because: every date key in the file came from `Date.now()` and the machine's zone at load time. The test
  clicked "the day after tomorrow", which on the 29th and 30th is in next month: the grid shows it as an outside day
  (`aria-disabled`), so the click did nothing and today stayed picked. #635 had already swapped in a two-days-back
  fallback, but it still ran on the real clock, so month edges were covered only on the days CI happened to run.
- Fix and regression test: one pinned instant for the whole file (`pinClock`: Date only, advancing with real time, so
  userEvent, waitFor and the timer countdown keep working). Every key comes from the component's own `localDayKey`,
  and a noon UTC instant keeps the day the same from UTC-11 to UTC+11. `describe.each` pins the 29th at 05:00Z (#637's
  instant), the last day and the first day of a month. The file passes under TZ=UTC, America/Los_Angeles and
  Pacific/Kiritimati. A past day's empty state renders correctly, so there was no product bug.
- Other tests that derive a calendar day from the real clock (not fixed here): `apps/ui-v2/src/lib/hooks/use-today.test.tsx`
  (`useDayItems(localDayKey(Date.now()))` at lines 55, 101 and 201; `Date.now()` day offsets at 133 and 216),
  `apps/ui-v2/src/message-view.test.tsx:63` ("09:05 today" from `new Date()`: before 09:05 it is in the future), and
  `apps/ui-v2/src/conversation-nav.test.tsx:13` (a module-load `Date.now()` bucketed under "Today", which flips at
  midnight).

**10. Archiving a thread left Cardputers pointing at it until their next turn** (`web-threads.ts` `DELETE
/api/threads/:id` never touched `bob.active_conversations`). Classes F and G.
- Caught by: the #565 e2e (T565-E2E) and the thread-pointer HIL run.
- Missed because: archiving or leaving a whole Space cleared the pointer and published `active.changed`, but the single
  thread path had no such step, and `getActive`'s stale check on the next turn masked it in every store test. No test
  archived a thread as one member and read another member's pointer.
- Fix (THREAD-ARCHIVE-CLEAR): `clearActiveThread` in `store/active-conversation.ts` shares its one UPDATE with
  `clearActiveThreadInSpace`. The archive route runs it as each member of the thread's space and publishes
  `active.changed` (both fields null) to each account it cleared. A failure is journaled, never fails the archive.
- Regression test: `apps/api/tests/conversations/thread-archive-pointer.test.ts`. Member A archives; member B's pointer is cleared
  and only B gets the event; a member on a General conversation is untouched.

**11. A new `/api/events` stream sent no body byte until the first event.** Class B.
- Caught by: the #565 e2e.
- Missed because: tests read the stream directly from the API. Behind a proxy (vite in e2e, possibly the production
  edge) the response is held until the first byte, so a tab opened just before a change missed it.
- Fixed by: SSE-FIRST-BYTE.

**12. The Cardputer sometimes played nothing: a reply fully buffered before the MP3 decoder began was dropped**
(`audio_playback.cpp` `finishStream()` called `RingBufferFileSource::close()`, which cleared `isOpen()`, and
ESP8266Audio's `begin()` refuses a closed source). Class M, and B.
- Caught by: HIL wake-followup step 22 on main3 b96921e (run 20260929-064635-40fc): `playback_ending frames=17` →
  `mp3_ring_ready avail=16416,eof=1` → `mp3_began ok=0` → `mp3_begin_failed` → `playback_completed mp3_exit=n/a`.
  `mp3_begin_failed` is in 9 earlier runs' `serial.log`; outside the stop scenarios' `playback_aborted` it always
  follows `playback_ending`, and no run has a successful begin with `eof=1`.
- Missed because: every other scenario's turn waited for a bare `playback_completed`, which a dropped reply also
  journals, so 9 runs of silent turns passed. The host tests never ran the ring source (it lived inside
  `audio_playback.cpp`). Production sends a whole reply in one burst (`BOB_STREAMING_REPLY=0`), the triggering order;
  HIL streams by default.
- Fix (MP3-BEGIN-RACE): playback_end now only marks end-of-data on the ring (`RingBufferFileSource::endOfData()`,
  called through `endMp3Stream()`); only abort and stop close the source. The ring and source moved unchanged to
  `apps/cardputer/src/mp3_ring_source.h` so the host tests run them.
- Regression tests: `apps/cardputer/test/host/test_mp3_ring_source.cpp` (the 40fc order: whole reply plus
  playback_end before begin; whole reply without the end; 4096 of 6144 bytes waiting for the rest; an abort still
  refuses begin). HIL `reply-burst` (`T server burst_next_reply` sends the reply in one burst), asserting
  `mp3_exit=eof` and no `mp3_begin_failed`.
- Other scenarios whose turns never asserted the reply played, now fixed in one place: `REPLY_PLAYED`
  (`scripts/hil/scenarios/steps.mjs`, `mp3_exit=eof`) is in `pttTurn()` and `wakeTurnToFollowUp()`, which covers
  ptt-turn, heap-floor, reply-card, stop-reply and stop-at-reply-start (their recovery turn), thread-pointer,
  wake-capture-rate and wake-followup-key. log-backpressure, thread-pointer (two more turns) and turn-long-sentence
  switched to it directly. Not changed: wake-detect-speaker, whose wait also accepts `wake_rejected` (no reply).
  `scenarios.test.mjs` now fails any `playback_completed` wait without `mp3_exit=`.

**13. PCM replies never played on the Cardputer** (issue #674; `audio_playback.cpp` `beginPlayback(kPcm16)` asked for
one internal block for the whole reply: `kPlaybackBufferBytes` 320 KB, then 160 KB). Class D, and B.
- Caught by: HIL pcm-reply (run 20260929-110910-342e, hello `format_id=1`): `playback_buffer_failed free=231320` →
  `playback_started format=1` → ~12 s of frames ignored → `playback_end` → READY, silent. The largest free block is
  159732 B in ptt, wake and announce_only (heap-per-mode), so both sizes fail on every boot, not only under pressure.
- Missed because: no scenario played PCM on a device. Every HIL turn negotiates MP3, the host tests never ran the PCM
  path (it lived inside `audio_playback.cpp`, calling M5 directly), and `memory-budget.json` noted the 160 KB fallback
  as "unverified on hardware". The size was only ever checked against total DRAM, never the largest block.
- Fix (PCM-BUFFER-674): PCM streams through `PcmRing` (`apps/cardputer/src/mp3_ring_source.h`): a 48 KB ring
  (`kPcmRingBufferBytes`, the MP3 ring's size), a 0.5 s prebuffer gate, and three 2048-sample speaker chunks fed only
  into a free `playRaw` slot. Overflow and underruns are counted on `playback_completed ... format=pcm16`. A reply of
  any length plays; allocation failure still logs `playback_buffer_failed` and ends at READY.
- Regression tests: `apps/cardputer/test/host/test_pcm_playback.cpp`: the old 320 KB and 160 KB blocks against the
  measured largest block; a 12 s (8x the ring) real-time-paced reply plays every sample in order with no drops or
  underruns; today's half-rate server pacing still plays every sample (with rebuffers); a reply shorter than the
  prebuffer plays at the end; an unpaced burst overflows, counted, no crash; a failed allocation plays nothing.
- Server side (same unit, c1): PCM went out at one 10 ms frame per 20 ms (`streamFrames(..., null)`), half real time,
  which only suited the whole-reply buffer; with the ring it rebuffered about every second. `playback.ts` now paces
  PCM through the MP3 ring model (`pacing.ts` `PCM_PACING`, 32000 B/s drain, 32 KB target of the 48 KB ring): 16 KB
  prime, model drains from the device's prebuffer gate, payload bytes only, and an 8 ms floor between frames for the
  device's 24-frame receive queue. `MAX_DOWNLINK_PCM_BYTES` is now a 60 s sanity cap, not a device buffer size.
  Test: `turn-stages.test.ts` "sends a 20 s reply at ~32000 B/s" replays the send times into the device ring (peak
  under 48 KB, never dry after the start, 32000 B/s +-2%).

**14. Creating a Pair space failed in prod: "That could not be created."** (2026-10-06; Postgres `new row violates
row-level security policy for table "spaces"`). Class B.
- Caught by: the owner, in the prod web app (New space -> Pair -> Create). Journal: `v2.web_error error="PostgresError"`.
- Missed because: `createSpace` inserted a pair with `owner_user_id` NULL under `withUser`, and `spaces_insert` requires
  `owner_user_id = auth.uid()`, so no pair could ever be created through RLS. No test created a pair through the app path:
  every `createSpace` call in the suites used `kind: 'group'`, and the isolation matrix seeded its pair as the database
  superuser (`seedPairSpace` in `apps/api/tests/db-harness.ts`), a path production never takes.
- Fix: spaces have no type (owner decision). Every create, including a legacy `kind: 'pair'`, is an owner-owned group.
- Regression tests: `store-spaces.test.ts` "createSpace(kind %s) under real RLS makes the caller its active owner" (no
  kind, group, pair); `web-spaces.test.ts` "POST /api/spaces %j creates a space the caller owns and can open";
  `apps/ui-v2/e2e/create-space.e2e.ts`.
- Class check: every other `withUser` INSERT into a table whose INSERT policy compares a column to `auth.uid()`
  (conversations, messages, message_versions, memories, action_items, notification_preferences, user_state, game_usage,
  publications `actor_user_id`) passes the `withUser` caller id for that column. The other inserts are gated on
  space membership instead. No other insert has this mistake.

**15. Every production turn-metric write failed** (`v2.turn_metric_failed` on 31/31 turns, 2026-10-06/07). Class B.
- Caught by: the #898 production RCA through the Railway journal, not by a test.
- Missed because: `createTurnMetricRecorder` bound `JSON.stringify(row)` to `$1::jsonb`. Under postgres.js with
  `prepare: true` the string is encoded again, so the function received a jsonb *string* and `jsonb_populate_record`
  failed with 22023. The unit tests mock the database, and the journal kept only the error name, so nothing showed the cause.
- Regression test: `apps/api/tests/platform/turn-metrics-recorder.db.test.ts` writes device, failed-STT and web rows
  through the real recorder against the local Supabase stack (red on the base tree with 22023). `v2.turn_metric_failed`
  now carries the SQLSTATE `code`.
- Same class still open: `conversations/messages.ts` and `thread-messages.ts` bind `JSON.stringify(...)` to `$4::jsonb`
  (masked on read by `DECODED_PARTS`); a shared jsonb parameter helper is the follow-up (#898).

**Bob Marketing first release, targeting and Retry (#1396).** Class E, and F.
- Caught by: post-release audit and browser replay, after 9,908 green tests and green Marketing journeys.
- Missed because: journeys walked the working order and re-chose New before each send, reads never failed, and pause was
  never followed by a reload. `ChatSurface` tests fixed the binding prop, and Retry was tested only after a stored turn.
- Regression tests: `apps/ui-v2/e2e/bob-apps-marketing.e2e.ts` (resume after reload, failed read, conflict, New after a
  failed turn), `apps/ui-v2/e2e/chat.e2e.ts` (Retry of an unstored message), `apps/api/tests/conversations/web-chat.test.ts`
  ("1396" cases, including other accounts' message ids).

## Earlier escapes this week

- **#542+#543** (typecheck; fixed in #547) and **#545+#546** (db erasure guard; fixed in #553): each PR was green on an
  older main2 and red together (L-96). Class I. No test was missing; the suite never ran on the merged tree before merge.
- **#561** e2e memory a11y spec needed memories to exist; the worker's DB had them, CI's fresh DB did not (L-100).
  Class J. Fixed by seeding (c3).
- **MIG-ORDER** brief gated scripts with `node --test`; the repo runs them with vitest, so the worker wrote a shim (L-105).
  Class K.
