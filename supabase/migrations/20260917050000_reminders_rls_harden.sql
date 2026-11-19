-- Harden the reminders schema (S14-REMINDERS-RLS-HARDEN).
--
-- 20260917030000_reminders_init.sql is ALREADY APPLIED to production, so it is
-- never edited (Supabase tracks by version and would never re-run it). This is
-- a NEW forward migration that closes four holes the init migration left open:
--
--   A. reminders_update / reminders_delete tested only membership, so any member
--      could retime, cancel or delete another member's reminder. Writes now
--      require the row's created_by OR a space owner/admin.
--   B. reminder_recipients_* tested only membership, so any member could
--      replace a reminder's recipient set -- and nothing tied a recipient to
--      the reminder's space. Recipient writes now require the reminder's owner
--      and the recipient must be an ACTIVE member of that space.
--   C. reminders.task_id / note_id / event_id were single-column FKs, so a
--      reminder could point at a resource in a DIFFERENT space. Composite
--      (id, space_id) FKs, following the threads/calendar idiom, pin it.
--   D. reminder_fanout_sources returned a stored recipient after their
--      membership was revoked. It now joins active membership.
--
-- Every statement is idempotent: drop-if-exists before each create policy, and
-- DO-guarded constraint adds, so a replay is a no-op.

-- C. Same-space targets. The composite FK needs an anchor unique (id, space_id)
--    on each target table. `id` is already the primary key, so the pair is
--    trivially unique and the constraint cannot fail on existing rows. The
--    threads (20260916051000:24) and calendar (20260916053000:12) migrations
--    already use this idiom; tasks/notes/calendar_events did not carry it.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'bob.tasks'::regclass and conname = 'tasks_id_space_key'
  ) then
    alter table bob.tasks add constraint tasks_id_space_key unique (id, space_id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'bob.notes'::regclass and conname = 'notes_id_space_key'
  ) then
    alter table bob.notes add constraint notes_id_space_key unique (id, space_id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'bob.calendar_events'::regclass
      and conname = 'calendar_events_id_space_key'
  ) then
    alter table bob.calendar_events
      add constraint calendar_events_id_space_key unique (id, space_id);
  end if;
end $$;

-- Swap the three single-column FKs for composite (resource_id, space_id) FKs.
-- Each drop/add is short and takes only a brief lock on bob.reminders; the
-- table holds one row per reminder, so the lock is momentary. MATCH SIMPLE
-- (the default) skips enforcement while the nullable resource column is NULL,
-- which is exactly the "standalone reminder" case. Dropping the old constraint
-- first also removes its index, so the swap does not leave a duplicate.
alter table bob.reminders drop constraint if exists reminders_task_id_fkey;
-- Also drop the NEW name, so a re-run of this migration is a no-op rather
-- than an "already exists" error that aborts the rest of it.
alter table bob.reminders drop constraint if exists reminders_task_fk;
alter table bob.reminders add constraint reminders_task_fk
  foreign key (task_id, space_id)
  references bob.tasks (id, space_id) on delete cascade;

alter table bob.reminders drop constraint if exists reminders_note_id_fkey;
-- Also drop the NEW name, so a re-run of this migration is a no-op rather
-- than an "already exists" error that aborts the rest of it.
alter table bob.reminders drop constraint if exists reminders_note_fk;
alter table bob.reminders add constraint reminders_note_fk
  foreign key (note_id, space_id)
  references bob.notes (id, space_id) on delete cascade;

alter table bob.reminders drop constraint if exists reminders_event_id_fkey;
-- Also drop the NEW name, so a re-run of this migration is a no-op rather
-- than an "already exists" error that aborts the rest of it.
alter table bob.reminders drop constraint if exists reminders_event_fk;
alter table bob.reminders add constraint reminders_event_fk
  foreign key (event_id, space_id)
  references bob.calendar_events (id, space_id) on delete cascade;

-- A. Reminder writes belong to the creator or a space owner/admin.
--    reminders_select / reminders_insert stay pure membership: any active
--    member may see the space's reminders and create one. Update and delete
--    now require the caller to be an ACTIVE member AND either the row's
--    created_by or an owner/admin of the space.
drop policy if exists reminders_update on bob.reminders;
create policy reminders_update on bob.reminders
  for update to authenticated
  using (
    bob_private.is_space_member(space_id)
    and (created_by = (select auth.uid())
         or bob_private.is_space_owner_or_admin(space_id))
  )
  -- The creator/owner test must repeat in WITH CHECK, otherwise a member could
  -- reassign created_by to themselves on the way past. is_space_member on the
  -- NEW space_id pins an update to a space the caller belongs to, so a reminder
  -- cannot be moved into a space it (and the caller) has no right to.
  with check (
    bob_private.is_space_member(space_id)
    and (created_by = (select auth.uid())
         or bob_private.is_space_owner_or_admin(space_id))
  );

