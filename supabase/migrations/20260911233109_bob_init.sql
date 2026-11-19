-- Bob init migration (T004, specs/008-supabase-auth-pairing).
-- DDL copied verbatim from data-model.md in §2.7 assembly order:
-- 1 schemas · 2 idempotent role · 3 tables (dependency order) · 4 table grants
-- · 5 functions · 6 revokes · 7 grants. auth.users already exists (Supabase);
-- PGlite tests preface this file with apps/api/tests/support/supabase-shim.sql.

-- 1. Schemas
create schema bob;
create schema bob_private;

-- 2. Role -- idempotent, so db push re-runs and the PGlite shim do not collide.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'bob_server') then
    create role bob_server login nobypassrls;
  end if;
end $$;
grant authenticated to bob_server;
-- password set manually after db push (quickstart §6)

-- 3. Tables in dependency order (§2.7 step 3): conversations → messages →
--    message_versions → devices → active_conversations → pairing_requests.

-- 3.1 bob.conversations (§2.1)
create table bob.conversations (
  id         text primary key default ('conv_' || gen_random_uuid())
             check (id ~ '^[A-Za-z0-9_-]{8,64}$'),
  user_id    uuid not null references auth.users (id) on delete cascade,
  title      text not null check (length(trim(title)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_user_updated_idx
  on bob.conversations (user_id, updated_at desc);

alter table bob.conversations enable row level security;
alter table bob.conversations force row level security;

create policy conversations_select on bob.conversations
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy conversations_insert on bob.conversations
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy conversations_update on bob.conversations
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy conversations_delete on bob.conversations
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- 3.2 bob.messages (§2.2)
create table bob.messages (
  id              text primary key default ('msg_' || gen_random_uuid())
                  check (id ~ '^[A-Za-z0-9_-]{8,64}$'),
  conversation_id text not null references bob.conversations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  position        integer not null,
  origin          text not null default 'web_text'
                  check (origin in ('web_text', 'web_voice', 'device')),
  created_at      timestamptz not null default now(),
  unique (conversation_id, position)
);

create index messages_user_id_idx on bob.messages (user_id);

alter table bob.messages enable row level security;
alter table bob.messages force row level security;

create policy messages_select on bob.messages
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy messages_insert on bob.messages
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy messages_update on bob.messages
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy messages_delete on bob.messages
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- 3.3 bob.message_versions (§2.3)
create table bob.message_versions (
  id            text primary key default ('ver_' || gen_random_uuid())
                check (id ~ '^[A-Za-z0-9_-]{8,64}$'),
  message_id    text not null references bob.messages (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  parts         jsonb not null,
  version_index integer not null,
  is_selected   boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (message_id, version_index)
);

create index message_versions_user_id_idx on bob.message_versions (user_id);

alter table bob.message_versions enable row level security;
alter table bob.message_versions force row level security;

create policy message_versions_select on bob.message_versions
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy message_versions_insert on bob.message_versions
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy message_versions_update on bob.message_versions
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy message_versions_delete on bob.message_versions
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- 3.4 bob.devices (§2.4)
create table bob.devices (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40),
  model       text not null,
  fw_version  text not null,
  token_hash  bytea null unique,   -- NULL = approved, token not yet delivered
  paired_at   timestamptz not null default now(),
  last_seen_at timestamptz null,
  revoked_at  timestamptz null
);

create index devices_user_id_idx on bob.devices (user_id);

alter table bob.devices enable row level security;
alter table bob.devices force row level security;

create policy devices_select on bob.devices
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy devices_update on bob.devices
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- 3.5 bob.active_conversations (§2.6)
create table bob.active_conversations (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  conversation_id text null references bob.conversations (id) on delete set null,
  changed_at      timestamptz not null default now(),
  surface         text not null check (surface in ('web_text','web_voice','device','picker','activate'))
);

create index active_conversations_conversation_idx
  on bob.active_conversations (conversation_id);

alter table bob.active_conversations enable row level security;
alter table bob.active_conversations force row level security;

create policy active_conversations_select on bob.active_conversations
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy active_conversations_insert on bob.active_conversations
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy active_conversations_update on bob.active_conversations
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- 3.6 bob.pairing_requests (§2.5)
create table bob.pairing_requests (
  id               uuid primary key default gen_random_uuid(),
  code_hash        bytea not null,
  claim_hash       bytea not null,
  device_model     text not null,
  fw_version       text not null,
  requested_ip_hash text not null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  status           text not null default 'pending'
                   check (status in ('pending','approved','delivered','denied','expired')),
  approved_by      uuid null references auth.users (id) on delete set null,
  device_id        uuid null references bob.devices (id) on delete set null,
  attempts         integer not null default 0
);

create unique index pairing_requests_pending_code_idx
  on bob.pairing_requests (code_hash) where status = 'pending';
create index pairing_requests_approved_by_idx on bob.pairing_requests (approved_by);
create index pairing_requests_device_id_idx on bob.pairing_requests (device_id);
create index pairing_requests_expiry_idx on bob.pairing_requests (expires_at);

alter table bob.pairing_requests enable row level security;
alter table bob.pairing_requests force row level security;
-- intentionally NO policies: authenticated sees nothing here (server-only via bob_private)

-- 4. Table grants (§2.7 step 4, §3) -- least privilege; nothing for anon/public.
grant usage on schema bob to authenticated;
revoke all on schema bob from anon, public;

grant select, insert, update, delete on bob.conversations to authenticated;
grant select, insert, delete on bob.messages to authenticated;
grant select, insert on bob.message_versions to authenticated;
grant update (is_selected) on bob.message_versions to authenticated;
grant select on bob.devices to authenticated;
grant update (name) on bob.devices to authenticated;
-- pairing_requests: NO grants to authenticated (server-only via bob_private)
grant select, insert, update on bob.active_conversations to authenticated;

-- 5. bob_private functions (§2.7 step 5, §4.1) -- SECURITY DEFINER, search_path = ''
create or replace function bob_private.device_for_token(p_token_hash bytea)
returns table (device_id uuid, user_id uuid, name text, revoked boolean, disabled boolean)
language plpgsql security definer set search_path = ''
as $$
begin
  -- touch last_seen only for non-revoked, non-disabled devices; a NULL token_hash
  -- (approved, not yet delivered) can never match p_token_hash here.
  update bob.devices d set last_seen_at = now()
    from auth.users u
   where d.token_hash = p_token_hash and d.revoked_at is null
     and u.id = d.user_id and (u.banned_until is null or u.banned_until < now());
  return query
    select d.id, d.user_id, d.name, (d.revoked_at is not null),
           (u.banned_until is not null and u.banned_until > now())
      from bob.devices d
      join auth.users u on u.id = d.user_id
     where d.token_hash = p_token_hash;
end;
$$;

create or replace function bob_private.issue_pairing(
  p_code_hash bytea, p_claim_hash bytea, p_model text, p_fw_version text,
  p_ip_hash text, p_ttl_seconds int
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  insert into bob.pairing_requests
    (id, code_hash, claim_hash, device_model, fw_version, requested_ip_hash,
     created_at, expires_at, status)
  values (gen_random_uuid(), p_code_hash, p_claim_hash, p_model, p_fw_version,
          p_ip_hash, now(), now() + make_interval(secs => p_ttl_seconds), 'pending')
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function bob_private.lookup_pairing(p_code_hash bytea)
returns table (id uuid, status text, device_model text, created_at timestamptz, expires_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated';
  end if;
  return query
    select pr.id, pr.status, pr.device_model, pr.created_at, pr.expires_at
      from bob.pairing_requests pr
     where pr.code_hash = p_code_hash and pr.status = 'pending';
end;
$$;

create or replace function bob_private.approve_pairing(p_pairing_id uuid, p_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_device_id uuid;
        v_model text; v_fw text; v_name text;
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated';
  end if;
  -- model/fw come from the pairing row; the raw token is NOT issued here (NULL hash)
  select pr.device_model, pr.fw_version
    into v_model, v_fw
    from bob.pairing_requests pr
   where pr.id = p_pairing_id and pr.status = 'pending' and pr.expires_at > now();
  if not found then
    raise exception 'pairing request not approvable';
  end if;
  v_name := coalesce(nullif(btrim(p_name), ''), left(v_model, 40));
  insert into bob.devices (user_id, name, model, fw_version, token_hash, paired_at)
  values ((select auth.uid()), v_name, v_model, v_fw, null, now())
  returning id into v_device_id;
  update bob.pairing_requests
     set status = 'approved', approved_by = (select auth.uid()), device_id = v_device_id
   where id = p_pairing_id;
  return v_device_id;
end;
$$;

create or replace function bob_private.claim_pairing(
  p_pairing_id uuid, p_claim_hash bytea, p_token_hash bytea
) returns table (device_id uuid, name text)
language plpgsql security definer set search_path = ''
as $$
declare v_device_id uuid; v_name text;
begin
  -- deliver (live push confirm) or re-deliver (same-boot resume): issue the token
  -- hash here so the raw token never has to survive a restart. Allowed only while
  -- the device has never authenticated (last_seen_at is null).
  select pr.device_id, d.name into v_device_id, v_name
    from bob.pairing_requests pr
    join bob.devices d on d.id = pr.device_id
   where pr.id = p_pairing_id
     and pr.status in ('approved', 'delivered')
     and pr.claim_hash = p_claim_hash
     and pr.expires_at > now()
     and d.last_seen_at is null;
  if v_device_id is null then
    return; -- no row returned
  end if;
  update bob.devices set token_hash = p_token_hash where id = v_device_id;
  update bob.pairing_requests set status = 'delivered' where id = p_pairing_id;
  return query select v_device_id, v_name;
end;
$$;

create or replace function bob_private.deny_pairing(p_pairing_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated';
  end if;
  update bob.pairing_requests set status = 'denied'
   where id = p_pairing_id and status = 'pending';
end;
$$;

create or replace function bob_private.touch_device(p_device_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update bob.devices set last_seen_at = now()
   where id = p_device_id and revoked_at is null;
end;
$$;

create or replace function bob_private.expire_pairings(p_now timestamptz)
returns setof uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  for v_id in
    select id from bob.pairing_requests
     where status in ('pending', 'approved', 'delivered') and expires_at < p_now
  loop
    -- delete never-authenticated device rows so no orphan "awaiting" devices remain
    delete from bob.devices d
     where d.id = (select device_id from bob.pairing_requests where id = v_id)
       and (d.token_hash is null or d.last_seen_at is null);
    update bob.pairing_requests set status = 'expired' where id = v_id;
    return next v_id;
  end loop;
  return;
end;
$$;

create or replace function bob_private.session_active(p_session_id uuid)
returns boolean
language sql security definer set search_path = ''
as $$
  select exists (
    select 1 from auth.sessions s
    join auth.users u on u.id = s.user_id
    where s.id = p_session_id and (u.banned_until is null or u.banned_until < now())
  );
$$;

create or replace function bob_private.account_disabled(p_user_id uuid)
returns boolean
language sql security definer set search_path = ''
as $$
  select exists (
    select 1 from auth.users u
    where u.id = p_user_id and u.banned_until is not null and u.banned_until > now()
  );
$$;

create or replace function bob_private.revoke_device(p_device_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update bob.devices set revoked_at = now()
   where id = p_device_id and user_id = (select auth.uid()) and revoked_at is null;
  if not found then
    raise exception 'device not found or not owned';
  end if;
end;
$$;

-- 6. Function revokes (§2.7 step 6) -- must come before the grants in step 7
revoke all on schema bob_private from public, anon, authenticated;
revoke all on all functions in schema bob_private from public;

-- 7. Function grants (§2.7 step 7)
grant usage on schema bob_private to bob_server;
grant execute on all functions in schema bob_private to bob_server;
grant usage on schema bob_private to authenticated;
grant execute on function bob_private.lookup_pairing(bytea) to authenticated;
grant execute on function bob_private.approve_pairing(uuid, text) to authenticated;
grant execute on function bob_private.deny_pairing(uuid) to authenticated;
grant execute on function bob_private.revoke_device(uuid) to authenticated;
