-- Bob timer ring settings (#389).
-- ring_seconds: how long a timer or alarm rings before it counts as missed.
-- ring_sound: which built-in ring pattern the device plays.
-- ring_reported: the device has reported ring_seconds in device_state at least
-- once, so its firmware understands the ring keys in device_control. Older
-- firmware never reports them and is never sent them.
-- Additive only: constant defaults, so existing rows need no rewrite. The
-- table's RLS policies and table-level grants
-- (20260923160000_device_settings.sql) cover the new columns unchanged.

alter table bob.device_settings
  add column if not exists ring_seconds smallint not null default 30
    constraint device_settings_ring_seconds_check check (ring_seconds between 10 and 120);

alter table bob.device_settings
  add column if not exists ring_sound text not null default 'classic'
    constraint device_settings_ring_sound_check check (ring_sound in ('classic', 'chime', 'pulse'));

alter table bob.device_settings
  add column if not exists ring_reported boolean not null default false;
