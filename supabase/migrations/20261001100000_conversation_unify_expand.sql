-- One conversation model, PR1 expand + backfill (#756, docs/diagrams/data-model.md
-- "LLD -- planned unified schema"). Additive only: conversations, messages and
-- message_versions gain a space key and the thread columns, conversation_reads
-- mirrors thread_reads, ai_invocations gains conversation_id, and every thread
-- is copied in with its ids kept. Nothing in apps/* reads the new columns yet;
-- the old tables stay authoritative until a later PR switches the routes.
-- Re-runnable throughout (if not exists / on conflict do nothing / null-only
-- updates). The migration runner wraps the file in one transaction. Old-table
-- reads go through execute inside a to_regclass guard so they resolve at run
-- time. No vector / pg_cron / pgmq, so it applies under PGlite.

-- 1. Self spaces (spaces_init backfill idiom) for every account created since,
--    so the private-conversation backfill below always finds one. The erased-
--    user sentinel owns no space.
insert into bob.spaces (id, kind, name, owner_user_id)
select gen_random_uuid(), 'private', 'Private', u.id
from auth.users u
where u.id <> '00000000-0000-4000-8000-0000000000de'
on conflict (owner_user_id) where kind = 'private' do nothing;

insert into bob.space_memberships (space_id, user_id, role)
select s.id, s.owner_user_id, 'owner'
from bob.spaces s
where s.kind = 'private'
on conflict (space_id, user_id) do nothing;

-- 2. bob.conversations: the space key and the thread columns.
alter table bob.conversations
  add column if not exists space_id uuid null
    references bob.spaces (id) on delete cascade,
  add column if not exists created_by uuid null
    references auth.users (id),
  add column if not exists last_sequence bigint not null default 0;

-- The composite target of the message-level same-space FK.
create unique index if not exists conversations_id_space_uidx
  on bob.conversations (id, space_id);

-- 3. bob.messages: thread-message columns. All nullable or defaulted, so the
--    old write path keeps inserting exactly what it does today.
alter table bob.messages
  add column if not exists space_id uuid null,
  add column if not exists author_user_id uuid null
    references auth.users (id) on delete set null,
  add column if not exists sequence bigint null,
  add column if not exists client_message_id text null
    check (char_length(btrim(client_message_id)) between 1 and 128),
  add column if not exists reply_to_message_id text null
    references bob.messages (id),
  add column if not exists revision integer not null default 1,
  add column if not exists tombstoned_at timestamptz null,
  add column if not exists tombstoned_by uuid null,
  add column if not exists updated_at timestamptz not null default now();

-- Ordering and retry-dedup are database guarantees (threads_init 1.2); nulls
-- never collide, so the old rows pass until they are backfilled.
create unique index if not exists messages_conversation_sequence_uidx
  on bob.messages (conversation_id, sequence);
create unique index if not exists messages_author_client_uidx
  on bob.messages (author_user_id, client_message_id);
create unique index if not exists messages_id_space_uidx
  on bob.messages (id, space_id);

-- 4. bob.message_versions: the space key, kept in step with its message.
alter table bob.message_versions
  add column if not exists space_id uuid null;

-- Composite same-space FKs, MATCH SIMPLE (the default) so a row whose space_id
-- is still null passes. Postgres has no "add constraint if not exists".
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'messages_conversation_space_fkey'
                   and conrelid = 'bob.messages'::regclass) then
    alter table bob.messages
      add constraint messages_conversation_space_fkey
      foreign key (conversation_id, space_id)
      references bob.conversations (id, space_id);
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'message_versions_message_space_fkey'
                   and conrelid = 'bob.message_versions'::regclass) then
    alter table bob.message_versions
      add constraint message_versions_message_space_fkey
      foreign key (message_id, space_id)
      references bob.messages (id, space_id);
  end if;
end;
$$;

-- 5. bob.conversation_reads: per person, not per space (thread_reads).
create table if not exists bob.conversation_reads (
  conversation_id     text not null references bob.conversations (id) on delete cascade,
  user_id             uuid not null references auth.users (id) on delete cascade,
  last_read_sequence  bigint not null default 0,
  updated_at          timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

alter table bob.conversation_reads enable row level security;
alter table bob.conversation_reads force row level security;

-- 6. bob.ai_invocations: the unified conversation key. thread_id,
--    trigger_message_id and result_message_id stay as they are.
alter table bob.ai_invocations
  add column if not exists conversation_id text null
    references bob.conversations (id) on delete cascade;

-- At most one running invocation per conversation (as per thread today).
create unique index if not exists ai_invocations_one_running_per_conversation
  on bob.ai_invocations (conversation_id) where state = 'running';

-- 7. Backfill the private conversations: each lands in its owner's self space,
--    sequence follows position, and only user turns carry an author.
update bob.conversations c
   set space_id = s.id
  from bob.spaces s
 where s.kind = 'private'
   and s.owner_user_id = c.user_id
   and c.space_id is null;

update bob.conversations set created_by = user_id where created_by is null;

update bob.messages set sequence = position + 1 where sequence is null;

update bob.messages m
   set space_id = c.space_id
  from bob.conversations c
 where c.id = m.conversation_id
   and m.space_id is null
   and c.space_id is not null;

update bob.messages
   set author_user_id = user_id
 where role = 'user' and author_user_id is null;

update bob.conversations c
   set last_sequence = x.max_sequence
  from (select conversation_id, max(sequence) as max_sequence
          from bob.messages group by conversation_id) x
 where x.conversation_id = c.id
   and c.last_sequence < x.max_sequence;

update bob.message_versions v
   set space_id = m.space_id
  from bob.messages m
 where m.id = v.message_id
   and v.space_id is null
   and m.space_id is not null;

-- 8. Copy the threads in, ids kept (uuid as text). A thread message becomes a
--    message plus one selected version whose parts hold the body; a null
--    author is Bob. Every statement runs only when its source table exists.
do $$
begin
  if to_regclass('bob.threads') is not null then
    execute $q$
      insert into bob.conversations
        (id, user_id, space_id, created_by, title, last_sequence, archived_at, created_at, updated_at)
      select t.id::text, t.created_by, t.space_id, t.created_by, t.title, t.last_sequence,
             t.archived_at, t.created_at, t.updated_at
        from bob.threads t
      on conflict (id) do nothing
    $q$;
    execute $q$
      insert into bob.messages
        (id, conversation_id, space_id, role, user_id, author_user_id, position, sequence,
         client_message_id, reply_to_message_id, revision, tombstoned_at, tombstoned_by,
         device_id, origin, created_at, updated_at)
      select tm.id::text, tm.thread_id::text, tm.space_id,
             case when tm.author_user_id is null then 'assistant' else 'user' end,
             coalesce(tm.author_user_id, t.created_by), tm.author_user_id,
             (tm.sequence - 1)::integer, tm.sequence, tm.client_message_id,
             tm.reply_to_message_id::text, tm.revision, tm.tombstoned_at, tm.tombstoned_by,
             tm.device_id,
             case when tm.device_id is not null then 'device' else 'web_text' end,
             tm.created_at, tm.updated_at
        from bob.thread_messages tm
        join bob.threads t on t.id = tm.thread_id
      on conflict (id) do nothing
    $q$;
    execute $q$
      insert into bob.message_versions
        (id, message_id, user_id, space_id, parts, version_index, is_selected, created_at)
      select 'ver_' || tm.id, m.id, m.user_id, m.space_id,
             jsonb_build_array(jsonb_build_object('type', 'text', 'text', tm.body)),
             0, true, m.created_at
        from bob.thread_messages tm
        join bob.messages m on m.id = tm.id::text
      on conflict do nothing
    $q$;
  end if;
  if to_regclass('bob.thread_reads') is not null then
    execute $q$
      insert into bob.conversation_reads (conversation_id, user_id, last_read_sequence, updated_at)
      select r.thread_id::text, r.user_id, r.last_read_sequence, r.updated_at
        from bob.thread_reads r
      on conflict (conversation_id, user_id) do nothing
    $q$;
  end if;
  if to_regclass('bob.ai_invocations') is not null then
    execute $q$
      update bob.ai_invocations
         set conversation_id = thread_id::text
       where conversation_id is null
    $q$;
  end if;
end;
$$;

-- 9. Indexes for the RLS key. No now() or any non-immutable function in any
--    predicate; (id, space_id) is covered by the unique indexes above.
create index if not exists conversations_space_idx on bob.conversations (space_id);
create index if not exists messages_space_idx on bob.messages (space_id);
create index if not exists message_versions_space_idx on bob.message_versions (space_id);

-- 10. Policies, alongside the per-account ones from bob_init (permissive
--     policies OR together). Membership is the single S01 definer,
--     bob_private.is_space_member(space_id), which keys on (select auth.uid()).
--   * <table>_<op>_space_member: an active member of the row's space may read
--     and write it, so a shared conversation reaches every member.
--   * <table>_space_guard, RESTRICTIVE (ANDed with every permissive policy): a
--     row that has a space needs an active membership in it, so an ex-member
--     who authored migrated shared rows (user_id = them) cannot keep reading
--     them through the old owner policy. Rows with no space yet pass.
--   * conversation_reads has no space_id; like thread_reads it resolves the
--     space through bob.conversations (whose own RLS gates the subquery).
--   Created through a catalog check so a re-run is a no-op (no "create policy
--   if not exists" in Postgres, and this file drops nothing).
do $$
declare
  t text;
  op text;
  expr text;
  clause text;
begin
  foreach t in array array['conversations', 'messages', 'message_versions', 'conversation_reads'] loop
    expr := case t
      when 'conversation_reads' then 'bob_private.is_space_member((select c.space_id from bob.conversations c where c.id = conversation_reads.conversation_id))'
      else format('bob_private.is_space_member(%I.space_id)', t)
    end;
    foreach op in array array['select', 'insert', 'update', 'delete'] loop
      clause := case op
        when 'insert' then format('with check (%s)', expr)
        when 'update' then format('using (%s) with check (%s)', expr, expr)
        else format('using (%s)', expr)
      end;
      if not exists (select 1 from pg_policies
                     where schemaname = 'bob' and tablename = t
                       and policyname = format('%s_%s_space_member', t, op)) then
        execute format('create policy %I on bob.%I for %s to authenticated %s',
                       format('%s_%s_space_member', t, op), t, op, clause);
      end if;
    end loop;
    if t <> 'conversation_reads' and not exists (
         select 1 from pg_policies
          where schemaname = 'bob' and tablename = t
            and policyname = format('%s_space_guard', t)) then
      execute format(
        'create policy %I on bob.%I as restrictive for all to authenticated '
        'using (%I.space_id is null or bob_private.is_space_member(%I.space_id)) '
        'with check (%I.space_id is null or bob_private.is_space_member(%I.space_id))',
        format('%s_space_guard', t), t, t, t, t, t);
    end if;
  end loop;
end;
$$;

-- 11. Grants (init-migration §2.7 pattern). messages keeps no table-wide
--     update; the thread edit/tombstone columns get a column grant, as
--     device_id and interrupted do.
grant select, insert, update, delete on bob.conversation_reads to authenticated;
grant update (revision, tombstoned_at, tombstoned_by, updated_at) on bob.messages to authenticated;
