-- Account deletion leaves the inbox behind (G6, CU-REVIEW-3). purgeAccountContent
-- (store/account.ts) never touched bob.notifications: those rows reference
-- auth.users, which deletion keeps, so they survive and a null-space notice is
-- readable again if the person signs back in.
--
-- This cannot be a plain withUser delete: notifications has FORCE RLS and no
-- delete policy (notifications-init.sql section 4.1 -- the only account write is
-- read_at via the update policy), and Postgres also applies the SELECT policy to
-- a DELETE with a WHERE, which hides space-scoped rows once erasure has already
-- revoked the memberships (erasure runs first in web-account.ts). So this follows
-- the server-only definer precedent exactly: bob_private.notifications_enqueue
-- (20260917020000_notifications_init.sql) runs as the migration owner, bypassing
-- the lock, and only bob_server may call it.
create or replace function bob_private.purge_account_notifications(p_user_id uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from bob.notifications where recipient_user_id = p_user_id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function bob_private.purge_account_notifications(uuid) from public, anon, authenticated;
grant execute on function bob_private.purge_account_notifications(uuid) to bob_server;
