-- Bob tasks, checklists and subscribers (S14-T005, specs/014-family-collaboration/
-- data-model.md "tasks, task_items, task_subscribers"). Follows the spaces-init
-- assembly order: 1 tables (dependency order) · 2 indexes · 3 enable/force RLS
-- · 4 policies · 5 grants. No vector / pg_cron / pgmq, so it applies under
-- PGlite. Access is decided by ACTIVE membership in the task's space via the
-- S14-T001 helper bob_private.is_space_member -- no second copy of it, and
-- no policy subqueries space_memberships directly.
--
-- A list is a task: its checklist items are CHILD tasks (parent_task_id). So
-- there is no separate task_items table; items ride the same table and the
-- (space_id, parent_task_id, order_key) index gives stable within-parent order.
-- A due value is HONEST about date-only versus time-specific: a date-only due
-- is stored as `date` and never synthesized into a midnight instant, and a
-- timed due always carries its zone (two CHECKs enforce both).

-- 1. Tables in dependency order: tasks -> task_subscribers.

-- 1.1 bob.tasks (data-model.md "tasks")
create table bob.tasks (
  id               uuid primary key default gen_random_uuid(),
  space_id         uuid not null references bob.spaces (id) on delete cascade,
  -- A list is a task; its items are children. Cascade purges children with the list.
  parent_task_id   uuid null references bob.tasks (id) on delete cascade,
  title            text not null check (char_length(btrim(title)) between 1 and 200),
  body             text null check (body is null or char_length(btrim(body)) <= 8000),
  status           text not null default 'open' check (status in ('open', 'completed')),
  assignee_user_id uuid null references auth.users (id) on delete set null,
  -- At most one kind of due value, and a timed due always carries its zone.
  due_date         date null,
  due_at           timestamptz null,
  due_zone         text null,
  check ((due_date is null) or (due_at is null)),
  check ((due_at is null) = (due_zone is null)),
  order_key        text not null,
  revision         integer not null default 1,
  created_by       uuid not null references auth.users (id),
  completed_at     timestamptz null,
  completed_by     uuid null,
  trashed_at       timestamptz null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- 1.2 bob.task_subscribers (data-model.md "task_subscribers") -- watchers,
--     distinct from the single accountable assignee.
create table bob.task_subscribers (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references bob.tasks (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (task_id, user_id)
);

-- 2. Indexes (data-model.md "tasks" -- due/status/space, unique ordering key,
--    active assignee scan).
create index tasks_space_status_due_idx
  on bob.tasks (space_id, status, due_date);
create index tasks_space_parent_order_idx
  on bob.tasks (space_id, parent_task_id, order_key);
create index tasks_assignee_active_idx
  on bob.tasks (assignee_user_id) where trashed_at is null;
create index task_subscribers_task_idx on bob.task_subscribers (task_id);
create index task_subscribers_user_idx on bob.task_subscribers (user_id);

-- 3. RLS -- both tables force it; access is decided by ACTIVE membership in the
--    task's space.
alter table bob.tasks enable row level security;
alter table bob.tasks force row level security;
alter table bob.task_subscribers enable row level security;
alter table bob.task_subscribers force row level security;

-- 4. Policies. Every read/write is decided by bob_private.is_space_member on
--    the task's space (S14-T001). task_subscribers has no space_id column, so
--    it derives the space from its task via a subquery on bob.tasks -- that
--    does not recurse through space_memberships and reuses the one helper.

-- 4.1 bob.tasks
create policy tasks_select on bob.tasks
  for select to authenticated
  using (bob_private.is_space_member(space_id));

create policy tasks_insert on bob.tasks
  for insert to authenticated
  with check (bob_private.is_space_member(space_id));

create policy tasks_update on bob.tasks
  for update to authenticated
  using (bob_private.is_space_member(space_id))
  with check (bob_private.is_space_member(space_id));

create policy tasks_delete on bob.tasks
  for delete to authenticated
  using (bob_private.is_space_member(space_id));

-- 4.2 bob.task_subscribers
create policy task_subscribers_select on bob.task_subscribers
  for select to authenticated
  using (
    bob_private.is_space_member(
      (select t.space_id from bob.tasks t where t.id = task_subscribers.task_id)
    )
  );

create policy task_subscribers_insert on bob.task_subscribers
  for insert to authenticated
  with check (
    bob_private.is_space_member(
      (select t.space_id from bob.tasks t where t.id = task_subscribers.task_id)
    )
  );

create policy task_subscribers_update on bob.task_subscribers
  for update to authenticated
  using (
    bob_private.is_space_member(
      (select t.space_id from bob.tasks t where t.id = task_subscribers.task_id)
    )
  )
  with check (
    bob_private.is_space_member(
      (select t.space_id from bob.tasks t where t.id = task_subscribers.task_id)
    )
  );

create policy task_subscribers_delete on bob.task_subscribers
  for delete to authenticated
  using (
    bob_private.is_space_member(
      (select t.space_id from bob.tasks t where t.id = task_subscribers.task_id)
    )
  );

-- 5. Grants (init-migration §2.7 pattern).
grant select, insert, update, delete on bob.tasks to authenticated;
grant select, insert, update, delete on bob.task_subscribers to authenticated;