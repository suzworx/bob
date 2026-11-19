# Web UI end-to-end tests (Playwright, #550)

The suite drives the real web app (`apps/ui-v2`) in a browser against the local
`dev:offline` stack: local Supabase, and a sign-in code minted by
`scripts/dev-offline.mjs --code` for the run's own new account (see "Every
spec seeds what it reads"). Specs live in `apps/ui-v2/e2e/*.e2e.ts`. The
suffix is not `.spec.ts` because vitest would collect those files.

| Command | What | AI | Cost |
|---|---|---|---|
| `npm run test:e2e` | every spec, both widths | scripted stub (`BOB_AI_STUB=scripted`) | free, deterministic |
| `npm run test:e2e:smoke` | `@smoke` only: sign-in, chat reply, calendar loads | scripted stub | free, about 1 minute |
| `npm run test:e2e:live` | every spec | real AI Gateway (`AI_GATEWAY_API_KEY`) | **paid**: each chat turn is a model call, capped at `BOB_E2E_LIVE_MAX_TURNS` (default 8) per run |

Extra arguments go to Playwright, for example `npm run test:e2e -- --list`,
`npm run test:e2e -- --grep @a11y`, or `npm run test:e2e -- --project=mobile-390`.

## Flows (each at 1280 px and 390 px)

