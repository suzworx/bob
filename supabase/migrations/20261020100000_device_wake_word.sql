-- Bob device wake word: "Hey Bob" or "Hey Bob", set from the web.
-- wake_word: the stored wake word; null until the device reports one or the
-- web picks one, while the API shows the brand default (Bob's Waveshare board
-- or a heybob.xyz host: 'bob', else 'bob').
-- wake_word_reported: the device has reported wake_word in device_state at
-- least once, so its firmware takes wake_word in device_control. Older
-- firmware never reports it and is never sent it.
-- Additive only: a nullable column and a constant default, so existing rows
-- need no rewrite. The devices RLS policies and table-level select grant cover
-- the new columns; the column-level update grant below matches the other
-- settings columns (20261003150000_device_settings_onto_devices.sql). Neither
-- column is personal data, so erase_account's settings reset leaves them (the
-- erased account's devices are revoked and never report again).

alter table bob.devices
  add column if not exists wake_word text null
    constraint devices_wake_word_check check (wake_word in ('bob', 'bob'));

alter table bob.devices
  add column if not exists wake_word_reported boolean not null default false;

grant update (wake_word, wake_word_reported) on bob.devices to authenticated;
