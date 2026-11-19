-- bob:contract #756 PR5 retires bob.threads/thread_messages/thread_reads and the legacy thread columns; owner-approved, its own release
-- One conversation model, PR5 CONTRACT (#756). The application uses only
-- conversations/messages/message_versions/conversation_reads (20261002170000
-- and the stage-A server). This migration deletes no personal data: every
-- thread, message and read cursor already lives in the unified tables under the
-- same id. Step 1 PROVES that and raises (rolling the whole migration back)
-- otherwise; only then are the old tables, columns and indexes dropped.
-- Every step is guarded, so it applies on a lagging database and re-runs.
-- space_id stays nullable on conversations/messages/message_versions/memories:
-- every product insert path supplies a space and the app enforces it, so
-- tightening to NOT NULL is a possible later step for the owner to decide.
-- Runs in the migration runner's single transaction. No vector / pg_cron /
-- pgmq, so it applies under PGlite.

-- 1. Preconditions. Counts only, never content.
do $$
declare
  n bigint;
begin
  if to_regprocedure('bob_private.unify_catch_up()') is not null then
    perform bob_private.unify_catch_up();
  end if;

  if to_regclass('bob.threads') is not null then
    execute $q$
      select count(*) from bob.threads t
       where not exists (select 1 from bob.conversations c where c.id = t.id::text)
    $q$ into n;
    if n > 0 then
      raise exception 'bob contract: % thread(s) have no conversation row', n;
    end if;
  end if;

  if to_regclass('bob.thread_messages') is not null then
    execute $q$
      select count(*) from bob.thread_messages tm
       where not exists (
         select 1 from bob.messages m
          where m.id = tm.id::text
            and m.conversation_id = tm.thread_id::text
            and m.sequence = tm.sequence
            and m.revision = tm.revision
            and m.tombstoned_at is not distinct from tm.tombstoned_at
            and m.author_user_id is not distinct from tm.author_user_id)
    $q$ into n;
    if n > 0 then
      raise exception 'bob contract: % thread message(s) have no matching message row', n;
    end if;
  end if;

  if to_regclass('bob.thread_reads') is not null then
    execute $q$
      select count(*) from bob.thread_reads r
       where not exists (select 1 from bob.conversation_reads c
                          where c.conversation_id = r.thread_id::text and c.user_id = r.user_id)
    $q$ into n;
    if n > 0 then
      raise exception 'bob contract: % thread read(s) have no conversation_reads row', n;
    end if;
  end if;

  -- Step 5 keeps only the thread-free key the orphan-cleanup migration
  -- (20261002180000) creates, so that migration must have run first.
  if to_regclass('bob.notification_prefs_conversation_only_uidx') is null then
    raise exception 'bob contract: notification_prefs_conversation_only_uidx is missing; apply 20261002180000_delete_orphan_notification_prefs first';
  end if;

  -- Orphans are deleted by their own earlier migration, never here.
  if exists (select 1 from information_schema.columns
              where table_schema = 'bob' and table_name = 'notification_preferences'
                and column_name = 'thread_id') then
    execute $q$
      select count(*) from bob.notification_preferences
       where thread_id is not null and conversation_id is null
    $q$ into n;
    if n > 0 then
      raise exception 'bob contract: % notification preference(s) have thread_id but no conversation_id', n;
    end if;
  end if;

  -- Step 4 sets this NOT NULL.
  select count(*) into n from bob.ai_invocations where conversation_id is null;
  if n > 0 then
    raise exception 'bob contract: % ai_invocations row(s) have a NULL conversation_id', n;
  end if;
end;
$$;

-- 2. The definers, without the thread tables.
-- erase_account: the body of 20261001100200_conversation_unify_erasure.sql
-- unchanged, minus the threads/thread_messages/thread_reads statements (their
-- rows live on as conversations/messages/conversation_reads, handled below).
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

-- Same contract as 20261002150000_active_clear_in_space, keyed only by
-- conversation_id (grants are kept by create or replace).
create or replace function bob_private.clear_active_conversation_in_space(p_user uuid, p_space uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
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
  return found;
end;
$$;

drop function if exists bob_private.unify_catch_up();

-- 3. The active pointer: policies without thread_space_id, then the columns.
drop policy if exists active_conversations_insert on bob.active_conversations;
create policy active_conversations_insert on bob.active_conversations
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists active_conversations_update on bob.active_conversations;
create policy active_conversations_update on bob.active_conversations
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table bob.active_conversations drop constraint if exists active_conversations_thread_pair;
drop index if exists bob.active_conversations_thread_idx;
drop index if exists bob.active_conversations_thread_space_idx;
alter table bob.active_conversations drop column if exists thread_id;
alter table bob.active_conversations drop column if exists thread_space_id;

-- 4. Invocations: the conversation_id partial unique index is the running guard.
drop index if exists bob.ai_invocations_one_running_per_thread;
alter table bob.ai_invocations drop column if exists thread_id;
alter table bob.ai_invocations alter column conversation_id set not null;

-- 5. Notification preferences: both older unique indexes carry a thread_id
--    term, so they go before the column. The surviving key is the thread-free
--    notification_prefs_conversation_only_uidx from
--    20261002180000_delete_orphan_notification_prefs.sql (step 1 proved it
--    exists), which the app's ON CONFLICT already names.
drop index if exists bob.notification_prefs_key_uidx;
drop index if exists bob.notification_prefs_conversation_key_uidx;
alter table bob.notification_preferences drop column if exists thread_id;

-- 6. The old tables, children first (their policies and grants go with them).
drop table if exists bob.thread_reads;
drop table if exists bob.thread_messages;
drop table if exists bob.threads;
