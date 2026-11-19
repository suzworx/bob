-- Routine history is independent of Insights. Old insight IDs remain valid.
alter table bob.routines add column name text not null default 'Email recap' check (char_length(name) between 1 and 100),
 add column instructions text not null default '' check (char_length(instructions)<=2000),
 add column gmail_query text not null default '' check (char_length(gmail_query)<=500),
 add column summary_style text not null default 'concise' check(summary_style in ('concise','detailed')),
 add column weekdays integer[] not null default array[1,2,3,4,5,6,7] check(cardinality(weekdays) between 1 and 7 and weekdays <@ array[1,2,3,4,5,6,7]);
drop index bob.routines_unique_schedule;
alter table bob.routines drop constraint routines_status_check;
alter table bob.routines drop constraint routines_check;
alter table bob.routines add check(status in ('active','paused','archived')),
 add check((status in ('paused','archived') and next_run_at is null) or(status='active' and next_run_at is not null));
create table bob.routine_results (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 google_account_id uuid not null,
 routine_id uuid,
 run_id uuid not null unique,
 category text not null check(category in ('future','reflections','past')),
 title text not null check(char_length(title) between 1 and 160),
 summary text not null check(char_length(summary) between 1 and 6000),
 period_start timestamptz not null, period_end timestamptz not null,
 generated_at timestamptz not null,
 sources jsonb not null check(jsonb_typeof(sources)='array' and jsonb_array_length(sources)<=200),
 partial boolean not null, message_count integer not null check(message_count between 0 and 200),
 foreign key(user_id,run_id) references bob.routine_runs(user_id,id) on delete cascade,
 foreign key(user_id,google_account_id) references bob.google_accounts(user_id,id) on delete cascade,
 check(period_start < period_end)
);
insert into bob.routine_results select * from bob.insights where run_id is not null;
alter table bob.routine_results enable row level security;
alter table bob.routine_results force row level security;
create policy routine_results_read on bob.routine_results for select to authenticated using(user_id=(select auth.uid()));
grant select on bob.routine_results to authenticated;
create index routine_results_owner on bob.routine_results(user_id,generated_at desc,id desc);
-- Results inherit the existing 90-day retention through their run foreign key.
create or replace function bob_private.routine_complete(p_id uuid,p_token uuid,p_summary text,p_sources jsonb,p_count integer,p_partial boolean,p_now timestamptz)
returns uuid language plpgsql security definer set search_path=pg_catalog,bob as $$
declare r bob.routines; v bob.routine_runs; v_id uuid;
begin
 perform 1 from bob.google_accounts g join bob.routines t on t.google_account_id=g.id join bob.routine_runs x on x.routine_id=t.id where x.id=p_id for share of g;
 select t.* into r from bob.routines t join bob.routine_runs x on x.routine_id=t.id where x.id=p_id for update of t;
 if not found then return null; end if;
 select * into v from bob.routine_runs where id=p_id for update;
 if r.status<>'active' or r.revision<>v.revision or v.state<>'running' or v.attempt_token<>p_token then return null; end if;
 insert into bob.routine_results(user_id,google_account_id,routine_id,run_id,category,title,summary,period_start,period_end,generated_at,sources,partial,message_count)
 values(r.user_id,r.google_account_id,r.id,v.id,'past',r.name,p_summary,v.coverage_start,v.coverage_end,p_now,p_sources,p_partial or v.partial,p_count)
 returning id into v_id;
 update bob.routine_runs set state='completed',completed_at=p_now where id=p_id;
 update bob.routines set last_coverage_end=greatest(last_coverage_end,v.coverage_end) where id=r.id;
 return v_id;
end $$;

drop function bob_private.routines_due(timestamptz);
create function bob_private.routines_due(p_now timestamptz)
returns table(id uuid, revision integer, local_time text, time_zone text, next_run_at timestamptz, weekdays integer[])
language sql security definer set search_path=pg_catalog,bob as $$
 select r.id,r.revision,r.local_time,r.time_zone,r.next_run_at,r.weekdays from bob.routines r
 where r.status='active' and r.next_run_at<=p_now order by r.next_run_at,r.id limit 100
$$;
revoke all on function bob_private.routines_due(timestamptz) from public,anon,authenticated;
grant execute on function bob_private.routines_due(timestamptz) to bob_server;
create or replace function bob_private.routine_quota() returns trigger language plpgsql security definer set search_path=pg_catalog,bob as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.user_id::text,783));
 if new.status='active' and (select count(*) from bob.routines where user_id=new.user_id and status<>'archived')>=10 then raise exception 'routine_limit' using errcode='23514'; end if;
 return new;
end $$;
