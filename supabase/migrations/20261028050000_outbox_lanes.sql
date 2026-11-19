-- Outbox lanes (S1 of #1322). The outbox gains LANES: several drain workers
-- over one table, each claiming only its own event types, so a slow handler
-- (routine runs, from S2 on) can never delay a short one (notifications). This
-- migration is purely additive — no policy, grant or column changes — and the
-- 4-argument claim stays byte-identical, so every caller keeps its behaviour.
--
-- It adds two things:
--  1. a 6-argument overload of bob_private.outbox_claim_batch that filters
--     by event_type (p_include / p_exclude), for the lanes. The body is the
--     original 4-argument body verbatim plus one predicate; the definer
--     discipline is the same: SECURITY DEFINER, search_path = '', EXECUTE for
--     bob_server alone.
--  2. a partial index the per-lane scans use: one event type over the
--     undelivered rows, then delivery order.

-- 1. The filtered claim overload. Same atomic lease set-and-return shape as
--    outbox_init.sql; the only body change is the two filter predicate lines.
create or replace function bob_private.outbox_claim_batch(
  p_owner text, p_limit int, p_lease_ms int, p_now timestamptz,
  p_include text[], p_exclude text[]
) returns table (
  id uuid, "spaceId" uuid, "eventType" text, "resourceType" text, "resourceId" uuid,
  revision int, "effectKey" text, payload jsonb,
  "availableAt" bigint, attempts int, "leaseOwner" text, "leaseExpiresAt" bigint,
  "deliveredAt" bigint, "lastErrorCode" text, "createdAt" bigint
)
language sql security definer set search_path = ''
as $$
  with updated as (
    update bob.outbox o
       set lease_owner = p_owner,
           lease_expires_at = p_now + (p_lease_ms * interval '1 millisecond')
     where o.id in (
       select o2.id
         from bob.outbox o2
        where o2.delivered_at is null
          and o2.available_at <= p_now
          and o2.lease_owner is null and o2.lease_expires_at is null
          and (p_include is null or o2.event_type = any(p_include))
          and (p_exclude is null or o2.event_type <> all(p_exclude))
        order by o2.available_at asc, o2.created_at asc
          for update skip locked
        limit p_limit
     )
     returning o.id, o.space_id, o.event_type, o.resource_type, o.resource_id,
               o.revision, o.effect_key, o.payload,
               floor(extract(epoch from o.available_at) * 1000)::bigint,
               o.attempts, o.lease_owner,
               floor(extract(epoch from o.lease_expires_at) * 1000)::bigint,
               floor(extract(epoch from o.delivered_at) * 1000)::bigint,
               o.last_error_code,
               floor(extract(epoch from o.created_at) * 1000)::bigint
  )
  select * from updated;
$$;

-- Function grant — the same revoke/grant as the original claim: EXECUTE for
-- bob_server only, revoked everywhere else.
revoke all on function bob_private.outbox_claim_batch(text, integer, integer, timestamptz, text[], text[]) from public, anon, authenticated;
grant execute on function bob_private.outbox_claim_batch(text, integer, integer, timestamptz, text[], text[]) to bob_server;

-- 2. The per-event-type partial index: a lane claim scans only its own event
--    types across the undelivered rows, then delivery order. `if not exists`
--    keeps the migration re-runnable, which tests exercise.
create index if not exists outbox_pending_event_idx
  on bob.outbox (event_type, available_at, created_at)
  where delivered_at is null;
