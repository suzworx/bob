-- Private immutable provenance/results, not a second job/lease queue.
alter table bob.routines add column last_coverage_end timestamptz;
create unique index routines_unique_schedule on bob.routines(user_id,google_account_id,kind,local_time,time_zone);
create function bob_private.routine_quota() returns trigger language plpgsql security definer set search_path=pg_catalog,bob as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.user_id::text,783));
 if (select count(*) from bob.routines where user_id=new.user_id)>=10 then raise exception 'routine_limit' using errcode='23514'; end if;
 return new;
end $$;
create trigger routine_quota before insert on bob.routines for each row execute function bob_private.routine_quota();
revoke all on function bob_private.routine_quota() from public,anon,authenticated;
create table bob.routine_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  routine_id uuid not null references bob.routines(id) on delete cascade,
  revision integer not null check (revision > 0),
  scheduled_at timestamptz not null,
  coverage_start timestamptz not null,
  coverage_end timestamptz not null,
  partial boolean not null default false,
  state text not null default 'pending' check (state in ('pending','running','completed','failed','skipped')),
  attempt integer not null default 0 check (attempt between 0 and 3),
  attempt_token uuid,
  failure_code text check (failure_code in ('consent_unavailable','provider_unavailable','summary_unavailable','cancelled','missed','stale')),
  started_at timestamptz, completed_at timestamptz,
  unique (routine_id, revision, scheduled_at),
  unique (user_id, id),
  check (coverage_start < coverage_end and coverage_end - coverage_start <= interval '7 days')
);
create index routine_runs_owner on bob.routine_runs(user_id, routine_id, scheduled_at desc);
alter table bob.routine_runs enable row level security;
alter table bob.routine_runs force row level security;
create policy routine_runs_read on bob.routine_runs for select to authenticated using (user_id=(select auth.uid()));
grant select on bob.routine_runs to authenticated;

create table bob.insights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  google_account_id uuid not null,
  routine_id uuid references bob.routines(id) on delete cascade,
  run_id uuid unique,
  category text not null check (category in ('future','reflections','past')),
  title text not null check (char_length(title) between 1 and 160),
  summary text not null check (char_length(summary) between 1 and 6000),
  period_start timestamptz not null, period_end timestamptz not null,
  generated_at timestamptz not null,
  sources jsonb not null check (jsonb_typeof(sources)='array' and jsonb_array_length(sources)<=200),
  partial boolean not null, message_count integer not null check (message_count between 0 and 200),
  foreign key (user_id, google_account_id) references bob.google_accounts(user_id,id) on delete cascade,
  foreign key (user_id, run_id) references bob.routine_runs(user_id,id) on delete cascade,
  check (period_start < period_end)
);
create index insights_owner_category on bob.insights(user_id,category,generated_at desc);
create unique index insights_current on bob.insights(user_id,google_account_id,category) where run_id is null;
alter table bob.insights enable row level security;
alter table bob.insights force row level security;
create policy insights_read on bob.insights for select to authenticated using (user_id=(select auth.uid()));
grant select on bob.insights to authenticated;

create function bob_private.insight_refresh(p_owner uuid,p_account uuid,p_category text,p_title text,p_summary text,p_start timestamptz,p_end timestamptz,p_generated timestamptz,p_sources jsonb,p_partial boolean)
returns uuid language plpgsql security definer set search_path=pg_catalog,bob as $$
declare v_id uuid;
begin
 if p_category not in ('future','reflections') then raise exception 'invalid_insight_category'; end if;
 perform 1 from bob.google_accounts where id=p_account and user_id=p_owner for share;
 if not found then return null; end if;
 insert into bob.insights(user_id,google_account_id,category,title,summary,period_start,period_end,generated_at,sources,partial,message_count)
 values(p_owner,p_account,p_category,p_title,p_summary,p_start,p_end,p_generated,p_sources,p_partial,0)
 on conflict(user_id,google_account_id,category) where run_id is null do update
 set title=excluded.title,summary=excluded.summary,period_start=excluded.period_start,period_end=excluded.period_end,
 generated_at=excluded.generated_at,sources=excluded.sources,partial=excluded.partial
 where bob.insights.generated_at<=excluded.generated_at returning id into v_id;
 if v_id is null then select id into v_id from bob.insights where user_id=p_owner and google_account_id=p_account and category=p_category and run_id is null; end if;
 return v_id;
end $$;
revoke all on function bob_private.insight_refresh(uuid,uuid,text,text,text,timestamptz,timestamptz,timestamptz,jsonb,boolean) from public,anon,authenticated;
grant execute on function bob_private.insight_refresh(uuid,uuid,text,text,text,timestamptz,timestamptz,timestamptz,jsonb,boolean) to bob_server;

