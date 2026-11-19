-- Connect subjects are explicit connection identities, not installation IDs.
alter table bob.google_accounts add column connect_subject text
  check (connect_subject ~ '^gc_[A-Za-z0-9_-]{43}$');
create unique index google_accounts_connect_subject on bob.google_accounts(user_id, connect_subject);
create or replace function bob_private.guard_google_account_identity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (NEW.id, NEW.user_id, NEW.installation_id, NEW.provider_account_id, NEW.connect_subject)
    is distinct from (OLD.id, OLD.user_id, OLD.installation_id, OLD.provider_account_id, OLD.connect_subject) then
    raise exception 'google_account_identity_mismatch';
  end if;
  return NEW;
end;
$$;

create table bob.google_consent_attempts (
  user_id uuid not null references auth.users(id) on delete cascade,
  state_hash text not null check (state_hash ~ '^[a-f0-9]{64}$'),
  connect_subject text not null check (connect_subject ~ '^gc_[A-Za-z0-9_-]{43}$'),
  capabilities text[] not null check (cardinality(capabilities) between 1 and 4
    and capabilities <@ array['calendar.read','calendar.write','gmail.read','gmail.draft']::text[]),
  reconnect_account_id uuid,
  consumed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  primary key (user_id, state_hash),
  foreign key (user_id, reconnect_account_id) references bob.google_accounts(user_id, id) on delete cascade
);
alter table bob.google_consent_attempts enable row level security;
alter table bob.google_consent_attempts force row level security;
create policy google_consent_attempts_owner on bob.google_consent_attempts
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on bob.google_consent_attempts from public, anon, authenticated;
grant select, insert, delete on bob.google_consent_attempts to authenticated;
grant update (consumed_at) on bob.google_consent_attempts to authenticated;
