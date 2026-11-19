-- The reminder fanout now CLAIMS an occurrence (reminder_occurrence_record,
-- insert on conflict do nothing) before it notifies, so two servers ticking at
-- once during a deploy overlap ring it once: only the one whose insert landed
-- notifies. When that notification then fails to enqueue, the claim is handed
-- back with this definer so the next tick retries it (#507). It deletes only a
-- fresh claim -- never an occurrence the recipient has acknowledged or snoozed.
-- Expand-only: a new function, nothing existing changes.
create or replace function bob_private.reminder_occurrence_release(
  p_reminder_id uuid, p_user_id uuid, p_occurrence_at timestamptz, p_schedule_revision int
) returns boolean
language sql security definer set search_path = ''
as $$
  with deleted as (
    delete from bob.reminder_occurrences
     where reminder_id = p_reminder_id and user_id = p_user_id
       and occurrence_at = p_occurrence_at and schedule_revision = p_schedule_revision
       and acknowledged_at is null and snoozed_until is null
    returning id
  )
  select exists (select 1 from deleted);
$$;

revoke all on function bob_private.reminder_occurrence_release(uuid, uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function bob_private.reminder_occurrence_release(uuid, uuid, timestamptz, integer) to bob_server;
