-- bob:requires-extension vector
-- Follow-up to #758: `npm run memory:reconcile` merges memories stored twice
-- before the memory judge existed ("User has a wife named Maya." beside
-- "My wife's name is Maya"). It works one account at a time under withUser,
-- but has to know which accounts hold memories first. bob_server runs under
-- FORCE RLS with no policy of its own, so a plain query sees zero rows; this
-- SECURITY DEFINER helper is the same pattern as the startup scan helper
-- (20260916020000_memory_scan_helper.sql): a system maintenance query that
-- returns account ids only, never memory content.

create or replace function bob_private.accounts_with_current_memories()
returns table (user_id uuid)
language sql stable security definer set search_path = ''
as $$
  select distinct m.user_id
    from bob.memories m
   where m.superseded_by is null
   order by m.user_id;
$$;

revoke all on function bob_private.accounts_with_current_memories() from public, anon;
grant execute on function bob_private.accounts_with_current_memories() to bob_server;
