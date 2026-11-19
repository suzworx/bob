-- 014 correction (GitHub issue #151): a narrow, auditable way for the server
-- to seed the auth rows the system-test dev sign-in path needs.
--
-- Diagnosis (verified against the real local Supabase Postgres, not PGlite):
--   docker exec supabase_db_Bob psql -U bob_server -h 127.0.0.1 -d postgres \
--     -c "insert into auth.sessions (id, user_id, created_at, updated_at) \
--         values (gen_random_uuid(), '<uuid>', now(), now());"
--   ERROR:  permission denied for table sessions
-- (created_at/updated_at are nullable with no default on the real table, and
-- the PGlite test shim's auth.sessions has neither column at all, so this
-- function -- like the original raw insert it replaces -- writes only id and
-- user_id, the columns every environment agrees on.)
-- `\dp auth.sessions` / `\dp auth.users` show privileges held only by
-- supabase_auth_admin, dashboard_user, and the table owner postgres -- never
-- bob_server, the role the API connects as (§2.7). createTestTokenHandler's
-- raw "insert into auth.sessions ... on conflict do nothing" (and its
-- "insert into auth.users ..." right above it) therefore failed on every real
-- Postgres, silently, inside the tolerant try/catch each one is wrapped in.
-- bob_private.session_active (auth.sessions join auth.users) then found no
-- row, so a freshly minted test-token could never satisfy requireActiveSession
-- and GET /api/events always 401ed. PGlite's test shim (pglite-shim.sql)
-- creates auth.users/auth.sessions as plain tables with none of Supabase's
-- restrictive real-world grants, so every existing test passed while the
-- feature was dead against a real database.
--
-- Fix: give bob_server one narrow, auditable path -- a SECURITY DEFINER
-- function that inserts exactly the two rows the caller's own locally-signed
-- ES256 test-token names, nothing else. No auth.uid() check: like
-- bob_private.accounts_with_unextracted, this is a system operation, not a
-- per-user one -- it grants no capability the caller (the system-test issuer)
-- did not already have, since it only ever runs from createTestTokenHandler,
-- mounted solely on a loopback bind with BOB_SYSTEM_TEST=1 (validateAuthConfig
-- refuses BOB_SYSTEM_TEST=1 outright under BOB_PRODUCTION=1). EXECUTE is
-- revoked from public/anon/authenticated and granted only to bob_server: a
-- real signed-in user must never be able to call this and forge a session for
-- an account that is not theirs.
create or replace function bob_private.ensure_test_session(
  p_user_id uuid, p_session_id uuid
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into auth.users (id) values (p_user_id) on conflict (id) do nothing;
  insert into auth.sessions (id, user_id) values (p_session_id, p_user_id)
  on conflict (id) do nothing;
end;
$$;

revoke all on function bob_private.ensure_test_session(uuid, uuid) from public, anon, authenticated;
grant execute on function bob_private.ensure_test_session(uuid, uuid) to bob_server;
