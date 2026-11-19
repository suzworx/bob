-- bob:requires-extension vector
-- #758: one current row per fact. `remember` and the extractor's supersede both
-- wrote a second copy of a fact that was already stored, so an account could end
-- up with three current rows holding the same content. The app now dedupes in the
-- store (applyExtractionOps, under a per-account advisory lock); this index is the
-- backstop when that check is bypassed.
--
-- #756 added memories.space_id (20261001100100_memories_space_id.sql) as
-- additive schema prep only -- nothing in apps/* writes or reads it yet, so
-- every row's space is still exactly its owner's one private space and this
-- index stays correct scoped by user_id alone. Once memory scoping is wired
-- to spaces, the unique index widens to (user_id, space_id, content_key).

-- 1. The normalised content a duplicate is judged on: internal whitespace
--    collapsed, trimmed, trailing sentence punctuation dropped, lower-cased.
--    Immutable, so it can back a generated column; the store calls it too.
create or replace function bob.memory_content_key(content text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select lower(btrim(regexp_replace(btrim(regexp_replace(content, '\s+', ' ', 'g')), '[.!?]+$', '')))
$$;

grant execute on function bob.memory_content_key(text) to authenticated, bob_server;

alter table bob.memories
  add column if not exists content_key text
  generated always as (bob.memory_content_key(content)) stored;

-- 2. Collapse the duplicates already stored: for each account and content key
--    with more than one current row, the oldest row stays current and every
--    newer copy is marked superseded by it. Nothing is deleted, so the history
--    the Memories page shows is kept.
with ranked as (
  select id,
         first_value(id) over (
           partition by user_id, content_key
           order by created_at, id
         ) as keeper
  from bob.memories
  where superseded_by is null
)
update bob.memories m
set superseded_by = ranked.keeper,
    updated_at = now()
from ranked
where m.id = ranked.id
  and ranked.id <> ranked.keeper;

-- 3. At most one current row per account and content key.
create unique index if not exists memories_current_content_key_uidx
  on bob.memories (user_id, content_key)
  where superseded_by is null;

-- 4. `npm run memory:dupes` (a read-only drift check, never run by the app)
--    needs the same cross-account visibility as the startup scan helper
--    (20260916020000_memory_scan_helper.sql): bob_server runs under FORCE
--    RLS with no policy of its own, so a plain query sees zero rows, not an
--    error. SECURITY DEFINER is correct here for the same reason it is there
--    -- a system maintenance query, not a user-data request -- and it returns
--    ids and a count only, never content.
create or replace function bob_private.memory_duplicate_groups()
returns table (user_id uuid, content_key text, row_count int)
language sql stable security definer set search_path = ''
as $$
  select m.user_id, m.content_key, count(*)::int as row_count
    from bob.memories m
   where m.superseded_by is null
   group by m.user_id, m.content_key
  having count(*) > 1;
$$;

revoke all on function bob_private.memory_duplicate_groups() from public, anon;
grant execute on function bob_private.memory_duplicate_groups() to bob_server;
