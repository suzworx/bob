-- Multiple trusted turn slots may point at one reconciled receipt. Retain the
-- opaque anchor after message deletion: deleting chat must not erase uncertainty.
create table bob.google_operation_slots (
  user_id uuid not null,
  google_account_id uuid not null,
  anchor_message_id text not null check (char_length(anchor_message_id) between 1 and 128),
  ordinal integer not null check (ordinal between 0 and 99),
  kind text not null check (kind in ('calendar_create','calendar_update','gmail_draft')),
  intent_hash text not null check (intent_hash ~ '^[a-f0-9]{64}$'),
  target_hash text not null check (target_hash ~ '^[a-f0-9]{64}$'),
  operation_id uuid not null,
  primary key(user_id,anchor_message_id,ordinal),
  unique(user_id,google_account_id,anchor_message_id,kind,intent_hash),
  foreign key(user_id,google_account_id,operation_id)
    references bob.google_operations(user_id,google_account_id,operation_id) on delete cascade
);
create index google_operation_slots_target on bob.google_operation_slots(user_id,google_account_id,kind,target_hash);
alter table bob.google_operation_slots enable row level security;
alter table bob.google_operation_slots force row level security;
create policy google_operation_slots_owner on bob.google_operation_slots
  for all to authenticated using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
revoke all on bob.google_operation_slots from public,anon,authenticated;
grant select,insert on bob.google_operation_slots to authenticated;

create function bob_private.guard_google_operation_slot() returns trigger
language plpgsql set search_path='' as $$
begin
  perform 1 from bob.google_accounts where user_id=NEW.user_id and id=NEW.google_account_id for update;
  if not exists (select 1 from bob.messages m join bob.conversations c on c.id=m.conversation_id
    join bob.spaces s on s.id=c.space_id where m.id=NEW.anchor_message_id
    and m.user_id=NEW.user_id and c.user_id=NEW.user_id and m.role='user'
    and c.archived_at is null and s.kind='private' and s.archived_at is null) then
    raise exception 'google_operation_anchor_unavailable';
  end if;
  if not exists (select 1 from bob.google_operations o where o.user_id=NEW.user_id
    and o.google_account_id=NEW.google_account_id and o.operation_id=NEW.operation_id
    and o.kind=NEW.kind and o.intent_hash=NEW.intent_hash) then
    raise exception 'google_operation_intent_mismatch';
  end if;
  if exists (select 1 from bob.google_operation_slots s join bob.google_operations o
    using(user_id,google_account_id,operation_id) where s.user_id=NEW.user_id
    and s.google_account_id=NEW.google_account_id and s.kind=NEW.kind and s.target_hash=NEW.target_hash
    and s.operation_id<>NEW.operation_id and o.state in ('pending','unknown')) then
    raise exception 'google_operation_needs_review';
  end if;
  return NEW;
end;
$$;
revoke all on function bob_private.guard_google_operation_slot() from public;
create trigger google_operation_slot_guard before insert on bob.google_operation_slots
  for each row execute function bob_private.guard_google_operation_slot();
