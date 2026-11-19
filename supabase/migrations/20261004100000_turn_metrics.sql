-- Bob turn metrics (ANL-DB1): one row per voice or chat turn recording
-- latency, token counts and outcome, for the operator analytics dashboard
-- (docs/design/metrics-dashboard-plan.md). Privacy is the point: the table has
-- no person or text columns, no foreign keys, and nothing that joins a row back
-- to an account, a device or a conversation. user_bucket is a hash of the
-- account modulo 1024, good for approximate distinct counts only and not
-- reversible. Every enum, regex and range is enforced here, in the database.
--
-- Server-only, following the outbox assembly order: 1 table, 2 indexes,
-- 3 enable and force RLS, 4 policies (NONE), 5 grants (NONE on the table).
-- The only way in is bob_private.record_turn_metric and the only way to
-- delete is bob_private.purge_turn_metrics, both security definers granted to
-- bob_server alone. Rows are kept 90 days (docs/privacy/turn-metrics.md).
-- Nothing writes here yet; later units wire the turn pipeline. Idempotent.

-- 0. Tool-name list check, immutable so a table constraint can call it.
create or replace function bob_private.tool_names_ok(p text[])
returns boolean
language sql immutable set search_path = ''
as $$
  select p is null
      or cardinality(p) = 0
      or (cardinality(p) <= 64
          and not exists (
            select 1 from unnest(p) as t(name)
             where t.name is null or t.name !~ '^[A-Za-z0-9_-]{1,64}$'
          ));
$$;

revoke all on function bob_private.tool_names_ok(text[]) from public, anon, authenticated;
grant execute on function bob_private.tool_names_ok(text[]) to bob_server;

-- 1. Table.
create table if not exists bob.turn_metrics (
  id                  bigint generated always as identity primary key,
  occurred_at         timestamptz not null default now(),
  surface             text not null
                      check (surface in ('device', 'web_text', 'web_voice', 'analytics')),
  outcome             text not null
                      check (outcome in ('completed', 'failed', 'cancelled', 'empty')),
  failed_stage        text null check (failed_stage in ('input', 'stt', 'agent', 'tts')),
  failure_kind        text null
                      check (failure_kind in ('invalid_input', 'upstream_error', 'internal')),
  upstream_status     smallint null check (upstream_status between 100 and 599),
  intent              text null
                      check (intent in ('timer_reminder', 'calendar', 'task_note', 'memory', 'game',
                                        'device_control', 'search_info', 'space_collab', 'chat', 'other')),
  model               text null check (model ~ '^[A-Za-z0-9._:/@-]{1,128}$'),
  provider            text null check (provider ~ '^[A-Za-z0-9._-]{1,64}$'),
  fw_version          text null check (fw_version ~ '^[0-9A-Za-z._+-]{1,32}$'),
  input_tokens        integer null check (input_tokens >= 0),
  output_tokens       integer null check (output_tokens >= 0),
  cached_input_tokens integer null check (cached_input_tokens >= 0),
  cache_write_tokens  integer null check (cache_write_tokens >= 0),
  reasoning_tokens    integer null check (reasoning_tokens >= 0),
  steps               smallint null check (steps between 0 and 100),
  tool_calls          smallint null check (tool_calls between 0 and 500),
  called_tools        text[] not null default '{}'
                      check (bob_private.tool_names_ok(called_tools)),
  streamed            boolean not null default false,
  interrupted         boolean not null default false,
  tts_cache_hit       boolean not null default false,
  stt_ms              integer null check (stt_ms between 0 and 600000),
  prep_ms             integer null check (prep_ms between 0 and 600000),
  model_ms            integer null check (model_ms between 0 and 600000),
  first_token_ms      integer null check (first_token_ms between 0 and 600000),
  tts_ms              integer null check (tts_ms between 0 and 600000),
  first_audio_ms      integer null check (first_audio_ms between 0 and 600000),
  total_ms            integer null check (total_ms between 0 and 600000),
  user_bucket         smallint null check (user_bucket between 0 and 1023),
  check ((outcome = 'failed') = (failed_stage is not null))
);

-- 2. Indexes: the retention purge and the per-surface time-range charts.
create index if not exists turn_metrics_occurred_idx
  on bob.turn_metrics (occurred_at);
create index if not exists turn_metrics_surface_occurred_idx
  on bob.turn_metrics (surface, occurred_at);

-- 3. RLS, forced, with no policies: this table is server-only.
alter table bob.turn_metrics enable row level security;
alter table bob.turn_metrics force row level security;

-- 4. Policies: none by design.

-- 5. Grants: none. Access is through the two definers below only.
revoke all on bob.turn_metrics from public, anon, authenticated;

-- 6. Write definer. Unknown keys are ignored; id and occurred_at are never
--    read from the payload, so they always take their defaults.
create or replace function bob_private.record_turn_metric(p jsonb)
returns void
language sql security definer set search_path = ''
as $$
  insert into bob.turn_metrics (
    surface, outcome, failed_stage, failure_kind, upstream_status, intent,
    model, provider, fw_version,
    input_tokens, output_tokens, cached_input_tokens, cache_write_tokens, reasoning_tokens,
    steps, tool_calls, called_tools, streamed, interrupted, tts_cache_hit,
    stt_ms, prep_ms, model_ms, first_token_ms, tts_ms, first_audio_ms, total_ms,
    user_bucket
  )
  select
    r.surface, r.outcome, r.failed_stage, r.failure_kind, r.upstream_status, r.intent,
    r.model, r.provider, r.fw_version,
    r.input_tokens, r.output_tokens, r.cached_input_tokens, r.cache_write_tokens, r.reasoning_tokens,
    r.steps, r.tool_calls, coalesce(r.called_tools, '{}'),
    coalesce(r.streamed, false), coalesce(r.interrupted, false), coalesce(r.tts_cache_hit, false),
    r.stt_ms, r.prep_ms, r.model_ms, r.first_token_ms, r.tts_ms, r.first_audio_ms, r.total_ms,
    r.user_bucket
  from jsonb_populate_record(null::bob.turn_metrics, p) as r;
$$;

-- 7. Retention definer: deletes rows older than the cutoff, returns the count.
create or replace function bob_private.purge_turn_metrics(p_before timestamptz)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  n integer;
begin
  delete from bob.turn_metrics where occurred_at < p_before;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function bob_private.record_turn_metric(jsonb) from public, anon, authenticated;
grant execute on function bob_private.record_turn_metric(jsonb) to bob_server;
revoke all on function bob_private.purge_turn_metrics(timestamptz) from public, anon, authenticated;
grant execute on function bob_private.purge_turn_metrics(timestamptz) to bob_server;
