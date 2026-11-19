-- Conversation-only audiences reuse Space membership, never a second ACL.
alter table bob.spaces
  add column conversation_id text,
  add column group_chat_created_by uuid references auth.users(id) on delete cascade,
  add column group_chat_request_id uuid,
  add constraint group_chat_binding check (
    (conversation_id is null and group_chat_created_by is null and group_chat_request_id is null)
    or (conversation_id is not null and kind = 'group' and group_chat_created_by is not null and group_chat_request_id is not null)),
  add constraint group_chat_conversation_fk foreign key (conversation_id, id)
    references bob.conversations(id, space_id) deferrable initially deferred;
create unique index spaces_group_chat_request_idx on bob.spaces(group_chat_created_by, group_chat_request_id);
create unique index spaces_group_chat_conversation_idx on bob.spaces(conversation_id) where conversation_id is not null;

create function bob_private.guard_group_chat_binding() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.conversation_id is distinct from old.conversation_id
    or new.group_chat_created_by is distinct from old.group_chat_created_by
    or new.group_chat_request_id is distinct from old.group_chat_request_id then
    -- Erasure may anonymize creator provenance; clients cannot change it.
    if current_user = 'authenticated' or new.conversation_id is distinct from old.conversation_id then
      raise exception 'immutable group chat binding' using errcode = '23514';
    end if;
  end if;
  if old.conversation_id is not null and current_user = 'authenticated'
    and (new.kind is distinct from old.kind or new.owner_user_id is distinct from old.owner_user_id
      or new.archived_at is distinct from old.archived_at) then
    raise exception 'use group chat lifecycle' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger guard_group_chat_binding before update on bob.spaces
for each row execute function bob_private.guard_group_chat_binding();

