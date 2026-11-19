-- The server reads the newest applied schema version (#349, docs/deploy.md
-- "Deploy ordering"). GET /health compares it with the version the code
-- expects (apps/api/src/web-health.ts EXPECTED_SCHEMA_VERSION) and reports
-- ok / schema_behind / schema_ahead.
--
-- bob_server has no access to supabase_migrations, and this does not grant
-- any: one SECURITY DEFINER function returns max(version) and nothing else (no
-- statements, names or timestamps). Additive: a new function and its grants.
--
-- plpgsql, so the table is only resolved when the function runs: it returns
-- null where supabase_migrations does not exist (PGlite, the per-test
-- databases), and the server falls back to its own history there.
create or replace function bob_private.schema_version()
returns text
language plpgsql stable security definer set search_path = ''
as $$
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    return null;
  end if;
  return (select max(version) from supabase_migrations.schema_migrations);
end;
$$;

revoke all on function bob_private.schema_version() from public, anon, authenticated;
grant execute on function bob_private.schema_version() to bob_server;
