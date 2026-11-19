-- Marketing installations (U2): server-owned rows, one per owner and package. Grants, config and state never
-- come from an app definition. The composite owner FK keeps each installation on its owner's app in the database.
alter table bob.bob_apps add constraint bob_apps_owner_id_key unique (user_id,id);
create table bob.bob_app_installations (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 app_id uuid not null unique,
 package_id text not null check (package_id ~ '^[a-z][a-z0-9-]{0,39}$'),
 package_version text not null check (length(package_version) between 1 and 20),
 state text not null default 'draft' check (state in ('draft','active','paused','inactive')),
 granted_capabilities text[] not null default '{}'
  check (granted_capabilities <@ array['campaign.draft','campaign.configure','campaign.read']::text[]),
 revision integer not null default 1 check (revision > 0),
 config_revision integer not null default 1 check (config_revision > 0),
 config jsonb not null default '{}' check (jsonb_typeof(config) = 'object' and octet_length(config::text) <= 2000),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique (user_id,package_id),
 unique (user_id,id),
 foreign key (user_id,app_id) references bob.bob_apps(user_id,id) on delete cascade
);
alter table bob.bob_app_installations enable row level security;
alter table bob.bob_app_installations force row level security;
create policy bob_app_installations_owner on bob.bob_app_installations for all to authenticated
 using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
grant select,insert,update on bob.bob_app_installations to authenticated;

-- Bounded per owner by the service (1000 receipts). installation_id is a result, not a foreign key: a replay
-- after the app is deleted answers not_found instead of recreating the installation.
create table bob.bob_app_marketing_operations (
 user_id uuid not null references auth.users(id) on delete cascade,
 mutation_id uuid not null,
 fingerprint text not null check (length(fingerprint) = 64),
 installation_id uuid,
 created_at timestamptz not null default now(),
 primary key (user_id,mutation_id)
);
alter table bob.bob_app_marketing_operations enable row level security;
alter table bob.bob_app_marketing_operations force row level security;
create policy bob_app_marketing_operations_owner on bob.bob_app_marketing_operations for all to authenticated
 using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
grant select,insert,delete on bob.bob_app_marketing_operations to authenticated;

-- At most one selected installation per owner. Expiry is set by the service (one hour).
create table bob.bob_app_selection (
 user_id uuid primary key references auth.users(id) on delete cascade,
 installation_id uuid not null,
 expires_at timestamptz not null,
 foreign key (user_id,installation_id) references bob.bob_app_installations(user_id,id) on delete cascade
);
alter table bob.bob_app_selection enable row level security;
alter table bob.bob_app_selection force row level security;
create policy bob_app_selection_owner on bob.bob_app_selection for all to authenticated
 using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
grant select,insert,update,delete on bob.bob_app_selection to authenticated;

-- Explicit account erasure: the auth row stays, so cascades never fire. Installations and selections go with their app.
create or replace function bob_private.purge_bob_apps(owner_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
 delete from bob.bob_app_selection where user_id=owner_id;
 delete from bob.bob_app_marketing_operations where user_id=owner_id;
 delete from bob.bob_app_installations where user_id=owner_id;
 delete from bob.bob_apps where user_id=owner_id;
 delete from bob.bob_app_mutations where user_id=owner_id;
 -- Keep global sessions available for account-deletion retries. Marketing install/selection admission needs a newer sign-in;
 -- other APIs keep their existing valid-session semantics, including after an authorized fresh installation.
 -- App metadata is server-owned; preserve unrelated keys and read this fence from the database, never a stale JWT.
 update auth.users set raw_app_meta_data=jsonb_set(coalesce(raw_app_meta_data,'{}'::jsonb),
   '{bob_marketing_erased_before}',to_jsonb(extract(epoch from clock_timestamp())),true) where id=owner_id;
end;
$$;
revoke all on function bob_private.purge_bob_apps(uuid) from public,anon,authenticated;
grant execute on function bob_private.purge_bob_apps(uuid) to bob_server;

-- Self-scoped install/selection admission check: it asks only about the caller's own session (auth.uid()), so the API
-- never reads the auth schema directly.
create function bob_private.marketing_session_active(p_session uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
 metadata jsonb;
 session_created_at timestamptz;
 fence jsonb;
begin
 if not bob_private.web_session_active(auth.uid(),p_session) then return false; end if;
 select coalesce(u.raw_app_meta_data,'{}'::jsonb),s.created_at into metadata,session_created_at
   from auth.users u join auth.sessions s on s.user_id=u.id where u.id=auth.uid() and s.id=p_session;
 if not found or jsonb_typeof(metadata)<>'object' then return false; end if;
 if not (metadata ? 'bob_marketing_erased_before') then return true; end if;
 fence := metadata->'bob_marketing_erased_before';
 if jsonb_typeof(fence)<>'number' or session_created_at is null then return false; end if;
 return extract(epoch from session_created_at)>(fence::text)::numeric;
end;
$$;
revoke all on function bob_private.marketing_session_active(uuid) from public,anon;
grant execute on function bob_private.marketing_session_active(uuid) to authenticated;

-- The local-only sign-in definer uses the same session age as hosted Auth. Reusing a session id never refreshes it.
-- Keep the prior user's token defaults and the definer's existing privileges unchanged.
create or replace function bob_private.ensure_test_session(p_user_id uuid,p_session_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
 insert into auth.users (
   id,aud,role,confirmation_token,recovery_token,email_change,email_change_token_new,email_change_token_current,
   phone_change,phone_change_token,reauthentication_token
 ) values (p_user_id,'authenticated','authenticated','','','','','','','','') on conflict (id) do nothing;
 insert into auth.sessions (id,user_id,created_at) values (p_session_id,p_user_id,clock_timestamp()) on conflict (id) do nothing;
end;
$$;
revoke all on function bob_private.ensure_test_session(uuid,uuid) from public,anon,authenticated;
grant execute on function bob_private.ensure_test_session(uuid,uuid) to bob_server;
