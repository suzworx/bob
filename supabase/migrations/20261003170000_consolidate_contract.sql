-- bob:contract #757: the six tables are folded into user_state, devices, reminders and outbox; owner approved 2026-10-02
-- #757 CONTRACT: retires bob.active_conversations, active_spaces, game_settings,
-- device_settings, timers and email_effects. Their rows already live in
-- bob.user_state (20261003120000), bob.devices (20261003150000),
-- bob.reminders (20261003160000) and bob.outbox (20261003110000); no running
-- code reads or writes the old tables. No personal data is deleted that the new
-- homes do not already hold: step 1 re-copies whatever an old server wrote
-- during the rollout, step 2 removes the old-table steps from the definers,
-- step 3 drops the tables (their policies, indexes and grants go with them).
-- Every step on an old table is guarded by to_regclass (a lagging database
-- still applies), and the file re-runs. No vector / pg_cron / pgmq, so it
-- applies under PGlite.

-- 1. Re-copy rollout writes. The space-membership trigger is dropped for the
--    copy (the migration role is no member of anything) and created again after.
drop trigger if exists user_state_check_space on bob.user_state;

do $$
begin
  if to_regclass('bob.active_conversations') is not null then
    execute $q$
      insert into bob.user_state as us
        (user_id, active_conversation_id, conversation_surface, conversation_changed_at)
      select ac.user_id, ac.conversation_id, ac.surface, ac.changed_at
        from bob.active_conversations ac
      on conflict (user_id) do update set
        active_conversation_id  = excluded.active_conversation_id,
        conversation_surface    = excluded.conversation_surface,
        conversation_changed_at = excluded.conversation_changed_at
      where us.conversation_surface is null
         or us.conversation_changed_at is null
         or excluded.conversation_changed_at > us.conversation_changed_at
    $q$;
  end if;

  if to_regclass('bob.active_spaces') is not null then
    execute $q$
      insert into bob.user_state as us
        (user_id, active_space_id, space_surface, space_changed_at)
      select asp.user_id, asp.space_id, asp.surface, asp.changed_at
        from bob.active_spaces asp
      on conflict (user_id) do update set
        active_space_id  = excluded.active_space_id,
        space_surface    = excluded.space_surface,
        space_changed_at = excluded.space_changed_at
      where us.space_surface is null
         or us.space_changed_at is null
         or excluded.space_changed_at > us.space_changed_at
    $q$;
  end if;

  if to_regclass('bob.game_settings') is not null then
    execute $q$
      insert into bob.user_state as us
        (user_id, games_enabled, games_kids_mode, games_max_band, games_allowed_games,
         games_daily_limit_minutes, games_quiet_start, games_quiet_end, games_updated_at)
      select gs.user_id, gs.enabled, gs.kids_mode, gs.max_band, gs.allowed_games,
             gs.daily_limit_minutes, gs.quiet_start, gs.quiet_end, gs.updated_at
        from bob.game_settings gs
      on conflict (user_id) do update set
        games_enabled             = excluded.games_enabled,
        games_kids_mode           = excluded.games_kids_mode,
        games_max_band            = excluded.games_max_band,
        games_allowed_games       = excluded.games_allowed_games,
        games_daily_limit_minutes = excluded.games_daily_limit_minutes,
        games_quiet_start         = excluded.games_quiet_start,
        games_quiet_end           = excluded.games_quiet_end,
        games_updated_at          = excluded.games_updated_at
      where us.games_updated_at is null or excluded.games_updated_at > us.games_updated_at
    $q$;
  end if;

  if to_regclass('bob.device_settings') is not null then
    execute $q$
      update bob.devices d
         set volume = s.volume, muted = s.muted, mode = s.mode, dnd = s.dnd,
             settings_updated_at = s.updated_at, pending_push = s.pending_push,
             device_reported = s.device_reported, ring_seconds = s.ring_seconds,
             ring_sound = s.ring_sound, ring_reported = s.ring_reported
        from bob.device_settings s
       where s.device_id = d.id
         and (d.settings_updated_at is null or s.updated_at > d.settings_updated_at)
    $q$;
  end if;

  if to_regclass('bob.timers') is not null then
    -- The mapping of 20261003160000: a private space per user, same id, no recipients.
    execute $q$
      insert into bob.spaces (id, kind, name, owner_user_id)
      select gen_random_uuid(), 'private', 'Private', u.id
        from auth.users u
       where u.id in (select t.user_id from bob.timers t)
         and u.id <> '00000000-0000-4000-8000-0000000000de'
      on conflict (owner_user_id) where kind = 'private' do nothing
    $q$;
    execute $q$
      insert into bob.space_memberships (space_id, user_id, role)
      select s.id, s.owner_user_id, 'owner'
        from bob.spaces s
       where s.kind = 'private'
         and s.owner_user_id in (select t.user_id from bob.timers t)
      on conflict (space_id, user_id) do nothing
    $q$;
    execute $q$
      insert into bob.reminders (
        id, space_id, created_by, kind, title, due_at, due_zone, duration_ms,
        status, fired_at, created_at, updated_at
      )
      select t.id, s.id, t.user_id, t.kind, t.label, t.fires_at, 'UTC', t.duration_ms,
             t.status, t.fired_at, t.created_at, t.created_at
        from bob.timers t
        join bob.spaces s on s.kind = 'private' and s.owner_user_id = t.user_id
      on conflict (id) do nothing
    $q$;
    execute $q$
      update bob.reminders r
         set status = t.status, fired_at = t.fired_at, updated_at = now()
        from bob.timers t
       where t.id = r.id and r.status = 'pending' and t.status <> 'pending'
    $q$;
  end if;

  if to_regclass('bob.email_effects') is not null then
    execute $q$
      update bob.outbox o
         set email_sent_at = e.sent_at, recipient_user_id = e.recipient_user_id
        from bob.email_effects e
       where e.effect_key = o.effect_key and o.email_sent_at is null
    $q$;
  end if;
