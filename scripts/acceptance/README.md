# Acceptance replay (#459)

Unit tests and evals passed while the running app still saved reminders as
memories, claimed reminders it never saved, had no hourly repeat, hid timers and
told a vegetarian to have chicken. This gate replays real sentences through the
**running local app** and checks the **database**, not the reply.

```sh
npm run accept:replay                        # every scenario
npm run accept:replay -- --only timer-2min   # one scenario
npm run accept:replay -- --only reminder-hourly,diet-chicken --repeat 10 --why
                                             # each 10 times, fresh conversation each; pass counts per scenario
npm run accept:replay -- --keep              # leave the created rows for inspection
```

Needs the local stack: `npx supabase start`, and the dev server on
`http://localhost:7444` (`npm run dev`). The judge calls the AI Gateway, so
`AI_GATEWAY_API_KEY` must be set.

## What it does

1. Signs in as `dev@bob.local` (`BOB_DEV_EMAIL` overrides) on the LOCAL
   Supabase stack only (a non-loopback API is refused), the same way as
   `apps/api/scripts/perf-baseline.mjs --dev-sign-in`.
2. Sends each sentence in `scenarios.mjs` to `POST /api/chat` in a fresh
   conversation, waits `--settle-ms` (15 s) for the journal line and memory
   extraction, then reads the rows the account created since that scenario
   started (`supabase status` DB_URL, read under RLS as the account).
3. Checks them. `called_tool` reads the turn's `v2.turn_stage_agent_completed`
   line from `apps/api/data/v2-journal.log` of whichever worktree runs the
   server (`BOB_JOURNAL_PATH` overrides). `judge` scores the reply with
   `BOB_EVAL_JUDGE_MODEL` (default `openai/gpt-4o`), given the account's saved
   facts and preferences.
   `no_false_claim` asks the judge whether the reply claims a reminder was set,
   and fails only if it does and no reminder or task row was created.
   `reminder_listed` and `timer_listed` go through the app's own API
   (`GET /api/spaces/:id/reminders` for the private space, `GET` and
   `DELETE /api/timers`), and only look at items the turn added. A reminder's
   `rrule` is read whether jsonb holds the object or a JSON string of it.
   `no_new_memory` fails when the scenario's own conversation created any
   memory. It is on every scenario, because every sentence is a request, not a
   statement about the person. The failure and the table's `new_memories`
   column give kinds and counts only (`fact 1`), never the content. See
   `docs/investigations/replay-memories.md`.
4. A turn that ends with a stream error is run once more; the row shows
   `tries` 2 and `flaky: stream error`, and a failed retry still fails.
5. Prints one row per scenario: `pass`, `fail`, `expected-fail` (a known open
   issue) or `skipped` (a later-today time is not possible after 23:00). Exits 1
   on any `fail`. An expected-fail that passes says so: drop its `expectedFail`.
6. `--repeat N` (1-50) runs each selected scenario N times and adds a summary
   row per scenario: passes out of runs, and the turn's `called_tools` counts.
   `--why` has the judge model put each reply in one category (`called-tool`,
   `asked-clarifying-question`, `refused`, `claimed-without-tool`,
   `ignored-constraint`, `respected-constraint`, `answered`; `no-reply` for an
   empty one) and counts those too. The reply is only sent to the judge; only
   the category is kept. See `docs/perf/reliability-2026-09.md`.

## Your data

- Cleanup only touches rows created after the run started: reminders are
  cancelled and timers cancelled through the store's cancel functions, memories
  are forgotten only when they belong to one of the run's own conversations, and
  the run's conversations are deleted through `DELETE /api/conversations/:id`.
  `--keep` skips all of it.
- Output is limited to each scenario's own sentence and its verdict. The reply,
  the judge's rationale, the token and any key are never printed.
- Detection is by time window, so a row you create by hand while the run is in
  progress can be counted against a scenario (and a reminder or timer you make
  mid-run would be cancelled). Don't use the dev account during a run.

## Adding a scenario

Add an entry to `scenarios.mjs` (data only): an `id`, the sentence, and checks
from the kinds listed at the top of that file. A new check kind belongs in
`evaluateCheck` in `replay.mjs`, with a unit test in `replay.test.mjs`. Mark a
scenario `expectedFail: '#<issue>'` until its fix lands.
