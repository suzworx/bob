-- 20261024060000 added the opt-in email_result column and a first delivery
-- context function. This replaces that function with the note-shaped context
-- the routine runner reads and records the enqueue outcome per run.

-- The persisted status describes the notification enqueue outcome, not an
-- SMTP/provider send. NULL means no queue outcome was recorded.
alter table bob.routine_runs
  add column email_outcome text
  check (email_outcome in ('queued', 'muted'));

-- Retry reads only the immutable completed result. The stable note id is the
-- run UUID, and delivery is available only while the exact opted-in revision
-- remains active. This function is server-only because it returns private
-- result content and the private-space id. Its return type changes, so the
-- 20261024060000 version is dropped first.
drop function if exists bob_private.get_routine_email_delivery_context(uuid);
create function bob_private.get_routine_email_delivery_context(p_run_id uuid)
returns table(owner uuid, space_id uuid, note_id uuid, title text, body text)
language sql security definer set search_path=pg_catalog,bob as $$
  select x.user_id, s.id, x.id, result.title, result.summary
  from bob.routine_runs x
  join bob.routines r on r.id=x.routine_id
  join bob.routine_results result on result.run_id=x.id and result.user_id=x.user_id
  join bob.spaces s on s.owner_user_id=x.user_id and s.kind='private'
  where x.id=p_run_id
    and x.state='completed'
    and x.email_outcome is null
    and r.email_result
    and r.status='active'
    and r.revision=x.revision
  limit 1
$$;
revoke all on function bob_private.get_routine_email_delivery_context(uuid) from public,anon,authenticated;
grant execute on function bob_private.get_routine_email_delivery_context(uuid) to bob_server;

-- Record only terminal enqueue outcomes. Failed/unknown outcomes stay NULL and
-- are retried with the same run UUID and notification effect key.
create function bob_private.routine_email_outcome(p_run_id uuid,p_outcome text)
returns void language plpgsql security definer set search_path=pg_catalog,bob as $$
begin
  if p_outcome not in ('queued','muted') then
    raise exception 'invalid_routine_email_outcome';
  end if;
  update bob.routine_runs
  set email_outcome=p_outcome
  where id=p_run_id and state='completed' and email_outcome is null;
end $$;
revoke all on function bob_private.routine_email_outcome(uuid,text) from public,anon,authenticated;
grant execute on function bob_private.routine_email_outcome(uuid,text) to bob_server;
