-- Bob reminders that survive a revision, a cancellation and a replay
-- (S14-REMINDERS-STORE, specs/014-family-collaboration/data-model.md
-- "reminders, reminder_recipients, reminder_occurrences"; contracts/api.md
-- "Tasks, checklists and reminders"). Follows the spaces-init assembly order:
-- 1 tables (dependency order) · 2 indexes · 3 enable/force RLS · 4 policies
-- · 5 server write path · 6 grants. No vector / pg_cron / pgmq, so it applies
-- under PGlite.
--
-- The three acceptance criteria are one idea: the uniqueness key is
-- **recipient + occurrence + schedule revision**.
--   1. A reminder for two recipients produces exactly ONE inbox item per
--      recipient, and one person snoozing changes only their own delivery.
--      The recipient set is STORED in reminder_recipients (never re-derived
--      from a token claim), and snoozed_until lives on the per
--      (reminder_id, user_id) reminder_occurrences row, so a snooze is
--      private to that recipient.
--   2. A cancelled reminder, or one whose linked task was completed, produces
--      NOTHING when a delayed delivery resumes. The fanout source query (a
--      definer, section 5) skips any reminder that is not `active` and any
--      reminder whose task is `completed`, so it is never even considered.
--   3. An acknowledged occurrence produces no duplicate when the worker
--      retries. The unique (reminder_id, user_id, occurrence_at,
--      schedule_revision) constraint makes recordOccurrence's
--      ON CONFLICT DO NOTHING a replay no-op, and a PATCH bump of
--      schedule_revision un-matches every row queued under an older revision.

-- 1. Tables in dependency order: reminders -> reminder_recipients,
--    reminder_occurrences.

-- 1.1 bob.reminders. A reminder is standalone or points at exactly one
--     resource (task/note/event) in the same space (num_nonnulls <= 1). Timing
--     mirrors the tasks migration's honest date/instant pair, but a reminder
--     ALWAYS resolves to an instant: a one-shot (rrule null) must carry
--     due_at, so the fanout has an anchor to expand from.
create table bob.reminders (
  id                 uuid primary key default gen_random_uuid(),
  space_id           uuid not null references bob.spaces (id) on delete cascade,
  title              text not null check (char_length(btrim(title)) between 1 and 200),
  task_id            uuid null references bob.tasks (id) on delete cascade,
  note_id            uuid null references bob.notes (id) on delete cascade,
  event_id           uuid null references bob.calendar_events (id) on delete cascade,
  due_date           date null,
  due_at             timestamptz null,
  due_zone           text null,
  rrule              jsonb null,
  schedule_revision  integer not null default 1,
  status             text not null default 'active' check (status in ('active', 'paused', 'cancelled')),
  created_by         uuid not null references auth.users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check ((due_date is null) or (due_at is null)),
  check ((due_at is null) = (due_zone is null)),
  check (num_nonnulls(task_id, note_id, event_id) <= 1),
  check (rrule is not null or due_at is not null)
);

-- 1.2 bob.reminder_recipients -- the recipient set is STORED, never
--     re-derived from a token claim.
create table bob.reminder_recipients (
  id          uuid primary key default gen_random_uuid(),
  reminder_id uuid not null references bob.reminders (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (reminder_id, user_id)
);

-- 1.3 bob.reminder_occurrences -- one row per (recipient, occurrence,
--     schedule revision). The single unique constraint is what makes a retry
--     safe: it cannot duplicate, and a PATCH bump of schedule_revision
--     un-matches every row queued under an older revision.
create table bob.reminder_occurrences (
  id                uuid primary key default gen_random_uuid(),
  reminder_id       uuid not null references bob.reminders (id) on delete cascade,
  user_id           uuid not null references auth.users (id) on delete cascade,
  occurrence_at     timestamptz not null,
  schedule_revision integer not null,
  snoozed_until     timestamptz null,
  acknowledged_at   timestamptz null,
  delivered_at      timestamptz null,
  unique (reminder_id, user_id, occurrence_at, schedule_revision)
);

-- 2. Indexes. The fanout claim scan: undelivered occurrences in time order.
create index reminder_occurrences_pending_idx
  on bob.reminder_occurrences (occurrence_at)
  where delivered_at is null;

-- 3. RLS -- all three tables force it. Access is decided by ACTIVE membership
--    in the reminder's space; occurrences additionally restrict an ordinary
--    caller to their OWN rows.
alter table bob.reminders enable row level security;
alter table bob.reminders force row level security;
alter table bob.reminder_recipients enable row level security;
alter table bob.reminder_recipients force row level security;
alter table bob.reminder_occurrences enable row level security;
alter table bob.reminder_occurrences force row level security;

-- 4. Policies. Every read/write keys on bob_private.is_space_member on the
--    reminder's space (S14-T001). reminder_recipients has no space_id column,
--    so it derives the space from its reminder via a subquery on bob.reminders
--    -- that does not recurse through space_memberships and reuses the helper.

-- 4.1 bob.reminders
create policy reminders_select on bob.reminders
  for select to authenticated
  using (bob_private.is_space_member(space_id));

create policy reminders_insert on bob.reminders
  for insert to authenticated
  with check (bob_private.is_space_member(space_id));

create policy reminders_update on bob.reminders
  for update to authenticated
  using (bob_private.is_space_member(space_id))
  with check (bob_private.is_space_member(space_id));

create policy reminders_delete on bob.reminders
  for delete to authenticated
  using (bob_private.is_space_member(space_id));

-- 4.2 bob.reminder_recipients
create policy reminder_recipients_select on bob.reminder_recipients
  for select to authenticated
  using (
    bob_private.is_space_member(
      (select r.space_id from bob.reminders r where r.id = reminder_recipients.reminder_id)
    )
  );

create policy reminder_recipients_insert on bob.reminder_recipients
  for insert to authenticated
  with check (
    bob_private.is_space_member(
      (select r.space_id from bob.reminders r where r.id = reminder_recipients.reminder_id)
    )
  );

create policy reminder_recipients_update on bob.reminder_recipients
  for update to authenticated
  using (
    bob_private.is_space_member(
      (select r.space_id from bob.reminders r where r.id = reminder_recipients.reminder_id)
    )
  )
  with check (
    bob_private.is_space_member(
      (select r.space_id from bob.reminders r where r.id = reminder_recipients.reminder_id)
    )
  );

create policy reminder_recipients_delete on bob.reminder_recipients
  for delete to authenticated
  using (
    bob_private.is_space_member(
      (select r.space_id from bob.reminders r where r.id = reminder_recipients.reminder_id)
    )
  );

-- 4.3 bob.reminder_occurrences. An ordinary caller sees and changes only
--     their OWN rows, and only while they are still an ACTIVE member of the
--     reminder's space. There is deliberately NO insert/delete policy --
--     occurrences are recorded only by the server definer in section 5.
create policy reminder_occurrences_select on bob.reminder_occurrences
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and bob_private.is_space_member(
      (select r.space_id from bob.reminders r where r.id = reminder_occurrences.reminder_id)
    )
  );

