-- A device turn's anchor write in one round trip (perf/server-latency).
-- preparePrivateDeviceTurn ran ~20 sequential statements (advisory lock,
-- anchor and scope reads, conversation create, append, pointer upsert), each a
-- cross-region round trip before generation could start. This function runs
-- the same steps, in the same order, in one call.
--
-- SECURITY INVOKER: it runs as the caller (authenticated, under withUser), so
-- every RLS policy, column grant and trigger applies exactly as it did to the
-- statements it replaces. Additive only: one new function, nothing existing
-- changes.
--
-- Outcomes (the caller maps each to its old behaviour):
--   existing        the anchor was already written (a retry): nothing changes
--   anchor_invalid  the id names a message that is not a private device user turn
--   not_private     the pinned conversation is unknown, hidden, shared or archived
--   scope_invalid   a just-created conversation is not private
--   not_found       the conversation vanished before the append's row lock
--   prepared        the anchor is written and the pointer moved
create or replace function bob.prepare_device_turn(
  p_user_id uuid,
  p_user_message_id text,
  p_pinned_id text,            -- the pinned conversation id; null: create one
  p_title text,                -- a created conversation's title
  p_parts jsonb,               -- the user message's parts
  p_device_id text,            -- stamps the message (unknown or foreign: null)
  p_pointer_device_id uuid,    -- moves this device's own pointer; null: follow-me reset
  p_now_ms bigint
) returns table (
  outcome text, "conversationId" text, "spaceId" uuid, "spaceName" text, title text, created boolean
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now constant timestamptz := to_timestamp(p_now_ms / 1000.0);
  v_conv text;
  v_role text;
  v_origin text;
  v_found boolean;
  v_private boolean;
  v_space uuid;
  v_space_name text;
  v_title text;
  v_lock_space uuid;
  v_created boolean := false;
  v_position integer;
  v_own_space uuid;
begin
  -- Defence in depth: RLS already rejects a mismatch, but never act for another account.
  if p_user_id is distinct from auth.uid() then
    raise exception 'prepare_device_turn: caller is not p_user_id' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('device-turn:' || p_user_message_id));

  -- A retry finds its anchor already written.
  select m.conversation_id, m.role, m.origin into v_conv, v_role, v_origin
    from bob.messages m where m.id = p_user_message_id;
  if found then
    select true, c.space_id, s.name, c.title,
           (c.space_id is null or s.kind = 'private') and s.archived_at is null and c.archived_at is null
      into v_found, v_space, v_space_name, v_title, v_private
      from bob.conversations c left join bob.spaces s on s.id = c.space_id
     where c.id = v_conv;
    if v_role <> 'user' or v_origin <> 'device' or v_found is not true or v_private is not true then
      return query select 'anchor_invalid', null::text, null::uuid, null::text, null::text, false;
      return;
    end if;
    return query select 'existing', v_conv, v_space, v_space_name, v_title, false;
    return;
  end if;

  if p_pinned_id is not null then
    v_conv := p_pinned_id;
  else
    -- The owner's private space, provisioned on first use (ensurePrivateSpace).
    select s.id into v_own_space from bob.spaces s where s.kind = 'private' and s.owner_user_id = p_user_id;
    if v_own_space is null then
      insert into bob.spaces (kind, name, owner_user_id) values ('private', 'Private', p_user_id)
        on conflict (owner_user_id) where kind = 'private' do nothing
        returning id into v_own_space;
      if v_own_space is not null then
        insert into bob.space_memberships (space_id, user_id, role) values (v_own_space, p_user_id, 'owner');
      end if;
    end if;
    v_conv := 'cnv_' || gen_random_uuid()::text;
    insert into bob.conversations (id, user_id, space_id, created_by, title, created_at, updated_at)
      values (v_conv, p_user_id,
              (select s.id from bob.spaces s where s.kind = 'private' and s.owner_user_id = p_user_id),
              p_user_id, p_title, v_now, v_now);
    v_created := true;
  end if;

  -- The conversation's scope (getConversationScope); RLS hides another account's.
  v_found := false;
  select true, c.space_id, s.name, c.title,
         (c.space_id is null or s.kind = 'private') and s.archived_at is null and c.archived_at is null
    into v_found, v_space, v_space_name, v_title, v_private
    from bob.conversations c left join bob.spaces s on s.id = c.space_id
   where c.id = v_conv;
  if v_found is not true or v_private is not true then
    return query select case when v_created then 'scope_invalid' else 'not_private' end,
      null::text, null::uuid, null::text, null::text, false;
    return;
  end if;

  -- The append (appendMessage): the row lock serialises positions; a straggler
  -- row with no space joins the owner's private space first.
  select c.space_id into v_lock_space
    from bob.conversations c
   where c.id = v_conv
     and (c.space_id is null or c.space_id in (select s.id from bob.spaces s where s.kind = 'private'))
     for update;
  if not found then
    return query select 'not_found', null::text, null::uuid, null::text, null::text, false;
    return;
  end if;
  if v_lock_space is null then
    update bob.conversations c
       set space_id = (select s.id from bob.spaces s where s.kind = 'private' and s.owner_user_id = p_user_id)
     where c.id = v_conv
     returning c.space_id into v_lock_space;
  end if;
  select coalesce(max(m.position) + 1, 0) into v_position from bob.messages m where m.conversation_id = v_conv;
  update bob.conversations c set updated_at = v_now, last_sequence = v_position + 1 where c.id = v_conv;
  insert into bob.messages
      (id, conversation_id, space_id, user_id, author_user_id, role, position, sequence, origin, created_at,
       device_turn_pending, device_id)
    values (p_user_message_id, v_conv, v_lock_space, p_user_id, p_user_id, 'user', v_position, v_position + 1,
            'device', v_now, true, (select d.id from bob.devices d where d.id::text = p_device_id));
  insert into bob.message_versions (message_id, user_id, space_id, parts, version_index, is_selected, created_at)
    values (p_user_message_id, p_user_id, v_lock_space, p_parts, 0, true, v_now);

  -- The pointer (setActive, surface 'device'): the account's, plus the
  -- device's own, or a follow-me reset of every device pointer.
  insert into bob.user_state (user_id, active_conversation_id, conversation_changed_at, conversation_surface)
    values (p_user_id, v_conv, v_now, 'device')
    on conflict (user_id) do update
      set active_conversation_id  = excluded.active_conversation_id,
          conversation_changed_at = excluded.conversation_changed_at,
          conversation_surface    = excluded.conversation_surface;
  if p_pointer_device_id is not null then
    update bob.devices d
       set active_conversation_id = v_conv, conversation_surface = 'device', conversation_changed_at = v_now
     where d.id = p_pointer_device_id and d.user_id = p_user_id;
  else
    update bob.devices d
       set active_conversation_id = null, conversation_surface = null, conversation_changed_at = null,
           active_space_id = null, space_surface = null, space_changed_at = null
     where d.user_id = p_user_id;
  end if;

  return query select 'prepared', v_conv, v_space, v_space_name, v_title, v_created;
end;
$$;

revoke all on function bob.prepare_device_turn(uuid, text, text, text, jsonb, text, uuid, bigint) from public, anon;
grant execute on function bob.prepare_device_turn(uuid, text, text, text, jsonb, text, uuid, bigint) to authenticated;
