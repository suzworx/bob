create table bob.google_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  installation_id text not null,
  provider_account_id text not null,
  email text not null check (char_length(email) between 3 and 320),
  name text null check (name is null or char_length(name) <= 200),
  selected boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, installation_id)
);
create unique index google_accounts_one_selected
  on bob.google_accounts (user_id)
  where selected;
alter table bob.google_accounts enable row level security;
alter table bob.google_accounts force row level security;
create policy google_accounts_owner on bob.google_accounts
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on bob.google_accounts to authenticated;
