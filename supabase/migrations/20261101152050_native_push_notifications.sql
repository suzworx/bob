-- Account/session-bound native installations. Tokens never enter logs or outbox payloads.
create table bob.push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references auth.sessions(id) on delete cascade,
  installation_id uuid not null,
  token text not null check (token ~ '^[a-f0-9]+$' and length(token) between 64 and 512 and length(token)%2=0),
  environment text not null check (environment in ('sandbox','production')),
  topic text not null check (length(topic) between 1 and 120),
  app_version text not null check (length(app_version) between 1 and 40),
  local_timer_ids uuid[] not null default '{}' check (cardinality(local_timer_ids) <= 60),
  generation uuid not null default gen_random_uuid(),
  last_seen_at timestamptz not null default now(),
  unique(user_id, installation_id), unique(installation_id), unique(token, environment, topic)
);
create index push_devices_session_idx on bob.push_devices(session_id);
alter table bob.push_devices enable row level security;
alter table bob.push_devices force row level security;
-- Account deletion retains global sessions for retry. Push admission therefore
-- needs its own fresh-sign-in fence, without changing other interfaces' auth.
create function bob_private.push_session_allowed(p_user uuid,p_session uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
 metadata jsonb;
 session_created_at timestamptz;
 fence jsonb;
begin
 if not bob_private.web_session_active(p_user,p_session) then return false; end if;
 select coalesce(u.raw_app_meta_data,'{}'::jsonb),s.created_at into metadata,session_created_at
   from auth.users u join auth.sessions s on s.user_id=u.id where u.id=p_user and s.id=p_session;
 if not found or jsonb_typeof(metadata)<>'object' then return false; end if;
 if not (metadata ? 'bob_push_erased_before') then return true; end if;
 fence := metadata->'bob_push_erased_before';
 if jsonb_typeof(fence)<>'number' or session_created_at is null then return false; end if;
 return extract(epoch from session_created_at)>(fence::text)::numeric;
end; $$;
revoke all on function bob_private.push_session_allowed(uuid,uuid) from public,anon,authenticated;
grant execute on function bob_private.push_session_allowed(uuid,uuid) to bob_server;
create function bob_private.push_session_active(p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select bob_private.push_session_allowed(auth.uid(),p_session);
$$;
revoke all on function bob_private.push_session_active(uuid) from public,anon;
grant execute on function bob_private.push_session_active(uuid) to authenticated;
create policy push_devices_read on bob.push_devices for select to authenticated using ((select auth.uid()) = user_id and bob_private.push_session_active(session_id));
create policy push_devices_delete on bob.push_devices for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on bob.push_devices from public, anon, authenticated;
grant select, delete on bob.push_devices to authenticated;

create function bob_private.push_register(p_user uuid, p_session uuid, p_installation uuid,
 p_token text, p_environment text, p_topic text, p_version text, p_local_timers uuid[])
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
  if not bob_private.push_session_allowed(p_user, p_session) then return false; end if;
  -- Both the opaque installation and the provider token belong to one signed-in
  -- account. Installation locking covers token rotation and sandbox/production
  -- upgrades even when the previous account's DELETE never reached the server.
  perform pg_advisory_xact_lock(hashtextextended(p_installation::text, 2));
  perform pg_advisory_xact_lock(hashtextextended(p_token || p_environment || p_topic, 0));
  delete from bob.push_devices
    where (installation_id=p_installation or (token=p_token and environment=p_environment and topic=p_topic))
      and (user_id <> p_user or installation_id <> p_installation);
  if not exists(select 1 from bob.push_devices where user_id=p_user and installation_id=p_installation)
    and (select count(*) from bob.push_devices where user_id=p_user) >= 20 then
    raise exception 'push_device_limit' using errcode='23514';
  end if;
  insert into bob.push_devices(user_id,session_id,installation_id,token,environment,topic,app_version,local_timer_ids)
    values(p_user,p_session,p_installation,p_token,p_environment,p_topic,p_version,p_local_timers)
  on conflict(user_id,installation_id) do update set session_id=excluded.session_id, token=excluded.token,
    environment=excluded.environment,topic=excluded.topic,app_version=excluded.app_version,
    local_timer_ids=excluded.local_timer_ids,generation=gen_random_uuid(),last_seen_at=now();
  return true;
end; $$;
revoke all on function bob_private.push_register(uuid,uuid,uuid,text,text,text,text,uuid[]) from public,anon,authenticated;
grant execute on function bob_private.push_register(uuid,uuid,uuid,text,text,text,text,uuid[]) to bob_server;

-- Per-installation receipts prevent successful devices from receiving a retry after another device failed.
create table bob.push_receipts (
  device_id uuid not null references bob.push_devices(id) on delete cascade,
  outbox_id uuid not null references bob.outbox(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  sent_at timestamptz not null default now(), primary key(device_id,outbox_id)
);
create index push_receipts_user_idx on bob.push_receipts(user_id);
create index push_receipts_outbox_idx on bob.push_receipts(outbox_id);
alter table bob.push_receipts enable row level security;
alter table bob.push_receipts force row level security;
create policy push_receipts_owner on bob.push_receipts for all to authenticated
 using((select auth.uid())=user_id) with check((select auth.uid())=user_id
 and exists(select 1 from bob.push_devices d where d.id=device_id and d.user_id=(select auth.uid())));
revoke all on bob.push_receipts from public,anon,authenticated;
grant select,insert on bob.push_receipts to authenticated;

-- This runs inside eraseAccountRow's transaction. Serialize with registration
-- and fence queued old-session POSTs before deleting dormant channels and work.
create function bob_private.purge_account_push(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
 update auth.users set raw_app_meta_data=jsonb_set(coalesce(raw_app_meta_data,'{}'::jsonb),
   '{bob_push_erased_before}',to_jsonb(extract(epoch from clock_timestamp())),true) where id=p_user;
 delete from bob.push_receipts where user_id=p_user;
 delete from bob.push_devices where user_id=p_user;
 delete from bob.outbox where recipient_user_id=p_user and event_type in ('push.notification','push.timer');
end; $$;
revoke all on function bob_private.purge_account_push(uuid) from public,anon,authenticated;
grant execute on function bob_private.purge_account_push(uuid) to bob_server;

-- Both enqueue hooks run in the originating transaction, including timer claim races and process crashes.
create function bob_private.push_enqueue_notification() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 insert into bob.outbox(space_id,event_type,resource_type,resource_id,effect_key,payload,recipient_user_id)
 values(new.space_id,'push.notification','notification',new.id,'push:notification:'||new.id,
 jsonb_build_object('recipient_user_id',new.recipient_user_id),new.recipient_user_id)
 on conflict(effect_key) do nothing;
 return new;
end; $$;
create trigger push_notification_enqueued after insert on bob.notifications
 for each row execute function bob_private.push_enqueue_notification();

create function bob_private.push_enqueue_timer() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 if new.kind <> 'reminder' and old.status='pending' and new.status='fired' then
   insert into bob.outbox(event_type,resource_type,resource_id,effect_key,payload,recipient_user_id)
   values('push.timer','timer',new.id,'push:timer:'||new.id,
    jsonb_build_object('recipient_user_id',new.created_by),new.created_by) on conflict(effect_key) do nothing;
 end if;
 return new;
end; $$;
create trigger push_timer_enqueued after update of status on bob.reminders
 for each row execute function bob_private.push_enqueue_timer();
revoke all on function bob_private.push_enqueue_notification() from public,anon,authenticated;
revoke all on function bob_private.push_enqueue_timer() from public,anon,authenticated;

-- Deliberate delivery deferral is not a failed attempt. Only the current lease holder can defer.
create function bob_private.outbox_defer(p_owner text,p_id uuid,p_retry_in_ms int,p_now timestamptz)
returns boolean language sql security definer set search_path = '' as $$
 with moved as (update bob.outbox set lease_owner=null,lease_expires_at=null,last_error_code=null,
   available_at=p_now + (greatest(1000,least(p_retry_in_ms,86400000))*interval '1 millisecond')
   where id=p_id and lease_owner=p_owner and delivered_at is null returning id)
 select exists(select 1 from moved);
$$;
revoke all on function bob_private.outbox_defer(text,uuid,int,timestamptz) from public,anon,authenticated;
grant execute on function bob_private.outbox_defer(text,uuid,int,timestamptz) to bob_server;
