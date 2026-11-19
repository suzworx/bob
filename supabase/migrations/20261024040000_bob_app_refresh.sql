-- Settings are one per app; runs have independent durable execution provenance.
create table bob.bob_app_refresh_settings (
 app_id uuid primary key references bob.bob_apps(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 enabled boolean not null default false, revision integer not null default 1,
 config jsonb, target_table text, next_run_at timestamptz,
 last_refresh_at timestamptz, last_error text,
 check (not enabled or (config is not null and target_table is not null and next_run_at is not null))
);
create index bob_app_refresh_due on bob.bob_app_refresh_settings(next_run_at) where enabled;
alter table bob.bob_app_refresh_settings enable row level security;
alter table bob.bob_app_refresh_settings force row level security;
create policy bob_refresh_owner on bob.bob_app_refresh_settings for all to authenticated using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()) and exists(select 1 from bob.bob_apps a where a.id=app_id and a.user_id=(select auth.uid())));
grant select,insert,update,delete on bob.bob_app_refresh_settings to authenticated;
create table bob.bob_app_runs (
 id uuid primary key default gen_random_uuid(), app_id uuid not null references bob.bob_apps(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 config_revision integer not null, app_revision integer not null,
 scheduled_at timestamptz not null, completed_at timestamptz,
 status text not null default 'pending' check(status in ('pending','completed','failed','skipped')),
 failure_code text check(failure_code in ('stale','permission_unavailable','source_unavailable')),
 unique(app_id,config_revision,scheduled_at)
);
create unique index bob_app_runs_one_pending on bob.bob_app_runs(app_id) where status='pending';
create index bob_app_runs_owner on bob.bob_app_runs(user_id,app_id,scheduled_at desc);
alter table bob.bob_app_runs enable row level security;
alter table bob.bob_app_runs force row level security;
create policy bob_runs_owner on bob.bob_app_runs for all to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()) and exists(select 1 from bob.bob_apps a where a.id=app_id and a.user_id=(select auth.uid())));
grant select,update,delete on bob.bob_app_runs to authenticated;
create function bob_private.bob_apps_due(p_now timestamptz) returns table(app_id uuid,revision integer,config jsonb)
language sql security definer set search_path='' as $$
 select s.app_id,s.revision,s.config from bob.bob_app_refresh_settings s join bob.bob_apps a on a.id=s.app_id
 where s.enabled and a.lifecycle='active' and s.next_run_at<=p_now
 and not exists(select 1 from bob.bob_app_runs r where r.app_id=s.app_id and r.status='pending' and r.scheduled_at>p_now-interval '1 hour')
 order by s.next_run_at limit 100;
$$;
create function bob_private.bob_app_dispatch(p_app uuid,p_revision integer,p_next timestamptz,p_now timestamptz) returns uuid
language plpgsql security definer set search_path='' as $$
declare a bob.bob_apps; s bob.bob_app_refresh_settings; v_id uuid;
begin
 select * into a from bob.bob_apps where id=p_app for update;
 if not found or a.lifecycle<>'active' then return null; end if;
 select * into s from bob.bob_app_refresh_settings where app_id=p_app for update;
 if not found or not s.enabled or s.revision<>p_revision or s.next_run_at>p_now then return null; end if;
 -- A lost or exhausted queue delivery must not block later schedules forever.
 -- The app lock fences any live publisher before expiring this metadata lease.
 update bob.bob_app_refresh_settings set last_error='source_unavailable' where app_id=p_app
 and exists(select 1 from bob.bob_app_runs where app_id=p_app and status='pending' and scheduled_at<=p_now-interval '1 hour');
 update bob.bob_app_runs set status='failed',failure_code='source_unavailable',completed_at=p_now
 where app_id=p_app and status='pending' and scheduled_at<=p_now-interval '1 hour';
 if exists(select 1 from bob.bob_app_runs where app_id=p_app and status='pending') then return null; end if;
 insert into bob.bob_app_runs(app_id,user_id,config_revision,app_revision,scheduled_at) values(p_app,s.user_id,s.revision,a.revision,s.next_run_at) on conflict do nothing returning id into v_id;
 if v_id is not null then
 perform bob_private.outbox_enqueue(array[null::uuid],array['routine.dispatch'],array['routine_run'],array[v_id],array[p_revision],array['bob-app:'||v_id::text],array[jsonb_build_object('resource_id',v_id)]);
 end if;
 update bob.bob_app_refresh_settings set next_run_at=p_next where app_id=p_app;
 delete from bob.bob_app_runs where app_id=p_app and status<>'pending' and id in(select id from bob.bob_app_runs where app_id=p_app order by scheduled_at desc offset 100);
 return v_id;
end $$;
create function bob_private.bob_app_run_owner(p_id uuid) returns table(user_id uuid,app_id uuid)
language sql security definer set search_path='' as $$ select user_id,app_id from bob.bob_app_runs where id=p_id; $$;
create function bob_private.bob_app_run_cleanup() returns trigger language plpgsql security definer set search_path='' as $$
begin delete from bob.outbox where resource_type='routine_run' and resource_id=old.id; return old; end $$;
create trigger bob_app_run_cleanup after delete on bob.bob_app_runs for each row execute function bob_private.bob_app_run_cleanup();
create function bob_private.bob_app_disable_invalid(p_app uuid,p_revision integer) returns void
language sql security definer set search_path='' as $$
 update bob.bob_app_refresh_settings set enabled=false,next_run_at=null,config=null,target_table=null,last_error='source_unavailable'
 where app_id=p_app and revision=p_revision;
$$;
revoke all on function bob_private.bob_app_disable_invalid(uuid,integer) from public,anon,authenticated;
grant execute on function bob_private.bob_app_disable_invalid(uuid,integer) to bob_server;
revoke all on function bob_private.bob_apps_due(timestamptz),bob_private.bob_app_dispatch(uuid,integer,timestamptz,timestamptz),bob_private.bob_app_run_owner(uuid),bob_private.bob_app_run_cleanup() from public,anon,authenticated;
grant execute on function bob_private.bob_apps_due(timestamptz),bob_private.bob_app_dispatch(uuid,integer,timestamptz,timestamptz),bob_private.bob_app_run_owner(uuid) to bob_server;
