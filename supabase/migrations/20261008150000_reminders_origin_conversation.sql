-- Background work carries the conversation it came from (#880 follow-up). A
-- reminder, timer or alarm created inside a conversation (web chat, a device
-- turn, an invocation, or a request naming the open conversation) stores that
-- conversation's canonical telemetry id. When the job fires, its spans and
-- journal lines are attributed to it (source `explicit`) instead of the
-- owner's active conversation at fire time. Telemetry only: never read for
-- authorization or data access, so there is no foreign key (legacy
-- conversation ids differ from their canonical telemetry form). Null for rows
-- created outside a conversation and for every row before this migration.
--
-- Expand-only: a nullable column; the two scheduler definers are recreated
-- with one more return column (a return type cannot change in place), so a
-- server still running the old code reads the same named columns as before.
-- Table grants and RLS on bob.reminders cover the new column unchanged.
alter table bob.reminders
  add column if not exists origin_conversation_id text null
  check (origin_conversation_id ~ '^conv_[0-9a-f]{32}$');

-- 1. The reminder fanout's source rows, plus the originating conversation for
--    the recipient who created the reminder (another recipient's job is not
--    about the creator's conversation, so it gets null and falls back).
drop function if exists bob_private.reminder_fanout_sources(timestamptz);
create function bob_private.reminder_fanout_sources(p_now timestamptz)
returns table (
  "reminderId" uuid, "spaceId" uuid, "dueAt" bigint, "dueZone" text, rrule jsonb,
  "scheduleRevision" int, "userId" uuid, "conversationId" text
)
language sql security definer set search_path = ''
as $$
  select r.id, r.space_id,
         floor(extract(epoch from r.due_at) * 1000)::bigint,
         r.due_zone, r.rrule, r.schedule_revision, rr.user_id,
         case when rr.user_id = r.created_by then r.origin_conversation_id end
    from bob.reminders r
    join bob.reminder_recipients rr on rr.reminder_id = r.id
   where r.kind = 'reminder'
     and r.status = 'active'
     and r.due_at <= p_now
     and (r.task_id is null or not exists (
            select 1 from bob.tasks t where t.id = r.task_id and t.status = 'completed'
          ))
     and exists (
            select 1 from bob.space_memberships m
            where m.space_id = r.space_id
              and m.user_id = rr.user_id
              and m.revoked_at is null
          );
$$;

revoke all on function bob_private.reminder_fanout_sources(timestamptz) from public, anon, authenticated;
grant execute on function bob_private.reminder_fanout_sources(timestamptz) to bob_server;

-- 2. The timer scheduler's due rows, plus the originating conversation.
drop function if exists bob_private.timers_due(timestamptz, integer);
create function bob_private.timers_due(p_now timestamptz, p_limit integer)
returns table (
  id uuid, "userId" uuid, kind text, label text, "firesAt" bigint,
  "durationMs" integer, status text, "createdAt" bigint, "firedAt" bigint,
  "conversationId" text
)
language sql security definer set search_path = ''
as $$
  select r.id, r.created_by, r.kind, r.title,
         floor(extract(epoch from r.due_at) * 1000)::bigint,
         r.duration_ms::integer, r.status,
         floor(extract(epoch from r.created_at) * 1000)::bigint,
         floor(extract(epoch from r.fired_at) * 1000)::bigint,
         r.origin_conversation_id
    from bob.reminders r
   where r.kind <> 'reminder' and r.status = 'pending' and r.due_at <= p_now
   order by r.due_at, r.id
   limit greatest(1, least(p_limit, 1000));
$$;

revoke all on function bob_private.timers_due(timestamptz, integer) from public, anon, authenticated;
grant execute on function bob_private.timers_due(timestamptz, integer) to bob_server;

-- 3. The fallback for a job with no originating conversation: the active
--    conversation of many accounts in ONE read, for a fan-out (user_state is
--    FORCE RLS, so the server role reads across accounts only through this).
create or replace function bob_private.active_conversation_ids(p_user_ids uuid[])
returns table ("userId" uuid, "conversationId" text)
language sql stable security definer set search_path = ''
as $$
  select s.user_id, s.active_conversation_id
    from bob.user_state s
   where s.user_id = any(p_user_ids) and s.active_conversation_id is not null;
$$;

revoke all on function bob_private.active_conversation_ids(uuid[]) from public, anon, authenticated;
grant execute on function bob_private.active_conversation_ids(uuid[]) to bob_server;
