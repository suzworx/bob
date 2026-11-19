-- Web account management: server-only reads and serialized fixed mutations.
create or replace function bob_private.web_session_active(p_user uuid, p_session uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.sessions s join auth.users u on u.id = s.user_id
    where s.id = p_session and s.user_id = p_user
      and u.deleted_at is null and u.id <> '00000000-0000-4000-8000-0000000000de'::uuid
      and (u.banned_until is null or u.banned_until <= now())
  );
$$;

create or replace function bob_private.admin_accounts_search(
  p_actor uuid, p_session uuid, p_query text, p_limit int, p_cursor text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_counts jsonb;
  v_rows jsonb;
  v_after_time timestamptz;
  v_after_id uuid;
  v_next text;
begin
  if not bob_private.web_session_active(p_actor, p_session) or not exists (
    select 1 from bob.user_scopes where user_id = p_actor and scope = 'accounts.admin'
  ) then raise exception 'admin_required' using errcode = '42501'; end if;
  if p_query is null or length(p_query) > 254 or p_limit is null or p_limit not between 1 and 50 then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  if p_cursor is not null and length(p_cursor) > 512 then
    raise exception 'invalid_cursor' using errcode = '22023';
  end if;
  if p_cursor is not null then
    begin
      v_after_time := (p_cursor::jsonb ->> 'createdAt')::timestamptz;
      v_after_id := (p_cursor::jsonb ->> 'id')::uuid;
      if v_after_time is null or v_after_id is null then raise exception 'invalid_cursor'; end if;
    exception when others then raise exception 'invalid_cursor' using errcode = '22023'; end;
  end if;
  select jsonb_build_object(
    'total', count(*),
    'enabled', count(*) filter (where banned_until is null or banned_until <= now()),
    'disabled', count(*) filter (where banned_until > now()),
    'awaitingConfirmation', count(*) filter (where (banned_until is null or banned_until <= now()) and email_confirmed_at is null)
  ) into v_counts from auth.users
    where nullif(btrim(email), '') is not null and deleted_at is null and id <> '00000000-0000-4000-8000-0000000000de'::uuid;
  with candidates as (
    select u.id, u.email, coalesce(u.created_at, 'epoch'::timestamptz) as created_at,
      u.last_sign_in_at, u.email_confirmed_at,
      case when u.banned_until > now() then 'disabled' else 'enabled' end as status,
      exists(select 1 from bob.user_scopes s where s.user_id = u.id and s.scope = 'accounts.admin') as is_admin
    from auth.users u
    where nullif(btrim(u.email), '') is not null and u.deleted_at is null and u.id <> '00000000-0000-4000-8000-0000000000de'::uuid
      and starts_with(lower(coalesce(u.email, '')), lower(p_query))
      and (v_after_id is null or (coalesce(u.created_at, 'epoch'::timestamptz), u.id) > (v_after_time, v_after_id))
    order by coalesce(u.created_at, 'epoch'::timestamptz), u.id limit p_limit + 1
  ) select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'email', email, 'createdAt', created_at, 'lastSignInAt', last_sign_in_at,
    'status', status, 'isAdmin', is_admin, 'emailConfirmed', email_confirmed_at is not null
  ) order by created_at,id), '[]'::jsonb) into v_rows from candidates;
  if jsonb_array_length(v_rows) > p_limit then
    v_rows := v_rows - p_limit;
    v_next := jsonb_build_object('createdAt', v_rows->(p_limit-1)->>'createdAt', 'id', v_rows->(p_limit-1)->>'id')::text;
  end if;
  return jsonb_build_object('accounts', v_rows, 'counts', v_counts, 'nextCursor', v_next);
end;
$$;

create or replace function bob_private.admin_account_mutate(
  p_actor uuid, p_session uuid, p_target uuid, p_action text
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_is_admin boolean;
  v_enabled boolean;
begin
  -- All web role/status writes serialize before reading fresh actor authority.
  perform pg_advisory_xact_lock(11201119);
  if not bob_private.web_session_active(p_actor, p_session) or not exists (
    select 1 from bob.user_scopes where user_id = p_actor and scope = 'accounts.admin'
  ) then return 'forbidden'; end if;
  if p_action not in ('disable','enable','grant_admin','revoke_admin') or p_action is null then
    return 'invalid_action';
  end if;
  if not exists (select 1 from auth.users where id = p_target and nullif(btrim(email), '') is not null and deleted_at is null
    and id <> '00000000-0000-4000-8000-0000000000de'::uuid) then return 'not_found'; end if;
  if p_actor = p_target and p_action in ('disable','revoke_admin') then return 'self_protected'; end if;
  select exists(select 1 from bob.user_scopes where user_id = p_target and scope = 'accounts.admin'),
    (banned_until is null or banned_until <= now()) into v_is_admin, v_enabled
    from auth.users where id = p_target for update;
  if p_action in ('disable','revoke_admin') and v_is_admin and v_enabled and not exists (
    select 1 from auth.users u join bob.user_scopes s on s.user_id = u.id and s.scope = 'accounts.admin'
    where u.id <> p_target and nullif(btrim(u.email), '') is not null and u.deleted_at is null and u.id <> '00000000-0000-4000-8000-0000000000de'::uuid
      and (u.banned_until is null or u.banned_until <= now())
  ) then return 'last_admin'; end if;
  if p_action = 'disable' then
    update auth.users set banned_until = now() + interval '876000 hours' where id = p_target;
    -- Supabase's FK cascades refresh tokens belonging to these sessions.
    delete from auth.sessions where user_id = p_target;
  elsif p_action = 'enable' then
    update auth.users set banned_until = null where id = p_target;
  elsif p_action = 'grant_admin' then
    insert into bob.user_scopes(user_id, scope) values(p_target, 'accounts.admin') on conflict do nothing;
  else
    delete from bob.user_scopes where user_id = p_target and scope = 'accounts.admin';
  end if;
  return 'updated';
end;
$$;
revoke all on function bob_private.web_session_active(uuid,uuid) from public, anon, authenticated;
revoke all on function bob_private.admin_accounts_search(uuid,uuid,text,int,text) from public, anon, authenticated;
revoke all on function bob_private.admin_account_mutate(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function bob_private.web_session_active(uuid,uuid) to bob_server;
grant execute on function bob_private.admin_accounts_search(uuid,uuid,text,int,text) to bob_server;
grant execute on function bob_private.admin_account_mutate(uuid,uuid,uuid,text) to bob_server;
