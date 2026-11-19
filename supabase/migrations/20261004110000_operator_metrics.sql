-- Bob operator metrics aggregates (ANL-AGG1): three read-only functions, each
-- returning ONE jsonb document, for the operator dashboard
-- (docs/design/metrics-dashboard-plan.md, views Usage, Voice and Reliability).
--
-- Privacy rule: aggregates only, never a person. No function here returns a
-- user id, email, name, title or any free text; person-level data leaves the
-- database only as counts, and any distinct-user count under 3 is returned as
-- JSON null so a small group cannot be picked out. Outputs hold counts,
-- percentiles, UTC timestamps, enums and the bounded outbox event_type label
-- (a table check already limits it to ^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$, 64).
--
-- Every function is STABLE, takes (p_from, p_to, p_bucket), validates the window
-- first (bucket hour/day/week, p_to > p_from, at most 92 days, at most 200
-- buckets) and is security definer with search_path = '', EXECUTE granted to
-- bob_server alone. The window is half-open: p_from <= t < p_to. No new table,
-- index or policy. Idempotent (create or replace).

-- 1. Window validator: raises invalid_window, otherwise returns nothing.
create or replace function bob_private.operator_metrics_window(
  p_from timestamptz, p_to timestamptz, p_bucket text
) returns void
language plpgsql immutable set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_bucket is null
     or p_bucket not in ('hour', 'day', 'week') then
    raise exception 'invalid_window: bucket must be hour, day or week and both times are required';
  end if;
  if p_to <= p_from then
    raise exception 'invalid_window: p_to must be after p_from';
  end if;
  if p_to - p_from > interval '92 days' then
    raise exception 'invalid_window: window is longer than 92 days';
  end if;
  if (select count(*) from generate_series(
        date_trunc(p_bucket, p_from at time zone 'UTC'),
        date_trunc(p_bucket, (p_to - interval '1 microsecond') at time zone 'UTC'),
        ('1 ' || p_bucket)::interval)) > 200 then
    raise exception 'invalid_window: window spans more than 200 buckets';
  end if;
end;
$$;

-- 2. Zero-fill series: one UTC bucket start per bucket the half-open window
--    touches (a window ending exactly on a boundary does not add an empty bucket).
create or replace function bob_private.operator_metrics_buckets(
  p_from timestamptz, p_to timestamptz, p_bucket text
) returns table (t timestamp)
language sql stable set search_path = ''
as $$
  select g
    from generate_series(
      date_trunc(p_bucket, p_from at time zone 'UTC'),
      date_trunc(p_bucket, (p_to - interval '1 microsecond') at time zone 'UTC'),
      ('1 ' || p_bucket)::interval) as g;
$$;

