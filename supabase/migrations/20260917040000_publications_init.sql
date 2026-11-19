-- Bob publication provenance (S14-PUBLICATION, GitHub issue #142,
-- specs/014-family-collaboration/data-model.md "resource_links, publications,
-- action_promotions" and the sentence "private provenance visible only to
-- source owner"). Publishing a private note into a space copies exactly what
-- was selected; promoting a remembered action into a task creates an ordinary
-- task that discloses nothing about where it came from. This table is the
-- provenance record for both acts.
--
-- THE SECURITY QUESTION -- read this before touching the policies. This table
-- records where a published resource came from. Membership of the destination
-- space grants NOTHING here. A member of the space can read the published note
-- or task like any other ordinary resource, and can learn nothing about where
-- it came from, because the provenance row is invisible to them. The select
-- policy is actor-only by design. A future reader will be tempted to
-- "helpfully" widen it to space members because both the source and the
-- destination involve the space -- that is exactly the provenance leak this
-- table exists to prevent. The published resource is ordinary and carries no
-- provenance; only the actor may ever read where a publication came from. Do
-- not widen publications_select.
--
-- source_id is `text`, not `uuid`: bob.notes and bob.tasks use uuid ids,
-- but bob.memories (the other source_type) uses a text primary key
-- ('mem_...'). A single text column holds both without a second type column.
-- published_id stays `uuid` because notes and tasks are the only published
-- types and both use uuid ids.
--
-- Follows the spaces-init assembly order: 1 tables · 2 indexes ·
-- 3 enable/force RLS · 4 policies · 5 grants. No vector / pg_cron / pgmq, so
-- it applies under PGlite.

-- 1. Tables.
create table bob.publications (
  id                      uuid primary key default gen_random_uuid(),
  source_type             text not null check (source_type in ('note', 'memory')),
  source_id               text not null,
  published_type          text not null check (published_type in ('note', 'task')),
  published_id            uuid not null,
  published_into_space_id uuid not null references bob.spaces (id) on delete cascade,
  actor_user_id           uuid not null references auth.users (id),
  created_at              timestamptz not null default now(),
  -- A published resource has at most one provenance row.
  unique (published_type, published_id)
);

-- 2. Indexes. The cascade target (a space deletion purges its publications)
--    and the actor's own publication history.
create index publications_space_idx on bob.publications (published_into_space_id);
create index publications_actor_idx on bob.publications (actor_user_id, created_at desc);

-- 3. RLS -- forced; access is decided ONLY by the actor id, never by space
--    membership (see the header comment).
alter table bob.publications enable row level security;
alter table bob.publications force row level security;

-- 4. Policies. Select is `actor_user_id = auth.uid()` ONLY. A member of the
--    destination space can read the published resource as an ordinary note or
--    task but cannot see this row; do not widen publications_select.
create policy publications_select on bob.publications
  for select to authenticated
  using (actor_user_id = (select auth.uid()));

-- Insert: only the actor records their own provenance; the with check is the
-- same actor gate so a row can never claim another actor.
create policy publications_insert on bob.publications
  for insert to authenticated
  with check (actor_user_id = (select auth.uid()));

-- 5. Grants (init-migration §2.7 pattern). Only the reads the actor uses and
--    the provenance insert; provenance is immutable by design.
grant select, insert on bob.publications to authenticated;