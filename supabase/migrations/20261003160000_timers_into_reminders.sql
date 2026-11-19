-- Timers move into bob.reminders (#757 merge 4, step 2: backfill and switch).
--
-- Step 1 (20261003130000_reminders_kind_expand) gave bob.reminders a kind and
-- the timer columns. This migration copies every bob.timers row in with its id
-- kept, repoints the scheduler's two service functions at the new rows (same
-- signatures, return columns and grants) and teaches erase_account to delete a
-- user's timer and alarm rows. bob.timers itself is neither dropped nor
-- altered: a later contract step removes it. Re-runnable throughout (the
-- backfill is on conflict do nothing); old-table reads go through execute inside
-- a to_regclass guard so they resolve at run time. No vector / pg_cron / pgmq,
-- so it applies under PGlite.

do $$
begin
  if to_regclass('bob.timers') is not null then
    -- 1. A private space for every user that has a timer (the idiom of
    --    20261001100000_conversation_unify_expand), so the copy always finds one.
    execute $sql$
      insert into bob.spaces (id, kind, name, owner_user_id)
      select gen_random_uuid(), 'private', 'Private', u.id
        from auth.users u
       where u.id in (select t.user_id from bob.timers t)
         and u.id <> '00000000-0000-4000-8000-0000000000de'
      on conflict (owner_user_id) where kind = 'private' do nothing
    $sql$;
    execute $sql$
      insert into bob.space_memberships (space_id, user_id, role)
      select s.id, s.owner_user_id, 'owner'
        from bob.spaces s
       where s.kind = 'private'
         and s.owner_user_id in (select t.user_id from bob.timers t)
      on conflict (space_id, user_id) do nothing
    $sql$;

    -- 2. The copy: same id, the owner's private space, no recipients.
    execute $sql$
      insert into bob.reminders (
        id, space_id, created_by, kind, title, due_at, due_zone, duration_ms,
        status, fired_at, created_at, updated_at
      )
      select t.id, s.id, t.user_id, t.kind, t.label, t.fires_at, 'UTC', t.duration_ms,
             t.status, t.fired_at, t.created_at, t.created_at
        from bob.timers t
        join bob.spaces s on s.kind = 'private' and s.owner_user_id = t.user_id
      on conflict (id) do nothing
    $sql$;
  end if;
end;
$$;

-- 3. The scheduler's service functions, now over the non-reminder rows. The
--    signatures, return columns and grants of 20260923140000_timers_init.
create or replace function bob_private.timers_due(p_now timestamptz, p_limit integer)
returns table (
  id uuid, "userId" uuid, kind text, label text, "firesAt" bigint,
  "durationMs" integer, status text, "createdAt" bigint, "firedAt" bigint
)
language sql security definer set search_path = ''
as $$
  select r.id, r.created_by, r.kind, r.title,
         floor(extract(epoch from r.due_at) * 1000)::bigint,
         r.duration_ms::integer, r.status,
         floor(extract(epoch from r.created_at) * 1000)::bigint,
         floor(extract(epoch from r.fired_at) * 1000)::bigint
    from bob.reminders r
   where r.kind <> 'reminder' and r.status = 'pending' and r.due_at <= p_now
   order by r.due_at, r.id
   limit greatest(1, least(p_limit, 1000));
$$;

create or replace function bob_private.timers_next_fire_at()
returns bigint
language sql security definer set search_path = ''
as $$
  select floor(extract(epoch from min(r.due_at)) * 1000)::bigint
    from bob.reminders r
   where r.kind <> 'reminder' and r.status = 'pending';
$$;

revoke all on function bob_private.timers_due(timestamptz, integer) from public, anon, authenticated;
grant execute on function bob_private.timers_due(timestamptz, integer) to bob_server;
revoke all on function bob_private.timers_next_fire_at() from public, anon, authenticated;
grant execute on function bob_private.timers_next_fire_at() to bob_server;

-- 4. erase_account: the body of 20261003150000_device_settings_onto_devices.sql
--    plus the delete of the user's timer and alarm rows, placed before any step
--    that anonymizes reminders.created_by. The old table's delete goes through a
--    guarded execute so a later drop of bob.timers needs no rewrite.
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

  -- The old timers table, while it still exists.
  if to_regclass('bob.timers') is not null then
    execute 'delete from bob.timers where user_id = $1' using p_user_id;
    get diagnostics v_touched = row_count; v_assignments_cleared := v_assignments_cleared + v_touched;
  end if;

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