end;
$$;

create trigger user_state_check_space
  before insert or update of active_space_id on bob.user_state
  for each row execute function bob_private.user_state_check_space();

-- 2. The definers without their old-table steps: same signatures and grants,
--    the newest bodies otherwise unchanged.
create or replace function bob_private.email_effect_sent(p_effect_key text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from bob.outbox where effect_key = p_effect_key and email_sent_at is not null);
$$;

create or replace function bob_private.purge_account_email_effects(p_user_id uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_total integer;
begin
  delete from bob.outbox where recipient_user_id = p_user_id and event_type = 'email.notification';
  get diagnostics v_total = row_count;
  return v_total;
end;
$$;

create or replace function bob_private.clear_active_conversation_in_space(p_user uuid, p_space uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_user is distinct from (select auth.uid()) then
    return false;
  end if;
  update bob.user_state u
     set active_conversation_id = null
   where u.user_id = p_user
     and exists (
       select 1
         from bob.conversations c
         join bob.spaces s on s.id = c.space_id
        where c.id = u.active_conversation_id
          and c.space_id = p_space
          and s.kind <> 'private'
     );
  return found;
end;
$$;

create or replace function bob_private.purge_account_games(p_user_id uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_total integer := 0;
  v_touched integer;
begin
  delete from bob.game_sessions where user_id = p_user_id;
  get diagnostics v_touched = row_count; v_total := v_total + v_touched;
  delete from bob.game_usage where user_id = p_user_id;
  get diagnostics v_touched = row_count; v_total := v_total + v_touched;
  update bob.user_state
     set games_enabled = default, games_kids_mode = default, games_max_band = default,
         games_allowed_games = default, games_daily_limit_minutes = default,
         games_quiet_start = null, games_quiet_end = null, games_updated_at = null
   where user_id = p_user_id;
  return v_total;
end;
$$;

revoke all on function bob_private.email_effect_sent(text) from public, anon, authenticated;
grant execute on function bob_private.email_effect_sent(text) to bob_server;
revoke all on function bob_private.purge_account_email_effects(uuid) from public, anon, authenticated;
grant execute on function bob_private.purge_account_email_effects(uuid) to bob_server;
revoke all on function bob_private.clear_active_conversation_in_space(uuid, uuid) from public, anon;
grant execute on function bob_private.clear_active_conversation_in_space(uuid, uuid) to authenticated, bob_server;
revoke all on function bob_private.purge_account_games(uuid) from public, anon, authenticated;
grant execute on function bob_private.purge_account_games(uuid) to bob_server;

-- erase_account: the body of 20261003160000_timers_into_reminders.sql minus the
-- steps on the six old tables.
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

  -- The account's timers and alarms are personal state, not shared work: delete
  -- them before any step below anonymizes reminders.created_by.
  delete from bob.reminders where created_by = p_user_id and kind <> 'reminder';
  get diagnostics v_touched = row_count; v_assignments_cleared := v_assignments_cleared + v_touched;

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

  -- #756: the unified conversations' read markers.
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

  delete from bob.user_state where user_id = p_user_id;
  get diagnostics v_touched = row_count; v_assignments_cleared := v_assignments_cleared + v_touched;

  -- The settings on the devices: reset to the defaults (the revoked device
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

-- 3. The six old tables (their policies, indexes and grants go with them).
drop table if exists bob.active_conversations;
drop table if exists bob.active_spaces;
drop table if exists bob.game_settings;
drop table if exists bob.device_settings;
drop table if exists bob.timers;
drop table if exists bob.email_effects;
