-- Bob timers and alarms (issue #320, server half). One row per timer or
-- alarm an account sets by voice; the server is the source of truth and the
-- scheduler (core/timer-scheduler.ts) fires each pending row exactly once.
-- Follows the init migration's assembly order: 1 table · 2 indexes · 3 enable/
-- force RLS · 4 policies · 5 service functions · 6 grants. No vector / pg_cron
-- / pgmq, so it applies under PGlite.
--
-- Accounts read and write only their own rows. The scheduler reads due rows
-- across accounts through the bob_private definers below (the
-- reminder_fanout_sources pattern), then marks each fired as its owner, so a
-- conditional pending -> fired update is the exactly-once guard.

-- 1. bob.timers
create table bob.timers (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  kind        text not null check (kind in ('timer', 'alarm')),
  label       text null check (label is null or char_length(label) between 1 and 60),
  fires_at    timestamptz not null,
  duration_ms integer null check (duration_ms is null or duration_ms > 0),
  status      text not null default 'pending'
              check (status in ('pending', 'fired', 'dismissed', 'cancelled')),
  created_at  timestamptz not null default now(),
  fired_at    timestamptz null,
  check (kind = 'alarm' or duration_ms is not null)
);

-- 2. Indexes -- the account's list/cancel path, and the scheduler's next-due
--    scan over pending rows only.
create index timers_user_status_fires_idx
  on bob.timers (user_id, status, fires_at);
create index timers_pending_fires_idx
  on bob.timers (fires_at)
  where status = 'pending';

-- 3. RLS
alter table bob.timers enable row level security;
alter table bob.timers force row level security;

-- 4. Policies -- own rows only.
create policy timers_select on bob.timers
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy timers_insert on bob.timers
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy timers_update on bob.timers
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- 5. Service functions for the scheduler (server path only).
-- 5.1 Pending rows due at or before p_now, oldest first, at most p_limit.
create or replace function bob_private.timers_due(p_now timestamptz, p_limit integer)
returns table (
  id uuid, "userId" uuid, kind text, label text, "firesAt" bigint,
  "durationMs" integer, status text, "createdAt" bigint, "firedAt" bigint
)
language sql security definer set search_path = ''
as $$
  select t.id, t.user_id, t.kind, t.label,
         floor(extract(epoch from t.fires_at) * 1000)::bigint,
         t.duration_ms, t.status,
         floor(extract(epoch from t.created_at) * 1000)::bigint,
         floor(extract(epoch from t.fired_at) * 1000)::bigint
    from bob.timers t
   where t.status = 'pending' and t.fires_at <= p_now
   order by t.fires_at, t.id
   limit greatest(1, least(p_limit, 1000));
$$;

-- 5.2 The earliest pending fires_at across accounts (null when none).
create or replace function bob_private.timers_next_fire_at()
returns bigint
language sql security definer set search_path = ''
as $$
  select floor(extract(epoch from min(t.fires_at)) * 1000)::bigint
    from bob.timers t
   where t.status = 'pending';
$$;

-- 6. Grants (init-migration §2.7 pattern) -- nothing for anon/public.
grant select, insert, update on bob.timers to authenticated;

revoke all on function bob_private.timers_due(timestamptz, integer) from public, anon, authenticated;
grant execute on function bob_private.timers_due(timestamptz, integer) to bob_server;
revoke all on function bob_private.timers_next_fire_at() from public, anon, authenticated;
grant execute on function bob_private.timers_next_fire_at() to bob_server;
