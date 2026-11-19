-- bob:requires-extension vector
-- S10-FIX10: server-privileged helpers for the embedding backfill script
-- (apps/api/scripts/backfill-memory-embeddings.ts). Rows written before the
-- embedder was wired into the turn paths (S10-FIX8) have `embedding IS NULL`
-- and are permanently invisible to bob.match_memories' semantic branch
-- (`where m.embedding is not null`), so the backfill has to find and fix them
-- across every account -- something forced RLS forbids the server role to do
-- directly. The first-line marker makes PGlite skip this file (memory/vector
-- are off there); production applies via supabase db push, which ignores it.
--
-- Shape copied from the precedent, 20260916020000_memory_scan_helper.sql:
-- SECURITY DEFINER, `set search_path = ''`, fully qualified references,
-- revoked from public/anon/authenticated, granted only to bob_server (the
-- role BOB_DATABASE_URL connects as). Unlike the scan helper -- which only
-- ever returns user ids -- these two touch memory content and the embedding
-- column directly, so the grant is written out to authenticated explicitly
-- too: nothing here may ever be reachable by a signed-in user.

-- 1. bob_private.memories_missing_embedding -- one keyset-paged page of the
--    rows the backfill still needs to visit: embedding IS NULL (never
--    embedded, or explicitly cleared) and superseded_by IS NULL (current
--    facts only -- no point spending an embed call on a fact nothing will
--    ever retrieve). id-ascending so repeated calls with the previous page's
--    last id (p_after_id) make forward progress; the first page passes null.
create or replace function bob_private.memories_missing_embedding(
  p_limit int,
  p_after_id text
) returns table (id text, user_id uuid, content text)
language sql stable security definer set search_path = ''
as $$
  select m.id, m.user_id, m.content
    from bob.memories m
   where m.embedding is null
     and m.superseded_by is null
     and (p_after_id is null or m.id > p_after_id)
   order by m.id
   limit p_limit;
$$;

revoke all on function bob_private.memories_missing_embedding(integer, text) from public, anon, authenticated;
grant execute on function bob_private.memories_missing_embedding(integer, text) to bob_server;

-- 2. bob_private.set_memory_embedding -- writes the embedding vector, model
--    id and dim for exactly one row, leaving every other column (including
--    updated_at) untouched, matching the embedding-only UPDATE shape
--    correctMemory already uses (apps/api/src/store/memories.ts). Guarded to
--    `where embedding is null` so a backfill run can only ever fill a row
--    that has never been embedded -- it can never clobber a good vector
--    written by the live turn path in the meantime.
create or replace function bob_private.set_memory_embedding(
  p_id text,
  p_embedding extensions.vector,
  p_model text,
  p_dim int
) returns void
language sql volatile security definer set search_path = ''
as $$
  update bob.memories
     set embedding = p_embedding,
         embedding_model = p_model,
         embedding_dim = p_dim
   where id = p_id
     and embedding is null;
$$;

revoke all on function bob_private.set_memory_embedding(text, extensions.vector, text, integer) from public, anon, authenticated;
grant execute on function bob_private.set_memory_embedding(text, extensions.vector, text, integer) to bob_server;