| Spec | Flow |
|---|---|
| `auth.setup.ts`, `sign-in.e2e.ts` | sign in with a minted code `@smoke`; a wrong code is refused |
| `chat.e2e.ts` | new chat and a reply `@smoke` |
| `calendar.e2e.ts` | calendar loads `@smoke`; reminder create (tomorrow 09:00), snooze 1 hour, cancel; running timer counts down, then cancel |
| `memory.e2e.ts` | filter; 'Make it a task' only on the action item |
| `cardputer.e2e.ts` | 'Use on Cardputer' answers "No Cardputer is connected." |
| `thread-pointer.e2e.ts` | a fake Cardputer and two tabs: 'Use on Cardputer' on a space thread, a voice turn shown live in both tabs, the device's picker, archive falls back to a new General conversation (#565) |
| `task-chip.e2e.ts` | a reply that creates a task shows its chip; the chip opens the tasks |
| `riddles.e2e.ts` | start Animal Riddles from chat |
| `a11y.e2e.ts` `@a11y` | axe scan (WCAG 2.x A/AA) of sign-in, chat, calendar, memory and devices; any serious or critical violation fails (#522) |

## Structure

- `pages/` holds one page object per page: `SignInPage`, `ChatPage`,
  `CalendarPage`, `MemoryPage`, `DevicesPage` and `ThreadPage` (a space
  thread, its menus and archive). `DevicesPage` also owns the
  'Use on Cardputer' conversation action.
- `components/side-nav.ts` opens the phone-width drawer before any navigation.
- Locators live only in these classes. Specs get the page objects as
  fixtures (`fixtures.ts`) and keep every assertion.
- `fixtures.ts` also provides:
  - `tag`: a per-test marker;
  - `api`: the REST API as the run's account;
  - `seed`: test data with its undo (see below);
  - `cleanup`: undo steps;
  - `makeAxeBuilder` and `expectNoSeriousA11yViolations`.

## The scripted stub (stub mode)

`BOB_AI_STUB=scripted` turns on the AI stubs. It also makes the web chat
route (`apps/api/src/web-chat.ts`) run the real turn: store, tools and
persistence are all real, but the model is the scripted stub in
`apps/ai/src/stub-agent.ts`.

The script maps a few fixed `e2e ...` sentences to one fixed tool call each:

- `e2e add a task called <title>` calls `create_task`.
- `e2e start a <n> minute timer called <label>` calls `set_timer`.
- `e2e play animal riddles as <name>` calls `start_game`.

Any other text gets `System test response: <text>`.

It is test infrastructure, never product behaviour:

- `scriptedStubAllowed()` in `apps/ai/src/config.ts` is false under
  `BOB_PRODUCTION=1`, whatever else is set.
- `BOB_AI_STUB=1` and `BOB_SYSTEM_TEST=1` keep the canned, store-free
  reply, as before.

## Two ways to run

**Started (default).** The suite starts its own stack on ports that never
collide with the everyday dev server:

- `e2e/start-stack.ts` runs the API on **:7454** (`BOB_E2E_API_PORT`) with
  dev:offline's own helpers. It refuses a non-loopback Supabase, and it applies
  the `bob_server` password (creating it on first use, as in CI) and the dev
  user.
- `e2e/vite.e2e.config.ts` serves the web app on **:5183**
  (`BOB_E2E_WEB_PORT`). It proxies `/api` to :7454, because the base vite
  config always proxies to :7444.

It differs from dev:offline in two ways:

1. It starts no second web server.
2. A local database that is ahead of this checkout is a warning, not a stop.
   `supabase migration up` reports `LegacyMigrationMissingLocalError` when
   another worktree applied a newer migration.

The suite's API also gets a high `BOB_RATE_LIMIT_API_RPM`, because every call
comes from one loopback IP. Locally, servers that are already up on those
ports are reused.

**Found.** `BOB_E2E_BASE_URL=http://localhost:5173 npm run test:e2e` runs
against a stack that is already running, and starts nothing. In this mode:

- Start that stack with `BOB_AI_STUB=scripted` for stub runs.
- The rate limit is that stack's own.
- The Cardputer spec skips itself if a real device is connected.

## The fake Cardputer

`e2e/support/fake-cardputer.ts` is a Node WebSocket client that plays a
Cardputer against the suite's own API (`BOB_E2E_API_PORT`, never 7444). It
uses the wire contract in `apps/api/src/schemas.ts` directly: its OLX2 codec
builds the uplink audio, and every frame the server sends is checked against
its DTO schemas (`violations` lists any that fail).

- `pairFakeCardputer(port, approve)` pairs the way a real device does: hello,
  `pair_request`, then `approve(userCode)` calls `POST /api/pair/lookup` and
  `/api/pair/approve` as the account. It returns the `olxd_` token.
- `FakeCardputer.connect(port, token)` then `hello()` gives a paired session.
  `send(type, payload)`, `waitFor(type, match, since)` and `mark()` drive and
  read it; `voiceTurn()` runs one push-to-talk turn to `playback_end`.
- The stub STT always hears `system test transcript`, and the stub agent
  answers `System test response: ...`. No provider is called.

Use it when a spec needs a connected device: pointer moves, the device picker,
device turns showing up on the web. `thread-pointer.e2e.ts` pairs once per
worker (`pair_request` is rate limited to 5 a minute) and revokes the device
when the worker ends. It skips on a found stack, because that stack may have a
real Cardputer.

Two tabs only hear live updates once their `/api/events` stream is up. Through
the suite's proxy, that stream's headers only arrive with its first event. So
before anything moves, the spec sends an account event until both tabs have
answered (`ThreadPage.eventsLive`).

## Browsers and artifacts

- Locally the suite uses the installed Microsoft Edge (`channel: msedge`).
  There is no `playwright install`.
- In CI (`CI` is set) it uses Chromium, with the `github` reporter.
- Output goes under the git-ignored `data/e2e/`:
  - `report/`: the HTML report.
  - `test-results/`: a screenshot, a trace and `error-context.md` for each
    failure.
  - `auth/`: the saved session.

## Every spec seeds what it reads

Each run signs in as a brand-new account of its own, so no spec can pass on
data that some earlier run, or the developer, left behind (#561 did exactly
that).

- `e2e/global-setup.ts` makes the account `e2e-run-<time>-<hex>@bob.local`
  through dev:offline's own `ensureDevUser` on the local auth admin API, and
  writes its email to `data/e2e/auth/run-account.json`. `auth.setup.ts` and
  `mintSignInCode()` sign in as it. `dev@bob.local` is never used.
- `fresh-state.e2e.ts` runs once, after sign-in and before every other spec
  (its own project). It fails if the account has any memory, conversation or
  Space, or if the memory page is not empty. Signing in makes no Space.
- A spec that reads data makes it first with the `seed` fixture, which also
  registers the undo: `seed.memory(content, kind)`, `seed.space()` (the
  private Space, made by one chat turn whose conversation is then deleted, as
  the product does) and `seed.timer(label, minutes)` (local SQL: no API makes
  a timer).
  `a11y.e2e.ts` (memory scan), `memory.e2e.ts` and `calendar.e2e.ts` use it.
- At teardown the account is left behind, isolated: nothing signs in as it
  again, and `auth.users` rows that own tasks or notes cannot be deleted. Each
  local run adds one throwaway user.

`npm run test:e2e` twice in a row must pass both times.

## Data and cleanup

All specs sign in as the run's account and run one at a time. The suite never
touches a hosted project.

Every fixture carries a per-test tag (`e2e-xxxxxxxx`) and is undone through
`cleanup`, even on failure. A failing undo fails the test. What happens to each
fixture:

| Fixture | Cleanup |
|---|---|
| Memories and conversations | deleted (a game session goes with its conversation) |
| Timers | rows deleted |
| Tasks | trashed (the API's delete) |
| Reminders | cancelled (the API has no delete) |

## CI

The `e2e` job in `.github/workflows/ci.yml` does the following:

1. Starts the full local Supabase stack.
2. Installs Chromium.
3. Runs `npm run test:e2e` in stub mode.
4. Uploads `data/e2e/report/` unless the run was cancelled, and
   `data/e2e/test-results/` (traces and screenshots) on failure.

It is not part of `validate` and not a required check yet. Once it has run
green for a while, add it to the required checks.

## CI viewport isolation

CI runs `desktop-1280` and `mobile-390` concurrently on separate runners.
Each runner starts its own full local Supabase stack and API, creates its own
account, and runs the existing `setup` and `fresh-state` project dependencies.
Tests within each viewport still use one worker: the shared account must not
be mutated concurrently. Local `npm run test:e2e` still runs both viewports.
No tests, retries or assertions are removed.

The stable `e2e` check succeeds only when every required viewport passes. It
accepts skipped browser jobs only when successful scope detection says neither
web nor server changed. A failed or cancelled lane fails the aggregate; the
other lane continues to preserve diagnostics. Reports and failure traces use
viewport-specific artifact names.

Baseline: CI run `39043148350` took 13m57s for e2e (10m32s tests, 2m22s
Supabase startup, 34s Chromium install, 11s npm install). Parallel viewports
reduce the serial test portion but repeat setup and consume more runner time.
Measure the two lane completion times and queue delay on the PR before claiming
wall-clock savings; this is not a 100x speed claim.
