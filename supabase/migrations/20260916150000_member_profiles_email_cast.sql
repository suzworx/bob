-- Fixes bob_private.space_member_profiles (S14-T027): real Postgres
-- declares auth.users.email as character varying(255), but the function
-- (migration 20260916061000_member_profiles.sql) returns it into a `text`
-- output column. PL/pgSQL's RETURN QUERY requires an exact type match, so on
-- real Supabase every call fails:
--   structure of query does not match function result type
--   DETAIL: Returned type character varying(255) does not match expected
--   type text in column 3.
-- PGlite's shim previously declared auth.users.email as `text`, so the
-- mismatch never showed up under test -- only against real Postgres.
--
-- This is a new forward migration rather than an edit to the already-applied
-- 20260916061000_member_profiles.sql: that migration is merged and applied on
-- other machines, and editing an applied migration in place is how
-- environments silently diverge. The function is replaced here with the same
-- body, changing only the cast on `u.email`.
--
-- Reproduced faithfully from the original: same signature, same
-- security definer, same empty search_path, same stable, same membership
-- check as the first statement, same display_name fallback chain, same
-- revoke/grant pair.

create or replace function bob_private.space_member_profiles(p_space_id uuid)
returns table (user_id uuid, display_name text, email text)
language plpgsql security definer set search_path = ''
stable
as $$
begin
  -- Authorization check FIRST: a caller who is not an active member of this
  -- space gets zero rows, the same as a space that does not exist.
  if not bob_private.is_space_member(p_space_id) then
    return;
  end if;

  return query
    select
      m.user_id,
      coalesce(
        nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
        nullif(split_part(u.email, '@', 1), '')
      ) as display_name,
      u.email::text
    from bob.space_memberships m
    join auth.users u on u.id = m.user_id
    where m.space_id = p_space_id
      and m.revoked_at is null;
end;
$$;

-- Never exposed to anon; called only from the app's authenticated store path
-- (listMembers runs under withUser(), i.e. as the authenticated role), same
-- pattern as is_space_member / is_space_owner_or_admin.
revoke all on function bob_private.space_member_profiles(uuid) from public, anon, authenticated;
grant execute on function bob_private.space_member_profiles(uuid) to authenticated;
