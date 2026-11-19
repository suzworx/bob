-- Bob native calendars and events (S14-T006, specs/014-family-collaboration/
-- data-model.md "calendars".."event_attendees"). Follows the spaces_init
-- assembly order: 1 tables (dependency order) · 2 indexes · 3 enable/force RLS
-- · 4 policies · 5 grants. No new definers: is_space_member (spaces_init) is
-- reused for every policy, never re-declared. No vector / pg_cron / pgmq, so
-- it applies under PGlite. External providers (Google, iCloud) are out of
-- scope; origin is kept for forward-compatibility only.

-- 1. Tables in dependency order: calendars -> calendar_events ->
--    event_exceptions / event_attendees.

-- 1.1 bob.calendars. The unique (id, space_id) is the anchor the events
--     composite FK references, so an event can never cross spaces.
create table bob.calendars (
  id         uuid primary key default gen_random_uuid(),
  space_id   uuid not null references bob.spaces (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 60),
  zone       text not null check (char_length(btrim(zone)) between 1 and 64),
  origin     text not null default 'native' check (origin in ('native', 'google', 'icloud')),
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, space_id)
);

-- 1.2 bob.calendar_events. uid is generated once on create and NEVER
--     regenerated on update; uid + sequence is what makes an edit an edit
--     rather than a new event. An event is all-day (dates only, end EXCLUSIVE)
--     or timed (instants), never both, never neither -- the checks below.
create table bob.calendar_events (
  id                uuid primary key default gen_random_uuid(),
  calendar_id       uuid not null,
  space_id          uuid not null,
  uid               text not null,
  sequence          integer not null default 0,
  organizer_user_id uuid not null references auth.users (id) on delete cascade,
  title             text not null check (char_length(btrim(title)) between 1 and 200),
  location          text null check (location is null or char_length(location) <= 500),
  body              text null check (body is null or char_length(body) <= 8000),
  all_day           boolean not null default false,
  start_date        date null,
  end_date          date null,
  start_at          timestamptz null,
  end_at            timestamptz null,
  zone              text not null check (char_length(btrim(zone)) between 1 and 64),
  rrule             jsonb null,
  status            text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  revision          integer not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint calendar_events_calendar_fk
    foreign key (calendar_id, space_id)
    references bob.calendars (id, space_id) on delete cascade,
  -- stable uid per calendar: an edit never mints a new uid.
  unique (calendar_id, uid),
  -- all-day means dates, and timed means instants -- never both, never neither.
  check (all_day = (start_date is not null)),
  check (all_day = (start_at is null)),
  -- the matching end half of whichever mode the event is in.
  check ((all_day and end_date is not null) or (not all_day and end_at is not null)),
  -- ordering; the paired all-day/timed columns are null in the other mode so
  -- these are NULL comparisons there and pass.
  check (end_date > start_date),
  check (end_at > start_at)
);

-- 1.3 bob.event_exceptions. original_occurrence_start is the occurrence's
--     identity: a moved instance keeps its ORIGINAL start, which is how it
--     stays the same occurrence. space_id rides along so RLS keys on it.
create table bob.event_exceptions (
  id                        uuid primary key default gen_random_uuid(),
  event_id                  uuid not null references bob.calendar_events (id) on delete cascade,
  space_id                  uuid not null,
  original_occurrence_start timestamptz not null,
  cancelled                 boolean not null default false,
  title                     text null,
  location                  text null,
  body                      text null,
  all_day                   boolean null,
  start_date                date null,
  end_date                  date null,
  start_at                  timestamptz null,
  end_at                    timestamptz null,
  zone                      text null,
  revision                  integer not null default 1,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (event_id, original_occurrence_start)
);

-- 1.4 bob.event_attendees. An attendee is a member already in the space --
--     being invited grants NO membership (enforced in code). user_id is null
--     for a future external attendee; email is that placeholder today.
create table bob.event_attendees (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references bob.calendar_events (id) on delete cascade,
  user_id    uuid null references auth.users (id) on delete cascade,
  email      text null,
  response   text not null default 'needs_action'
    check (response in ('needs_action', 'accepted', 'declined', 'tentative')),
  role       text not null default 'required' check (role in ('required', 'optional')),
  space_id   uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, user_id),
  check (user_id is not null or email is not null)
);

