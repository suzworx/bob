-- Bob operator metrics, three more aggregates (ANL-AGG2): AI and cost,
-- devices, and features, for the operator dashboard
-- (docs/design/metrics-dashboard-plan.md, views AI quality, Cost, Devices and
-- Features). Same conventions as 20261004110000_operator_metrics.sql, whose
-- window validator, zero-fill helper and window echo these functions reuse.
--
-- Privacy rule: aggregates only, never a person. No function here returns a
-- user id, email, name, title or any free text. Outputs are counts, sums,
-- ratios, percentiles, UTC timestamps, enums and bounded labels only (model,
-- tool and intent come from checked turn_metrics columns; firmware version and
-- device model are returned only when they match a short safe pattern; the
-- notification type is checked the same way). Any group of fewer than 3
-- devices is folded into one "other (fewer than 3)" row, so a small group
-- cannot be picked out.
--
-- Every function is STABLE, takes (p_from, p_to, p_bucket), validates the window
-- first and is security definer with search_path = '', EXECUTE granted to
-- bob_server alone. The window is half-open: p_from <= t < p_to. No new table,
-- index or policy. Idempotent (create or replace).

-- 1. AI and cost: tokens, cache use, steps, models, tools and intents from
--    bob.turn_metrics.
create or replace function bob_private.operator_metrics_ai(
  p_from timestamptz, p_to timestamptz, p_bucket text
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_totals jsonb;
  v_models jsonb;
  v_tools jsonb;
  v_intents jsonb;
  v_series jsonb;
begin
  perform bob_private.operator_metrics_window(p_from, p_to, p_bucket);

  select jsonb_build_object(
           'turns', count(*),
           'tokens', jsonb_build_object(
             'input', coalesce(sum(input_tokens), 0),
             'output', coalesce(sum(output_tokens), 0),
             'cached_input', coalesce(sum(cached_input_tokens), 0),
             'cache_write', coalesce(sum(cache_write_tokens), 0),
             'reasoning', coalesce(sum(reasoning_tokens), 0)),
           'cache_hit_ratio', case when coalesce(sum(input_tokens), 0) = 0 then null
                                   else round(coalesce(sum(cached_input_tokens), 0)::numeric / sum(input_tokens), 4) end,
           'avg_steps', round(avg(steps)::numeric, 1),
           'avg_output_tokens', round(avg(output_tokens)::numeric, 1),
           'interrupted_rate', case when count(*) filter (where outcome = 'completed') = 0 then null
                                    else round(count(*) filter (where interrupted and outcome = 'completed')::numeric
                                               / count(*) filter (where outcome = 'completed'), 4) end)
    into v_totals
    from bob.turn_metrics
   where occurred_at >= p_from and occurred_at < p_to;

  with m as (
    select coalesce(model, 'unknown') as model, count(*) as turns,
           coalesce(sum(input_tokens), 0)::bigint as i,
           coalesce(sum(output_tokens), 0)::bigint as o,
           coalesce(sum(cached_input_tokens), 0)::bigint as c
      from bob.turn_metrics
     where occurred_at >= p_from and occurred_at < p_to
     group by 1
  ),
  ranked as (
    select m.*, row_number() over (order by m.turns desc, m.model) as rn from m
  )
  select coalesce(jsonb_agg(jsonb_build_object('model', x.model, 'turns', x.turns, 'input', x.i,
                                               'output', x.o, 'cached_input', x.c)
                            order by x.ord, x.turns desc, x.model), '[]'::jsonb)
    into v_models
    from (
      select r.model, r.turns, r.i, r.o, r.c, 0 as ord from ranked r where r.rn <= 7
      union all
      select 'other', sum(r.turns)::bigint, sum(r.i)::bigint, sum(r.o)::bigint, sum(r.c)::bigint, 1
        from ranked r where r.rn > 7 having count(*) > 0
    ) x;

  select coalesce(jsonb_agg(jsonb_build_object('tool', t.tool, 'count', t.n) order by t.n desc, t.tool), '[]'::jsonb)
    into v_tools
    from (select u.tool, count(*) as n
            from bob.turn_metrics m
           cross join lateral unnest(m.called_tools) as u(tool)
           where m.occurred_at >= p_from and m.occurred_at < p_to
           group by u.tool
           order by count(*) desc, u.tool
           limit 25) t;

  select coalesce(jsonb_agg(jsonb_build_object(
           'intent', i.intent, 'turns', i.turns,
           'success_rate', case when i.completed + i.failed = 0 then null
                                else round(i.completed::numeric / (i.completed + i.failed), 4) end,
           'p95_total_ms', i.p95) order by i.turns desc, i.intent), '[]'::jsonb)
    into v_intents
    from (select coalesce(intent, 'unknown') as intent, count(*) as turns,
                 count(*) filter (where outcome = 'completed') as completed,
                 count(*) filter (where outcome = 'failed') as failed,
                 round((percentile_cont(0.95) within group (order by total_ms))::numeric)::integer as p95
            from bob.turn_metrics
           where occurred_at >= p_from and occurred_at < p_to
           group by 1) i;

  with x as (
    select date_trunc(p_bucket, occurred_at at time zone 'UTC') as t,
           coalesce(sum(input_tokens), 0) as i, coalesce(sum(output_tokens), 0) as o,
           coalesce(sum(cached_input_tokens), 0) as c
      from bob.turn_metrics
     where occurred_at >= p_from and occurred_at < p_to
     group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           't', to_char(b.t, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'input', coalesce(x.i, 0), 'output', coalesce(x.o, 0), 'cached_input', coalesce(x.c, 0)) order by b.t), '[]'::jsonb)
    into v_series
    from bob_private.operator_metrics_buckets(p_from, p_to, p_bucket) as b
    left join x on x.t = b.t;

  return jsonb_build_object('window', bob_private.operator_metrics_window_doc(p_from, p_to, p_bucket))
      || v_totals
      || jsonb_build_object('by_model', v_models, 'tools', v_tools, 'intents', v_intents, 'tokens_by_bucket', v_series);
