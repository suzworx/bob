-- Bob #757 merge 2 (expand): bob.device_settings becomes columns on
-- bob.devices. Additive and re-runnable; bob.device_settings is neither
-- dropped nor altered, so the old code keeps working until the switch ships.
--
-- settings_updated_at is the old updated_at, nullable with no default: NULL
-- means "no stored settings" (the old table's "no row"). The other nine columns
-- keep the old types, defaults and checks; the settings reads and writes of the
-- API (identity/devices/settings-store.ts) switch to them in the same change.

-- 1. The ten settings columns.
alter table bob.devices
  add column if not exists volume smallint not null default 6
    constraint devices_volume_check check (volume between 0 and 10);
alter table bob.devices
  add column if not exists muted boolean not null default false;
alter table bob.devices
  add column if not exists mode text not null default 'ptt'
    constraint devices_mode_check check (mode in ('ptt', 'wake', 'announce_only'));
alter table bob.devices
  add column if not exists dnd boolean not null default false;
alter table bob.devices
  add column if not exists settings_updated_at timestamptz null;
alter table bob.devices
  add column if not exists pending_push boolean not null default false;
alter table bob.devices
  add column if not exists device_reported boolean not null default false;
alter table bob.devices
  add column if not exists ring_seconds smallint not null default 30
    constraint devices_ring_seconds_check check (ring_seconds between 10 and 120);
alter table bob.devices
  add column if not exists ring_sound text not null default 'classic'
    constraint devices_ring_sound_check check (ring_sound in ('classic', 'chime', 'pulse'));
alter table bob.devices
  add column if not exists ring_reported boolean not null default false;

-- 2. Backfill from the old table, by device id. Only devices still without
--    stored settings are touched, so a re-run (or a write made after the
--    switch) is never overwritten.
do $$
begin
  if to_regclass('bob.device_settings') is not null then
    update bob.devices d
       set volume = s.volume, muted = s.muted, mode = s.mode, dnd = s.dnd,
           settings_updated_at = s.updated_at, pending_push = s.pending_push,
           device_reported = s.device_reported, ring_seconds = s.ring_seconds,
           ring_sound = s.ring_sound, ring_reported = s.ring_reported
      from bob.device_settings s
     where s.device_id = d.id and d.settings_updated_at is null;
  end if;
end;
$$;

-- 3. Grants: the old table let the owner insert and update every column of the
--    settings row (RLS scoped it to their own devices), so the owner may update
--    just these ten columns here. Identity columns (token_hash, user_id, ...)
--    stay ungranted. The devices update policy scopes rows to the caller; the
--    revoked-device refusal of the old insert/update policy is in the API's
--    WHERE clause (revoked_at is null).
grant update (volume, muted, mode, dnd, settings_updated_at, pending_push,
              device_reported, ring_seconds, ring_sound, ring_reported)
  on bob.devices to authenticated;

-- 4. erase_account: the body of 20261003120000_user_state_expand.sql plus the
--    reset of the account's devices' settings (the revoked device rows stay).
--    The old table's delete goes through a guarded execute so a later drop of
--    bob.device_settings needs no rewrite of this function.
create or replace function bob_private.erase_account(p_user_id uuid, p_now timestamptz)
returns table (
  anonymized int,
  "assignmentsCleared" int,
  "privateSpacesDeleted" int,
  "membershipsRevoked" int,
  "jobsInvalidated" int
)
language plpgsql security definer set search_path = ''
as $$
declare
  v_owned int;
  v_anonymized int := 0;
  v_assignments_cleared int := 0;
  v_private_spaces_deleted int := 0;
  v_memberships_revoked int := 0;
  v_jobs_invalidated int := 0;
  v_touched int;
begin
  -- Guard: an account that still SOLELY owns a group must transfer or delete
  -- it first. Counts only, never a group name.
  select count(*)::int into v_owned
    from bob.spaces s
   where s.kind = 'group'
     and s.owner_user_id = p_user_id
     and not exists (
       select 1 from bob.space_memberships m
        where m.space_id = s.id
          and m.user_id <> p_user_id
          and m.role = 'owner'
          and m.revoked_at is null
     );
  if v_owned > 0 then
    raise exception 'bob: account still owns % group(s); transfer or delete before erasing', v_owned
      using errcode = 'OX001', detail = v_owned::text;
  end if;

  -- The sentinel authorship is repointed to (GoTrue-safe insert; keep the id
  -- in sync with ERASED_USER_ID in apps/api/src/core/erasure.ts).
  insert into auth.users (
    id, email, aud, role, confirmation_token, recovery_token, email_change,
    email_change_token_new, email_change_token_current, phone_change,
    phone_change_token, reauthentication_token
  )
  values (
    '00000000-0000-4000-8000-0000000000de', 'erased@bob.local',
    'authenticated', 'authenticated', '', '', '', '', '', '', '', ''
  )
  on conflict (id) do nothing;

  -- Anonymize authorship on the original eight columns.
  update bob.tasks set created_by = '00000000-0000-4000-8000-0000000000de'
   where created_by = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.tasks set completed_by = '00000000-0000-4000-8000-0000000000de'
   where completed_by = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.notes set created_by = '00000000-0000-4000-8000-0000000000de'
   where created_by = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.notes set updated_by = '00000000-0000-4000-8000-0000000000de'
   where updated_by = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.note_revisions set editor_user_id = '00000000-0000-4000-8000-0000000000de'
   where editor_user_id = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  -- Clear the erased account's trace on other people's task lists.
  update bob.tasks set assignee_user_id = null where assignee_user_id = p_user_id;
  get diagnostics v_touched = row_count; v_assignments_cleared := v_assignments_cleared + v_touched;

  delete from bob.task_subscribers where user_id = p_user_id;
  get diagnostics v_touched = row_count; v_assignments_cleared := v_assignments_cleared + v_touched;

  -- #756: the unified conversations' read markers, as thread_reads.
  delete from bob.conversation_reads where user_id = p_user_id;
  get diagnostics v_touched = row_count; v_assignments_cleared := v_assignments_cleared + v_touched;

  -- Delete the account's private spaces and, by cascade, everything inside
  -- them (private reminders, calendars and events included).
  delete from bob.spaces where kind = 'private' and owner_user_id = p_user_id;
  get diagnostics v_touched = row_count; v_private_spaces_deleted := v_touched;

  -- #756: anonymize the unified conversations that remain (shared spaces).
  update bob.conversations set created_by = '00000000-0000-4000-8000-0000000000de'
   where created_by = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.messages set author_user_id = '00000000-0000-4000-8000-0000000000de'
   where author_user_id = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.messages set tombstoned_by = '00000000-0000-4000-8000-0000000000de'
   where tombstoned_by = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  -- #513: anonymize the shared work that remains, now only in group spaces.
  update bob.reminders set created_by = '00000000-0000-4000-8000-0000000000de'
   where created_by = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.calendars set created_by = '00000000-0000-4000-8000-0000000000de'
   where created_by = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.calendar_events set organizer_user_id = '00000000-0000-4000-8000-0000000000de'
   where organizer_user_id = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.ai_invocations set actor_user_id = '00000000-0000-4000-8000-0000000000de'
   where actor_user_id = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.publications set actor_user_id = '00000000-0000-4000-8000-0000000000de'
   where actor_user_id = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.space_invitations set created_by = '00000000-0000-4000-8000-0000000000de'
   where created_by = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.space_invitations set accepted_by = null where accepted_by = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.pairing_requests set approved_by = null where approved_by = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  -- Hand a co-owned group to the longest-standing other active owner (the
  -- guard above guarantees one exists for every group still owned here).
  update bob.spaces s
     set owner_user_id = (
           select m.user_id from bob.space_memberships m
            where m.space_id = s.id and m.user_id <> p_user_id
              and m.role = 'owner' and m.revoked_at is null
            order by m.joined_at, m.id
            limit 1
         ),
         membership_revision = s.membership_revision + 1,
         updated_at = p_now
   where s.kind = 'group' and s.owner_user_id = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  -- #513: clear the account's own per-user state.
  delete from bob.reminder_recipients where user_id = p_user_id;
  get diagnostics v_touched = row_count; v_assignments_cleared := v_assignments_cleared + v_touched;

  delete from bob.reminder_occurrences where user_id = p_user_id;
  get diagnostics v_touched = row_count; v_assignments_cleared := v_assignments_cleared + v_touched;

  delete from bob.event_attendees where user_id = p_user_id;
  get diagnostics v_touched = row_count; v_assignments_cleared := v_assignments_cleared + v_touched;

  delete from bob.timers where user_id = p_user_id;
  get diagnostics v_touched = row_count; v_assignments_cleared := v_assignments_cleared + v_touched;

  delete from bob.active_spaces where user_id = p_user_id;
  get diagnostics v_touched = row_count; v_assignments_cleared := v_assignments_cleared + v_touched;

  delete from bob.active_conversations where user_id = p_user_id;
  get diagnostics v_touched = row_count; v_assignments_cleared := v_assignments_cleared + v_touched;

  delete from bob.user_state where user_id = p_user_id;
  get diagnostics v_touched = row_count; v_assignments_cleared := v_assignments_cleared + v_touched;

  -- The old settings table, while it still exists.
  if to_regclass('bob.device_settings') is not null then
    execute 'delete from bob.device_settings ds using bob.devices d
              where d.id = ds.device_id and d.user_id = $1' using p_user_id;
    get diagnostics v_touched = row_count; v_assignments_cleared := v_assignments_cleared + v_touched;
  end if;

  -- The settings now on the devices: reset to the defaults (the revoked device
  -- rows themselves stay); a device with no stored settings is already there.
  update bob.devices
     set volume = default, muted = default, mode = default, dnd = default,
         settings_updated_at = null, pending_push = default,
         device_reported = default, ring_seconds = default,
         ring_sound = default, ring_reported = default
   where user_id = p_user_id and settings_updated_at is not null;
  get diagnostics v_touched = row_count; v_assignments_cleared := v_assignments_cleared + v_touched;

  -- Revoke memberships (history preserved, not deleted).
  update bob.space_memberships
     set revoked_at = p_now
   where user_id = p_user_id and revoked_at is null;
  get diagnostics v_touched = row_count; v_memberships_revoked := v_touched;

  -- Invalidate the erased actor's undelivered, unleased outbox work.
  update bob.outbox
     set delivered_at = p_now, lease_owner = null, lease_expires_at = null
   where delivered_at is null
     and lease_owner is null
     and lease_expires_at is null
     and payload ->> 'actor_user_id' = p_user_id::text;
  get diagnostics v_touched = row_count; v_jobs_invalidated := v_touched;

  return query
    select v_anonymized, v_assignments_cleared, v_private_spaces_deleted,
           v_memberships_revoked, v_jobs_invalidated;
end;
$$;

revoke all on function bob_private.erase_account(uuid, timestamptz) from public, anon, authenticated;
grant execute on function bob_private.erase_account(uuid, timestamptz) to bob_server;
