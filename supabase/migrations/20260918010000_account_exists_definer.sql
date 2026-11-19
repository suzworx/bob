-- bob_private.account_exists: whether an auth.users row exists for this id.
--
-- The local-history import (scripts/db-import-local.mjs) refuses to import into
-- an account that does not exist. It checked that with a direct
-- `select 1 from auth.users` on its own connection -- and that connection is
-- whatever BOB_DATABASE_URL names, which in production is bob_server. That
-- role has no grant on schema auth, so the check raised "permission denied for
-- schema auth" and the tool could never run against production at all. It only
-- ever worked in tests, which ran on PGlite as superuser.
--
-- The two existing auth.users readers cannot stand in for this:
--   bob_private.user_email       returns NULL both for a missing account and
--                                  for an account with no email;
--   bob_private.account_disabled returns false both for a missing account and
--                                  for one that simply is not banned.
-- So this answers the one question unambiguously, and nothing else.
--
-- Read-only, exposes a single boolean, and callable by bob_server only: an
-- ordinary signed-in user gains no way to probe which account ids exist.

create or replace function bob_private.account_exists(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from auth.users u where u.id = p_user_id);
$$;

revoke all on function bob_private.account_exists(uuid) from public, anon, authenticated;
grant execute on function bob_private.account_exists(uuid) to bob_server;
