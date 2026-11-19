# Integration suite (#551)

`npm run test:integration --workspace @bob/api` boots the real server
(`createV2Server`) on a free loopback port and drives it the way the apps do:
web chat and the web routes over HTTP, a simulated Cardputer over the device
WebSocket. It asserts database rows, wire frames and journal events (ids and
counts only). It needs no network and no model keys.

- Config: `apps/api/vitest.integration.config.ts`. Files end in
  `.integration.ts`, so the default `npm test` run (which matches `*.test.ts`)
  never runs them twice.
- Harness: `apps/api/tests/integration-helpers.ts` (`bootIntegrationServer`,
  `connectDevice`, journal helpers). The device is `tests/helpers/sim-device.ts`,
  the in-process form of `scripts/simulate-device.mjs`.
- Database: the per-file Postgres copy from `tests/support/test-db.ts` on the
  local Supabase stack (the same database the default suite uses). Start it once
  with `npx supabase start` first.
- AI: `BOB_AI_STUB=1` (canned transcript, test-tone TTS, fixed agent reply).
  `BOB_SYSTEM_TEST=1` is also set, only for the loopback `/api/test-token`
  issuer the web routes verify against. Without it the only verifier is
  Supabase's JWKS, which needs the network.
- Scripted AI: `tool-flows.integration.ts` switches its own worker to
  `BOB_AI_STUB=scripted` after boot: the web chat then answers from the
  scripted stub model (`apps/ai/src/stub-agent.ts`), which turns a fixed
  `e2e ...` sentence into one fixed tool call and runs the real turn around it.
  It is test infrastructure and cannot be built under `BOB_PRODUCTION=1`.

## Flows

| File | Flow | Deliberate break that makes it fail |
| --- | --- | --- |
| `web-chat.integration.ts` | `POST /api/chat` streams the stub reply; no token is a 401. `create_task`, `create_reminder` and `set_timer` from the tool set a web turn binds write rows that `/api/spaces/:id/tasks`, `/api/spaces/:id/reminders` and `/api/timers` return; the task and reminder outputs carry the link (`spaceId`, id, title) | `bindPrivateCallbacks.createTask` returns no `spaceId` (the #517 link): the task test fails |
| `device.integration.ts` | hello/welcome; a voice turn streams MP3 and the web reads the stored user and assistant messages back; `timers_state` is pushed when a timer is set and again at the next welcome; `active_conversation` is pushed when the web activates a conversation | `timersChanged` skips `pushTimersState`: the timers test times out. `DeviceSessions` ignores `active.changed`: the active test times out |
| `announce.integration.ts` | the scheduler fires a 1 s timer, the device gets `announce` (ring), acks it, the outbox empties; the reminder fan-out writes one inbox row, announces it (spoken), the ack clears it, and a second tick writes no second row | `announce_ack` acks the wrong id: both tests fail. The fan-out skips `announce`: the reminder test times out |
| `tool-flows.integration.ts` | Through `POST /api/chat` on the scripted stub: a task, a reminder and a timer sentence each make the real tool call. Asserts one DB row per item, the stored reply's tool part carries the chip link (`spaceId` + `taskId`/`reminderId`, the rule of `toResourceRef` in `apps/ui-v2/src/tool-calls.ts`, #544), and for the timer a connected device gets `timers_state` with its id | `createTask` returns an id without calling `storeCreateTask`: the task test fails (row count 0). The reminder output drops `spaceId`: the reminder test fails (no chip link). `timersChanged` skips `pushTimersState`: the timer test times out |

Each break was a one-line edit to `apps/api/src`, run against its flow, then
reverted; `git diff -- apps/api/src` was empty afterwards.

## CI

The `integration` job in `.github/workflows/ci.yml` runs this suite on every
change in the `server` scope. It follows the `db` job's shape with the `server`
job's slim stack: this suite talks only to Postgres on :54322, and kong stays
because `db-harness.ts` needs `supabase status` to report API_URL. It sets
`BOB_AI_STUB=scripted`, needs no secrets and no model keys, and is not a
required check yet.

`accept:replay` stays the live-model gate.
