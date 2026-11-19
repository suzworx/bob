-- S14-DEVAUTH-FIX: stop writing auth.users rows that break GoTrue's admin API.
--
-- Two places create an auth user with the id column alone:
--   - apps/api/src/dev-account.ts: `insert into auth.users (id) values ($1)`
--   - bob_private.ensure_test_session (20260916070000_system_test_session.sql)
-- GoTrue scans several auth.users token columns into non-nullable Go strings,
-- so a row with NULLs there breaks GET /auth/v1/admin/users for the WHOLE
-- project (dev:offline's "dev user setup failed: auth admin lookup failed"):
--
--   unable to fetch records: sql: Scan error on column index 3,
--   name "confirmation_token": converting NULL to string is unsupported
--
-- GoTrue's own inserts use the empty string, never NULL.
--
-- This is a NEW forward migration rather than an edit to the already-applied
-- 20260916070000_system_test_session.sql: that migration is merged and applied
-- on other machines, and editing an applied migration in place is how
-- environments silently diverge (the same house rule as
-- 20260916150000_member_profiles_email_cast.sql). Part (a) repairs rows we
-- already broke on this machine; part (b) replaces the helper so the id-only
-- insert can never happen again.

-- (a) Idempotent repair: set GoTrue's scanned string columns to '' only where
-- they are currently NULL, so a healthy row is never rewritten. Each column is
-- guarded by an information_schema check so the migration cannot fail on a
-- Postgres version that lacks one of them.
do $$
declare
  col text;
begin
  foreach col in array array[
    'confirmation_token', 'recovery_token', 'email_change',
    'email_change_token_new', 'email_change_token_current',
    'phone_change', 'phone_change_token', 'reauthentication_token'
  ]
  loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'auth'
        and table_name = 'users'
        and column_name = col
    ) then
      execute format(
        'update auth.users set %I = '''' where %I is null',
        col, col
      );
    end if;
  end loop;
end;
$$;

-- (b) Reproduced faithfully from 20260916070000_system_test_session.sql: same
-- signature, same security definer, same empty search_path, same body — the
-- only change is the auth.users insert, which now also sets aud and role to
-- GoTrue's defaults ('authenticated') and every scanned token column to ''.
create or replace function bob_private.ensure_test_session(
  p_user_id uuid, p_session_id uuid
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into auth.users (
    id, aud, role, confirmation_token, recovery_token, email_change,
    email_change_token_new, email_change_token_current, phone_change,
    phone_change_token, reauthentication_token
  )
  values (
    p_user_id, 'authenticated', 'authenticated', '', '', '', '', '', '', '', ''
  )
  on conflict (id) do nothing;
  insert into auth.sessions (id, user_id) values (p_session_id, p_user_id)
  on conflict (id) do nothing;
end;
$$;

revoke all on function bob_private.ensure_test_session(uuid, uuid) from public, anon, authenticated;
grant execute on function bob_private.ensure_test_session(uuid, uuid) to bob_server;