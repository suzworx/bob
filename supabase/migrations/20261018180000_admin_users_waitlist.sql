-- Admin waitlist is a read-only directory, with fresh authority checked in SQL.
-- Operator users metrics expose only aggregate counts. Activity means retained,
-- non-tombstoned human messages, not sign-ins; small active cohorts stay suppressed.
create or replace function bob_private.admin_waitlist_counts()
returns jsonb language sql stable security definer set search_path = '' as $$
  with entries as (
    select w.verified_at, exists (
      select 1 from auth.users u where lower(u.email) = lower(w.email)
        and u.deleted_at is null and u.id <> '00000000-0000-4000-8000-0000000000de'::uuid
    ) as has_account from bob.waitlist w
  ) select jsonb_build_object(
    'total', count(*), 'verified', count(*) filter (where verified_at is not null),
    'pending', count(*) filter (where verified_at is null),
    'withAccount', count(*) filter (where has_account),
    'waitingVerified', count(*) filter (where verified_at is not null and not has_account)
  ) from entries;
$$;

create or replace function bob_private.admin_waitlist_search(
  p_actor uuid, p_session uuid, p_query text, p_limit int, p_cursor text default null, p_status text default 'all'
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_rows jsonb;
  v_after_time timestamptz;
  v_after_id uuid;
  v_next text;
begin
  if not bob_private.web_session_active(p_actor, p_session) or not exists (
    select 1 from bob.user_scopes where user_id = p_actor and scope = 'accounts.admin'
  ) then raise exception 'admin_required' using errcode = '42501'; end if;
  if p_query is null or length(p_query) > 254 or p_limit is null or p_limit not between 1 and 50
    or p_status is null or p_status not in ('all','verified','pending','waiting','with_account') then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  if p_cursor is not null then
    begin
      if length(p_cursor) > 512 then raise exception 'invalid_cursor'; end if;
      v_after_time := (p_cursor::jsonb ->> 'createdAt')::timestamptz;
      v_after_id := (p_cursor::jsonb ->> 'id')::uuid;
      if v_after_time is null or v_after_id is null then raise exception 'invalid_cursor'; end if;
    exception when others then raise exception 'invalid_cursor' using errcode = '22023'; end;
  end if;
  with entries as (
    select w.id, w.email, w.source, w.created_at, w.verified_at,
      coalesce((select case when u.banned_until > now() then 'disabled' else 'enabled' end
        from auth.users u where lower(u.email) = lower(w.email) and u.deleted_at is null
          and u.id <> '00000000-0000-4000-8000-0000000000de'::uuid
        order by u.created_at, u.id limit 1), 'none') as account_status
    from bob.waitlist w
    where starts_with(lower(w.email), lower(p_query))
      and (v_after_id is null or (w.created_at, w.id) > (v_after_time, v_after_id))
  ), page as (
    select * from entries where p_status = 'all'
      or (p_status = 'verified' and verified_at is not null)
      or (p_status = 'pending' and verified_at is null)
      or (p_status = 'waiting' and verified_at is not null and account_status = 'none')
      or (p_status = 'with_account' and account_status <> 'none')
    order by created_at, id limit p_limit + 1
  ) select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'email', email, 'source', source, 'createdAt', created_at,
    'verifiedAt', verified_at, 'accountStatus', account_status
  ) order by created_at, id), '[]'::jsonb) into v_rows from page;
  if jsonb_array_length(v_rows) > p_limit then
    v_rows := v_rows - p_limit;
    v_next := jsonb_build_object('createdAt', v_rows->(p_limit-1)->>'createdAt', 'id', v_rows->(p_limit-1)->>'id')::text;
  end if;
  return jsonb_build_object('entries', v_rows, 'counts', bob_private.admin_waitlist_counts(), 'nextCursor', v_next);
end;
$$;

create or replace function bob_private.operator_metrics_users(
  p_from timestamptz, p_to timestamptz, p_bucket text
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_accounts jsonb;
  v_signups bigint;
  v_series jsonb;
  v_day bigint;
  v_week bigint;
  v_month bigint;
  v_window bigint;
  v_activated bigint;
begin
  perform bob_private.operator_metrics_window(p_from, p_to, p_bucket);
  select jsonb_build_object(
    'total', count(*), 'enabled', count(*) filter (where banned_until is null or banned_until <= now()),
    'disabled', count(*) filter (where banned_until > now()),
    'awaitingConfirmation', count(*) filter (where (banned_until is null or banned_until <= now()) and email_confirmed_at is null)
  ), count(*) filter (where created_at >= p_from and created_at < p_to)
  into v_accounts, v_signups from auth.users
  where nullif(btrim(email), '') is not null and deleted_at is null
    and id <> '00000000-0000-4000-8000-0000000000de'::uuid;

  with signups as (
    select date_trunc(p_bucket, created_at at time zone 'UTC') as t, count(*) as n
    from auth.users where nullif(btrim(email), '') is not null and deleted_at is null
      and id <> '00000000-0000-4000-8000-0000000000de'::uuid and created_at >= p_from and created_at < p_to
    group by 1
  ) select coalesce(jsonb_agg(jsonb_build_object(
    't', to_char(b.t, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'count', coalesce(s.n, 0)
  ) order by b.t), '[]'::jsonb) into v_series
  from bob_private.operator_metrics_buckets(p_from, p_to, p_bucket) b left join signups s on s.t = b.t;

  -- Shared messages must have a real author. Personal rows created before the
  -- author column was populated may use their owner; erased authors never do.
  with activity as (
    select u.id, max(m.created_at) as last_message_at
    from bob.messages m join auth.users u on u.id =
      case when m.space_id is null then coalesce(m.author_user_id, m.user_id) else m.author_user_id end
    where m.role = 'user' and m.tombstoned_at is null and m.created_at < p_to
      and nullif(btrim(u.email), '') is not null and u.deleted_at is null
      and u.id <> '00000000-0000-4000-8000-0000000000de'::uuid
    group by u.id
  ) select count(*) filter (where last_message_at >= p_to - interval '1 day'),
      count(*) filter (where last_message_at >= p_to - interval '7 days'),
      count(*) filter (where last_message_at >= p_to - interval '30 days'),
      count(*) filter (where last_message_at >= p_from), count(*)
    into v_day, v_week, v_month, v_window, v_activated from activity;
  return jsonb_build_object(
    'window', bob_private.operator_metrics_window_doc(p_from, p_to, p_bucket),
    'accounts', v_accounts, 'signups', v_signups, 'signups_by_bucket', v_series,
    'active_users', jsonb_build_object(
      'day', case when v_day < 3 then null else v_day end,
      'week', case when v_week < 3 then null else v_week end,
      'month', case when v_month < 3 then null else v_month end,
      'in_window', case when v_window < 3 then null else v_window end),
    'activated_users', case when v_activated < 3 then null else v_activated end,
    'waitlist', bob_private.admin_waitlist_counts());
end;
$$;
revoke all on function bob_private.admin_waitlist_counts() from public, anon, authenticated;
revoke all on function bob_private.admin_waitlist_search(uuid,uuid,text,int,text,text) from public, anon, authenticated;
revoke all on function bob_private.operator_metrics_users(timestamptz,timestamptz,text) from public, anon, authenticated;
-- Counts helper stays internal; exposed functions execute as their definer.
grant execute on function bob_private.admin_waitlist_search(uuid,uuid,text,int,text,text) to bob_server;
grant execute on function bob_private.operator_metrics_users(timestamptz,timestamptz,text) to bob_server;
