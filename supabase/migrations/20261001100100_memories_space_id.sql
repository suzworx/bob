-- bob:requires-extension vector
-- One conversation model, PR1 (#756): memory scope is the conversation's
-- space, so bob.memories gains a space key, backfilled to the owner's
-- private space. The first-line marker makes PGlite skip this file, as it
-- skips memory_init (apps/api/src/platform/db/migrate.ts). Additive only:
-- nullable column, an index, a null-only backfill. RLS and match_memories
-- are unchanged; nothing in apps/* reads the column yet. Re-runnable.

alter table bob.memories
  add column if not exists space_id uuid null
    references bob.spaces (id) on delete cascade;

create index if not exists memories_space_idx on bob.memories (space_id);

-- Every existing memory lands in its owner's self space (the EXPAND migration
-- guarantees one per account).
update bob.memories m
   set space_id = s.id
  from bob.spaces s
 where s.kind = 'private'
   and s.owner_user_id = m.user_id
   and m.space_id is null;
