-- Exactly-once email effects and the outbox health counts (#506).
--
-- 1. bob.email_effects: one row per email.notification outbox effect_key
--    that was handed to the mail provider. The handler skips a key that is
--    already here, so a row reclaimed after its send (the worker died before
--    the ack) acks without mailing twice. It stores the key, the recipient
--    (so account deletion cascades) and a timestamp only -- never an address,
--    a template or any content. FORCE RLS with no policies and no table
--    grants: only the server-role definers below read or write it.
-- 2. bob_private.outbox_health: the counts the runner journals as
--    v2.outbox_health (in flight, parked, oldest due lag). Counts only.
--
-- Additive: a new table, its index and new functions with their grants.

create table bob.email_effects (
  effect_key        text primary key check (char_length(effect_key) between 1 and 512),
  recipient_user_id uuid not null references auth.users (id) on delete cascade,
  sent_at           timestamptz not null default now()
);

create index email_effects_recipient_idx on bob.email_effects (recipient_user_id);

alter table bob.email_effects enable row level security;
alter table bob.email_effects force row level security;
revoke all on table bob.email_effects from public, anon, authenticated;

-- True when the effect was already mailed.
create or replace function bob_private.email_effect_sent(p_effect_key text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from bob.email_effects where effect_key = p_effect_key);
$$;

-- Records a mailed effect; true when this call recorded it, false when it was
-- already recorded (idempotent).
create or replace function bob_private.email_effect_mark(
  p_effect_key text, p_recipient_user_id uuid
)
returns boolean
language sql security definer set search_path = ''
as $$
  with inserted as (
    insert into bob.email_effects (effect_key, recipient_user_id)
    values (p_effect_key, p_recipient_user_id)
    on conflict (effect_key) do nothing
    returning 1
  )
  select exists (select 1 from inserted);
$$;

-- Counts for the runner's health line, across every worker process:
-- in_flight = undelivered rows under a live lease; parked = undelivered rows
-- that reached p_max_attempts; oldest_due_lag_ms = how long the oldest due,
-- unleased (or lease-expired), undelivered row has waited (0 when none).
create or replace function bob_private.outbox_health(p_now timestamptz, p_max_attempts int)
returns table (in_flight int, parked int, oldest_due_lag_ms bigint)
language sql stable security definer set search_path = ''
as $$
  select
    (count(*) filter (where lease_owner is not null and lease_expires_at > p_now))::int,
    (count(*) filter (where attempts >= p_max_attempts))::int,
    coalesce(greatest(0, floor(extract(epoch from (p_now - min(available_at) filter (
      where available_at <= p_now and attempts < p_max_attempts
        and (lease_owner is null or lease_expires_at <= p_now)))) * 1000))::bigint, 0)
  from bob.outbox
  where delivered_at is null;
$$;

revoke all on function bob_private.email_effect_sent(text) from public, anon, authenticated;
grant execute on function bob_private.email_effect_sent(text) to bob_server;
revoke all on function bob_private.email_effect_mark(text, uuid) from public, anon, authenticated;
grant execute on function bob_private.email_effect_mark(text, uuid) to bob_server;
revoke all on function bob_private.outbox_health(timestamptz, int) from public, anon, authenticated;
grant execute on function bob_private.outbox_health(timestamptz, int) to bob_server;
