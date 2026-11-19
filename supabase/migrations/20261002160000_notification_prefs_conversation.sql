-- One conversation model, PR5 expand (#756). Additive only: notification
-- preferences gain conversation_id (the unified id; a thread's id is its uuid
-- as text) so the contract migration can later drop thread_id and
-- notification_prefs_key_uidx. Both stay in place here, and the server keeps
-- writing thread_id, so a rolled-back old server still works.
-- No vector / pg_cron / pgmq, so it applies under PGlite.

do $$
declare
  orphans integer;
begin
  if to_regclass('bob.notification_preferences') is null then
    return;
  end if;

  -- 1. The new key column; a deleted conversation takes its preferences with
  --    it, as the old thread FK did.
  alter table bob.notification_preferences
    add column if not exists conversation_id text null
      references bob.conversations (id) on delete cascade;

  -- 2. Backfill only rows whose conversation exists; a preference for a thread
  --    that never reached bob.conversations stays NULL (reads fall back to
  --    thread_id) and is reported, never deleted.
  update bob.notification_preferences p
     set conversation_id = p.thread_id::text
   where p.thread_id is not null
     and p.conversation_id is null
     and exists (select 1 from bob.conversations c where c.id = p.thread_id::text);

  select count(*) into orphans
    from bob.notification_preferences
   where thread_id is not null and conversation_id is null;
  if orphans > 0 then
    raise notice 'notification_preferences: % thread preference(s) have no conversation; conversation_id left NULL', orphans;
  end if;

  -- 3. The conversation-keyed twin of notification_prefs_key_uidx (same
  --    coalesce idiom, so NULLs are a real key and the global row stays unique).
  --    A row with no conversation keys on its thread text, so orphans and rows
  --    an old server writes (thread_id only) never collide with each other.
  create unique index if not exists notification_prefs_conversation_key_uidx
    on bob.notification_preferences (
      user_id,
      coalesce(space_id, '00000000-0000-0000-0000-000000000000'),
      coalesce(conversation_id, thread_id::text, ''),
      coalesce(type, '')
    );
end;
$$;
