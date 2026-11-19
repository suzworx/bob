-- bob:requires-extension vector
-- 010 (T010B, correction c1): the server-privileged cross-account startup scan
-- helper. The first-line marker makes PGlite skip this file -- memory is off
-- there, and bob.messages.memory_extracted_at (added by
-- 20260915200000_memory_init.sql) does not exist in a PGlite build (T004 lint,
-- apps/api/src/store/migrate.ts). Production applies via supabase db push.

-- The worker's startup scan (research R11) must find every account with
-- unextracted messages, so it cannot run under withUser (we do not know which
-- accounts need work until we look) and a plain query on bob.messages will
-- not do either: the bob_server connection runs with auth.uid() null, so
-- FORCE RLS silently returns zero rows, with no error. SECURITY DEFINER is
-- correct here because this is a cross-account scan BY DESIGN -- a system
-- maintenance query, not a user-data request -- and it takes no user input
-- beyond a timestamp bound and a cap. It returns user ids only, never message
-- content, so nothing sensitive crosses the function boundary. It lives in the
-- unexposed bob_private schema, with EXECUTE revoked from public/anon and
-- granted only to bob_server, the role the API connects as.

create or replace function bob_private.accounts_with_unextracted(
  p_since timestamptz,
  p_limit int
) returns table (user_id uuid)
language sql stable security definer set search_path = ''
as $$
  select distinct u.user_id
    from bob.messages u
   where u.role = 'user'
     and u.memory_extracted_at is null
     and u.created_at >= p_since
   order by u.user_id
   limit p_limit;
$$;

revoke all on function bob_private.accounts_with_unextracted(timestamptz, integer) from public, anon;
grant execute on function bob_private.accounts_with_unextracted(timestamptz, integer) to bob_server;