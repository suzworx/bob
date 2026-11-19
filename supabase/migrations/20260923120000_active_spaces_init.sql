-- Bob active-Space pointer (issue #301, unit U1). One row per account naming
-- the Space the Cardputer context currently targets. Kept separate from
-- bob.active_conversations on purpose: a Space is not a conversation, and the
-- follow-me conversation pointer keeps its own meaning (issue #301 "Recommended
-- MVP decision"). Account-wide, like active_conversations.
-- Follows the init migration's assembly order: 1 table · 2 indexes · 3 enable/
-- force RLS · 4 policies · 5 grants. No vector / pg_cron / pgmq, so it applies
-- under PGlite.
--
-- The policies only prove the caller may name the Space (an ACTIVE membership,
-- via bob_private.is_space_member). Archived Spaces, and a pointer whose
-- membership was revoked later, are cleared by the store on the next read
-- (store/active-space.ts getActiveSpace), so a stale id never survives a read.

-- 1. bob.active_spaces
create table bob.active_spaces (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  space_id   uuid null references bob.spaces (id) on delete set null,
  changed_at timestamptz not null default now(),
  surface    text not null check (surface in ('web', 'device'))
);

-- 2. Indexes -- the FK's on-delete-set-null lookup.
create index active_spaces_space_idx
  on bob.active_spaces (space_id);

-- 3. RLS
alter table bob.active_spaces enable row level security;
alter table bob.active_spaces force row level security;

-- 4. Policies. A caller reads and writes only their own row, and may only
--    point it at nothing or at a Space they are an active member of.
create policy active_spaces_select on bob.active_spaces
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy active_spaces_insert on bob.active_spaces
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (space_id is null or bob_private.is_space_member(space_id))
  );
create policy active_spaces_update on bob.active_spaces
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (space_id is null or bob_private.is_space_member(space_id))
  );

-- 5. Grants (init-migration §2.7 pattern) -- nothing for anon/public.
grant select, insert, update on bob.active_spaces to authenticated;
