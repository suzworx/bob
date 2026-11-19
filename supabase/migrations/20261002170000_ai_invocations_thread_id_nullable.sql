-- One conversation model, PR5 stage A (#756). Makes the legacy thread columns
-- safe before the contract release drops them; additive and data-only:
--   1. ai_invocations.thread_id becomes nullable, so the server writes only
--      conversation_id (the running guard is the conversation_id partial
--      unique index from 20261001100000_conversation_unify_expand).
--   2. unify_catch_up() keys every invocation whose conversation exists.
--   3. The active pointer lives only in conversation_id: a pre-PR3 row with
--      just thread_id is copied there first (when that conversation exists),
--      then both thread columns are nulled, so a stale thread_space_id for a
--      space the user left can no longer fail the insert/update policies.
-- No vector / pg_cron / pgmq, so it applies under PGlite.

do $$
begin
  if to_regclass('bob.ai_invocations') is not null then
    alter table bob.ai_invocations alter column thread_id drop not null;
  end if;

  if to_regprocedure('bob_private.unify_catch_up()') is not null then
    perform bob_private.unify_catch_up();
  end if;

  if to_regclass('bob.active_conversations') is not null then
    update bob.active_conversations a
       set conversation_id = a.thread_id::text
     where a.conversation_id is null
       and a.thread_id is not null
       and exists (select 1 from bob.conversations c where c.id = a.thread_id::text);

    update bob.active_conversations
       set thread_id = null, thread_space_id = null
     where thread_id is not null or thread_space_id is not null;
  end if;
end;
$$;
