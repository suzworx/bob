-- Space member profiles (S14-T019, spec 014). Lets a space show WHO its
-- members are (name + email) instead of a raw uuid, without ever making
-- auth.users itself readable to an ordinary authenticated caller.
--
-- Same safety shape as bob_private.is_space_member
-- (supabase/migrations/20260916050000_spaces_init.sql): SECURITY DEFINER,
-- search_path = '', and no user argument, so it cannot be called to probe an
-- arbitrary account -- the only account it can ever resolve is whichever
-- space the CALLING user (auth.uid()) already shares. The membership check is
-- the first statement in the body: every other statement is unreachable for a
-- non-member, so there is no code path that returns a row before it runs.

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
      u.email
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