drop policy if exists reminders_delete on bob.reminders;
create policy reminders_delete on bob.reminders
  for delete to authenticated
  using (
    bob_private.is_space_member(space_id)
    and (created_by = (select auth.uid())
         or bob_private.is_space_owner_or_admin(space_id))
  );

-- B. Recipients: only the reminder's owner may change them, and only to real
--    active members of the reminder's space. reminder_recipients_select stays
--    keyed on membership so members can see who a reminder targets.
--    The reminder's space is resolved through a subquery on bob.reminders
--    (whose SELECT policy already gates by membership). The recipient-membership
--    test queries bob.space_memberships directly: the caller is a member or
--    owner of that space, so the space_memberships_select policy (own rows or
--    any space the caller is an active member of) lets them see those rows.
drop policy if exists reminder_recipients_insert on bob.reminder_recipients;
create policy reminder_recipients_insert on bob.reminder_recipients
  for insert to authenticated
  with check (
    exists (
      select 1 from bob.reminders r
      where r.id = reminder_recipients.reminder_id
        and (r.created_by = (select auth.uid())
             or bob_private.is_space_owner_or_admin(r.space_id))
        and exists (
          select 1 from bob.space_memberships m
          where m.space_id = r.space_id
            and m.user_id = reminder_recipients.user_id
            and m.revoked_at is null
        )
    )
  );

drop policy if exists reminder_recipients_update on bob.reminder_recipients;
create policy reminder_recipients_update on bob.reminder_recipients
  for update to authenticated
  using (
    exists (
      select 1 from bob.reminders r
      where r.id = reminder_recipients.reminder_id
        and (r.created_by = (select auth.uid())
             or bob_private.is_space_owner_or_admin(r.space_id))
    )
  )
  with check (
    exists (
      select 1 from bob.reminders r
      where r.id = reminder_recipients.reminder_id
        and (r.created_by = (select auth.uid())
             or bob_private.is_space_owner_or_admin(r.space_id))
        and exists (
          select 1 from bob.space_memberships m
          where m.space_id = r.space_id
            and m.user_id = reminder_recipients.user_id
            and m.revoked_at is null
        )
    )
  );

drop policy if exists reminder_recipients_delete on bob.reminder_recipients;
create policy reminder_recipients_delete on bob.reminder_recipients
  for delete to authenticated
  using (
    exists (
      select 1 from bob.reminders r
      where r.id = reminder_recipients.reminder_id
        and (r.created_by = (select auth.uid())
             or bob_private.is_space_owner_or_admin(r.space_id))
    )
  );

-- D. A removed member must stop receiving. reminder_fanout_sources (init 5.1)
--    returned a stored recipient even after their membership was revoked. Join
--    ACTIVE membership in the reminder's space so the source set excludes former
--    members. CREATE OR REPLACE keeps the existing EXECUTE grants and owner;
--    the signature is unchanged. Stored reminder_recipients rows are NOT
--    deleted -- membership can be restored and destroying stored intent is not
--    this migration's call.
create or replace function bob_private.reminder_fanout_sources(p_now timestamptz)
returns table (
  "reminderId" uuid, "spaceId" uuid, "dueAt" bigint, "dueZone" text, rrule jsonb,
  "scheduleRevision" int, "userId" uuid
)
language sql security definer set search_path = ''
as $$
  select r.id, r.space_id,
         floor(extract(epoch from r.due_at) * 1000)::bigint,
         r.due_zone, r.rrule, r.schedule_revision, rr.user_id
    from bob.reminders r
    join bob.reminder_recipients rr on rr.reminder_id = r.id
   where r.status = 'active'
     and r.due_at <= p_now
     and (r.task_id is null or not exists (
            select 1 from bob.tasks t where t.id = r.task_id and t.status = 'completed'
          ))
     and exists (
            select 1 from bob.space_memberships m
            where m.space_id = r.space_id
              and m.user_id = rr.user_id
              and m.revoked_at is null
          );
$$;
