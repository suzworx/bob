-- Expand durable receipt kinds; immutable ownership and transition guards stay in force.
alter table bob.google_operations drop constraint google_operations_kind_check;
alter table bob.google_operations add constraint google_operations_kind_check check
  (kind in ('calendar_create','calendar_update','gmail_draft','gmail_compose','gmail_update_draft','gmail_send','gmail_trash','gmail_restore'));
alter table bob.google_operation_slots drop constraint google_operation_slots_kind_check;
alter table bob.google_operation_slots add constraint google_operation_slots_kind_check check
  (kind in ('calendar_create','calendar_update','gmail_draft','gmail_compose','gmail_update_draft','gmail_send','gmail_trash','gmail_restore'));
alter table bob.google_operations drop constraint google_operations_check;
alter table bob.google_operations add constraint google_operations_check check (
  (kind = 'calendar_create' and char_length(stable_key) >= 5 and stable_key ~ '^[a-v0-9]+$')
  or (kind in ('calendar_update','gmail_trash','gmail_restore') and stable_key ~ '^[A-Za-z0-9_-]+$')
  or (kind in ('gmail_draft','gmail_compose','gmail_update_draft','gmail_send') and stable_key ~ '^<[A-Za-z0-9._-]+@[A-Za-z0-9.-]+>$'));

-- Direct operation IDs and trusted turn slots share the same unresolved-target guard.
alter table bob.google_operations add column target_hash text check (target_hash is null or target_hash ~ '^[a-f0-9]{64}$');
create index google_operations_unresolved_target on bob.google_operations(user_id,google_account_id,target_hash,kind)
  where state in ('pending','unknown');
create function bob_private.guard_google_operation_target() returns trigger
language plpgsql set search_path='' as $$
begin
  if NEW.target_hash is distinct from OLD.target_hash then
    raise exception 'google_operation_immutable';
  end if;
  return NEW;
end;
$$;
revoke all on function bob_private.guard_google_operation_target() from public;
create trigger google_operation_target_guard before update on bob.google_operations
  for each row execute function bob_private.guard_google_operation_target();
alter table bob.google_operations add constraint google_operations_mail_target_required check
  (kind not in ('gmail_compose','gmail_update_draft','gmail_send','gmail_trash','gmail_restore') or target_hash is not null);
