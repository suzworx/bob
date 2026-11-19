-- Email exactly-once marker moves onto bob.outbox (#757 merge 6, expand).
--
-- bob.email_effects is a one-row-per-key ledger whose effect_key is exactly
-- the effect_key of the email.notification outbox row. The handler writes the
-- marker BEFORE it acks, so outbox.delivered_at cannot be the marker: a row
-- reclaimed after its send is still undelivered. email_sent_at is the dedicated
-- column, recipient_user_id keeps account erasure and cascade working.
--
-- Additive only. The three bob_private functions keep their signatures,
-- return types, security definer search_path and grants, so apps/api calls them
-- unchanged. During the expand window email_effects is still read (a key marked
-- by an old server is never mailed twice) and still purged; it is neither
-- dropped nor altered here (a later contract unit retires it). Re-runnable.

-- 1. The marker columns and the erasure index.
alter table bob.outbox
  add column if not exists email_sent_at timestamptz null,
  add column if not exists recipient_user_id uuid null
    references auth.users (id) on delete cascade;

create index if not exists outbox_recipient_idx
  on bob.outbox (recipient_user_id) where recipient_user_id is not null;

comment on column bob.outbox.email_sent_at is
  'Email exactly-once marker: set when the email was handed to the provider, before the ack. Any outbox pruning must keep rows where it is set.';

-- 2. Backfill from the old ledger, only while that table exists.
do $$
begin
  if to_regclass('bob.email_effects') is not null then
    execute $q$
      update bob.outbox o
         set email_sent_at = e.sent_at,
             recipient_user_id = e.recipient_user_id
        from bob.email_effects e
       where e.effect_key = o.effect_key
         and o.email_sent_at is null
    $q$;
  end if;
end;
$$;

-- 3. True when the effect was already mailed (outbox marker, or the old ledger
--    while it exists).
create or replace function bob_private.email_effect_sent(p_effect_key text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_sent boolean;
begin
  select exists (select 1 from bob.outbox where effect_key = p_effect_key and email_sent_at is not null)
    into v_sent;
  if not v_sent and to_regclass('bob.email_effects') is not null then
    execute 'select exists (select 1 from bob.email_effects where effect_key = $1)'
      into v_sent using p_effect_key;
  end if;
  return v_sent;
end;
$$;

-- 4. Records a mailed effect; true when this call recorded it, false when it was
--    already recorded (idempotent).
create or replace function bob_private.email_effect_mark(
  p_effect_key text, p_recipient_user_id uuid
)
returns boolean
language sql security definer set search_path = ''
as $$
  with marked as (
    update bob.outbox
       set email_sent_at = now(), recipient_user_id = p_recipient_user_id
     where effect_key = p_effect_key and email_sent_at is null
     returning 1
  )
  select exists (select 1 from marked);
$$;

-- 5. Account erasure: the account's email outbox rows (and, while it exists,
--    the old ledger's rows). Returns the outbox rows deleted.
create or replace function bob_private.purge_account_email_effects(p_user_id uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_total integer;
begin
  delete from bob.outbox where recipient_user_id = p_user_id and event_type = 'email.notification';
  get diagnostics v_total = row_count;
  if to_regclass('bob.email_effects') is not null then
    execute 'delete from bob.email_effects where recipient_user_id = $1' using p_user_id;
  end if;
  return v_total;
end;
$$;

revoke all on function bob_private.email_effect_sent(text) from public, anon, authenticated;
grant execute on function bob_private.email_effect_sent(text) to bob_server;
revoke all on function bob_private.email_effect_mark(text, uuid) from public, anon, authenticated;
grant execute on function bob_private.email_effect_mark(text, uuid) to bob_server;
revoke all on function bob_private.purge_account_email_effects(uuid) from public, anon, authenticated;
grant execute on function bob_private.purge_account_email_effects(uuid) to bob_server;
