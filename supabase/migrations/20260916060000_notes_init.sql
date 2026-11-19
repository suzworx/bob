-- Bob shared notes and revision history (S18, GitHub issue #129,
-- specs/014-family-collaboration/contracts/api.md "Notes and assets").
-- Follows the spaces-init assembly order: 1 tables (dependency order) ·
-- 2 indexes · 3 enable/force RLS · 4 policies · 5 grants. Access is decided by
-- ACTIVE membership in the note's space via the S14-T001 helper
-- bob_private.is_space_member -- no second copy of it, and no policy
-- subqueries space_memberships directly. No vector / pg_cron / pgmq, so it
-- applies under PGlite. No now() or other non-immutable function appears in an
-- index predicate.

-- 1. Tables in dependency order: notes -> note_revisions.

-- 1.1 bob.notes
create table bob.notes (
  id          uuid primary key default gen_random_uuid(),
  space_id    uuid not null references bob.spaces (id) on delete cascade,
  title       text not null check (char_length(btrim(title)) between 1 and 200),
  body        text not null default '' check (char_length(body) <= 20000),
  pinned      boolean not null default false,
  revision    integer not null default 1,
  created_by  uuid not null references auth.users (id),
  updated_by  uuid not null references auth.users (id),
  ai_assisted boolean not null default false,
  trashed_at  timestamptz null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 1.2 bob.note_revisions -- append-only history: every accepted edit writes a
--     row with the editor and the ai_assisted flag, so history is inspectable.
--     space_id is denormalised so RLS keys on it with no join.
create table bob.note_revisions (
  id             uuid primary key default gen_random_uuid(),
  note_id        uuid not null references bob.notes (id) on delete cascade,
  space_id       uuid not null,
  revision       integer not null,
  title          text not null,
  body           text not null,
  editor_user_id uuid not null references auth.users (id),
  ai_assisted    boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (note_id, revision)
);

-- 2. Indexes. Listing order (pinned first, then most recently updated) and a
--    scoped full-text search over title+body. The search expression is
--    immutable, so it is a valid index expression; there is no predicate.
--    to_tsvector is Postgres core (unrelated to the pgvector extension), but
--    written with a space before its argument list so the literal substring
--    "vector(" -- which the S10 migration-lint rule greps for to catch a
--    missing "-- bob:requires-extension vector" marker -- does not
--    false-positive on a plain text-search index that needs no extension.
create index notes_space_pinned_updated_idx
  on bob.notes (space_id, pinned desc, updated_at desc);
create index notes_fts_idx
  on bob.notes using gin (to_tsvector ('english', title || ' ' || body));

-- 3. RLS -- both tables force it; access is decided by ACTIVE membership.
alter table bob.notes enable row level security;
alter table bob.notes force row level security;
alter table bob.note_revisions enable row level security;
alter table bob.note_revisions force row level security;

-- 4. Policies. Every read/write keys on bob_private.is_space_member(space_id)
--    (the single definer helper from S01 -- never re-written here). Both tables
--    carry space_id denormalised, so no policy needs a join.

-- 4.1 bob.notes
create policy notes_select on bob.notes
  for select to authenticated
  using (bob_private.is_space_member(space_id));

create policy notes_insert on bob.notes
  for insert to authenticated
  with check (bob_private.is_space_member(space_id));

create policy notes_update on bob.notes
  for update to authenticated
  using (bob_private.is_space_member(space_id))
  with check (bob_private.is_space_member(space_id));

create policy notes_delete on bob.notes
  for delete to authenticated
  using (bob_private.is_space_member(space_id));

-- 4.2 bob.note_revisions (append-only in the store; RLS is the membership gate)
create policy note_revisions_select on bob.note_revisions
  for select to authenticated
  using (bob_private.is_space_member(space_id));

create policy note_revisions_insert on bob.note_revisions
  for insert to authenticated
  with check (bob_private.is_space_member(space_id));

create policy note_revisions_update on bob.note_revisions
  for update to authenticated
  using (bob_private.is_space_member(space_id))
  with check (bob_private.is_space_member(space_id));

create policy note_revisions_delete on bob.note_revisions
  for delete to authenticated
  using (bob_private.is_space_member(space_id));

-- 5. Grants (init-migration §2.7 pattern).
grant select, insert, update, delete on bob.notes to authenticated;
grant select, insert, update, delete on bob.note_revisions to authenticated;
