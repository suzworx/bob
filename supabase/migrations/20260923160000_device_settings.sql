-- Bob per-device settings (epic #311: #314 volume, #330 listening modes).
-- One row per paired device holding the last settings the device reported
-- (device_state) or the server pushed (device_control), so the web can show
-- them while the device is offline. The device's NVS stays authoritative: it
-- reports its state after every welcome and on each local change.
-- Follows the init migration's assembly order: 1 table · 2 indexes · 3 enable/
-- force RLS · 4 policies · 5 functions · 6 grants. No vector / pg_cron / pgmq,
-- so it applies under PGlite.
--
-- Access goes through the owning account: a caller reads and writes only the
-- rows of devices whose bob.devices.user_id is theirs (the devices SELECT
-- policy already scopes that subquery to the caller's own rows).

-- 1. bob.device_settings
create table bob.device_settings (
  device_id  uuid primary key references bob.devices (id) on delete cascade,
  volume     smallint not null check (volume between 0 and 10),
  muted      boolean not null default false,
  mode       text not null default 'ptt' check (mode in ('ptt', 'wake', 'announce_only')),
  dnd        boolean not null default false,
  updated_at timestamptz not null default now()
);

-- 2. Indexes -- the primary key is the only lookup path (by device id).

-- 3. RLS
alter table bob.device_settings enable row level security;
alter table bob.device_settings force row level security;

-- 4. Policies -- rows of the caller's own devices only.
create policy device_settings_select on bob.device_settings
  for select to authenticated
  using (exists (
    select 1 from bob.devices d
     where d.id = device_id and d.user_id = (select auth.uid())
  ));
create policy device_settings_insert on bob.device_settings
  for insert to authenticated
  with check (exists (
    select 1 from bob.devices d
     where d.id = device_id and d.user_id = (select auth.uid()) and d.revoked_at is null
  ));
create policy device_settings_update on bob.device_settings
  for update to authenticated
  using (exists (
    select 1 from bob.devices d
     where d.id = device_id and d.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from bob.devices d
     where d.id = device_id and d.user_id = (select auth.uid()) and d.revoked_at is null
  ));

-- 5. The caller's own account time zone (#316). Web turns read
--    user_metadata.time_zone from the verified JWT; a device turn has no JWT,
--    so this definer reads the same value for auth.uid() -- and only that
--    row, only that one key. NULL when unset.
create or replace function bob_private.account_time_zone()
returns text
language sql security definer set search_path = ''
stable
as $$
  select nullif(btrim(u.raw_user_meta_data ->> 'time_zone'), '')
    from auth.users u
   where u.id = (select auth.uid());
$$;

-- 6. Grants (init-migration §2.7 pattern) -- nothing for anon/public.
grant select, insert, update on bob.device_settings to authenticated;
revoke all on function bob_private.account_time_zone() from public, anon, authenticated;
grant execute on function bob_private.account_time_zone() to authenticated;