-- A non-recursive policy lookup, with no caller-controlled identity argument.
create function bob_private.is_group_chat_space(p_space uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from bob.spaces where id = p_space and conversation_id is not null);
$$;
create function bob_private.can_bootstrap_group_chat(p_space uuid, p_user uuid, p_role text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user = auth.uid() and p_role = 'owner' and exists(
    select 1 from bob.spaces s where s.id = p_space and s.owner_user_id = auth.uid()
      and not exists(select 1 from bob.space_memberships m where m.space_id = s.id));
$$;
create policy group_chat_members_insert on bob.space_memberships as restrictive for insert to authenticated
with check (not bob_private.is_group_chat_space(space_id)
  or bob_private.can_bootstrap_group_chat(space_id, user_id, role));
create policy group_chat_members_update on bob.space_memberships as restrictive for update to authenticated
using (not bob_private.is_group_chat_space(space_id))
with check (not bob_private.is_group_chat_space(space_id));
create policy group_chat_members_delete on bob.space_memberships as restrictive for delete to authenticated
using (not bob_private.is_group_chat_space(space_id));

-- Trigger coverage is derived from the schema, including nullable resource keys.
-- Message/invocation keys already have same-conversation constraints; events are
-- delivery metadata, not additional resources in the audience.
create function bob_private.guard_conversation_audience() returns trigger
language plpgsql security definer set search_path = '' as $$
declare audience uuid; bound text;
begin
  audience := (to_jsonb(new)->>tg_argv[0])::uuid;
  select conversation_id into bound from bob.spaces where id = audience;
  if bound is null then return new; end if;
  if tg_table_name = 'conversations' and to_jsonb(new)->>'id' = bound then return new; end if;
  raise exception 'conversation-only audience' using errcode = '23514';
end;
$$;
do $$
declare col record;
begin
  for col in select table_name, column_name from information_schema.columns
    where table_schema = 'bob' and column_name in ('space_id','published_into_space_id','active_space_id')
      and table_name not in ('spaces','space_memberships','messages','message_versions','ai_invocations','outbox','notifications','notification_deliveries')
  loop
    execute format('create trigger conversation_audience_guard before insert or update on bob.%I for each row execute function bob_private.guard_conversation_audience(%L)', col.table_name, col.column_name);
  end loop;
end;
$$;

-- A link is a reusable, individually revocable lifecycle (one-to-many).
create table bob.group_chat_links (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references bob.spaces(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '7 days')
);
create index group_chat_links_space_idx on bob.group_chat_links(space_id);
create index group_chat_links_creator_idx on bob.group_chat_links(created_by);
alter table bob.group_chat_links enable row level security;
alter table bob.group_chat_links force row level security;
create policy group_chat_links_select on bob.group_chat_links for select to authenticated
using (bob_private.is_space_member(space_id));
create policy group_chat_links_insert on bob.group_chat_links for insert to authenticated
with check (created_by = auth.uid() and bob_private.is_space_member(space_id)
  and exists(select 1 from bob.spaces s where s.id = space_id and s.conversation_id is not null and s.archived_at is null));
create policy group_chat_links_update on bob.group_chat_links for update to authenticated
using (exists(select 1 from bob.spaces s where s.id = space_id and s.owner_user_id = auth.uid())
  and bob_private.is_space_member(space_id))
with check (exists(select 1 from bob.spaces s where s.id = space_id and s.owner_user_id = auth.uid())
  and bob_private.is_space_member(space_id));
grant select on bob.group_chat_links to authenticated;
grant insert(space_id, token_hash, created_by, expires_at) on bob.group_chat_links to authenticated;
grant update(revoked_at) on bob.group_chat_links to authenticated;

create function bob_private.preview_group_chat_link(p_hash text)
returns table(title text, inviter_name text, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.title, coalesce(nullif(btrim(u.raw_user_meta_data->>'name'), ''), 'A friend'), l.expires_at
  from bob.group_chat_links l join bob.spaces s on s.id = l.space_id
  join bob.conversations c on c.id = s.conversation_id
  join auth.users u on u.id = l.created_by
  where auth.uid() is not null and l.token_hash = p_hash and l.revoked_at is null
    and l.expires_at > now() and s.archived_at is null
    and exists(select 1 from bob.space_memberships m where m.space_id = s.id and m.user_id = l.created_by and m.revoked_at is null)
    and not exists(select 1 from bob.space_memberships m where m.space_id = s.id and m.user_id = auth.uid() and m.revoked_at >= l.created_at);
$$;

create function bob_private.accept_group_chat_link(p_hash text) returns text
language plpgsql security definer set search_path = '' as $$
declare link bob.group_chat_links; audience bob.spaces; previous bob.space_memberships;
begin
  if auth.uid() is null then raise exception 'invitation unavailable' using errcode = 'P0002'; end if;
  select * into link from bob.group_chat_links where token_hash = p_hash;
  if not found then raise exception 'invitation unavailable' using errcode = 'P0002'; end if;
  -- Serialize capacity, removal and admission on the same audience row.
  select * into audience from bob.spaces where id = link.space_id for update;
  select * into link from bob.group_chat_links where id = link.id for update;
  if not exists(select 1 from bob_private.preview_group_chat_link(p_hash)) then
    raise exception 'invitation unavailable' using errcode = 'P0002';
  end if;
  select * into previous from bob.space_memberships where space_id = audience.id and user_id = auth.uid();
  if found and previous.revoked_at is null then return audience.conversation_id; end if;
  if (select count(*) from bob.space_memberships where space_id = audience.id and revoked_at is null) >= 20 then
    raise exception 'group chat is full' using errcode = '23514';
  end if;
  insert into bob.space_memberships(space_id,user_id,role) values(audience.id,auth.uid(),'member')
    on conflict(space_id,user_id) do update set revoked_at = null, joined_at = now(), role = 'member';
  update bob.spaces set membership_revision = membership_revision + 1, updated_at = now() where id = audience.id;
  return audience.conversation_id;
end;
$$;

create function bob_private.remove_group_chat_member(p_conversation text, p_target uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare audience bob.spaces; successor uuid;
begin
  select * into audience from bob.spaces where conversation_id = p_conversation and archived_at is null for update;
  if not found or auth.uid() is null or not bob_private.is_space_member(audience.id)
    or (p_target <> auth.uid() and audience.owner_user_id <> auth.uid()) then
    raise exception 'group chat not found' using errcode = 'P0002';
  end if;
  if p_target = audience.owner_user_id then
    select user_id into successor from bob.space_memberships where space_id = audience.id
      and user_id <> p_target and revoked_at is null order by joined_at, user_id limit 1;
    if successor is null then
      update bob.spaces set archived_at = now() where id = audience.id;
    else
      update bob.spaces set owner_user_id = successor where id = audience.id;
      update bob.space_memberships set role = 'owner' where space_id = audience.id and user_id = successor;
    end if;
  end if;
  update bob.space_memberships set revoked_at = now(), role = 'member'
    where space_id = audience.id and user_id = p_target and revoked_at is null;
  update bob.group_chat_links set revoked_at = now() where space_id = audience.id and created_by = p_target and revoked_at is null;
  update bob.spaces set membership_revision = membership_revision + 1, updated_at = now() where id = audience.id;
end;
$$;

create function bob_private.purge_account_group_chats(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from bob.group_chat_links where created_by = p_user;
  update bob.spaces set group_chat_created_by = '00000000-0000-4000-8000-0000000000de', group_chat_request_id = gen_random_uuid()
    where group_chat_created_by = p_user;
end;
$$;
revoke all on function bob_private.purge_account_group_chats(uuid) from public, anon, authenticated;
grant execute on function bob_private.purge_account_group_chats(uuid) to bob_server;
revoke all on function bob_private.is_group_chat_space(uuid), bob_private.can_bootstrap_group_chat(uuid,uuid,text),
  bob_private.preview_group_chat_link(text), bob_private.accept_group_chat_link(text),
  bob_private.remove_group_chat_member(text,uuid) from public, anon;
grant execute on function bob_private.is_group_chat_space(uuid), bob_private.can_bootstrap_group_chat(uuid,uuid,text),
  bob_private.preview_group_chat_link(text), bob_private.accept_group_chat_link(text),
  bob_private.remove_group_chat_member(text,uuid) to authenticated;

-- Existing profile callers must not expose member email addresses through a
-- second, generic Space endpoint for conversation-only audiences.
create or replace function bob_private.space_member_profiles(p_space_id uuid)
returns table(user_id uuid, display_name text, email text)
language plpgsql stable security definer set search_path = '' as $$
declare conversation_only boolean;
begin
  if not bob_private.is_space_member(p_space_id) then return; end if;
  conversation_only := bob_private.is_group_chat_space(p_space_id);
  return query select m.user_id,
    coalesce(nullif(btrim(u.raw_user_meta_data->>'name'), ''),
      case when conversation_only then 'Member' else nullif(split_part(u.email, '@', 1), '') end),
    case when conversation_only then null::text else u.email::text end
  from bob.space_memberships m join auth.users u on u.id = m.user_id
  where m.space_id = p_space_id and m.revoked_at is null;
end;
$$;



-- Closing the final-member audience must not strand its former owner behind
-- the ordinary live-group sole-owner erasure refusal. This server-only cleanup
-- runs in the same transaction BEFORE erase_account and deletes no live group.
create function bob_private.purge_closed_group_chats(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from bob.spaces s
  where s.owner_user_id = p_user and s.conversation_id is not null
    and s.archived_at is not null
    and not exists(select 1 from bob.space_memberships m
      where m.space_id = s.id and m.revoked_at is null);
end;
$$;
revoke all on function bob_private.purge_closed_group_chats(uuid) from public, anon, authenticated;
grant execute on function bob_private.purge_closed_group_chats(uuid) to bob_server;

-- Generic thread routes remain available for messages, but cannot bypass the
-- conversation audience's owner-only rename or its explicit leave lifecycle.
create function bob_private.guard_group_chat_conversation_lifecycle() returns trigger
language plpgsql set search_path = '' as $$
declare audience_owner uuid;
begin
  if current_user <> 'authenticated' then return new; end if;
  select owner_user_id into audience_owner from bob.spaces
    where id = old.space_id and conversation_id = old.id;
  if not found then return new; end if;
  if new.archived_at is distinct from old.archived_at then
    raise exception 'use group chat lifecycle' using errcode = '42501';
  end if;
  if new.title is distinct from old.title and audience_owner is distinct from auth.uid() then
    raise exception 'only the group owner can rename' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger guard_group_chat_conversation_lifecycle before update on bob.conversations
for each row execute function bob_private.guard_group_chat_conversation_lifecycle();

-- Ordinary members cannot UPDATE the Space under RLS. This narrow helper only
-- locks an audience they belong to; the caller's transaction retains the lock
-- until the reply is persisted. Recheck membership after waiting for removal.
create function bob_private.lock_thread_audience_revision(p_space uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare revision integer;
begin
  if auth.uid() is null or not bob_private.is_space_member(p_space) then return null; end if;
  select membership_revision into revision from bob.spaces
    where id = p_space and archived_at is null for update;
  if not found or not bob_private.is_space_member(p_space) then return null; end if;
  return revision;
end;
$$;
revoke all on function bob_private.lock_thread_audience_revision(uuid) from public, anon;
grant execute on function bob_private.lock_thread_audience_revision(uuid) to authenticated;
