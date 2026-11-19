-- Account erasure removes the account's email effects (#545 + #546).
--
-- bob.email_effects.recipient_user_id cascades only when the auth.users row
-- is deleted, and erasure never deletes it (erase_account anonymizes in
-- place). This definer deletes the account's rows; store/erasure.ts calls it
-- in the erase_account transaction, next to purge_account_games. The rows
-- hold only an effect key, the recipient and a timestamp.
--
-- Additive: one new function and its grants. erase_account is unchanged.

create or replace function bob_private.purge_account_email_effects(p_user_id uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_total integer;
begin
  delete from bob.email_effects where recipient_user_id = p_user_id;
  get diagnostics v_total = row_count;
  return v_total;
end;
$$;

revoke all on function bob_private.purge_account_email_effects(uuid) from public, anon, authenticated;
grant execute on function bob_private.purge_account_email_effects(uuid) to bob_server;
