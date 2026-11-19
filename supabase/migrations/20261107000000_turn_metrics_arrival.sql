-- Bob turn metrics: arrival_ms (spec 015 FR-003, SIMPLIFY-U0B). The whole
-- wait of a web chat turn, from the request reaching the handler to the model
-- call, which prep_ms understates because its clock starts after the
-- conversation is located, the message stored and the history loaded.
-- Milliseconds only, bounded like every other timing column; null on device
-- rows and on rows written before this column existed. Idempotent.
--
-- The writer probes for this column before sending it, because production
-- applies migrations only from CI after merge (platform/observability/turn-metrics.ts).

-- 1. Column.
alter table bob.turn_metrics
  add column if not exists arrival_ms integer null check (arrival_ms between 0 and 600000);

-- 2. Write definer, now carrying arrival_ms. Unknown keys are still ignored;
--    id and occurred_at are never read from the payload.
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
    user_bucket, arrival_ms
  )
  select
    r.surface, r.outcome, r.failed_stage, r.failure_kind, r.upstream_status, r.intent,
    r.model, r.provider, r.fw_version,
    r.input_tokens, r.output_tokens, r.cached_input_tokens, r.cache_write_tokens, r.reasoning_tokens,
    r.steps, r.tool_calls, coalesce(r.called_tools, '{}'),
    coalesce(r.streamed, false), coalesce(r.interrupted, false), coalesce(r.tts_cache_hit, false),
    r.stt_ms, r.prep_ms, r.model_ms, r.first_token_ms, r.tts_ms, r.first_audio_ms, r.total_ms,
    r.user_bucket, r.arrival_ms
  from jsonb_populate_record(null::bob.turn_metrics, p) as r;
$$;

-- 3. Grants, unchanged: bob_server alone may call the definer.
revoke all on function bob_private.record_turn_metric(jsonb) from public, anon, authenticated;
grant execute on function bob_private.record_turn_metric(jsonb) to bob_server;
