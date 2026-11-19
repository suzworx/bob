-- Bob OTA-4A: the server side of firmware updates (epic #343,
-- docs/cardputer/ota-decision.md). Signed releases, their images, the
-- channel -> version map, the per-device OTA state and an event log. Data layer
-- only: the firmware module (apps/api/src/modules/firmware) reads and writes it
-- through the bob_private definers below; routes come later.
--
-- Privacy: versions, boards, reason codes and timestamps only. No account id, no
-- email, no free text from a device. The per-device state is denormalised onto
-- bob.devices (columns, no new table); account erasure keeps the device rows,
-- and these columns carry nothing personal, so erase_account is untouched.
--
-- Server-only tables, following the user_scopes order: 1 table, 2 indexes,
-- 3 enable and force RLS, 4 policies (NONE), 5 grants (NONE on the tables). The
-- only way in is the definers, granted to bob_server alone. Idempotent.

-- 1. Tables.
create table if not exists bob.firmware_releases (
  version             text primary key,
  boards              text[] not null,
  size                int not null check (size > 0),
  sha256              text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  signature           text not null,          -- base64 DER ECDSA over manifest
  manifest            text not null,          -- the exact signed bytes
  key_id              text not null,
  min_from            text not null default '0.0.0',
  mandatory           boolean not null default false,
  security_fix        boolean not null default false,
  rollback_safe       boolean not null default true,
  requires_bootloader text null,
  settings_schema     int not null default 1,
  git_sha             text null,
  notes               text null,
  hil_attested_at     timestamptz null,
  created_at          timestamptz not null default now()
);

-- Separate from firmware_releases because each row is ~1.6 MB and images are
-- pruned on their own schedule, long after the release row is history.
create table if not exists bob.firmware_images (
  sha256 text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes  bytea not null
);

create table if not exists bob.firmware_channels (
  channel        text not null check (channel in ('dev', 'beta', 'stable')),
  board          text not null,
  version        text not null references bob.firmware_releases (version),
  rollout_pct    int not null default 100 check (rollout_pct between 0 and 100),
  halted         boolean not null default false,
  min_fw_version text null,
  updated_at     timestamptz not null default now(),
  primary key (channel, board)
);

-- Denormalised per-device OTA state: one row per device already exists.
alter table bob.devices add column if not exists fw_channel text not null default 'stable'
  constraint devices_fw_channel_check check (fw_channel in ('dev', 'beta', 'stable'));
alter table bob.devices add column if not exists fw_pin_version text null;
alter table bob.devices add column if not exists fw_board text null;
alter table bob.devices add column if not exists fw_last_result text null;
alter table bob.devices add column if not exists fw_last_result_at timestamptz null;
alter table bob.devices add column if not exists fw_last_offer_version text null;
alter table bob.devices add column if not exists fw_attempts int not null default 0;

-- A real one-to-many: many events per device, counted in windows for auto-halt.
create table if not exists bob.firmware_events (
  id           bigint generated always as identity primary key,
  device_id    uuid not null references bob.devices (id) on delete cascade,
  kind         text not null check (kind in ('offer', 'start', 'ok', 'rolled_back', 'failed')),
  from_version text null,
  to_version   text null,
  reason_code  text null,
  at           timestamptz not null default now()
);

-- 2. Indexes.
create index if not exists firmware_events_to_version_at_idx
  on bob.firmware_events (to_version, at);
create index if not exists firmware_events_device_idx
  on bob.firmware_events (device_id, id desc);

-- 3. RLS, forced, with no policies: these tables are server-only.
alter table bob.firmware_releases enable row level security;
alter table bob.firmware_releases force row level security;
alter table bob.firmware_images enable row level security;
alter table bob.firmware_images force row level security;
alter table bob.firmware_channels enable row level security;
alter table bob.firmware_channels force row level security;
alter table bob.firmware_events enable row level security;
alter table bob.firmware_events force row level security;

-- 4. Policies: none by design.

-- 5. Grants: none. Access is through the definers below only. The devices
--    columns get no grant either: the owner's update grant stays name-only.
revoke all on bob.firmware_releases from public, anon, authenticated;
revoke all on bob.firmware_images from public, anon, authenticated;
revoke all on bob.firmware_channels from public, anon, authenticated;
revoke all on bob.firmware_events from public, anon, authenticated;

-- 6. Definers.
create or replace function bob_private.fw_put_release(
  p_version text, p_boards text[], p_size int, p_sha text, p_sig text, p_manifest text,
  p_key_id text, p_min_from text, p_mandatory boolean, p_security_fix boolean,
  p_rollback_safe boolean, p_requires_bootloader text, p_settings_schema int,
  p_git_sha text, p_notes text, p_image bytea
) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  n integer;
begin
  insert into bob.firmware_images (sha256, bytes) values (p_sha, p_image)
    on conflict (sha256) do nothing;
  insert into bob.firmware_releases (
    version, boards, size, sha256, signature, manifest, key_id, min_from, mandatory,
    security_fix, rollback_safe, requires_bootloader, settings_schema, git_sha, notes
  ) values (
    p_version, p_boards, p_size, p_sha, p_sig, p_manifest, p_key_id, p_min_from, p_mandatory,
    p_security_fix, p_rollback_safe, p_requires_bootloader, p_settings_schema, p_git_sha, p_notes
  ) on conflict (version) do nothing;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

create or replace function bob_private.fw_get_release(p_version text)
returns setof bob.firmware_releases
language sql stable security definer set search_path = ''
as $$
  select * from bob.firmware_releases where version = p_version;
