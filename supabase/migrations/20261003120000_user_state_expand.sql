-- #757 merges 1 and 3, expand step: bob.user_state, one row per account,
-- carries what bob.active_conversations, bob.active_spaces and
-- bob.game_settings carry today. Additive and re-runnable: the three old
-- tables, their policies and grants are not touched, so the running server keeps
-- working until the stores switch (same PR, later units).
--
-- A pointer is "absent" when its surface column is null (old tables: no row).
-- games_updated_at is null until the settings are first saved, so readers can
-- keep "no saved settings means defaults". conversation ids are text
-- (bob.conversations.id is text, e.g. 'conv_<uuid>'); space ids are uuid.

-- 1. bob.user_state
create table if not exists bob.user_state (
  user_id                   uuid primary key references auth.users (id) on delete cascade,
  active_conversation_id    text null references bob.conversations (id) on delete set null,
  conversation_surface      text null check (conversation_surface is null
                            or conversation_surface in ('web_text','web_voice','device','picker','activate')),
  conversation_changed_at   timestamptz null,
  active_space_id           uuid null references bob.spaces (id) on delete set null,
  space_surface             text null check (space_surface is null or space_surface in ('web', 'device')),
  space_changed_at          timestamptz null,
  games_enabled             boolean not null default true,
  games_kids_mode           boolean not null default true,
  games_max_band            text not null default 'kid' check (games_max_band in ('little', 'kid', 'grown')),
  games_allowed_games       text[] not null
                            default array['animal_riddles', 'simon_says', 'family_quiz', 'twenty_questions', 'silly_stories']
                            check (games_allowed_games <@ array['animal_riddles', 'simon_says', 'family_quiz',
                                                                'twenty_questions', 'silly_stories']),
  games_daily_limit_minutes integer not null default 45 check (games_daily_limit_minutes between 1 and 600),
  games_quiet_start         text null check (games_quiet_start is null or games_quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  games_quiet_end           text null check (games_quiet_end is null or games_quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  games_updated_at          timestamptz null,
  check ((games_quiet_start is null) = (games_quiet_end is null))
);

-- 2. Indexes -- the FKs' on-delete-set-null lookups, as the old tables had.
create index if not exists user_state_conversation_idx on bob.user_state (active_conversation_id);
create index if not exists user_state_space_idx on bob.user_state (active_space_id);

-- 3. RLS
alter table bob.user_state enable row level security;
alter table bob.user_state force row level security;

-- 4. Policies: a caller reads and writes only their own row; no delete policy
--    (the old tables had none). Space membership is a trigger, below, so a
--    stale space pointer never blocks an unrelated game-setting write.
drop policy if exists user_state_select on bob.user_state;
create policy user_state_select on bob.user_state
  for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists user_state_insert on bob.user_state;
create policy user_state_insert on bob.user_state
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists user_state_update on bob.user_state;
create policy user_state_update on bob.user_state
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- 5. Grants (bob_server inherits authenticated) -- nothing for anon/public.
grant select, insert, update on bob.user_state to authenticated;

-- 6. A caller may only point the row at nothing or at a Space they are an
--    active member of, and only when the pointer changes. Same error as the old
--    active_spaces policy raised.
create or replace function bob_private.user_state_check_space()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.active_space_id is not null
     and (tg_op = 'INSERT' or new.active_space_id is distinct from old.active_space_id)
     and not bob_private.is_space_member(new.active_space_id) then
    raise exception 'new row violates row-level security policy for table "user_state"'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function bob_private.user_state_check_space() from public, anon, authenticated;

-- Dropped here and created again after the backfill: the backfill copies
-- pointers as the migration role, which is no member of anything.
drop trigger if exists user_state_check_space on bob.user_state;

-- 7. Backfill: one row per account in any of the three tables. Fills only what
--    is still null (game columns: only while never saved), so a re-run changes
--    nothing.
do $$
begin
  if to_regclass('bob.active_conversations') is not null
     and to_regclass('bob.active_spaces') is not null then
    insert into bob.user_state as us
      (user_id, active_conversation_id, conversation_surface, conversation_changed_at,
       active_space_id, space_surface, space_changed_at)
    select coalesce(ac.user_id, asp.user_id), ac.conversation_id, ac.surface, ac.changed_at,
           asp.space_id, asp.surface, asp.changed_at
      from bob.active_conversations ac
      full outer join bob.active_spaces asp on asp.user_id = ac.user_id
    on conflict (user_id) do update set
      active_conversation_id  = coalesce(us.active_conversation_id, excluded.active_conversation_id),
      conversation_surface    = coalesce(us.conversation_surface, excluded.conversation_surface),
      conversation_changed_at = coalesce(us.conversation_changed_at, excluded.conversation_changed_at),
      active_space_id         = coalesce(us.active_space_id, excluded.active_space_id),
      space_surface           = coalesce(us.space_surface, excluded.space_surface),
      space_changed_at        = coalesce(us.space_changed_at, excluded.space_changed_at);
  end if;

  if to_regclass('bob.game_settings') is not null then
    insert into bob.user_state as us
      (user_id, games_enabled, games_kids_mode, games_max_band, games_allowed_games,
       games_daily_limit_minutes, games_quiet_start, games_quiet_end, games_updated_at)
    select gs.user_id, gs.enabled, gs.kids_mode, gs.max_band, gs.allowed_games,
           gs.daily_limit_minutes, gs.quiet_start, gs.quiet_end, gs.updated_at
      from bob.game_settings gs
    on conflict (user_id) do update set
      games_enabled             = case when us.games_updated_at is null then excluded.games_enabled else us.games_enabled end,
      games_kids_mode           = case when us.games_updated_at is null then excluded.games_kids_mode else us.games_kids_mode end,
      games_max_band            = case when us.games_updated_at is null then excluded.games_max_band else us.games_max_band end,
      games_allowed_games       = case when us.games_updated_at is null then excluded.games_allowed_games else us.games_allowed_games end,
      games_daily_limit_minutes = case when us.games_updated_at is null then excluded.games_daily_limit_minutes else us.games_daily_limit_minutes end,
      games_quiet_start         = case when us.games_updated_at is null then excluded.games_quiet_start else us.games_quiet_start end,
      games_quiet_end           = case when us.games_updated_at is null then excluded.games_quiet_end else us.games_quiet_end end,
      games_updated_at          = coalesce(us.games_updated_at, excluded.games_updated_at);
  end if;
end;
$$;

create trigger user_state_check_space
  before insert or update of active_space_id on bob.user_state
  for each row execute function bob_private.user_state_check_space();

-- 8. The definers, same signatures. erase_account is the body of
--    20261003100000_conversation_unify_contract.sql plus the user_state delete.
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

  delete from bob.device_settings ds
   using bob.devices d
   where d.id = ds.device_id and d.user_id = p_user_id;
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

-- Same contract as the contract migration's version, plus the user_state
-- conversation pointer (grants are kept by create or replace).
create or replace function bob_private.clear_active_conversation_in_space(p_user uuid, p_space uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_found boolean;
begin
  if p_user is distinct from (select auth.uid()) then
    return false;
  end if;
  update bob.active_conversations a
     set conversation_id = null
   where a.user_id = p_user
     and exists (
       select 1
         from bob.conversations c
         join bob.spaces s on s.id = c.space_id
        where c.id = a.conversation_id
          and c.space_id = p_space
          and s.kind <> 'private'
     );
  v_found := found;
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
  return v_found or found;
end;
$$;

-- Same body as 20260926110000_games_init.sql, plus the user_state game columns
-- back to their defaults (the row stays: it may carry the pointers).
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
  delete from bob.game_settings where user_id = p_user_id;
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

revoke all on function bob_private.purge_account_games(uuid) from public, anon, authenticated;
grant execute on function bob_private.purge_account_games(uuid) to bob_server;
