-- Durable write receipts have their own lifecycle: many operations per linked account.
alter table bob.google_accounts add constraint google_accounts_owner_id_unique unique (user_id, id);
create table bob.google_operations (
  user_id uuid not null,
  google_account_id uuid not null,
  operation_id uuid not null,
  kind text not null check (kind in ('calendar_create', 'calendar_update', 'gmail_draft')),
  intent_hash text not null check (intent_hash ~ '^[a-f0-9]{64}$'),
  stable_key text not null check (char_length(stable_key) between 1 and 1024 and stable_key !~ '[[:cntrl:]]'),
  state text not null default 'pending' check (state in ('pending', 'succeeded', 'unknown', 'failed')),
  result_id text check (result_id is null or (char_length(result_id) between 1 and 1024 and result_id ~ '^[A-Za-z0-9_-]+$')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, google_account_id, operation_id),
  foreign key (user_id, google_account_id) references bob.google_accounts(user_id, id) on delete cascade,
  check ((kind = 'calendar_create' and char_length(stable_key) >= 5 and stable_key ~ '^[a-v0-9]+$')
    or (kind = 'calendar_update' and stable_key ~ '^[A-Za-z0-9_-]+$')
    or (kind = 'gmail_draft' and stable_key ~ '^<[A-Za-z0-9._-]+@[A-Za-z0-9.-]+>$')),
  check ((state = 'succeeded') = (result_id is not null))
);
alter table bob.google_operations enable row level security;
alter table bob.google_operations force row level security;
create policy google_operations_owner on bob.google_operations
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on bob.google_operations from public, anon, authenticated;
grant select, insert on bob.google_operations to authenticated;
grant update (state, result_id) on bob.google_operations to authenticated;

create function bob_private.guard_google_operation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    if NEW.state <> 'pending' or NEW.result_id is not null then
      raise exception 'google_operation_invalid_initial_state';
    end if;
    NEW.created_at := now();
  else
    if (NEW.user_id, NEW.google_account_id, NEW.operation_id, NEW.kind, NEW.intent_hash, NEW.stable_key, NEW.created_at)
      is distinct from (OLD.user_id, OLD.google_account_id, OLD.operation_id, OLD.kind, OLD.intent_hash, OLD.stable_key, OLD.created_at) then
      raise exception 'google_operation_immutable';
    end if;
    if not ((OLD.state = 'pending' and NEW.state in ('unknown', 'failed', 'succeeded'))
      or (OLD.state = 'unknown' and NEW.state in ('failed', 'succeeded'))) then
      raise exception 'google_operation_invalid_transition';
    end if;
  end if;
  NEW.updated_at := now();
  return NEW;
end;
$$;
revoke all on function bob_private.guard_google_operation() from public;
create trigger google_operation_guard before insert or update on bob.google_operations
  for each row execute function bob_private.guard_google_operation();
