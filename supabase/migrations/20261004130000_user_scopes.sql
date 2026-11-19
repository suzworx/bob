-- Bob user scopes (ANL-SCOPE1): permissions assigned to accounts as scopes,
-- a short lowercase dotted name such as metrics.operator (may read the
-- operator metrics API). This is the data layer only: a server-only
-- (user, scope) table and the definers that check, grant and revoke a scope.
-- A later unit points the API gate at it and adds the admin CLI.
--
-- Privacy: the table holds an account id, a scope name and a timestamp, and
-- nothing else. No grantor, no note, no email, no free text. Deleting the auth
-- user cascades the rows away. Error messages never carry an id or an email.
--
-- Server-only, following the outbox assembly order: 1 table, 2 indexes,
-- 3 enable and force RLS, 4 policies (NONE), 5 grants (NONE on the table).
-- The only way in is the bob_private definers below, granted to bob_server
-- alone. The *_by_email variants and user_scopes_for_email serve the admin CLI,
-- which runs as the database admin. Idempotent.

-- 1. Table.
create table if not exists bob.user_scopes (
  user_id    uuid not null references auth.users (id) on delete cascade,
  scope      text not null check (scope ~ '^[a-z][a-z0-9_.]{1,63}$'),
  granted_at timestamptz not null default now(),
  primary key (user_id, scope)
);

-- 2. Index: who holds a scope.
create index if not exists user_scopes_scope_idx
  on bob.user_scopes (scope);

-- 3. RLS, forced, with no policies: this table is server-only.
alter table bob.user_scopes enable row level security;
alter table bob.user_scopes force row level security;

-- 4. Policies: none by design.

-- 5. Grants: none. Access is through the definers below only.
revoke all on bob.user_scopes from public, anon, authenticated;

-- 6. Definers.
create or replace function bob_private.user_has_scope(p_user uuid, p_scope text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select true from bob.user_scopes s where s.user_id = p_user and s.scope = p_scope),
    false);
$$;

create or replace function bob_private.grant_user_scope(p_user uuid, p_scope text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  n integer;
begin
  if not exists (select 1 from auth.users u where u.id = p_user) then
    raise exception 'grant_user_scope: unknown user' using errcode = 'P0002';
  end if;
  insert into bob.user_scopes (user_id, scope) values (p_user, p_scope)
    on conflict (user_id, scope) do nothing;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

create or replace function bob_private.revoke_user_scope(p_user uuid, p_scope text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  n integer;
begin
  delete from bob.user_scopes where user_id = p_user and scope = p_scope;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

create or replace function bob_private.user_scopes_for_email(p_email text)
returns text[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(s.scope order by s.scope), '{}'::text[])
    from bob.user_scopes s
    join auth.users u on u.id = s.user_id
   where lower(u.email) = lower(p_email);
$$;

create or replace function bob_private.grant_user_scope_by_email(p_email text, p_scope text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid;
begin
  select u.id into v_user from auth.users u where lower(u.email) = lower(p_email) limit 1;
  if v_user is null then
    raise exception 'unknown_account' using errcode = 'P0002';
  end if;
  return bob_private.grant_user_scope(v_user, p_scope);
end;
$$;

create or replace function bob_private.revoke_user_scope_by_email(p_email text, p_scope text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid;
begin
  select u.id into v_user from auth.users u where lower(u.email) = lower(p_email) limit 1;
  if v_user is null then
    raise exception 'unknown_account' using errcode = 'P0002';
  end if;
  return bob_private.revoke_user_scope(v_user, p_scope);
end;
$$;

-- Erasure: bob_private.erase_account keeps the auth.users row (it tombstones
-- it), so the on delete cascade above never fires on account erasure. The
-- erasure transaction (identity/erasure/store.ts) calls this instead, next to
-- purge_account_games and purge_account_email_effects.
create or replace function bob_private.purge_account_scopes(p_user uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_total integer;
begin
  delete from bob.user_scopes where user_id = p_user;
  get diagnostics v_total = row_count;
  return v_total;
end;
$$;

-- 7. Function grants: EXECUTE to the server role only.
revoke all on function bob_private.purge_account_scopes(uuid) from public, anon, authenticated;
grant execute on function bob_private.purge_account_scopes(uuid) to bob_server;
revoke all on function bob_private.user_has_scope(uuid, text) from public, anon, authenticated;
grant execute on function bob_private.user_has_scope(uuid, text) to bob_server;
revoke all on function bob_private.grant_user_scope(uuid, text) from public, anon, authenticated;
grant execute on function bob_private.grant_user_scope(uuid, text) to bob_server;
revoke all on function bob_private.revoke_user_scope(uuid, text) from public, anon, authenticated;
grant execute on function bob_private.revoke_user_scope(uuid, text) to bob_server;
revoke all on function bob_private.user_scopes_for_email(text) from public, anon, authenticated;
grant execute on function bob_private.user_scopes_for_email(text) to bob_server;
revoke all on function bob_private.grant_user_scope_by_email(text, text) from public, anon, authenticated;
grant execute on function bob_private.grant_user_scope_by_email(text, text) to bob_server;
revoke all on function bob_private.revoke_user_scope_by_email(text, text) from public, anon, authenticated;
grant execute on function bob_private.revoke_user_scope_by_email(text, text) to bob_server;
