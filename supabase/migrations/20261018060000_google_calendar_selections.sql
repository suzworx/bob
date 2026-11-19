-- Explicit, owner-scoped projection preferences. No provider events are stored.
create table bob.google_calendar_selections (
  user_id uuid not null,
  google_account_id uuid not null,
  calendar_id text not null check (char_length(calendar_id) between 1 and 1024),
  title text not null check (char_length(title) <= 200),
  time_zone text check (char_length(time_zone) <= 128),
  last_success_at timestamptz,
  primary key (user_id, google_account_id, calendar_id),
  foreign key (user_id, google_account_id) references bob.google_accounts(user_id, id) on delete cascade
);
alter table bob.google_calendar_selections enable row level security;
alter table bob.google_calendar_selections force row level security;
create policy google_calendar_selections_owner on bob.google_calendar_selections
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on bob.google_calendar_selections from public, anon, authenticated;
grant select, insert, delete on bob.google_calendar_selections to authenticated;
grant update (title, time_zone, last_success_at) on bob.google_calendar_selections to authenticated;
