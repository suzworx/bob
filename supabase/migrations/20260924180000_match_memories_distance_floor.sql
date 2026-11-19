-- bob:requires-extension vector
-- #405 (epic #394, PERF-S10): a cosine-distance floor on the semantic arm of
-- bob.match_memories and recency as a tie-break only. SHIPPED DARK: the two
-- new trailing parameters default to today's behaviour --
--   p_max_distance     null  = no floor (every semantic hit kept, as before)
--   p_recency_tiebreak false = the additive recency term, as before
-- so every existing 2- and 3-argument call returns exactly the rows and scores
-- the 20260915200000 body returned. The API opts in only when
-- BOB_MEMORY_MAX_DISTANCE is set (apps/api/src/store/memories.ts).
--
-- The old signature is dropped rather than overloaded: two functions that both
-- accept a 3-argument call would make every existing call ambiguous. Drop and
-- create run in the migration's single transaction, so callers never observe a
-- missing function.
--
-- When p_max_distance is set, the semantic CTE's ORDER BY ... LIMIT is
-- unchanged (same HNSW scan); rows whose distance exceeds the floor are
-- dropped AFTER the limit, so a full-text hit beyond the floor is still
-- returned (match_source 'full_text'). When p_recency_tiebreak is true the
-- recency term leaves the score and ranks equal scores newest first.
--
-- Rollback: re-run the 20260915200000 create function body and its
-- revoke/grant pair after dropping this 10-argument signature.
drop function bob.match_memories(text, extensions.vector, integer, double precision, double precision, integer, double precision, double precision);

-- `set hnsw.iterative_scan` on a function needs the GUC registered, which
-- happens when the pgvector library loads (the init migration got that from
-- `create extension`). Calling vector_in loads it in this session.
select '[1]'::extensions.vector;

create function bob.match_memories(
  p_query_text text,
  p_query_embedding extensions.vector(1536),
  p_match_count int default 8,
  p_full_text_weight double precision default 1.0,
  p_semantic_weight double precision default 1.0,
  p_rrf_k int default 50,
  p_recency_weight double precision default 0.15,
  p_recency_half_life_days double precision default 30.0,
  p_max_distance double precision default null,
  p_recency_tiebreak boolean default false
)
returns table (
  id text, kind text, content text, confidence real, sensitive boolean,
  conversation_id text, message_id text, surface text, created_at timestamptz,
  match_source text, score double precision
)
language sql stable security invoker set search_path = ''
       set hnsw.iterative_scan = relaxed_order
as $$
with full_text as (
  select m.id,
         row_number() over (
           order by ts_rank_cd(m.fts, websearch_to_tsquery('english', p_query_text)) desc
         ) as rank_ix
    from bob.memories m
   where m.superseded_by is null
     and m.user_id = (select auth.uid())
     and m.fts @@ websearch_to_tsquery('english', p_query_text)
   order by rank_ix limit least(p_match_count, 30) * 2
),
semantic_scan as (
  select m.id,
         row_number() over (order by m.embedding operator(extensions.<=>) p_query_embedding) as rank_ix,
         (m.embedding operator(extensions.<=>) p_query_embedding)::double precision as distance
    from bob.memories m
   where m.superseded_by is null
     and m.user_id = (select auth.uid())
     and m.embedding is not null
   order by rank_ix limit least(p_match_count, 30) * 2
),
semantic as (
  select s.id, s.rank_ix
    from semantic_scan s
   where p_max_distance is null or s.distance <= p_max_distance
)
select m.id, m.kind, m.content, m.confidence, m.sensitive,
       m.conversation_id, m.message_id, m.surface, m.created_at,
       case when ft.id is not null and se.id is not null then 'both'
            when ft.id is not null then 'full_text' else 'semantic' end as match_source,
       (coalesce(1.0 / (p_rrf_k + ft.rank_ix), 0.0) * p_full_text_weight
        + coalesce(1.0 / (p_rrf_k + se.rank_ix), 0.0) * p_semantic_weight
        + case when p_recency_tiebreak then 0.0
               else p_recency_weight * exp(
                 - ln(2.0) * extract(epoch from (now() - m.created_at))
                   / (p_recency_half_life_days * 86400.0)
               ) end
       )::double precision as score
  from full_text ft
  full outer join semantic se on ft.id = se.id
  join bob.memories m on m.id = coalesce(ft.id, se.id)
 order by score desc,
          case when p_recency_tiebreak then m.created_at end desc nulls last,
          case when p_recency_tiebreak then m.id end
 limit least(p_match_count, 30)
$$;

-- Function execute: authenticated only (bob_server inherits it), public/anon
-- revoked -- the grant is tied to the argument list, so it is re-issued here.
revoke all on function bob.match_memories(text, extensions.vector, integer, double precision, double precision, integer, double precision, double precision, double precision, boolean) from public, anon;
grant execute on function bob.match_memories(text, extensions.vector, integer, double precision, double precision, integer, double precision, double precision, double precision, boolean) to authenticated;
