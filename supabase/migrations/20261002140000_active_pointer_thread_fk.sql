-- One conversation model, PR2 cutover (#756). Relaxing only: the composite FK
-- from bob.active_conversations (thread_id, thread_space_id) to bob.threads
-- goes, because new threads exist only in bob.conversations and a pointer to
-- one would violate it. The columns and the active_conversations_thread_pair
-- check stay; the store now reports a pointer to a missing or archived thread
-- as cleared on the next read (conversations/active.ts getActive).
-- No vector / pg_cron / pgmq, so it applies under PGlite.

-- Found by (table, column) in pg_constraint so the name never matters. A
-- missing table simply matches nothing.
do $$
declare
  r record;
begin
  for r in
    select distinct c.conrelid::regclass as tbl, c.conname
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attname = 'thread_id'
     where c.conrelid = to_regclass('bob.active_conversations')
       and c.contype = 'f'
       and a.attnum = any (c.conkey)
  loop
    execute format('alter table %s drop constraint if exists %I', r.tbl, r.conname);
  end loop;
end;
$$;
