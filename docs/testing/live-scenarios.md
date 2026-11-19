# Live scenario suite (release gate)

`npm run test:scenarios` runs a real model through the device-turn path and then
checks the database rows the turn saved. It exists because a reply can say
"Got it, I'll remember that" while nothing was saved: on 2026-09-25 turn
`turn_1978033_v2` did exactly that (`called_tools=""`). Unit tests use a stub AI,
and `tools.eval` only scores which tool was picked. This suite scores what was
stored.

## What it drives

`apps/api/tests/scenarios/live.scenario.ts` calls `processTurn` (apps/api/src/turn.ts)
with a device session. Only STT and TTS are replaced: `transcribePcm` returns the
scenario's text and synthesis returns silence. Everything else is the production path:

- the per-turn agent (`createBobAgent`)
- memory retrieval and the memory tools
- the productivity, voice, timer and device tools
- private-Space resolution
- the account time zone, read from auth `user_metadata.time_zone` by
  `bob_private.account_time_zone()`

"Now" is fixed by faking `Date` only, at Tue 2026-10-06 10:07 PDT (22:37 IST).
That is how production passes it: `new Date()` at call time. Each repeat uses a
fresh account in one per-run database, cloned by `tests/support/test-db.ts`. The
background memory-extraction worker is not started, so any memory row comes from
the turn's own tools.

| id | utterance | passes when |
|---|---|---|
| a | "Hey Alexa, remember to go to park today at four p.m." | reminder at 16:00 LA today; no memory row |
| b | "remember to go to temple today at nine fifteen p.m." | reminder at 21:15 LA; no memory row |
| c-la / c-ist | "remind me to have breakfast with eggs tomorrow at 9 a.m." | reminder or task stored at exactly 09:00 tomorrow in the account zone (America/Los_Angeles, Asia/Kolkata) |
| d | "remember that my wife's name is Priya" | fact/preference memory naming Priya; no reminder, no task |
| e | "add buy milk to my list" | undated task; no reminder |
| f | "set a timer for five minutes" | timer ending within 60 s of now + 5 min |
| g | "what time is it" | no rows written; reply contains 10:07 |
| h | "what reminders do I have" (in a's session) | the park reminder row exists and the reply names it; no rows written |

A scenario passes only when every repeat passes. Only g and h look at reply
text, and h also requires the row, so an answer recalled from the chat history
does not count. Any turn whose memory journal reports `store_unavailable` is
marked `HARNESS: memory store unavailable`: that is a broken harness, not a model result.

## How to run

It needs the local Supabase stack (`npx supabase start`), the same as `npm run test:db`.
The key must be in the environment. The config does not load `.env`, so an
offline run cannot spend by accident. Without a key the suite skips with a message.

```sh
# model defaults to apps/ai/src/config.ts (openai/gpt-4o); repeats default 2
BOB_CHAT_MODEL=openai/gpt-4o SCENARIO_REPEATS=2 \
  node --env-file=.env node_modules/vitest/vitest.mjs run --config apps/api/vitest.scenarios.config.ts
# one scenario: add  -t "a: Hey"
```

Put `BOB_CHAT_MODEL` on the command line. With `--env-file`, a value already in
the environment wins over the file. The model actually used is recorded per row.

Results go to `data/scenarios/<model>-<timestamp>.json` (git-ignored). Each row
holds scenario, model, repeat, zone, pass, why, called_tools, reply, the rows
found, tokens and memory events. The table is printed when a scenario fails.

## Cost per run (9 scenarios x 2 repeats = 18 turns, measured 2026-09-25)

| model | input tokens | output tokens | approx. cost |
|---|---|---|---|
| openai/gpt-4o | ~95k | ~1k | ~$0.25 |
| google/gemini-2.5-flash | ~54k | ~3k | ~$0.02 |

Embeddings (retrieval and `remember`) add a negligible amount. TTS and STT are not called.

## When it is required

Run it with repeats=2 and attach the JSON before merging a change to any of:

- the chat model (`BOB_CHAT_MODEL`, provider routing)
- the agent instructions or prompt layout
- tool definitions or descriptions (apps/ai/src/*-tools.ts)
- the turn wiring (apps/api/src/turn.ts, the core binders)

It is not part of `npm test`, validate or CI because it costs money.

## Known harness note

`tests/support/pg-template.ts` builds the template with `--no-privileges`, so a
cloned test database lacks the Supabase platform grants: USAGE on schemas `auth`
and `extensions`. Memory then silently degrades: `remember` fails, and
`match_memories` is denied. The suite restores exactly those grants on its own
database (`grantPlatformUsage`). Any other test-db user of vector memory has the
same gap.
