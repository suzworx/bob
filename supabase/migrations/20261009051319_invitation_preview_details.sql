-- Invitation preview details (#859). Adds the offered role and the expiry
-- (epoch milliseconds) to the accountless preview. Eligibility is unchanged:
-- still NO rows for an unknown, accepted, revoked or expired token. Still never
-- returns invited_email, space_id, content or the raw token.
--
-- RETURNS TABLE cannot change in place, so the function is dropped (no cascade)
-- and recreated in this one transactional migration, then its grants are
-- restored exactly as the invitations_init migration set them: nothing for
-- public/anon/authenticated, execute only for bob_server. The preview stays
-- token-based and deliberately has no auth.uid() requirement (an invitee may
-- have no account yet). Apply this migration before the API that reads the new
-- columns; the old API's `select *` ignores them.

drop function bob_private.preview_invitation(text);

create function bob_private.preview_invitation(p_token_hash text)
returns table (
  space_name text,
  space_kind text,
  inviter_display_name text,
  exposes_history boolean,
  role text,
  expires_at bigint
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
           coalesce(inviter_email, ''), true::boolean,
           inv.role,
           (extract(epoch from inv.expires_at) * 1000)::bigint;
end;
$$;

revoke all on function bob_private.preview_invitation(text) from public, anon, authenticated;
grant execute on function bob_private.preview_invitation(text) to bob_server;