$$;

create or replace function bob_private.fw_get_channel(p_channel text, p_board text)
returns setof bob.firmware_channels
language sql stable security definer set search_path = ''
as $$
  select * from bob.firmware_channels where channel = p_channel and board = p_board;
$$;

-- A new version un-halts the channel: the halt was a verdict on the old one.
create or replace function bob_private.fw_set_channel(
  p_channel text, p_board text, p_version text, p_rollout int
) returns void
language sql security definer set search_path = ''
as $$
  insert into bob.firmware_channels (channel, board, version, rollout_pct)
  values (p_channel, p_board, p_version, p_rollout)
  on conflict (channel, board) do update
    set version = excluded.version, rollout_pct = excluded.rollout_pct, updated_at = now(),
        halted = case when bob.firmware_channels.version = excluded.version
                      then bob.firmware_channels.halted else false end;
$$;

create or replace function bob_private.fw_set_halted(p_channel text, p_board text, p_halted boolean)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  n integer;
begin
  update bob.firmware_channels set halted = p_halted, updated_at = now()
   where channel = p_channel and board = p_board and halted is distinct from p_halted;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

create or replace function bob_private.fw_get_image(p_version text, p_board text)
returns table (bytes bytea, sha256 text)
language sql stable security definer set search_path = ''
as $$
  select i.bytes, i.sha256
    from bob.firmware_releases r
    join bob.firmware_images i on i.sha256 = r.sha256
   where r.version = p_version and p_board = any (r.boards);
$$;

create or replace function bob_private.fw_device(p_device uuid)
returns table (channel text, pin_version text, board text, attempts int)
language sql stable security definer set search_path = ''
as $$
  select d.fw_channel, d.fw_pin_version, d.fw_board, d.fw_attempts
    from bob.devices d where d.id = p_device and d.revoked_at is null;
$$;

-- One event and its denormalised device columns. A null kind only records the
-- board. A repeat of the device's latest event (same kind and versions) is
-- dropped, because a device repeats its last result until the next attempt.
create or replace function bob_private.fw_record_event(
  p_device uuid, p_board text, p_kind text, p_from text, p_to text, p_reason text
) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_kind is not null and exists (
    select 1 from (
      select e.kind, e.from_version, e.to_version from bob.firmware_events e
       where e.device_id = p_device order by e.id desc limit 1
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

create or replace function bob_private.fw_recent_failures(p_device uuid, p_to text)
returns int
language sql stable security definer set search_path = ''
as $$
  select count(*)::int from bob.firmware_events e
   where e.device_id = p_device and e.to_version = p_to
     and e.kind in ('failed', 'rolled_back') and e.at > now() - interval '24 hours';
$$;

-- Outcomes of the channel's current version over the last 7 days, and how many
-- live devices sit on that channel and board.
create or replace function bob_private.fw_halt_counts(p_channel text, p_board text)
returns table (attempts int, rollbacks int, fleet_size int)
language sql stable security definer set search_path = ''
as $$
  select
    (select count(*)::int from bob.firmware_events e
       join bob.devices d on d.id = e.device_id
      where e.to_version = c.version and d.fw_board = p_board
        and e.kind in ('ok', 'rolled_back', 'failed') and e.at > now() - interval '7 days'),
    (select count(*)::int from bob.firmware_events e
       join bob.devices d on d.id = e.device_id
      where e.to_version = c.version and d.fw_board = p_board
        and e.kind = 'rolled_back' and e.at > now() - interval '7 days'),
    (select count(*)::int from bob.devices d
      where d.fw_board = p_board and d.fw_channel = p_channel and d.revoked_at is null)
  from bob.firmware_channels c where c.channel = p_channel and c.board = p_board;
$$;

-- 7. Function grants: EXECUTE to the server role only.
revoke all on function bob_private.fw_put_release(text, text[], int, text, text, text, text, text,
  boolean, boolean, boolean, text, int, text, text, bytea) from public, anon, authenticated;
grant execute on function bob_private.fw_put_release(text, text[], int, text, text, text, text, text,
  boolean, boolean, boolean, text, int, text, text, bytea) to bob_server;
revoke all on function bob_private.fw_get_release(text) from public, anon, authenticated;
grant execute on function bob_private.fw_get_release(text) to bob_server;
revoke all on function bob_private.fw_get_channel(text, text) from public, anon, authenticated;
grant execute on function bob_private.fw_get_channel(text, text) to bob_server;
revoke all on function bob_private.fw_set_channel(text, text, text, int) from public, anon, authenticated;
grant execute on function bob_private.fw_set_channel(text, text, text, int) to bob_server;
revoke all on function bob_private.fw_set_halted(text, text, boolean) from public, anon, authenticated;
grant execute on function bob_private.fw_set_halted(text, text, boolean) to bob_server;
revoke all on function bob_private.fw_get_image(text, text) from public, anon, authenticated;
grant execute on function bob_private.fw_get_image(text, text) to bob_server;
revoke all on function bob_private.fw_device(uuid) from public, anon, authenticated;
grant execute on function bob_private.fw_device(uuid) to bob_server;
revoke all on function bob_private.fw_record_event(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function bob_private.fw_record_event(uuid, text, text, text, text, text) to bob_server;
revoke all on function bob_private.fw_recent_failures(uuid, text) from public, anon, authenticated;
grant execute on function bob_private.fw_recent_failures(uuid, text) to bob_server;
revoke all on function bob_private.fw_halt_counts(text, text) from public, anon, authenticated;
grant execute on function bob_private.fw_halt_counts(text, text) to bob_server;
