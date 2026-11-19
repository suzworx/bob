-- A Bob invitation is one durable email effect per account. No addresses or mail
-- content are persisted in the queue. The existing SMTP acceptance marker is
-- separate from delivered_at: an ineligible recipient is acked, never "sent".
create or replace function bob_private.admin_invitation_recipient(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  select u.email from auth.users u where u.id = p_user
    and u.deleted_at is null and u.id <> '00000000-0000-4000-8000-0000000000de'
    and exists (select 1 from bob.outbox o where o.resource_id = u.id and o.event_type = 'email.admininvite')
    and (u.banned_until is null or u.banned_until <= now());
$$;

create or replace function bob_private.admin_invitation_queue(
  p_actor uuid, p_session uuid, p_email text, p_retry boolean default false
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_row bob.outbox%rowtype;
  v_key text;
begin
  if not exists (select 1 from auth.sessions s join auth.users u on u.id = s.user_id
    join bob.user_scopes sc on sc.user_id = u.id and sc.scope = 'accounts.admin'
    where s.id = p_session and u.id = p_actor
      and (u.banned_until is null or u.banned_until <= now())) then
    raise exception 'admin access unavailable' using errcode = '42501';
  end if;
  if p_email is null or length(p_email) > 254 then return 'failed'; end if;
  select u.id into v_user from auth.users u where lower(u.email) = lower(trim(p_email))
    and u.deleted_at is null and u.id <> '00000000-0000-4000-8000-0000000000de'
    and (u.banned_until is null or u.banned_until <= now()) for update;
  if v_user is null then return 'failed'; end if;
  v_key := 'admin-invite:' || v_user::text;
  perform bob_private.outbox_enqueue(
    array[null::uuid], array['email.admininvite'], array['account'], array[v_user],
    array[1], array[v_key], array[jsonb_build_object('recipient_user_id', v_user)]
  );
  update bob.outbox set recipient_user_id = v_user where effect_key = v_key;
  select * into v_row from bob.outbox where effect_key = v_key for update;
  if v_row.email_sent_at is not null then return 'sent'; end if;
  -- A retry is explicit and cannot steal a live lease or duplicate accepted mail.
  if p_retry and v_row.lease_owner is null
    and (v_row.last_error_code is not null or v_row.delivered_at is not null) then
    update bob.outbox set attempts = 0, last_error_code = null, delivered_at = null,
      available_at = now() where id = v_row.id;
    return 'queued';
  end if;
  if v_row.delivered_at is not null or v_row.last_error_code = 'parked' then return 'failed'; end if;
  return 'queued';
end;
$$;

-- Keep erasure's existing email-effect cleanup complete for the new event.
create or replace function bob_private.purge_account_email_effects(p_user_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_total integer;
begin
  delete from bob.outbox where recipient_user_id = p_user_id
    and event_type in ('email.notification', 'email.admininvite');
  get diagnostics v_total = row_count;

  return v_total;
end;
$$;
revoke all on function bob_private.admin_invitation_recipient(uuid) from public, anon, authenticated;
grant execute on function bob_private.admin_invitation_recipient(uuid) to bob_server;
revoke all on function bob_private.admin_invitation_queue(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function bob_private.admin_invitation_queue(uuid, uuid, text, boolean) to bob_server;
