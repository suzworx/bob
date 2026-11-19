-- Routine email delivery is opt-in; existing routines remain disabled.
alter table bob.routines
  add column if not exists email_result boolean not null default false;

create or replace function bob_private.get_routine_email_delivery_context(p_run_id uuid)
returns table (
  owner_id uuid,
  routine_id uuid,
  routine_revision integer,
  google_account_id uuid,
  routine_name text,
  instructions text,
  gmail_query text,
  summary_style text,
  run_id uuid,
  result_id uuid,
  title text,
  summary text,
  period_start timestamptz,
  period_end timestamptz,
  generated_at timestamptz,
  sources jsonb,
  partial boolean,
  message_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    run.user_id,
    routine.id,
    routine.revision,
    routine.google_account_id,
    routine.name,
    routine.instructions,
    routine.gmail_query,
    routine.summary_style,
    run.id,
    result.id,
    result.title,
    result.summary,
    result.period_start,
    result.period_end,
    result.generated_at,
    result.sources,
    result.partial,
    result.message_count
  from bob.routine_runs as run
  join bob.routines as routine
    on routine.id = run.routine_id
   and routine.user_id = run.user_id
  join bob.routine_results as result
    on result.run_id = run.id
   and result.user_id = run.user_id
   and result.routine_id = routine.id
  where run.id = p_run_id
    and run.state = 'completed'
    and routine.status = 'active'
    and routine.email_result is true
    and routine.revision = run.revision;
$$;

revoke all on function bob_private.get_routine_email_delivery_context(uuid)
  from public, anon, authenticated;
grant execute on function bob_private.get_routine_email_delivery_context(uuid)
  to bob_server;
