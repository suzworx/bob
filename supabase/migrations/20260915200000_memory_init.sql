-- bob:requires-extension vector
-- Memory migration for 010-cross-session-memory. DDL copied verbatim from
-- data-model.md §1-§7. The first-line marker (plan A.1) makes PGlite skip this
-- file (apps/api/src/store/migrate.ts:81-86); production applies via supabase
-- db push, which ignores the marker. Requires the `vector` extension (R1),
-- enabled below in the `extensions` schema.

-- 1. Extension enablement (§1) -- no version clause (R1: a pinned version is
--    ignored from 2026-08-05); Supabase-recommended placement in `extensions`.
create extension if not exists vector with schema extensions;

-- 2. bob.memories (§2) -- the durable record: one fact/preference/intent/
--    action-item per row, owned by one account.
create table bob.memories (
  id               text primary key default ('mem_' || gen_random_uuid())
                   check (id ~ '^[A-Za-z0-9_-]{8,64}$'),
  user_id          uuid not null references auth.users (id) on delete cascade,
  kind             text not null check (kind in ('fact','preference','intent','action_item')),
  content          text not null check (char_length(content) between 1 and 2000),
  confidence       real not null check (confidence >= 0 and confidence <= 1),
  sensitive        boolean not null default false,
  conversation_id  text null references bob.conversations (id) on delete set null,
  message_id       text null references bob.messages (id) on delete set null,
  surface          text not null default 'web_text'
                   check (surface in ('web_text','web_voice','device')),
  superseded_by    text null references bob.memories (id) on delete set null,
  embedding        extensions.vector(1536) null,
  embedding_model  text null,
  embedding_dim    integer null,
  fts              tsvector generated always as (to_tsvector('english', content)) stored,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- 3. bob.action_items (§3) -- thin actionable subset of bob.memories so
--    "list open items with due dates" is a structured query, not a parse.
create table bob.action_items (
  id         text primary key default ('act_' || gen_random_uuid())
             check (id ~ '^[A-Za-z0-9_-]{8,64}$'),
  memory_id  text not null references bob.memories (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  due_at     timestamptz null,
  status     text not null default 'open' check (status in ('open','done','dropped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4. bob.messages.memory_extracted_at (§4) -- the extraction-durability
--    marker (research R11); a single nullable column, not a job table.
alter table bob.messages add column memory_extracted_at timestamptz;

-- 5. Indexes (§5).
-- HNSW cosine ANN for semantic retrieval (Supabase hybrid-search guide).
-- pgvector defaults: m = 16 (max links per node), ef_construction = 64
-- (build-time candidate list). Kept explicit so a future tune is a diff.
create index memories_embedding_hnsw_idx
  on bob.memories using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- GIN for full-text retrieval over the generated fts column.
create index memories_fts_gin_idx on bob.memories using gin (fts);

-- Current facts only: retrieval filters superseded_by is null (FR-007, R10).
create index memories_current_idx on bob.memories (user_id) where superseded_by is null;

-- The (user_id, kind) filter used by the Memory page and by extraction's
-- "top similar existing memories" seed query.
create index memories_user_kind_idx on bob.memories (user_id, kind);

-- FK indexes (schema-foreign-key-indexes): superseded_by and the two source FKs.
create index memories_superseded_by_idx on bob.memories (superseded_by);
create index memories_conversation_id_idx on bob.memories (conversation_id);
create index memories_message_id_idx on bob.memories (message_id);

-- Action items: "open, due soon" for one account.
create index action_items_user_status_due_idx
  on bob.action_items (user_id, status, due_at);
create index action_items_memory_id_idx on bob.action_items (memory_id);

-- The unextracted-messages scan (research R11): one index scan per account.
create index messages_unextracted_idx
  on bob.messages (user_id, created_at) where memory_extracted_at is null;

-- 6. RLS (§6) -- enabled AND forced on both tables; one policy per command,
--    `to authenticated`, `using ((select auth.uid()) = user_id)`, with a
--    matching `with check` on insert and update (the exact 008 pattern).
alter table bob.memories enable row level security;
alter table bob.memories force row level security;

create policy memories_select on bob.memories
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy memories_insert on bob.memories
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy memories_update on bob.memories
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy memories_delete on bob.memories
  for delete to authenticated
  using ((select auth.uid()) = user_id);

alter table bob.action_items enable row level security;
alter table bob.action_items force row level security;

create policy action_items_select on bob.action_items
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy action_items_insert on bob.action_items
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy action_items_update on bob.action_items
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy action_items_delete on bob.action_items
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- 6. Grants (§6) -- follow the 008 convention (migration:197-207): usage on
--    schema bob to authenticated already exists; add only the new tables'
--    per-table grants. bob_server inherits these via `authenticated to
--    bob_server` (migration:17).
grant select, insert, update, delete on bob.memories to authenticated;
grant select, insert, update, delete on bob.action_items to authenticated;
-- The extraction marker on messages is the one new column write for the
-- authenticated role (migration:201 grants no update on bob.messages today).
-- FORCE RLS passes it only because the existing messages_update policy
-- (migration:78-81, using + with check on user_id) already allows an
-- authenticated update of the account's own row.
grant update (memory_extracted_at) on bob.messages to authenticated;

-- 7. Retrieval function bob.match_memories (§7) -- SECURITY INVOKER (never
--    definer), stable, `set search_path = ''`, fully qualified. Runs under
--    withUser as bob_server/authenticated; because it is INVOKER, RLS applies
--    to every row it reads. RRF of full-text + semantic, plus a recency term
--    (Supabase hybrid-search guide). The function-level
--    `set hnsw.iterative_scan = relaxed_order` was confirmed honoured by the
--    T001 spike (pg_proc.proconfig shows it; relaxed order satisfies the
--    filtered top-k), so it is shipped as designed (data-model §7, §11).
create or replace function bob.match_memories(
  p_query_text text,
  p_query_embedding extensions.vector(1536),
  p_match_count int default 8,
  p_full_text_weight double precision default 1.0,
  p_semantic_weight double precision default 1.0,
  p_rrf_k int default 50,
  p_recency_weight double precision default 0.15,
  p_recency_half_life_days double precision default 30.0
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
semantic as (
  select m.id,
         row_number() over (order by m.embedding operator(extensions.<=>) p_query_embedding) as rank_ix
    from bob.memories m
   where m.superseded_by is null
     and m.user_id = (select auth.uid())
     and m.embedding is not null
   order by rank_ix limit least(p_match_count, 30) * 2
)
select m.id, m.kind, m.content, m.confidence, m.sensitive,
       m.conversation_id, m.message_id, m.surface, m.created_at,
       case when ft.id is not null and se.id is not null then 'both'
            when ft.id is not null then 'full_text' else 'semantic' end as match_source,
       (coalesce(1.0 / (p_rrf_k + ft.rank_ix), 0.0) * p_full_text_weight
        + coalesce(1.0 / (p_rrf_k + se.rank_ix), 0.0) * p_semantic_weight
        + p_recency_weight * exp(
            - ln(2.0) * extract(epoch from (now() - m.created_at))
              / (p_recency_half_life_days * 86400.0)
          ))::double precision as score
  from full_text ft
  full outer join semantic se on ft.id = se.id
  join bob.memories m on m.id = coalesce(ft.id, se.id)
 order by score desc
 limit least(p_match_count, 30)
$$;

-- Function execute: granted to authenticated only (bob_server inherits it),
-- with public/anon revoked -- the 008 convention (migration:397-407). The
-- schema-level revoke from anon/public is already in place (migration:198).
revoke all on function bob.match_memories(text, extensions.vector, integer, double precision, double precision, integer, double precision, double precision) from public, anon;
grant execute on function bob.match_memories(text, extensions.vector, integer, double precision, double precision, integer, double precision, double precision) to authenticated;