-- 2. Indexes. Lookup by space/calendar, and the time-range arms listEvents and
--    agenda read (timed by start_at, all-day by start_date; only one is live).
create index calendars_space_idx on bob.calendars (space_id);
create index calendar_events_calendar_idx on bob.calendar_events (calendar_id);
create index calendar_events_start_at_idx
  on bob.calendar_events (space_id, start_at) where start_at is not null;
create index calendar_events_start_date_idx
  on bob.calendar_events (space_id, start_date) where start_date is not null;
create index event_exceptions_event_idx on bob.event_exceptions (event_id);
create index event_attendees_event_idx on bob.event_attendees (event_id);
create index event_attendees_user_idx
  on bob.event_attendees (user_id) where user_id is not null;

-- 3. RLS -- all four tables force it; access is decided by is_space_member.
alter table bob.calendars enable row level security;
alter table bob.calendars force row level security;
alter table bob.calendar_events enable row level security;
alter table bob.calendar_events force row level security;
alter table bob.event_exceptions enable row level security;
alter table bob.event_exceptions force row level security;
alter table bob.event_attendees enable row level security;
alter table bob.event_attendees force row level security;

-- 4. Policies. calendars / calendar_events / event_exceptions are pure
--    membership: a non-member sees none of them (the "not found equals
--    forbidden" rule falls out of RLS). event_attendees additionally lets an
--    attendee see and update their OWN row so "own RSVP only" survives even
--    after the attendee leaves the space (data-model permission matrix).
create policy calendars_select on bob.calendars
  for select to authenticated using (bob_private.is_space_member(space_id));
create policy calendars_insert on bob.calendars
  for insert to authenticated with check (bob_private.is_space_member(space_id));
create policy calendars_update on bob.calendars
  for update to authenticated
  using (bob_private.is_space_member(space_id))
  with check (bob_private.is_space_member(space_id));
create policy calendars_delete on bob.calendars
  for delete to authenticated using (bob_private.is_space_member(space_id));

create policy calendar_events_select on bob.calendar_events
  for select to authenticated using (bob_private.is_space_member(space_id));
create policy calendar_events_insert on bob.calendar_events
  for insert to authenticated with check (bob_private.is_space_member(space_id));
create policy calendar_events_update on bob.calendar_events
  for update to authenticated
  using (bob_private.is_space_member(space_id))
  with check (bob_private.is_space_member(space_id));
create policy calendar_events_delete on bob.calendar_events
  for delete to authenticated using (bob_private.is_space_member(space_id));

create policy event_exceptions_select on bob.event_exceptions
  for select to authenticated using (bob_private.is_space_member(space_id));
create policy event_exceptions_insert on bob.event_exceptions
  for insert to authenticated with check (bob_private.is_space_member(space_id));
create policy event_exceptions_update on bob.event_exceptions
  for update to authenticated
  using (bob_private.is_space_member(space_id))
  with check (bob_private.is_space_member(space_id));
create policy event_exceptions_delete on bob.event_exceptions
  for delete to authenticated using (bob_private.is_space_member(space_id));

create policy event_attendees_select on bob.event_attendees
  for select to authenticated using (
    event_attendees.user_id = (select auth.uid())
    or bob_private.is_space_member(space_id)
  );
create policy event_attendees_insert on bob.event_attendees
  for insert to authenticated with check (bob_private.is_space_member(space_id));
create policy event_attendees_update on bob.event_attendees
  for update to authenticated using (event_attendees.user_id = (select auth.uid()))
  with check (event_attendees.user_id = (select auth.uid()));
create policy event_attendees_delete on bob.event_attendees
  for delete to authenticated using (bob_private.is_space_member(space_id));

-- 5. Grants (init-migration §2.7 pattern).
grant select, insert, update, delete on bob.calendars to authenticated;
grant select, insert, update, delete on bob.calendar_events to authenticated;
grant select, insert, update, delete on bob.event_exceptions to authenticated;
grant select, insert, update, delete on bob.event_attendees to authenticated;