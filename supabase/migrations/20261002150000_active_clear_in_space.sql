-- One conversation model, PR3 pointer half (#756). Additive: one SECURITY
-- DEFINER function that clears the caller's active pointer when it names a
-- conversation in a shared space. A definer because the clear runs right
-- after a membership revoke, when RLS no longer lets the caller see that
-- conversation. The store stamps changed_at itself (conversations/active.ts).
-- No vector / pg_cron / pgmq, so it applies under PGlite.

-- Nulls the pointer (and the legacy thread columns, dropped later) when its
-- effective target -- conversation_id, else a pre-PR3 thread_id -- is a
-- conversation of p_space and p_space is not a private space. Returns true
-- when a pointer was cleared. Callers run under withUser (role authenticated),
-- so p_user must be the caller: no account can clear another's pointer.
create or replace function bob_private.clear_active_conversation_in_space(p_user uuid, p_space uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_user is distinct from (select auth.uid()) then
    return false;
  end if;
  update bob.active_conversations a
     set conversation_id = null, thread_id = null, thread_space_id = null
   where a.user_id = p_user
     and exists (
       select 1
         from bob.conversations c
         join bob.spaces s on s.id = c.space_id
        where c.id = coalesce(a.conversation_id, a.thread_id::text)
          and c.space_id = p_space
          and s.kind <> 'private'
     );
  return found;
end;
$$;

revoke all on function bob_private.clear_active_conversation_in_space(uuid, uuid) from public, anon;
grant execute on function bob_private.clear_active_conversation_in_space(uuid, uuid) to authenticated, bob_server;
