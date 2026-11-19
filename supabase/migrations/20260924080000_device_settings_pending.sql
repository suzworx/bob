-- Bob device settings sync (#327).
-- pending_push marks a web change the device has not applied yet: every web
-- write sets it (sent is not applied), and only a device_state that reports
-- exactly the stored values clears it. On reconnect the server pushes the
-- stored values as device_control once more; a differing report after that is
-- accepted (the device wins), so a clamped value can never stay pending.
-- device_reported: the device has sent device_state at least once, so its
-- firmware understands device_control. Rows written before this migration all
-- came from device_state (the web could not write yet), so they backfill true;
-- new rows default to false.
-- Additive only. The table's RLS policies and table-level grants
-- (20260923160000_device_settings.sql) cover the new columns unchanged.

alter table bob.device_settings
  add column if not exists pending_push boolean not null default false;

alter table bob.device_settings
  add column if not exists device_reported boolean not null default true;
alter table bob.device_settings
  alter column device_reported set default false;
