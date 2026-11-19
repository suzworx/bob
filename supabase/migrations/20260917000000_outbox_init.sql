-- Bob durable outbox (S14-OUTBOX, specs/014-family-collaboration/
-- data-model.md "outbox, jobs"). The event spine: a domain write and its
-- delivery record commit together, and a restarted worker reclaims leased work
-- without delivering anything twice. Follows the spaces-init assembly order:
-- 1 table · 2 index · 3 enable/force RLS · 4 policies (NONE — server-only)
-- · 5 grants. No vector / pg_cron / pgmq, so it applies under PGlite.
--
-- The table is server-only: FORCE RLS with zero policies locks out every
-- account role, and the drain worker (a separate unit) reaches it only through
-- the narrow bob_private functions defined below. This migration lays down
-- the raw storage, the claim/lease columns, and — below — the SECURITY DEFINER
-- access functions that are the only way in. payload carries IDs, types and
-- revisions ONLY — a table CHECK (via the bob_private helper below) rejects
-- any top-level key outside the allowlist, so no title/body/email/message text
-- can ever be stored. effect_key is unique, so one effect can never be
-- enqueued twice and a retried command is idempotent.
--
-- Why the table is server-only and why every access goes through SECURITY
-- DEFINER functions: bob_server is a nobypassrls role (20260911233109_
-- bob_init.sql §2.7), so with FORCE RLS and zero policies Postgres denies it
-- every row of this table outright — a direct store query would silently see
-- nothing. The store (apps/api/src/store/outbox.ts) therefore calls the
-- bob_private.outbox_* functions below, each of which runs as its definer
-- (the migration owner, who bypasses the lock) with search_path = '' and
-- EXECUTE granted to bob_server alone. This is the established server-only
-- pattern (memory_scan_helper.sql / memory-extract-queue.ts, option A).

-- 1. Table.
create table bob.outbox (
  id               uuid primary key default gen_random_uuid(),
  space_id         uuid null references bob.spaces (id) on delete cascade,
  event_type       text not null
                   check (char_length(event_type) between 1 and 64)
                   check (event_type ~ '^[a-z][a-z0-9]*(\.([a-z][a-z0-9]*))+$'),
  resource_type    text not null check (char_length(resource_type) between 1 and 32),
  resource_id      uuid not null,
  revision         integer not null default 1,
  effect_key       text not null unique,
  -- IDs, types and revisions ONLY; the allowlist check is below (bob_private
  -- helper so a table CHECK can scan jsonb keys without a subquery).
  payload          jsonb not null default '{}'::jsonb,
  available_at     timestamptz not null default now(),
  attempts         integer not null default 0,
  lease_owner      text null,
  lease_expires_at timestamptz null,
  delivered_at     timestamptz null,
  last_error_code  text null,
  created_at       timestamptz not null default now(),
  -- A lease is all-or-nothing: both set or both null.
  check ((lease_owner is null) = (lease_expires_at is null))
);

-- 1.1 The immutable helper behind the payload allowlist CHECK. Immutable so it
--     can run inside a constraint; fully qualified, so it cannot read other
--     rows. Every top-level payload key must be in the allowlist.
create or replace function bob_private.outbox_payload_keys_allowed(p_payload jsonb)
returns boolean
language plpgsql immutable set search_path = ''
as $$
begin
  if p_payload is null then return true; end if;
  return not exists (
    select 1
    from jsonb_each_text(p_payload) k
    where k.key not in (
      'space_id', 'resource_id', 'resource_type', 'revision',
      'actor_user_id', 'recipient_user_id', 'occurrence_key', 'event_type'
    )
  );
end;
$$;

alter table bob.outbox
  add constraint outbox_payload_keys_allowlist
  check (bob_private.outbox_payload_keys_allowed(payload));

-- 2. Index. The claim scan: undelivered rows in delivery order. Partial so the
--    claim query touches only work still to do.
create index outbox_pending_delivery_idx
  on bob.outbox (available_at, created_at)
  where delivered_at is null;