create policy reminder_occurrences_update on bob.reminder_occurrences
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and bob_private.is_space_member(
      (select r.space_id from bob.reminders r where r.id = reminder_occurrences.reminder_id)
    )
  )
  with check (user_id = (select auth.uid()));

-- 5. Server write path. The fanout worker must see active reminders across
--    EVERY space (RLS cannot scope it to one account), and recordOccurrence
--    must insert into the FORCE-RLS occurrence table -- which locks out every
--    account role AND bob_server (nobypassrls, init-migration §2.7). So the
--    fanout store (apps/api/src/store/reminders.ts, S14) reaches the tables
--    only through these SECURITY DEFINER functions, which run as the migration
--    owner (bypassing the lock) with search_path = ''. This mirrors the
--    outbox/notifications option-A pattern. The store shares its caller's
--    transaction (no BEGIN here), so a recorded occurrence and its outbox row
--    commit together.

-- 5.1 The fanout source: one row per ACTIVE reminder x recipient, where the
--     reminder is due (due_at <= now) and its linked task is not completed.
--     The status and task-completion filters ARE the enforcement of acceptance
--     criterion 2 -- a cancelled reminder or a completed task never appears
--     here, so a delayed delivery resumes to nothing.
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
          ));
$$;

-- 5.2 The already-recorded keys for a set of reminders, so the fanout can skip
--     triples that have a row (criterion 3, no-duplicate-on-replay).
create or replace function bob_private.reminder_existing_keys(p_reminder_ids uuid[])
returns table (
  "reminderId" uuid, "userId" uuid, "occurrenceAt" bigint, "scheduleRevision" int
)
language sql security definer set search_path = ''
as $$
  select o.reminder_id, o.user_id,
         floor(extract(epoch from o.occurrence_at) * 1000)::bigint,
         o.schedule_revision
    from bob.reminder_occurrences o
   where o.reminder_id = any(p_reminder_ids);
$$;

-- 5.3 recordOccurrence: insert ON CONFLICT DO NOTHING, so a replay of the same
--     (recipient, occurrence, schedule revision) triple is a no-op. Returns
--     true only when a row was actually inserted (a retried command is false).
create or replace function bob_private.reminder_occurrence_record(
  p_reminder_id uuid, p_user_id uuid, p_occurrence_at timestamptz, p_schedule_revision int
) returns boolean
language sql security definer set search_path = ''
as $$
  with inserted as (
    insert into bob.reminder_occurrences
      (reminder_id, user_id, occurrence_at, schedule_revision)
    values (p_reminder_id, p_user_id, p_occurrence_at, p_schedule_revision)
    on conflict (reminder_id, user_id, occurrence_at, schedule_revision) do nothing
    returning id
  )
  select exists (select 1 from inserted);
$$;

-- 6. Grants (init-migration §2.7 pattern). Accounts fully own reminders and
--    their recipient set, but occurrences are read + snooze/ack only (no
--    account insert/delete -- recording is the server definer's job). The
--    definers run as the owner, so they need no table grant; EXECUTE goes to
--    bob_server alone.
grant select, insert, update, delete on bob.reminders to authenticated;
grant select, insert, update, delete on bob.reminder_recipients to authenticated;
grant select, update on bob.reminder_occurrences to authenticated;

revoke all on function bob_private.reminder_fanout_sources(timestamptz) from public, anon, authenticated;
grant execute on function bob_private.reminder_fanout_sources(timestamptz) to bob_server;
revoke all on function bob_private.reminder_existing_keys(uuid[]) from public, anon, authenticated;
grant execute on function bob_private.reminder_existing_keys(uuid[]) to bob_server;
revoke all on function bob_private.reminder_occurrence_record(uuid, uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function bob_private.reminder_occurrence_record(uuid, uuid, timestamptz, integer) to bob_server;