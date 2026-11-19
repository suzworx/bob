-- An owner can keep multiple private definitions tied to a Google connection.
-- Disconnecting that connection or erasing the owner cascades its definitions.
-- This migration creates no execution queue, results, worker, or provider grant.
create table bob.routines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  google_account_id uuid not null,
  kind text not null check (kind = 'daily_gmail_digest'),
  local_time text not null check (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  time_zone text not null check (char_length(time_zone) between 1 and 100),
  scheduled_read_consent boolean not null check (scheduled_read_consent),
  status text not null default 'active' check (status in ('active', 'paused')),
  revision integer not null default 1 check (revision > 0),
  next_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (user_id, google_account_id)
    references bob.google_accounts(user_id, id) on delete cascade,
  check ((status = 'paused' and next_run_at is null) or (status = 'active' and next_run_at is not null))
);
create index routines_owner_account on bob.routines(user_id, google_account_id);
alter table bob.routines enable row level security;
alter table bob.routines force row level security;
create policy routines_owner on bob.routines for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on bob.routines to authenticated;
comment on table bob.routines is
  'Private routine definitions only. Execution must recheck account ownership and live Gmail read grants; no worker is registered by this table.';
