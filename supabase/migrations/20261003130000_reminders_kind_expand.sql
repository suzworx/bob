-- Reminders gain a kind (#757 merge 4, step 1: expand).
--
-- #757 folds bob.timers into bob.reminders: one table, two consumers. This
-- migration only prepares the table. It copies NO timer data and changes NO
-- behaviour: every existing row becomes kind 'reminder'. The reminder readers
-- in apps/api ship with this migration and filter on kind = 'reminder', so a
-- timer or alarm row that lands later never reaches a reminder list, a
-- notification or an email.
--
-- Timer and alarm rows keep the timer vocabulary: statuses pending / fired /
-- dismissed / cancelled, a nullable 1-60 character label in title, duration_ms
-- and fired_at, and no rrule. Additive and re-runnable; the only things dropped
-- are the two check constraints this migration replaces.

-- 1. New columns. A constant default on a new column is metadata-only.
alter table bob.reminders
  add column if not exists kind text not null default 'reminder',
  add column if not exists duration_ms bigint null,
  add column if not exists fired_at timestamptz null;

-- 2. Checks. Drop first so a re-run converges on the same definitions.
alter table bob.reminders drop constraint if exists reminders_kind_check;
alter table bob.reminders add constraint reminders_kind_check
  check (kind in ('reminder', 'timer', 'alarm'));

alter table bob.reminders drop constraint if exists reminders_status_check;
alter table bob.reminders add constraint reminders_status_check
  check (
    (kind = 'reminder' and status in ('active', 'paused', 'cancelled'))
    or (kind <> 'reminder' and status in ('pending', 'fired', 'dismissed', 'cancelled'))
  );

-- A reminder keeps today's rule (trimmed 1-200); a timer or alarm has an
-- optional label of 1-60 characters.
alter table bob.reminders alter column title drop not null;
alter table bob.reminders drop constraint if exists reminders_title_check;
alter table bob.reminders add constraint reminders_title_check
  check (
    (kind = 'reminder' and title is not null and char_length(btrim(title)) between 1 and 200)
    or (kind <> 'reminder' and (title is null or char_length(title) between 1 and 60))
  );

-- The timers table's rules, scoped to the rows that are not reminders.
alter table bob.reminders drop constraint if exists reminders_timer_shape_check;
alter table bob.reminders add constraint reminders_timer_shape_check
  check (
    kind = 'reminder'
    or (
      due_at is not null
      and rrule is null
      and (duration_ms is null or duration_ms > 0)
      and (kind = 'alarm' or duration_ms is not null)
    )
  );

-- 3. The timer scheduler's due scan: pending non-reminder rows by due time.
create index if not exists reminders_timer_due_idx
  on bob.reminders (due_at)
  where kind <> 'reminder' and status = 'pending';

-- 4. The reminder fanout never considers a timer or alarm. Same signature and
--    grants as 20260917050000_reminders_rls_harden; only `r.kind = 'reminder'`
--    is new.
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
   where r.kind = 'reminder'
     and r.status = 'active'
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
