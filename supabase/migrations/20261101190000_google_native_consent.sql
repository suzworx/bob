-- Native authorization is a sidecar: old prepared RETURNING * statements on
-- google_consent_attempts retain their exact row shape during migration-first rollout.
create function bob_private.google_native_session_active(p_session uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare metadata jsonb; created timestamptz; fence jsonb;
begin
 select coalesce(u.raw_app_meta_data,'{}'::jsonb),s.created_at into metadata,created
 from auth.users u join auth.sessions s on s.user_id=u.id where u.id=auth.uid() and s.id=p_session
 for key share of s;
 if not found or jsonb_typeof(metadata)<>'object' then return false; end if;
 -- Hold eligibility through this short transaction. A revocation that already
 -- owns the row wins; a later revocation waits until finalization commits.
 if not bob_private.web_session_active(auth.uid(),p_session) then return false; end if;
 if not (metadata ? 'bob_google_native_erased_before') then return true; end if;
 fence := metadata->'bob_google_native_erased_before';
 if jsonb_typeof(fence)<>'number' or created is null then return false; end if;
 return extract(epoch from created)>(fence::text)::numeric;
end; $$;
revoke all on function bob_private.google_native_session_active(uuid) from public,anon;
grant execute on function bob_private.google_native_session_active(uuid) to authenticated;

create table bob.google_native_consent_attempts (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 session_id uuid not null references auth.sessions(id) on delete cascade,
 state_hash text not null check(state_hash ~ '^[a-f0-9]{64}$'),
 code_challenge text not null check(code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
 connect_subject text not null check(connect_subject ~ '^gc_[A-Za-z0-9_-]{43}$'),
 capabilities text[] not null check(cardinality(capabilities) between 1 and 6 and
   capabilities <@ array['calendar.read','calendar.write','gmail.read','gmail.draft','gmail.send','gmail.modify']::text[]),
 reconnect_account_id uuid,
 status text not null default 'pending' check(status in ('pending','processing','completed','failed','cancelled','expired')),
 expires_at timestamptz not null default (now()+interval '10 minutes'),
 claim_deadline timestamptz,
 result_account_id uuid,
 foreign key(user_id,reconnect_account_id) references bob.google_accounts(user_id,id) on delete cascade,
 foreign key(user_id,result_account_id) references bob.google_accounts(user_id,id) on delete cascade,
 check((status='completed') = (result_account_id is not null))
);
create index google_native_consent_owner_idx on bob.google_native_consent_attempts(user_id);
create index google_native_consent_session_idx on bob.google_native_consent_attempts(session_id);
alter table bob.google_native_consent_attempts enable row level security;
alter table bob.google_native_consent_attempts force row level security;
create policy google_native_consent_owner on bob.google_native_consent_attempts for all to authenticated
 using(user_id=(select auth.uid()))
 with check(user_id=(select auth.uid()) and bob_private.google_native_session_active(session_id));
revoke all on bob.google_native_consent_attempts from public,anon,authenticated;
grant select,insert,delete on bob.google_native_consent_attempts to authenticated;
grant update(status,claim_deadline,result_account_id) on bob.google_native_consent_attempts to authenticated;

-- Old web servers also supersede an in-flight native reconnect. This trigger
-- preserves the legacy row shape and runs under the existing owner RLS/lock.
create function bob_private.google_native_supersede() returns trigger language plpgsql set search_path='' as $$
begin
 if new.reconnect_account_id is not null then
   delete from bob.google_native_consent_attempts
   where user_id=new.user_id and reconnect_account_id=new.reconnect_account_id;
 end if;
 return new;
end; $$;
create trigger google_native_reconnect_superseded before insert on bob.google_consent_attempts
 for each row execute function bob_private.google_native_supersede();
revoke all on function bob_private.google_native_supersede() from public,anon,authenticated;

create function bob_private.purge_account_google_native(p_user uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtext('google-accounts:'||p_user::text));
 update auth.users set raw_app_meta_data=jsonb_set(coalesce(raw_app_meta_data,'{}'::jsonb),
  '{bob_google_native_erased_before}',to_jsonb(extract(epoch from clock_timestamp())),true) where id=p_user;
 delete from bob.google_native_consent_attempts where user_id=p_user;
end; $$;
revoke all on function bob_private.purge_account_google_native(uuid) from public,anon,authenticated;
grant execute on function bob_private.purge_account_google_native(uuid) to bob_server;