end;
$$;

-- 2. Small-group folding for device labels: the label is kept only when it
--    matches a short safe pattern, and only when at least 3 devices share it
--    (top 10 labels). Everything else is summed into one row.
create or replace function bob_private.operator_metrics_fold_counts(p_values text[], p_key text)
returns jsonb
language sql immutable set search_path = ''
as $$
  with n as (
    select case when t.v ~ '^[0-9A-Za-z._+ -]{1,32}$' then t.v else 'other' end as label, count(*) as c
      from unnest(p_values) as t(v)
     group by 1
  ),
  good as (
    select label, c from n where label <> 'other' and c >= 3 order by c desc, label limit 10
  ),
  rest as (
    select coalesce(sum(c), 0)::bigint as c from n where label not in (select label from good)
  )
  select coalesce((select jsonb_agg(jsonb_build_object(p_key, g.label, 'count', g.c) order by g.c desc, g.label)
                     from good g), '[]'::jsonb)
      || coalesce((select jsonb_build_array(jsonb_build_object(p_key, 'other (fewer than 3)', 'count', r.c))
                     from rest r where r.c > 0), '[]'::jsonb);
$$;

-- 3. Devices: fleet size, firmware and model mix, how recently devices were
--    seen (relative to p_to) and pairing outcomes. Revoked devices are left out
--    of the mix and freshness; pairing_requests status maps pending to
--    requested, approved and delivered to approved, expired to expired and
--    anything else (denied) to other.
create or replace function bob_private.operator_metrics_devices(
  p_from timestamptz, p_to timestamptz, p_bucket text
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_counts jsonb;
  v_fw jsonb;
  v_model jsonb;
  v_fresh jsonb;
  v_pairing jsonb;
begin
  perform bob_private.operator_metrics_window(p_from, p_to, p_bucket);

  select jsonb_build_object(
           'paired', count(*) filter (where revoked_at is null),
           'active_in_window', count(*) filter (where revoked_at is null
                                                 and last_seen_at >= p_from and last_seen_at < p_to),
           'revoked', count(*) filter (where revoked_at >= p_from and revoked_at < p_to))
    into v_counts
    from bob.devices;

  select bob_private.operator_metrics_fold_counts(coalesce(array_agg(fw_version), '{}'::text[]), 'fw_version'),
         bob_private.operator_metrics_fold_counts(coalesce(array_agg(model), '{}'::text[]), 'model')
    into v_fw, v_model
    from bob.devices
   where revoked_at is null;

  select jsonb_build_object(
           'under_1h', count(*) filter (where p_to - last_seen_at < interval '1 hour'),
           'under_24h', count(*) filter (where p_to - last_seen_at >= interval '1 hour'
                                          and p_to - last_seen_at < interval '24 hours'),
           'under_7d', count(*) filter (where p_to - last_seen_at >= interval '24 hours'
                                         and p_to - last_seen_at < interval '7 days'),
           'older', count(*) filter (where p_to - last_seen_at >= interval '7 days'),
           'never', count(*) filter (where last_seen_at is null))
    into v_fresh
    from bob.devices
   where revoked_at is null;

  select jsonb_build_object(
           'requested', count(*) filter (where status = 'pending'),
           'approved', count(*) filter (where status in ('approved', 'delivered')),
           'expired', count(*) filter (where status = 'expired'),
           'other', count(*) filter (where status not in ('pending', 'approved', 'delivered', 'expired')))
    into v_pairing
    from bob.pairing_requests
   where created_at >= p_from and created_at < p_to;

  return jsonb_build_object(
    'window', bob_private.operator_metrics_window_doc(p_from, p_to, p_bucket),
    'devices', v_counts,
    'by_fw_version', v_fw,
    'by_model', v_model,
    'freshness', v_fresh,
    'pairing', v_pairing);
end;
$$;

-- 4. Features: counts of rows created, never their content. calendar_events
--    has no origin column (origin lives on bob.calendars), so by_origin is
--    an empty list. Reminders are rows with kind = 'reminder'; timers and
--    alarms are not counted.
create or replace function bob_private.operator_metrics_features(
  p_from timestamptz, p_to timestamptz, p_bucket text
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_series jsonb;
  v_tasks jsonb;
  v_reminders jsonb;
  v_notifications jsonb;
  v_events bigint;
  v_spaces jsonb;
  v_game bigint;
begin
  perform bob_private.operator_metrics_window(p_from, p_to, p_bucket);

  with t as (
    select date_trunc(p_bucket, created_at at time zone 'UTC') as tb, count(*) as n
      from bob.tasks where created_at >= p_from and created_at < p_to group by 1
  ),
  n as (
    select date_trunc(p_bucket, created_at at time zone 'UTC') as tb, count(*) as n
      from bob.notes where created_at >= p_from and created_at < p_to group by 1
  ),
  r as (
    select date_trunc(p_bucket, created_at at time zone 'UTC') as tb, count(*) as n
      from bob.reminders
     where kind = 'reminder' and created_at >= p_from and created_at < p_to group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           't', to_char(b.t, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'tasks', coalesce(t.n, 0), 'notes', coalesce(n.n, 0), 'reminders', coalesce(r.n, 0)) order by b.t), '[]'::jsonb)
    into v_series
    from bob_private.operator_metrics_buckets(p_from, p_to, p_bucket) as b
    left join t on t.tb = b.t
    left join n on n.tb = b.t
    left join r on r.tb = b.t;

  select jsonb_build_object('created', count(*), 'completed', count(*) filter (where completed_at is not null))
    into v_tasks
    from bob.tasks
   where created_at >= p_from and created_at < p_to;

  select jsonb_build_object(
           'created', (select count(*) from bob.reminders
                        where kind = 'reminder' and created_at >= p_from and created_at < p_to),
           'delivered', count(*) filter (where delivered_at is not null),
           'acknowledged', count(*) filter (where acknowledged_at is not null),
           'snoozed', count(*) filter (where snoozed_until is not null))
    into v_reminders
    from bob.reminder_occurrences
   where occurrence_at >= p_from and occurrence_at < p_to;

  select jsonb_build_object(
           'created', count(*),
           'read', count(*) filter (where read_at is not null),
           'by_type', (select coalesce(jsonb_agg(jsonb_build_object('type', x.type, 'count', x.n)
                                                 order by x.n desc, x.type), '[]'::jsonb)
                         from (select nn.type, count(*) as n
                                 from bob.notifications nn
                                where nn.created_at >= p_from and nn.created_at < p_to
                                  and nn.type ~ '^[a-z0-9_.:-]{1,48}$'
                                group by nn.type
                                order by count(*) desc, nn.type
                                limit 10) x))
    into v_notifications
    from bob.notifications
   where created_at >= p_from and created_at < p_to;

  select count(*) into v_events
    from bob.calendar_events
   where created_at >= p_from and created_at < p_to;

  select jsonb_build_object(
           'created', count(*),
           'by_kind', jsonb_build_object(
             'private', count(*) filter (where kind = 'private'),
             'pair', count(*) filter (where kind = 'pair'),
             'group', count(*) filter (where kind = 'group')))
    into v_spaces
    from bob.spaces
   where created_at >= p_from and created_at < p_to;

  select (coalesce(sum(seconds), 0) / 60)::bigint into v_game
    from bob.game_usage
   where day::timestamp >= p_from at time zone 'UTC' and day::timestamp < p_to at time zone 'UTC';

  return jsonb_build_object(
    'window', bob_private.operator_metrics_window_doc(p_from, p_to, p_bucket),
    'created_by_bucket', v_series,
    'tasks', v_tasks,
    'reminders', v_reminders,
    'notifications', v_notifications,
    'calendar', jsonb_build_object('events_created', v_events, 'by_origin', '[]'::jsonb),
    'spaces', v_spaces,
    'game_minutes', v_game);
end;
$$;

-- 5. Grants: EXECUTE to the server role only.
revoke all on function bob_private.operator_metrics_fold_counts(text[], text) from public, anon, authenticated;
grant execute on function bob_private.operator_metrics_fold_counts(text[], text) to bob_server;
revoke all on function bob_private.operator_metrics_ai(timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function bob_private.operator_metrics_ai(timestamptz, timestamptz, text) to bob_server;
revoke all on function bob_private.operator_metrics_devices(timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function bob_private.operator_metrics_devices(timestamptz, timestamptz, text) to bob_server;
revoke all on function bob_private.operator_metrics_features(timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function bob_private.operator_metrics_features(timestamptz, timestamptz, text) to bob_server;
