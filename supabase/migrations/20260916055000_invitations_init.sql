-- Bob space invitations (S03, specs/014-family-collaboration/data-model.md
-- "space_invitations"). Pending grants no read; single-use transaction; 7-day
-- expiry; no raw token in DB or log (only its SHA-256 hash). Follows the init
-- migration's assembly order. The accept and preview paths deliberately do NOT
-- go through RLS: a pending invitee is not a member, so the two security-definer
-- functions carry them (the "reviewed private lookup with least privilege"
-- pattern from data-model.md §"Authorization and revocation contract"). No
-- vector / pg_cron / pgmq, so it applies under PGlite.

-- 1. Table
create table bob.space_invitations (
  id           uuid primary key default gen_random_uuid(),
  space_id     uuid not null references bob.spaces (id) on delete cascade,
  -- the intended identity; the accepting account must match this email.
  invited_email text not null,
  role         text not null check (role in ('admin', 'member')),
  -- SHA-256 hex of the raw token; the raw token is never stored or logged.
  token_hash   text not null unique,
  expires_at   timestamptz not null,
  accepted_at  timestamptz null,
  accepted_by  uuid null references auth.users (id) on delete set null,
  revoked_at   timestamptz null,
  created_by   uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now()
);

-- 2. Indexes. At most one active pending (not accepted, not revoked) invitation
--    per (space_id, invited_email). Postgres forbids now() in an index predicate
--    (STABLE, not IMMUTABLE), so "not expired" is NOT enforced here: an expired
--    row is refused at accept time, and createInvitation supersedes any prior
--    pending row (SET revoked_at) before inserting, so a fresh invite is always
--    possible regardless of an old row's expiry.
create unique index space_invitations_pending_uidx
  on bob.space_invitations (space_id, invited_email)
  where accepted_at is null and revoked_at is null;

-- 3. RLS -- forced. Pending invitees are NOT members and must not read a row
--    through these policies; the preview path below deliberately bypasses RLS.
alter table bob.space_invitations enable row level security;
alter table bob.space_invitations force row level security;

-- 4. Policies. Reads keyed on membership (a member may list a space's pending
--    invitations); writes keyed on owner-or-admin (only they create and revoke).
create policy space_invitations_select on bob.space_invitations
  for select to authenticated
  using (bob_private.is_space_member(space_invitations.space_id));

create policy space_invitations_insert on bob.space_invitations
  for insert to authenticated
  with check (bob_private.is_space_owner_or_admin(space_invitations.space_id));

create policy space_invitations_update on bob.space_invitations
  for update to authenticated
  using (bob_private.is_space_owner_or_admin(space_invitations.space_id))
  with check (bob_private.is_space_owner_or_admin(space_invitations.space_id));

create policy space_invitations_delete on bob.space_invitations
  for delete to authenticated
  using (bob_private.is_space_owner_or_admin(space_invitations.space_id));

-- 5. Grants (init-migration §2.7 pattern).
grant select, insert, update, delete on bob.space_invitations to authenticated;

-- 6. Definer helpers. Each is security definer with search_path '' and reads
--    only the columns its narrow job needs; none is exposed to anon.

-- Resolves an account's identity email. Auth is invite-only; auth.users holds
-- the email the accepting account signed up with. SECURITY DEFINER because the
-- authenticated role has no grant on auth.users. The shim's auth.users lacks an
-- email column (tests add it), which is fine: plpgsql bodies are not analysed
-- at creation.
create or replace function bob_private.user_email(p_user_id uuid)
returns text
language plpgsql security definer set search_path = ''
stable
as $$
declare
  result text;
begin
  select u.email into result from auth.users u where u.id = p_user_id;
  return result;
end;
$$;

-- The unauthenticated-safe preview: for a pending, unexpired, unrevoked hash
-- returns only space name, space kind, the inviter's identity email and whether
-- admission exposes existing history. Returns NO rows for a used, expired or
-- revoked token (recovery is "no content, no detail"). Deliberately bypasses
-- RLS via the definer so a non-member can see what admission would grant.
create or replace function bob_private.preview_invitation(p_token_hash text)
returns table (
  space_name text,
  space_kind text,
  inviter_display_name text,
  exposes_history boolean
)
language plpgsql security definer set search_path = ''
stable
as $$
declare
  inv bob.space_invitations%rowtype;
  space_name text;
  space_kind text;
  inviter_email text;
begin
  select * into inv
    from bob.space_invitations i
    where i.token_hash = p_token_hash;
  if not found
     or inv.accepted_at is not null
     or inv.revoked_at is not null
     or inv.expires_at <= now() then
    return;
  end if;
  select s.name, s.kind into space_name, space_kind
    from bob.spaces s where s.id = inv.space_id;
  inviter_email := bob_private.user_email(inv.created_by);
  return query
    select coalesce(space_name, ''), coalesce(space_kind, ''),
           coalesce(inviter_email, ''), true::boolean;
end;
$$;

-- Single-use, transactional acceptance. Runs entirely as the definer so the
-- pending invitee (a non-member) can be admitted: it re-reads the row FOR
-- UPDATE, verifies pending + unexpired + bound to this account's email, then
-- inserts the membership and stamps accepted_at/accepted_by in the same
-- transaction. A concurrent second accept serialises on the row lock and sees
-- accepted_at set, so it returns already_accepted and never a second
-- membership. Outcome is one of: accepted, already_accepted, already_member,
-- expired, revoked, email_mismatch, not_found.
create or replace function bob_private.accept_invitation(p_token_hash text, p_user_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  inv          bob.space_invitations%rowtype;
  account_email text;
  existing     boolean;
begin
  select * into inv
    from bob.space_invitations i
    where i.token_hash = p_token_hash
    for update;
  if not found then
    return 'not_found';
  end if;
  if inv.revoked_at is not null then return 'revoked'; end if;
  if inv.accepted_at is not null then return 'already_accepted'; end if;
  if inv.expires_at <= now() then return 'expired'; end if;

  account_email := bob_private.user_email(p_user_id);
  if account_email is null or lower(account_email) <> lower(inv.invited_email) then
    return 'email_mismatch';
  end if;

  select exists (
    select 1 from bob.space_memberships m
    where m.space_id = inv.space_id
      and m.user_id = p_user_id
      and m.revoked_at is null
  ) into existing;
  if existing then return 'already_member'; end if;

  insert into bob.space_memberships (space_id, user_id, role)
  values (inv.space_id, p_user_id, inv.role);

  update bob.space_invitations
     set accepted_at = now(), accepted_by = p_user_id
   where id = inv.id;

  return 'accepted';
end;
$$;

-- The definers are called only from the store under asServer; never exposed to
-- anon or authenticated (a client must not call them directly -- acceptance is
-- reached only through the store's token flow). The init migration's blanket
-- "grant execute ... to bob_server" ran before these functions existed, so
-- grant them explicitly here.
revoke all on function bob_private.user_email(uuid) from public, anon, authenticated;
revoke all on function bob_private.preview_invitation(text) from public, anon, authenticated;
revoke all on function bob_private.accept_invitation(text, uuid) from public, anon, authenticated;
grant execute on function bob_private.user_email(uuid) to bob_server;
grant execute on function bob_private.preview_invitation(text) to bob_server;
grant execute on function bob_private.accept_invitation(text, uuid) to bob_server;