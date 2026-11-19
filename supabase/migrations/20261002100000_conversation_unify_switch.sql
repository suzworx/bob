-- One conversation model, PR2 switch (#756). Relaxing and additive only:
--   * the FKs from ai_invocations (thread_id, result_message_id) and
--     notification_preferences (thread_id) to the old thread tables go, because
--     new threads will exist only in bob.conversations. The columns stay uuid
--     and populated, so a rolled-back old server still reads them. The
--     active_conversations pointer FK stays until the cutover moves the pointer
--     (a later migration), so this release changes no pointer behaviour.
--   * bob_private.unify_catch_up() re-copies the old tables with upsert
--     semantics: the PR1 backfill used "on conflict do nothing", so edits,
--     tombstones, renames, archives and read cursors written after PR1 applied
--     were missed. Same row shapes as 20261001100000_conversation_unify_expand
--     step 8; re-runnable, and every old-table read is to_regclass-guarded.
-- No vector / pg_cron / pgmq, so it applies under PGlite.

-- 1. Drop the three FKs, found by (table, column) in pg_constraint so the
--    generated names never matter. A missing table simply matches nothing.
do $$
declare
  r record;
begin
  for r in
    select distinct c.conrelid::regclass as tbl, c.conname
      from (values ('bob.ai_invocations', 'thread_id'),
                   ('bob.ai_invocations', 'result_message_id'),
                   ('bob.notification_preferences', 'thread_id')) v (tbl, col)
      join pg_constraint c on c.conrelid = to_regclass(v.tbl) and c.contype = 'f'
      join pg_attribute a on a.attrelid = c.conrelid and a.attname = v.col
     where a.attnum = any (c.conkey)
  loop
    execute format('alter table %s drop constraint if exists %I', r.tbl, r.conname);
  end loop;
end;
$$;

-- 2. The catch-up. Order matters: versions for edited messages are written
--    before the message upsert raises its revision.
create or replace function bob_private.unify_catch_up()
returns void
language plpgsql
set search_path = ''
as $fn$
begin
  -- 2.1 Self spaces and owner memberships (PR1 step 1 idiom).
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

  -- 2.2 Null-only fills for private rows written by the old code (PR1 step 7).
  update bob.conversations c
     set space_id = s.id
    from bob.spaces s
   where s.kind = 'private' and s.owner_user_id = c.user_id and c.space_id is null;
  update bob.conversations set created_by = user_id where created_by is null;
  update bob.messages set sequence = position + 1 where sequence is null;
  update bob.messages m
     set space_id = c.space_id
    from bob.conversations c
   where c.id = m.conversation_id and m.space_id is null and c.space_id is not null;
  update bob.messages set author_user_id = user_id
   where role = 'user' and author_user_id is null;
  update bob.conversations c
     set last_sequence = x.max_sequence
    from (select conversation_id, max(sequence) as max_sequence
            from bob.messages group by conversation_id) x
   where x.conversation_id = c.id and c.last_sequence < x.max_sequence;
  update bob.message_versions v
     set space_id = m.space_id
    from bob.messages m
   where m.id = v.message_id and v.space_id is null and m.space_id is not null;

  -- 2.3 Threads, thread messages and their versions.
  if to_regclass('bob.threads') is not null then
    execute $q$
      insert into bob.conversations
        (id, user_id, space_id, created_by, title, last_sequence, archived_at, created_at, updated_at)
      select t.id::text, t.created_by, t.space_id, t.created_by, t.title, t.last_sequence,
             t.archived_at, t.created_at, t.updated_at
        from bob.threads t
      on conflict (id) do update
        set title = excluded.title,
            archived_at = excluded.archived_at,
            last_sequence = greatest(bob.conversations.last_sequence, excluded.last_sequence),
            updated_at = excluded.updated_at
    $q$;
    -- An edit made on the old tables: deselect what exists, add the new body
    -- as the next version (its id carries the revision, so a re-run is a no-op).
    execute $q$
      update bob.message_versions v
         set is_selected = false
        from bob.thread_messages tm
        join bob.messages m on m.id = tm.id::text
       where v.message_id = m.id and tm.revision > m.revision and v.is_selected
    $q$;
    execute $q$
      insert into bob.message_versions
        (id, message_id, user_id, space_id, parts, version_index, is_selected, created_at)
      select 'ver_' || tm.id || '_r' || tm.revision, m.id, m.user_id, m.space_id,
             jsonb_build_array(jsonb_build_object('type', 'text', 'text', tm.body)),
             (select coalesce(max(x.version_index), -1) + 1
                from bob.message_versions x where x.message_id = m.id),
             true, tm.updated_at
        from bob.thread_messages tm
        join bob.messages m on m.id = tm.id::text
       where tm.revision > m.revision
      on conflict do nothing
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
       order by tm.thread_id, tm.sequence
      on conflict (id) do update
        set revision = excluded.revision,
            tombstoned_at = excluded.tombstoned_at,
            tombstoned_by = excluded.tombstoned_by,
            updated_at = excluded.updated_at
    $q$;
    -- A message new since PR1 gets its first selected version (PR1 shape).
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

  -- 2.4 Read cursors only move forward.
  if to_regclass('bob.thread_reads') is not null then
    execute $q$
      insert into bob.conversation_reads (conversation_id, user_id, last_read_sequence, updated_at)
      select r.thread_id::text, r.user_id, r.last_read_sequence, r.updated_at
        from bob.thread_reads r
      on conflict (conversation_id, user_id) do update
        set last_read_sequence = greatest(bob.conversation_reads.last_read_sequence,
                                          excluded.last_read_sequence),
            updated_at = greatest(bob.conversation_reads.updated_at, excluded.updated_at)
    $q$;
  end if;

  -- thread_id has no FK now, so only key the rows whose conversation exists.
  if to_regclass('bob.ai_invocations') is not null then
    execute $q$
      update bob.ai_invocations i
         set conversation_id = i.thread_id::text
       where i.conversation_id is null
         and exists (select 1 from bob.conversations c where c.id = i.thread_id::text)
    $q$;
  end if;
end;
$fn$;

-- Server-side only: no client role may run it.
revoke all on function bob_private.unify_catch_up() from public;

-- 3. Catch up once now; later runs happen at the store cutover.
select bob_private.unify_catch_up();