-- Due discovery exposes references/schedules only to the server, never content.
create function bob_private.routines_due(p_now timestamptz)
returns table(id uuid, revision integer, local_time text, time_zone text, next_run_at timestamptz)
language sql security definer set search_path=pg_catalog,bob as $$
 select r.id,r.revision,r.local_time,r.time_zone,r.next_run_at from bob.routines r
 where r.status='active' and r.next_run_at<=p_now order by r.next_run_at,r.id limit 100
$$;
create function bob_private.routine_dispatch(p_id uuid,p_revision integer,p_scheduled timestamptz,p_next timestamptz,p_now timestamptz)
returns uuid language plpgsql security definer set search_path=pg_catalog,bob as $$
declare r bob.routines; v_id uuid; v_last timestamptz; v_start timestamptz;
begin
 perform 1 from bob.google_accounts g join bob.routines t on t.google_account_id=g.id where t.id=p_id for share of g;
 select * into r from bob.routines where id=p_id for update;
 if not found or r.status<>'active' or r.revision<>p_revision or r.next_run_at>p_now then return null; end if;
 if exists(select 1 from bob.routine_runs where routine_id=r.id and state in ('pending','running')) then return null; end if;
 if p_scheduled>p_now or p_scheduled<r.next_run_at or p_next<=p_now then
   raise exception 'invalid_routine_occurrence';
 end if;
 if p_scheduled<p_now-interval '24 hours' then
  insert into bob.routine_runs(user_id,routine_id,revision,scheduled_at,coverage_start,coverage_end,state,failure_code,completed_at)
  values(r.user_id,r.id,r.revision,p_scheduled,p_scheduled-interval '24 hours',p_scheduled,'skipped','missed',p_now)
  on conflict do nothing;
  update bob.routines set next_run_at=p_next where id=r.id;
  return null;
 end if;
 if r.next_run_at<p_scheduled then
   insert into bob.routine_runs(user_id,routine_id,revision,scheduled_at,coverage_start,coverage_end,state,failure_code,completed_at)
    values(r.user_id,r.id,r.revision,r.next_run_at,r.next_run_at-interval '24 hours',r.next_run_at,'skipped','missed',p_now)
    on conflict do nothing;
 end if;
 v_last:=r.last_coverage_end;
 v_start:=greatest(coalesce(v_last,p_scheduled-interval '24 hours'),p_scheduled-interval '7 days');
 insert into bob.routine_runs(user_id,routine_id,revision,scheduled_at,coverage_start,coverage_end,partial)
 values(r.user_id,r.id,r.revision,p_scheduled,v_start,p_scheduled,v_last is not null and v_last<v_start)
 on conflict do nothing returning id into v_id;
 if v_id is not null then
  perform bob_private.outbox_enqueue(array[null::uuid],array['routine.dispatch'],array['routine_run'],array[v_id],array[p_revision],
    array['routine:'||v_id::text],array[jsonb_build_object('resource_id',v_id)]);
 end if;
 update bob.routines set next_run_at=p_next where id=r.id;
 return v_id;
end $$;

create function bob_private.routine_claim(p_id uuid,p_now timestamptz)
returns table(owner uuid,routine_id uuid,google_account_id uuid,revision integer,attempt_token uuid,coverage_start timestamptz,coverage_end timestamptz,partial boolean)
language plpgsql security definer set search_path=pg_catalog,bob as $$
declare r bob.routines; v bob.routine_runs;
begin
 perform 1 from bob.google_accounts g join bob.routines t on t.google_account_id=g.id join bob.routine_runs x on x.routine_id=t.id where x.id=p_id for share of g;
 select t.* into r from bob.routines t join bob.routine_runs x on x.routine_id=t.id where x.id=p_id for update of t;
 if not found then return; end if;
 select * into v from bob.routine_runs x where x.id=p_id for update;
 if v.state not in ('pending','running') then return; end if;
 if r.status<>'active' or r.revision<>v.revision then
  update bob.routine_runs set state='skipped',failure_code='stale',completed_at=p_now where id=p_id; return;
 end if;
 if v.attempt>=3 then update bob.routine_runs set state='failed',failure_code='provider_unavailable',completed_at=p_now where id=p_id; return; end if;
 update bob.routine_runs set state='running',attempt=attempt+1,attempt_token=gen_random_uuid(),started_at=p_now,failure_code=null
 where id=p_id returning * into v;
 return query select r.user_id,r.id,r.google_account_id,r.revision,v.attempt_token,v.coverage_start,v.coverage_end,v.partial;
end $$;

