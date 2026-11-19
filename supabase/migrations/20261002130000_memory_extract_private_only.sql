-- bob:requires-extension vector
-- One conversation model, PR4 memory half (#756): personal memory is never
-- extracted from a pair or group space. listUnextracted already filters to
-- private conversations; this replaces the cross-account startup-scan helper
-- (20260916020000_memory_scan_helper.sql, same signature and security) so an
-- author of shared-thread messages is not enqueued on every boot for turns the
-- worker will never pick up. The first-line marker makes PGlite skip this
-- file, as it skips memory_init. Additive: no backfill of memory_extracted_at.
-- A conversation with no space yet is a legacy private one.

create or replace function bob_private.accounts_with_unextracted(
  p_since timestamptz,
  p_limit int
) returns table (user_id uuid)
language sql stable security definer set search_path = ''
as $$
  select distinct u.user_id
    from bob.messages u
    join bob.conversations c on c.id = u.conversation_id
    left join bob.spaces s on s.id = c.space_id
   where u.role = 'user'
     and u.memory_extracted_at is null
     and u.created_at >= p_since
     and coalesce(s.kind, 'private') = 'private'
   order by u.user_id
   limit p_limit;
$$;

revoke all on function bob_private.accounts_with_unextracted(timestamptz, integer) from public, anon;
grant execute on function bob_private.accounts_with_unextracted(timestamptz, integer) to bob_server;