-- 3. Window echo with UTC ISO timestamps.
create or replace function bob_private.operator_metrics_window_doc(
  p_from timestamptz, p_to timestamptz, p_bucket text
) returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_build_object(
    'from', to_char(p_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'to', to_char(p_to at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'bucket', p_bucket);
$$;

-- 4. Usage: turns by origin, conversations, signups, active users (suppressed < 3).
create or replace function bob_private.operator_metrics_usage(
  p_from timestamptz, p_to timestamptz, p_bucket text
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_series jsonb;
  v_turns bigint;
  v_conversations bigint;
  v_signups bigint;
  v_day bigint;
  v_week bigint;
  v_month bigint;
  v_window bigint;
begin
  perform bob_private.operator_metrics_window(p_from, p_to, p_bucket);

  with turns as (
    select date_trunc(p_bucket, m.created_at at time zone 'UTC') as t,
           count(*) filter (where m.origin = 'device') as device,
           count(*) filter (where m.origin = 'web_voice') as web_voice,
           count(*) filter (where m.origin = 'web_text') as web_text
      from bob.messages m
     where m.role = 'user' and m.tombstoned_at is null
       and m.created_at >= p_from and m.created_at < p_to
     group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           't', to_char(b.t, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'device', coalesce(x.device, 0),
           'web_voice', coalesce(x.web_voice, 0),
           'web_text', coalesce(x.web_text, 0)) order by b.t), '[]'::jsonb),
         coalesce(sum(coalesce(x.device, 0) + coalesce(x.web_voice, 0) + coalesce(x.web_text, 0)), 0)
    into v_series, v_turns
    from bob_private.operator_metrics_buckets(p_from, p_to, p_bucket) as b
    left join turns x on x.t = b.t;

  select count(*) into v_conversations
    from bob.conversations c
   where c.created_at >= p_from and c.created_at < p_to;

  select count(*) into v_signups
    from auth.users u
   where u.created_at >= p_from and u.created_at < p_to;

  select count(distinct m.user_id) filter (where m.created_at >= p_to - interval '1 day'),
         count(distinct m.user_id) filter (where m.created_at >= p_to - interval '7 days'),
         count(distinct m.user_id) filter (where m.created_at >= p_to - interval '30 days'),
         count(distinct m.user_id) filter (where m.created_at >= p_from)
    into v_day, v_week, v_month, v_window
    from bob.messages m
   where m.role = 'user' and m.tombstoned_at is null
     and m.created_at >= least(p_from, p_to - interval '30 days')
     and m.created_at < p_to;

  return jsonb_build_object(
    'window', bob_private.operator_metrics_window_doc(p_from, p_to, p_bucket),
    'turns_by_bucket', v_series,
    'turns_total', v_turns,
    'conversations_created', v_conversations,
    'signups', v_signups,
    'active_users', jsonb_build_object(
      'day', case when v_day < 3 then null else v_day end,
      'week', case when v_week < 3 then null else v_week end,
      'month', case when v_month < 3 then null else v_month end,
      'in_window', case when v_window < 3 then null else v_window end));
end;
$$;

-- 5. Voice: per-surface outcomes, success rate and latency percentiles from
--    bob.turn_metrics. device, web_voice and web_text are always present.
create or replace function bob_private.operator_metrics_voice(
  p_from timestamptz, p_to timestamptz, p_bucket text
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_surfaces jsonb;
  v_stages jsonb;
  v_series jsonb;
begin
  perform bob_private.operator_metrics_window(p_from, p_to, p_bucket);

  with w as (
    select * from bob.turn_metrics
     where occurred_at >= p_from and occurred_at < p_to
  ),
  names as (
    select s from unnest(array['device', 'web_voice', 'web_text']) as s
    union
    select distinct surface from w
  ),
  agg as (
    select n.s as surface,
           count(w.id) as turns,
           count(w.id) filter (where w.outcome = 'completed') as completed,
           count(w.id) filter (where w.outcome = 'failed') as failed,
           count(w.id) filter (where w.outcome = 'cancelled') as cancelled,
           count(w.id) filter (where w.outcome = 'empty') as empty,
           round((percentile_cont(0.5) within group (order by w.first_audio_ms))::numeric)::integer as fa50,
           round((percentile_cont(0.95) within group (order by w.first_audio_ms))::numeric)::integer as fa95,
           round((percentile_cont(0.5) within group (order by w.stt_ms))::numeric)::integer as stt50,
           round((percentile_cont(0.95) within group (order by w.stt_ms))::numeric)::integer as stt95,
           round((percentile_cont(0.5) within group (order by w.model_ms))::numeric)::integer as model50,
           round((percentile_cont(0.95) within group (order by w.model_ms))::numeric)::integer as model95,
           round((percentile_cont(0.5) within group (order by w.tts_ms))::numeric)::integer as tts50,
           round((percentile_cont(0.95) within group (order by w.tts_ms))::numeric)::integer as tts95,
           round((percentile_cont(0.5) within group (order by w.total_ms))::numeric)::integer as total50,
           round((percentile_cont(0.95) within group (order by w.total_ms))::numeric)::integer as total95
      from names n
      left join w on w.surface = n.s
     group by n.s
  )
  select jsonb_object_agg(a.surface, jsonb_build_object(
           'turns', a.turns,
           'outcomes', jsonb_build_object('completed', a.completed, 'failed', a.failed,
                                          'cancelled', a.cancelled, 'empty', a.empty),
           'success_rate', case when a.completed + a.failed = 0 then null
                                else round(a.completed::numeric / (a.completed + a.failed), 4) end,
           'latency_ms', jsonb_build_object(
             'first_audio', jsonb_build_object('p50', a.fa50, 'p95', a.fa95),
             'stt', jsonb_build_object('p50', a.stt50, 'p95', a.stt95),
             'model', jsonb_build_object('p50', a.model50, 'p95', a.model95),
             'tts', jsonb_build_object('p50', a.tts50, 'p95', a.tts95),
             'total', jsonb_build_object('p50', a.total50, 'p95', a.total95))))
    into v_surfaces
    from agg a;

  select jsonb_build_object(
           'input', count(*) filter (where failed_stage = 'input'),
           'stt', count(*) filter (where failed_stage = 'stt'),
           'agent', count(*) filter (where failed_stage = 'agent'),
           'tts', count(*) filter (where failed_stage = 'tts'))
    into v_stages
    from bob.turn_metrics
   where occurred_at >= p_from and occurred_at < p_to;

  with x as (
    select date_trunc(p_bucket, occurred_at at time zone 'UTC') as t,
           round((percentile_cont(0.95) within group (order by first_audio_ms)
                  filter (where surface = 'device'))::numeric)::integer as device,
           round((percentile_cont(0.95) within group (order by first_audio_ms)
                  filter (where surface = 'web_voice'))::numeric)::integer as web_voice
      from bob.turn_metrics
     where occurred_at >= p_from and occurred_at < p_to
     group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           't', to_char(b.t, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'device', x.device, 'web_voice', x.web_voice) order by b.t), '[]'::jsonb)
    into v_series
    from bob_private.operator_metrics_buckets(p_from, p_to, p_bucket) as b
    left join x on x.t = b.t;

  return jsonb_build_object(
    'window', bob_private.operator_metrics_window_doc(p_from, p_to, p_bucket),
    'by_surface', v_surfaces,
    'failed_by_stage', v_stages,
    'first_audio_p95_by_bucket', v_series);
end;
$$;

-- 6. Platform: outbox backlog and failures. event_type is a bounded label (the
--    table check limits it to dotted lowercase words, at most 64 characters).
create or replace function bob_private.operator_metrics_platform(
  p_from timestamptz, p_to timestamptz, p_bucket text
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_backlog bigint;
  v_oldest bigint;
  v_retried bigint;
  v_failed jsonb;
begin
  perform bob_private.operator_metrics_window(p_from, p_to, p_bucket);

  select count(*), floor(extract(epoch from now() - min(created_at)))::bigint
    into v_backlog, v_oldest
    from bob.outbox
   where delivered_at is null;

  select count(*) into v_retried
    from bob.outbox
   where created_at >= p_from and created_at < p_to and attempts > 1;

  select coalesce(jsonb_agg(jsonb_build_object('event_type', f.event_type, 'count', f.n)
                            order by f.n desc, f.event_type), '[]'::jsonb)
    into v_failed
    from (select event_type, count(*) as n
            from bob.outbox
           where created_at >= p_from and created_at < p_to and last_error_code is not null
           group by event_type
           order by count(*) desc, event_type
           limit 10) as f;

  return jsonb_build_object(
    'window', bob_private.operator_metrics_window_doc(p_from, p_to, p_bucket),
    'backlog', v_backlog,
    'oldest_pending_seconds', v_oldest,
    'retried', v_retried,
    'failed_by_event_type', v_failed);
end;
$$;

-- 7. Grants: EXECUTE to the server role only.
revoke all on function bob_private.operator_metrics_window(timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function bob_private.operator_metrics_window(timestamptz, timestamptz, text) to bob_server;
revoke all on function bob_private.operator_metrics_buckets(timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function bob_private.operator_metrics_buckets(timestamptz, timestamptz, text) to bob_server;
revoke all on function bob_private.operator_metrics_window_doc(timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function bob_private.operator_metrics_window_doc(timestamptz, timestamptz, text) to bob_server;
revoke all on function bob_private.operator_metrics_usage(timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function bob_private.operator_metrics_usage(timestamptz, timestamptz, text) to bob_server;
revoke all on function bob_private.operator_metrics_voice(timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function bob_private.operator_metrics_voice(timestamptz, timestamptz, text) to bob_server;
revoke all on function bob_private.operator_metrics_platform(timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function bob_private.operator_metrics_platform(timestamptz, timestamptz, text) to bob_server;