create function bob_private.routine_complete(p_id uuid,p_token uuid,p_summary text,p_sources jsonb,p_count integer,p_partial boolean,p_now timestamptz)
returns uuid language plpgsql security definer set search_path=pg_catalog,bob as $$
declare r bob.routines; v bob.routine_runs; v_id uuid;
begin
 perform 1 from bob.google_accounts g join bob.routines t on t.google_account_id=g.id join bob.routine_runs x on x.routine_id=t.id where x.id=p_id for share of g;
 select t.* into r from bob.routines t join bob.routine_runs x on x.routine_id=t.id where x.id=p_id for update of t;
 if not found then return null; end if;
 select * into v from bob.routine_runs where id=p_id for update;
 if r.status<>'active' or r.revision<>v.revision or v.state<>'running' or v.attempt_token<>p_token then return null; end if;
 insert into bob.insights(user_id,google_account_id,routine_id,run_id,category,title,summary,period_start,period_end,generated_at,sources,partial,message_count)
 values(r.user_id,r.google_account_id,r.id,v.id,'past','Your email recap',p_summary,v.coverage_start,v.coverage_end,p_now,p_sources,p_partial or v.partial,p_count)
 returning id into v_id;
 update bob.routine_runs set state='completed',completed_at=p_now where id=p_id;
 update bob.routines set last_coverage_end=greatest(last_coverage_end,v.coverage_end) where id=r.id;
 return v_id;
end $$;

create function bob_private.routine_fail(p_id uuid,p_token uuid,p_code text,p_pause boolean,p_now timestamptz)
returns void language plpgsql security definer set search_path=pg_catalog,bob as $$
declare r bob.routines; v bob.routine_runs;
begin
 select t.* into r from bob.routines t join bob.routine_runs x on x.routine_id=t.id where x.id=p_id for update of t;
 if not found then return; end if;
 select * into v from bob.routine_runs where id=p_id for update;
 if v.state<>'running' or v.attempt_token<>p_token then return; end if;
 update bob.routine_runs set state=case when p_code='stale' then 'skipped' when p_pause or attempt>=3 then 'failed' else 'pending' end,
 failure_code=p_code,completed_at=case when p_code='stale' or p_pause or attempt>=3 then p_now else null end where id=p_id;
 if p_pause and r.revision=v.revision then
 update bob.routines set status='paused',next_run_at=null,revision=revision+1,updated_at=p_now where id=r.id;
 end if;
end $$;

-- Queue/outbox references vanish with the run (disconnect, erasure, retention).
create function bob_private.routine_run_cleanup() returns trigger language plpgsql security definer set search_path=pg_catalog,bob as $$
begin
 delete from bob.outbox where resource_type='routine_run' and resource_id=old.id;
 delete from bob_jobs.job where name='routine-run' and id=old.id;
 return old;
end $$;
create trigger routine_run_cleanup after delete on bob.routine_runs for each row execute function bob_private.routine_run_cleanup();

create function bob_private.routine_prune(p_now timestamptz) returns void language plpgsql security definer set search_path=pg_catalog,bob as $$
begin
 update bob.routine_runs r set state='failed',failure_code='provider_unavailable',completed_at=p_now
 where r.state in ('pending','running') and (r.scheduled_at<p_now-interval '24 hours'
   or exists(select 1 from bob_jobs.job j where j.id=r.id and j.name='routine-run' and j.state in ('failed','cancelled')));
 delete from bob.routine_runs where id in (select id from bob.routine_runs where scheduled_at<p_now-interval '90 days' order by scheduled_at limit 100);
 delete from bob.insights where id in (select id from bob.insights where run_id is null and generated_at<p_now-interval '90 days' order by generated_at limit 100);
end $$;
revoke all on function bob_private.routine_prune(timestamptz) from public,anon,authenticated;
grant execute on function bob_private.routine_prune(timestamptz) to bob_server;

revoke all on function bob_private.routines_due(timestamptz),bob_private.routine_dispatch(uuid,integer,timestamptz,timestamptz,timestamptz),bob_private.routine_claim(uuid,timestamptz),bob_private.routine_complete(uuid,uuid,text,jsonb,integer,boolean,timestamptz),bob_private.routine_fail(uuid,uuid,text,boolean,timestamptz),bob_private.routine_run_cleanup() from public,anon,authenticated;
grant execute on function bob_private.routines_due(timestamptz),bob_private.routine_dispatch(uuid,integer,timestamptz,timestamptz,timestamptz),bob_private.routine_claim(uuid,timestamptz),bob_private.routine_complete(uuid,uuid,text,jsonb,integer,boolean,timestamptz),bob_private.routine_fail(uuid,uuid,text,boolean,timestamptz) to bob_server;
