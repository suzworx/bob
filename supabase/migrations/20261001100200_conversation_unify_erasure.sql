-- One conversation model, PR1 (#756): erasure covers the columns the EXPAND
-- migration (20261001100000_conversation_unify_expand.sql) added. This
-- replaces the definer (create or replace, same signature and the same five
-- counts) with the body of 20260926140100_erasure_gaps.sql, unchanged, plus:
--   * anonymize: conversations.created_by, messages.author_user_id and
--     messages.tombstoned_by move to the erased-user sentinel, exactly like
--     threads.created_by and thread_messages.author_user_id/tombstoned_by.
--     They run after the private-space delete, so only shared conversations
--     are left to reach.
--   * clear: the account's conversation_reads are deleted (as thread_reads).
-- Additive: no existing step is removed. Idempotent: every step matches only
-- rows that still name the account.

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

  update bob.threads set created_by = '00000000-0000-4000-8000-0000000000de'
   where created_by = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.thread_messages set author_user_id = '00000000-0000-4000-8000-0000000000de'
   where author_user_id = p_user_id;
  get diagnostics v_touched = row_count; v_anonymized := v_anonymized + v_touched;

  update bob.thread_messages set tombstoned_by = '00000000-0000-4000-8000-0000000000de'
   where tombstoned_by = p_user_id;
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

  delete from bob.thread_reads where user_id = p_user_id;
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
