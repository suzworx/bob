-- Receipts and authorization bind to one immutable local/provider identity.
-- A different provider account requires a new local row, never reassignment.
create function bob_private.guard_google_account_identity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (NEW.id, NEW.user_id, NEW.installation_id, NEW.provider_account_id)
    is distinct from (OLD.id, OLD.user_id, OLD.installation_id, OLD.provider_account_id) then
    raise exception 'google_account_identity_mismatch';
  end if;
  return NEW;
end;
$$;
revoke all on function bob_private.guard_google_account_identity() from public;
create trigger google_account_identity_guard before update on bob.google_accounts
  for each row execute function bob_private.guard_google_account_identity();
