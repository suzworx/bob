-- Bob human threads (S06, specs/014-family-collaboration/contracts/api.md
-- "Threads and messages"). Posting a message NEVER invokes a model (FR-008);
-- this schema is pure human conversation. Follows the spaces-init migration's
-- assembly order: 1 tables (dependency order) · 2 indexes · 3 enable/force RLS
-- · 4 policies · 5 grants. Reuses bob_private.is_space_member(space_id) from
-- 20260916050000 -- no second copy of that helper, and no policy subqueries
-- space_memberships directly. No vector / pg_cron / pgmq, so it applies under
-- PGlite.

-- 1. Tables in dependency order: threads -> thread_messages -> thread_reads.

-- 1.1 bob.threads
create table bob.threads (
  id             uuid primary key default gen_random_uuid(),
  space_id       uuid not null references bob.spaces (id) on delete cascade,
  title          text not null check (char_length(btrim(title)) between 1 and 120),
  created_by     uuid not null references auth.users (id),
  archived_at    timestamptz null,
  last_sequence  bigint not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- The composite unique the message-level composite FK targets: a message can
  -- never claim one space while its thread sits in another.
  unique (id, space_id)
);

-- 1.2 bob.thread_messages. space_id is denormalised so RLS keys on it with
--     no join; the composite FK below keeps it in step with the thread.
create table bob.thread_messages (
  id                   uuid primary key default gen_random_uuid(),
  thread_id            uuid not null references bob.threads (id) on delete cascade,
  space_id             uuid not null,
  -- null means the assistant; a later task writes those rows.
  author_user_id       uuid null references auth.users (id) on delete set null,
  body                 text not null check (char_length(btrim(body)) between 1 and 8000),
  reply_to_message_id  uuid null references bob.thread_messages (id),
  sequence             bigint not null,
  client_message_id    text not null check (char_length(btrim(client_message_id)) between 1 and 128),
  revision             integer not null default 1,
  tombstoned_at        timestamptz null,
  tombstoned_by        uuid null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- Ordering is a database guarantee, not an application hop.
  unique (thread_id, sequence),
  -- A retried POST is one message, not two.
  unique (author_user_id, client_message_id),
  -- Composite same-space link (data-model.md "Use typed linking tables").
  foreign key (thread_id, space_id) references bob.threads (id, space_id)
);

-- 1.3 bob.thread_reads: per person, not per space.
create table bob.thread_reads (
  thread_id           uuid not null references bob.threads (id) on delete cascade,
  user_id             uuid not null references auth.users (id) on delete cascade,
  last_read_sequence  bigint not null default 0,
  updated_at          timestamptz not null default now(),
  primary key (thread_id, user_id)
);

-- 2. Indexes. No now() or any non-immutable function in any index predicate.
-- (thread_id, sequence) and (id, space_id) are already covered by unique/PK.
create index threads_space_idx on bob.threads (space_id);
create index thread_messages_space_idx on bob.thread_messages (space_id);

-- 3. RLS -- all three tables force it; access is decided by an ACTIVE
--    membership in the thread's space, via the S01 definer lookup.
alter table bob.threads enable row level security;
alter table bob.threads force row level security;
alter table bob.thread_messages enable row level security;
alter table bob.thread_messages force row level security;
alter table bob.thread_reads enable row level security;
alter table bob.thread_reads force row level security;

-- 4. Policies. Every read/write keys on bob_private.is_space_member(space_id)
--    (the single definer helper from S01 -- never re-written here). Messages
--    carry space_id denormalised, so their policies need no join. thread_reads
--    has no space_id column, so its policies resolve the space through
--    bob.threads (whose SELECT policy already gates by membership); a
--    non-member sees the subquery return nothing, so is_space_member(NULL) is
--    false -- no leak, no recursion (the helper never reads thread rows).

-- 4.1 bob.threads
create policy threads_select on bob.threads
  for select to authenticated
  using (bob_private.is_space_member(threads.space_id));

create policy threads_insert on bob.threads
  for insert to authenticated
  with check (bob_private.is_space_member(threads.space_id));

create policy threads_update on bob.threads
  for update to authenticated
  using (bob_private.is_space_member(threads.space_id))
  with check (bob_private.is_space_member(threads.space_id));

create policy threads_delete on bob.threads
  for delete to authenticated
  using (bob_private.is_space_member(threads.space_id));

-- 4.2 bob.thread_messages (authorship is enforced in the store: a member may
--     edit/tombstone only their own message, an owner/admin may tombstone as
--     moderation; RLS here is the membership gate, per the brief).
create policy thread_messages_select on bob.thread_messages
  for select to authenticated
  using (bob_private.is_space_member(thread_messages.space_id));

create policy thread_messages_insert on bob.thread_messages
  for insert to authenticated
  with check (bob_private.is_space_member(thread_messages.space_id));

create policy thread_messages_update on bob.thread_messages
  for update to authenticated
  using (bob_private.is_space_member(thread_messages.space_id))
  with check (bob_private.is_space_member(thread_messages.space_id));

create policy thread_messages_delete on bob.thread_messages
  for delete to authenticated
  using (bob_private.is_space_member(thread_messages.space_id));

-- 4.3 bob.thread_reads
create policy thread_reads_select on bob.thread_reads
  for select to authenticated
  using (bob_private.is_space_member(
    (select space_id from bob.threads where id = thread_reads.thread_id)
  ));

create policy thread_reads_insert on bob.thread_reads
  for insert to authenticated
  with check (bob_private.is_space_member(
    (select space_id from bob.threads where id = thread_reads.thread_id)
  ));

create policy thread_reads_update on bob.thread_reads
  for update to authenticated
  using (bob_private.is_space_member(
    (select space_id from bob.threads where id = thread_reads.thread_id)
  ))
  with check (bob_private.is_space_member(
    (select space_id from bob.threads where id = thread_reads.thread_id)
  ));

create policy thread_reads_delete on bob.thread_reads
  for delete to authenticated
  using (bob_private.is_space_member(
    (select space_id from bob.threads where id = thread_reads.thread_id)
  ));

-- 5. Grants (init-migration §2.7 pattern).
grant select, insert, update, delete on bob.threads to authenticated;
grant select, insert, update, delete on bob.thread_messages to authenticated;
grant select, insert, update, delete on bob.thread_reads to authenticated;