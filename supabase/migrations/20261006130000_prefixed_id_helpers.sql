-- IDS epic P1 (owner 2026-10-06): every Bob-owned record gets a type-prefixed
-- id, `<prefix>_<32 lowercase hex of a v4 uuid>`. This adds only the helpers the
-- later per-table conversions use; no table, default or check changes here.
-- The prefix registry and the TS mirror of legacy_id live in
-- apps/api/src/domain/ids.ts (canonicalId); tests/domain/ids-sql.test.ts keeps
-- the two in agreement.
-- Expand-only: three new functions, nothing existing changes.

-- 1. A fresh prefixed id; future column defaults call it, so it runs as the
--    inserting role (account or server).
create or replace function bob.new_id(p text)
returns text
language sql
volatile
parallel safe
security invoker
set search_path = ''
as $$
  select p || '_' || replace(gen_random_uuid()::text, '-', '')
$$;

revoke all on function bob.new_id(text) from public, anon;
grant execute on function bob.new_id(text) to authenticated, bob_server;

-- 2. The canonical id for an existing id under prefix p, for backfills: the
--    kind's own prefix (and, for conv, the legacy cnv_/thr_) is stripped; a
--    uuid left over (dashed or not) becomes its hex, any other id of the
--    OpaqueId shape becomes md5 of the whole old id, and anything else is null
--    (so a later NOT NULL fails loudly instead of inventing an id).
create or replace function bob_private.legacy_id(p text, old text)
returns text
language sql
immutable
strict
parallel safe
security invoker
set search_path = ''
as $$
  select case
    when old !~ '^[A-Za-z0-9_-]{8,64}$' then null
    when rest ~* '^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$'
      then p || '_' || lower(replace(rest, '-', ''))
    else p || '_' || md5(old)
  end
  from (
    select case
      when starts_with(old, p || '_') then substr(old, length(p) + 2)
      when p = 'conv' and (starts_with(old, 'cnv_') or starts_with(old, 'thr_')) then substr(old, 5)
      else old
    end as rest
  ) stripped
$$;

revoke all on function bob_private.legacy_id(text, text) from public, anon, authenticated;
grant execute on function bob_private.legacy_id(text, text) to bob_server;

-- 3. The bob tables whose id column is still text: the conversion migrations'
--    worklist and their drift check.
create or replace function bob_private.id_text_tables()
returns setof text
language sql
stable
parallel safe
security invoker
set search_path = ''
as $$
  select c.relname::text
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'bob'
     and c.relkind in ('r', 'p')
     and a.attname = 'id'
     and not a.attisdropped
     and a.atttypid = 'pg_catalog.text'::pg_catalog.regtype
   order by 1
$$;

revoke all on function bob_private.id_text_tables() from public, anon, authenticated;
grant execute on function bob_private.id_text_tables() to bob_server;