-- 3. RLS — forced, with NO policies: this queue is server-only.
alter table bob.outbox enable row level security;
alter table bob.outbox force row level security;

-- 4. Policies: none by design. Access is server-only via the narrow worker
--    functions in section 6 below; no account role may touch this table.

-- 5. Grants. The server role bob_server owns this table's access (it inherits
--    usage on schema bob via `authenticated to bob_server`). No
--    authenticated grant — accounts must never read or write the queue. The
--    payload-allowlist helper is called from a CHECK, which runs as the DML
--    executor (bob_server), so it is granted to that role.
revoke all on function bob_private.outbox_payload_keys_allowed(jsonb) from public, anon, authenticated;
grant execute on function bob_private.outbox_payload_keys_allowed(jsonb) to bob_server;
grant select, insert, update, delete on bob.outbox to bob_server;

-- 6. Server-only access functions (S14 correction, option A). Each is SECURITY
--    DEFINER with search_path = '' and runs as the migration owner, so the
--    forced-RLS lock is bypassed; EXECUTE is granted to bob_server only. The
--    returned row shape matches the store's OutboxRow exactly (timestamps as
--    epoch-ms bigints). Functions that take an optional p_now default to now()
--    so the store can pin the clock in deterministic tests.

create or replace function bob_private.outbox_enqueue(
  p_space_ids uuid[], p_event_types text[], p_resource_types text[],
  p_resource_ids uuid[], p_revisions int[], p_effect_keys text[], p_payloads jsonb[]
) returns table (
  id uuid, "spaceId" uuid, "eventType" text, "resourceType" text, "resourceId" uuid,
  revision int, "effectKey" text, payload jsonb,
  "availableAt" bigint, attempts int, "leaseOwner" text, "leaseExpiresAt" bigint,
  "deliveredAt" bigint, "lastErrorCode" text, "createdAt" bigint
)
language plpgsql security definer set search_path = ''
as $$
begin
  insert into bob.outbox
    (space_id, event_type, resource_type, resource_id, revision, effect_key, payload)
  select u.space_id, u.event_type, u.resource_type, u.resource_id, u.revision,
         u.effect_key, u.payload
    from unnest(p_space_ids, p_event_types, p_resource_types, p_resource_ids,
                p_revisions, p_effect_keys, p_payloads)
         as u(space_id, event_type, resource_type, resource_id, revision, effect_key, payload)
  on conflict (effect_key) do nothing;
  -- Re-select every requested key so a retried command yields exactly one row
  -- per effect_key, never zero (on conflict may have skipped the insert).
  return query
    select o.id, o.space_id, o.event_type, o.resource_type, o.resource_id, o.revision,
           o.effect_key, o.payload,
           floor(extract(epoch from o.available_at) * 1000)::bigint,
           o.attempts, o.lease_owner,
           floor(extract(epoch from o.lease_expires_at) * 1000)::bigint,
           floor(extract(epoch from o.delivered_at) * 1000)::bigint,
           o.last_error_code,
           floor(extract(epoch from o.created_at) * 1000)::bigint
      from bob.outbox o
     where o.effect_key = any(p_effect_keys);
end;
$$;

