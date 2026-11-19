-- A prepared device user message is visible to history but not extraction.
-- Crashed turns remain held until explicit recovery; no timeout grants reuse.
alter table bob.messages add column device_turn_pending boolean not null default false;
grant update (device_turn_pending) on bob.messages to authenticated;

create or replace function bob_private.accounts_with_unextracted(p_since timestamptz, p_limit int)
returns table (user_id uuid)
language sql stable security definer set search_path = '' as $$
  select distinct u.user_id
    from bob.messages u
    join bob.conversations c on c.id = u.conversation_id
    left join bob.spaces s on s.id = c.space_id
   where u.role = 'user' and u.memory_extracted_at is null
     and not u.device_turn_pending
     and u.created_at >= p_since and coalesce(s.kind, 'private') = 'private'
   order by u.user_id limit p_limit;
$$;
revoke all on function bob_private.accounts_with_unextracted(timestamptz, integer) from public, anon;
grant execute on function bob_private.accounts_with_unextracted(timestamptz, integer) to bob_server;
