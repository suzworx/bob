-- A device repeats its last OTA result in every hello until its next attempt. The
-- repeat was dropped only when it was the very latest event, so an offer
-- recorded in between made each reconnect count as a fresh failure and tripped
-- the two-failure backoff. A result is now a repeat unless an attempt (start)
-- came after the latest result of the same shape.
create or replace function bob_private.fw_record_event(
  p_device uuid, p_board text, p_kind text, p_from text, p_to text, p_reason text
) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_kind is not null and exists (
    select 1 from (
      select e.kind, e.from_version, e.to_version from bob.firmware_events e
       where e.device_id = p_device and (p_kind in ('ok', 'rolled_back', 'failed') and e.kind <> 'offer' or p_kind not in ('ok', 'rolled_back', 'failed'))
       order by e.id desc limit 1
    ) last
     where last.kind = p_kind and last.from_version is not distinct from p_from
       and last.to_version is not distinct from p_to
  ) then
    return false;
  end if;
  update bob.devices d set
      fw_board = coalesce(p_board, d.fw_board),
      fw_last_result = case when p_kind in ('ok', 'rolled_back', 'failed') then p_kind else d.fw_last_result end,
      fw_last_result_at = case when p_kind in ('ok', 'rolled_back', 'failed') then now() else d.fw_last_result_at end,
      fw_last_offer_version = case when p_kind = 'offer' then p_to else d.fw_last_offer_version end,
      fw_attempts = case p_kind when 'start' then d.fw_attempts + 1 when 'ok' then 0 else d.fw_attempts end
    where d.id = p_device;
  if p_kind is null then
    return false;
  end if;
  insert into bob.firmware_events (device_id, kind, from_version, to_version, reason_code)
  values (p_device, p_kind, p_from, p_to, p_reason);
  return true;
end;
$$;
