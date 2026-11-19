-- Bob spaces foundation (S01, specs/014-family-collaboration/data-model.md).
-- The audience layer that will later carry conversations, tasks, notes,
-- calendars and notifications. Follows the init migration's assembly order:
-- 1 tables (dependency order) · 2 indexes · 3 enable/force RLS · 4 the single
-- recursion-breaking security-definer lookup · 5 policies · 6 function/table
-- grants · 7 backfill. No vector / pg_cron / pgmq, so it applies under PGlite.

-- 1. Tables in dependency order: spaces -> space_memberships.

-- 1.1 bob.spaces (data-model.md "spaces")
create table bob.spaces (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null check (kind in ('private', 'pair', 'group')),
  name               text not null check (char_length(btrim(name)) between 1 and 60),
  -- not null for private/group, null for pair (fixed identities, server-created).
  owner_user_id      uuid references auth.users (id) on delete cascade,
  membership_revision integer not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- the pair/private/group nullability invariant, so a pair can never carry a
  -- single owner and a private/group space can never be ownerless.
  check (
    (kind = 'pair' and owner_user_id is null) or
    (kind in ('private', 'group') and owner_user_id is not null)
  )
);

-- 1.2 bob.space_memberships (data-model.md "space_memberships")
create table bob.space_memberships (
  id         uuid primary key default gen_random_uuid(),
  space_id   uuid not null references bob.spaces (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null check (role in ('owner', 'admin', 'member')),
  joined_at  timestamptz not null default now(),
  revoked_at timestamptz null,
  unique (space_id, user_id)
);

-- 2. Indexes
-- At most one private space per account (backfill + ensurePrivateSpace rely on it).
create unique index spaces_private_owner_uidx
  on bob.spaces (owner_user_id) where kind = 'private';

-- Membership lookup in both directions, active rows only (data-model.md).
create index space_memberships_user_idx
  on bob.space_memberships (user_id) where revoked_at is null;
create index space_memberships_space_idx
  on bob.space_memberships (space_id) where revoked_at is null;

-- 3. RLS -- both tables force it; access is decided by an ACTIVE membership.
alter table bob.spaces enable row level security;
alter table bob.spaces force row level security;
alter table bob.space_memberships enable row level security;
alter table bob.space_memberships force row level security;

-- 4. The one security-definer lookup that resolves the membership recursion
--    (data-model.md "Authorization and revocation contract"). A policy on
--    space_memberships that queried space_memberships would recurse through
--    its own policy; this definer reads the table directly (owner = the
--    migration role, bypassing RLS). It compares only against auth.uid(), so
--    it takes no user argument and cannot be called to probe another account.
create or replace function bob_private.is_space_member(p_space_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
stable
as $$
begin
  return exists (
    select 1 from bob.space_memberships m
    where m.space_id = p_space_id
      and m.user_id = (select auth.uid())
      and m.revoked_at is null
  );
end;
$$;

-- The owner-or-admin counterpart of is_space_member, needed because the
-- insert/update/delete policies on space_memberships must NOT query
-- space_memberships directly (that would recurse through their own policies).
-- data-model.md "Authorization and revocation contract": a helper that would
-- recurse through membership RLS is a reviewed private lookup. Like
-- is_space_member it only ever compares against auth.uid(), so it cannot probe
-- another account's role.
create or replace function bob_private.is_space_owner_or_admin(p_space_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
stable
as $$
begin
  return exists (
    select 1 from bob.space_memberships m
    where m.space_id = p_space_id
      and m.user_id = (select auth.uid())
      and m.revoked_at is null
      and m.role in ('owner', 'admin')
  );
end;
$$;

-- A narrow housekeeping helper so a membership change always bumps the space's
-- membership_revision, even for the self-leave case where the caller is a plain
-- member who (under RLS) cannot UPDATE bob.spaces. SECURITY DEFINER with an
-- active-membership guard so a caller can only bump a space they belong to.
create or replace function bob_private.bump_membership_revision(p_space_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated';
  end if;
  update bob.spaces s
     set membership_revision = membership_revision + 1, updated_at = now()
   where s.id = p_space_id
     and exists (
       select 1 from bob.space_memberships m
       where m.space_id = p_space_id and m.user_id = (select auth.uid())
         and m.revoked_at is null
     );
end;
$$;

-- 5. Policies. Every read/write is decided by an active membership row; pair
--    spaces are created by the server path, so inserts stay restricted to the
--    owner column being the caller.

-- 5.1 bob.spaces
-- The recorded owner may see the space as well as active members: INSERT ...
-- RETURNING applies the SELECT policy to the returned row, and a brand-new
-- space has no membership row yet, so without this the creator could never read
-- the space they just made. The owner always holds an active membership by
-- construction (backfill/createSpace/transfer all pair them), so this leaks
-- nothing across accounts.
create policy spaces_select on bob.spaces
  for select to authenticated
  using (
    bob_private.is_space_member(spaces.id)
    or spaces.owner_user_id = (select auth.uid())
  );

create policy spaces_insert on bob.spaces
  for insert to authenticated
  with check ((select auth.uid()) = spaces.owner_user_id);

create policy spaces_update on bob.spaces
  for update to authenticated
  using (bob_private.is_space_owner_or_admin(spaces.id))
  with check (bob_private.is_space_owner_or_admin(spaces.id));

-- 5.2 bob.space_memberships. Select: own rows, plus rows of any space the
--    caller is an active member of (via the definer, so no recursion).
create policy space_memberships_select on bob.space_memberships
  for select to authenticated
  using (
    space_memberships.user_id = (select auth.uid())
    or bob_private.is_space_member(space_memberships.space_id)
  );

-- Insert: an owner/admin of the space may add members; the space's recorded
-- owner may bootstrap the first (owner) membership when creating it. Both arms
-- avoid querying space_memberships (the owner arm reads bob.spaces, the role
-- arm is the definer lookup) so the policy does not recurse through itself.
create policy space_memberships_insert on bob.space_memberships
  for insert to authenticated
  with check (
    exists (
      select 1 from bob.spaces s
      where s.id = space_memberships.space_id
        and s.owner_user_id = (select auth.uid())
    )
    or bob_private.is_space_owner_or_admin(space_memberships.space_id)
  );

-- Update: owner/admin of the space may change memberships; a caller may set
-- revoked_at on their own row (self-leave).
create policy space_memberships_update on bob.space_memberships
  for update to authenticated
  using (
    bob_private.is_space_member(space_memberships.space_id)
    or (space_memberships.user_id = (select auth.uid()) and space_memberships.revoked_at is null)
  )
  with check (
    bob_private.is_space_owner_or_admin(space_memberships.space_id)
    or (space_memberships.user_id = (select auth.uid()) and space_memberships.revoked_at is not null)
  );

create policy space_memberships_delete on bob.space_memberships
  for delete to authenticated
  using (bob_private.is_space_owner_or_admin(space_memberships.space_id));

-- 6. Grants (init-migration §2.7 pattern).
grant select, insert, update on bob.spaces to authenticated;
grant select, insert, update, delete on bob.space_memberships to authenticated;

-- is_space_member is called from the policies, which run as authenticated; it
-- is never exposed to anon.
revoke all on function bob_private.is_space_member(uuid) from public, anon, authenticated;
grant execute on function bob_private.is_space_member(uuid) to authenticated;

-- is_space_owner_or_admin is called from the policies, which run as
-- authenticated; never exposed to anon.
revoke all on function bob_private.is_space_owner_or_admin(uuid) from public, anon, authenticated;
grant execute on function bob_private.is_space_owner_or_admin(uuid) to authenticated;

-- bump_membership_revision is guarded to an active membership; granted to
-- authenticated so self-leave can bump the revision. Not granted to anon.
revoke all on function bob_private.bump_membership_revision(uuid) from public, anon;
grant execute on function bob_private.bump_membership_revision(uuid) to authenticated;

-- 7. Backfill: give every existing account exactly one private space and one
--    owner membership. Set-based and re-runnable (on conflict do nothing), so
--    applying it again never creates a second private space.
insert into bob.spaces (id, kind, name, owner_user_id)
select gen_random_uuid(), 'private', 'Private', u.id
from auth.users u
on conflict (owner_user_id) where kind = 'private' do nothing;

insert into bob.space_memberships (space_id, user_id, role)
select s.id, s.owner_user_id, 'owner'
from bob.spaces s
where s.kind = 'private'
on conflict (space_id, user_id) do nothing;