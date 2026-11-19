# Turn metrics: what the analytics table holds

Table `bob.turn_metrics` (migration `20261004100000_turn_metrics.sql`) holds one row per voice or chat
turn so operators can chart success, latency, tokens, cost and intents.

## What a row holds

- When the turn happened (`occurred_at`) and where it came from (`surface`: device, web text, web voice,
  analytics).
- The outcome (`completed`, `failed`, `cancelled`, `empty`) and, for a failure, the stage and kind.
- A coarse intent label from a fixed list, never free text.
- The model, provider and firmware version strings, each checked against a strict pattern.
- Token counts, step and tool-call counts, and the names of the tools called.
- Timings in milliseconds (speech-to-text, model, first token, text-to-speech, first audio, total).
- Flags: streamed, interrupted, speech cache hit.
- `user_bucket`: a hash of the account modulo 1024. It exists only for approximate distinct counts and
  cannot be reversed to a person.

## What a row never holds

No person, device, conversation or turn identifier, no foreign key to any account table, no message text,
no speech text, no instructions sent to the model, no audio. The database refuses any value outside the
fixed lists and patterns, so free text cannot be stored even by mistake.

## Who can reach it

The table is server-only. Row level security is forced with no policies, and no role has a direct grant.
Rows are written through `bob_private.record_turn_metric` and deleted through
`bob_private.purge_turn_metrics`, both callable only by the server role. There is no read function.
Operators only ever see aggregates computed by the server.

## Retention

Rows are kept 90 days. The server purges with `purge_turn_metrics(now() - interval '90 days')`, which
deletes older rows and returns how many it removed. The schedule that calls it ships in a later unit.
