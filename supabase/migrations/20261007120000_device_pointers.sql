-- Bob #900: per-device conversation/space pointers on bob.devices. Two
-- Cardputers on one account currently clobber each other's current
-- conversation because the pointer lives once per account (bob.user_state,
-- #757, 20261003120000_user_state_expand.sql). Additive and re-runnable, like
-- 20261003150000_device_settings_onto_devices.sql: a device uses its own
-- pointer when set, else callers fall back to the account pointer -- that
-- resolution and the writers are a later unit; this migration only adds the
-- storage. No backfill: a device starts with no pointer of its own.
--
-- Same column shapes as bob.user_state: a pointer is "absent" when its
-- surface column is null.

-- 1. The six pointer columns.
alter table bob.devices
  add column if not exists active_conversation_id text null
    references bob.conversations (id) on delete set null;
alter table bob.devices
  add column if not exists conversation_surface text null
    constraint devices_conversation_surface_check check (conversation_surface is null
      or conversation_surface in ('web_text','web_voice','device','picker','activate'));
alter table bob.devices
  add column if not exists conversation_changed_at timestamptz null;
alter table bob.devices
  add column if not exists active_space_id uuid null
    references bob.spaces (id) on delete set null;
alter table bob.devices
  add column if not exists space_surface text null
    constraint devices_space_surface_check check (space_surface is null or space_surface in ('web', 'device'));
alter table bob.devices
  add column if not exists space_changed_at timestamptz null;

-- 2. Indexes -- the FKs' on-delete-set-null lookups, as user_state has.
create index if not exists devices_conversation_idx on bob.devices (active_conversation_id);
create index if not exists devices_space_idx on bob.devices (active_space_id);

-- 3. A caller may only point their own device at a Space they are an active
--    member of, and only when the pointer changes (same shape as
--    bob_private.user_state_check_space). devices_update already scopes
--    rows to (select auth.uid()) = user_id, so new.active_space_id here is
--    always the device owner's own write.
create or replace function bob_private.devices_check_space()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.active_space_id is not null
     and (tg_op = 'INSERT' or new.active_space_id is distinct from old.active_space_id)
     and not bob_private.is_space_member(new.active_space_id) then
    raise exception 'new row violates row-level security policy for table "devices"'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function bob_private.devices_check_space() from public, anon, authenticated;

drop trigger if exists devices_check_space on bob.devices;
create trigger devices_check_space
  before insert or update of active_space_id on bob.devices
  for each row execute function bob_private.devices_check_space();

-- 4. Grant: the owner may update just these six columns (devices_update
--    already scopes rows to their own device). token_hash/user_id/revoked_at
--    stay ungranted, as today.
grant update (active_conversation_id, conversation_surface, conversation_changed_at,
              active_space_id, space_surface, space_changed_at)
  on bob.devices to authenticated;

-- 5. Mirrors bob_private.clear_active_conversation_in_space (user_state,
--    20261002150000_active_clear_in_space.sql): nulls a device's own
--    conversation pointer when it names a conversation in a space the caller
--    is leaving. p_user must be the caller (no account can clear another's
--    device pointers); unlike user_state this is not one row per user, so one
--    call may null more than one device at once.
create or replace function bob_private.clear_device_conversations_in_space(p_user uuid, p_space uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_user is distinct from (select auth.uid()) then
    return false;
  end if;
  update bob.devices d
     set active_conversation_id = null
   where d.user_id = p_user
     and exists (
       select 1
         from bob.conversations c
         join bob.spaces s on s.id = c.space_id
        where c.id = d.active_conversation_id
          and c.space_id = p_space
          and s.kind <> 'private'
     );
  return found;
end;
$$;

revoke all on function bob_private.clear_device_conversations_in_space(uuid, uuid) from public, anon;
grant execute on function bob_private.clear_device_conversations_in_space(uuid, uuid) to authenticated, bob_server;