create or replace function bob_private.outbox_claim_batch(
  p_owner text, p_limit int, p_lease_ms int, p_now timestamptz
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

create or replace function bob_private.outbox_heartbeat(
  p_owner text, p_ids uuid[], p_lease_ms int, p_now timestamptz default null
) returns int
language sql security definer set search_path = ''
as $$
  with touched as (
    update bob.outbox
       set lease_expires_at = coalesce(p_now, now()) + (p_lease_ms * interval '1 millisecond')
     where id = any(p_ids)
       and lease_owner = p_owner
       and delivered_at is null
       and lease_expires_at > coalesce(p_now, now())
     returning id
  )
  select count(*)::int from touched;
$$;

create or replace function bob_private.outbox_ack(p_owner text, p_id uuid)
returns boolean
language sql security definer set search_path = ''
as $$
  with done as (
    update bob.outbox
       set delivered_at = now(), lease_owner = null, lease_expires_at = null
     where id = p_id and lease_owner = p_owner and delivered_at is null
     returning id
  )
  select exists (select 1 from done);
$$;

create or replace function bob_private.outbox_release(
  p_owner text, p_id uuid, p_retry_in_ms int, p_error_code text,
  p_now timestamptz default null
) returns table (
  id uuid, "spaceId" uuid, "eventType" text, "resourceType" text, "resourceId" uuid,
  revision int, "effectKey" text, payload jsonb,
  "availableAt" bigint, attempts int, "leaseOwner" text, "leaseExpiresAt" bigint,
  "deliveredAt" bigint, "lastErrorCode" text, "createdAt" bigint
)
language sql security definer set search_path = ''
as $$
  update bob.outbox o
     set attempts = o.attempts + 1, lease_owner = null, lease_expires_at = null,
         last_error_code = p_error_code,
         available_at = coalesce(p_now, now()) + (p_retry_in_ms * interval '1 millisecond')
   where o.id = p_id and o.lease_owner = p_owner and o.delivered_at is null
   returning o.id, o.space_id, o.event_type, o.resource_type, o.resource_id,
             o.revision, o.effect_key, o.payload,
             floor(extract(epoch from o.available_at) * 1000)::bigint,
             o.attempts, o.lease_owner,
             floor(extract(epoch from o.lease_expires_at) * 1000)::bigint,
             floor(extract(epoch from o.delivered_at) * 1000)::bigint,
             o.last_error_code,
             floor(extract(epoch from o.created_at) * 1000)::bigint;
$$;

create or replace function bob_private.outbox_reclaim_expired(p_now timestamptz)
returns int
language sql security definer set search_path = ''
as $$
  with released as (
    update bob.outbox
       set lease_owner = null, lease_expires_at = null
     where delivered_at is null
       and lease_owner is not null
       and lease_expires_at <= p_now
     returning id
  )
  select count(*)::int from released;
$$;

create or replace function bob_private.outbox_pending_count()
returns int
language sql security definer set search_path = ''
as $$
  select count(*)::int from bob.outbox where delivered_at is null;
$$;

-- 7. Function grants — EXECUTE to the server role only; every other role
--    (public, anon, authenticated) is revoked.
revoke all on function bob_private.outbox_enqueue(uuid[], text[], text[], uuid[], integer[], text[], jsonb[]) from public, anon, authenticated;
grant execute on function bob_private.outbox_enqueue(uuid[], text[], text[], uuid[], integer[], text[], jsonb[]) to bob_server;
revoke all on function bob_private.outbox_claim_batch(text, integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function bob_private.outbox_claim_batch(text, integer, integer, timestamptz) to bob_server;
revoke all on function bob_private.outbox_heartbeat(text, uuid[], integer, timestamptz) from public, anon, authenticated;
grant execute on function bob_private.outbox_heartbeat(text, uuid[], integer, timestamptz) to bob_server;
revoke all on function bob_private.outbox_ack(text, uuid) from public, anon, authenticated;
grant execute on function bob_private.outbox_ack(text, uuid) to bob_server;
revoke all on function bob_private.outbox_release(text, uuid, integer, text, timestamptz) from public, anon, authenticated;
grant execute on function bob_private.outbox_release(text, uuid, integer, text, timestamptz) to bob_server;
revoke all on function bob_private.outbox_reclaim_expired(timestamptz) from public, anon, authenticated;
grant execute on function bob_private.outbox_reclaim_expired(timestamptz) to bob_server;
revoke all on function bob_private.outbox_pending_count() from public, anon, authenticated;
grant execute on function bob_private.outbox_pending_count() to bob_server;