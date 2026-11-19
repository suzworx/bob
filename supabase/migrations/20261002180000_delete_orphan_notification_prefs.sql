-- One conversation model, PR5 stage B (#756). Every notification preference
-- and AI invocation ends up keyed by conversation_id, so the server reads and
-- writes only that column and the contract release can drop thread_id:
--   1. unify_catch_up() links every thread that can be linked;
--   2. a thread preference whose conversation exists gets conversation_id;
--   3. the rest point at threads that never reached bob.conversations: a
--      setting for a thread that no longer exists, so it is deleted (owner
--      approved);
--   4. likewise for ai_invocations: link, then delete what has no conversation
--      (operational bookkeeping; the result message lives in messages);
--   5. notification_prefs_key_uidx goes: it keys on thread_id, which the
--      server no longer writes, so two thread mutes in one space would collide
--      on it. notification_prefs_conversation_key_uidx is the key from here on.
-- bob:contract orphan notification preferences point at threads that never existed in conversations
-- Re-runnable: a second run finds nothing to link or delete.
-- No vector / pg_cron / pgmq, so it applies under PGlite.

do $$
declare
  orphans integer;
begin
  if to_regprocedure('bob_private.unify_catch_up()') is not null then
    perform bob_private.unify_catch_up();
  end if;

  if to_regclass('bob.notification_preferences') is not null then
    update bob.notification_preferences p
       set conversation_id = p.thread_id::text
     where p.thread_id is not null
       and p.conversation_id is null
       and exists (select 1 from bob.conversations c where c.id = p.thread_id::text);

    select count(*) into orphans
      from bob.notification_preferences
     where thread_id is not null and conversation_id is null;
    if orphans > 0 then
      raise notice 'deleting % orphan notification preference(s)', orphans;
      delete from bob.notification_preferences
       where thread_id is not null and conversation_id is null;
    end if;

    drop index if exists bob.notification_prefs_key_uidx;

    -- The thread-free key the server arbitrates on, so the contract release can
    -- drop thread_id (and rebuild notification_prefs_conversation_key_uidx)
    -- without breaking a running upsert. Orphans are gone and every other row
    -- has conversation_id = thread_id::text, so nothing can collide; refuse
    -- loudly if something does.
    select count(*) into orphans from (
      select 1 from bob.notification_preferences
       group by user_id, coalesce(space_id, '00000000-0000-0000-0000-000000000000'),
                coalesce(conversation_id, ''), coalesce(type, '')
      having count(*) > 1) dup;
    if orphans > 0 then
      raise exception 'notification_preferences: % duplicate conversation key(s); notification_prefs_conversation_only_uidx not created', orphans;
    end if;
    create unique index if not exists notification_prefs_conversation_only_uidx
      on bob.notification_preferences (
        user_id,
        coalesce(space_id, '00000000-0000-0000-0000-000000000000'),
        coalesce(conversation_id, ''),
        coalesce(type, '')
      );
  end if;

  if to_regclass('bob.ai_invocations') is not null then
    update bob.ai_invocations i
       set conversation_id = i.thread_id::text
     where i.conversation_id is null
       and i.thread_id is not null
       and exists (select 1 from bob.conversations c where c.id = i.thread_id::text);

    select count(*) into orphans
      from bob.ai_invocations
     where conversation_id is null;
    if orphans > 0 then
      raise notice 'deleting % orphan ai invocation(s)', orphans;
      delete from bob.ai_invocations where conversation_id is null;
    end if;
  end if;
end;
$$;
