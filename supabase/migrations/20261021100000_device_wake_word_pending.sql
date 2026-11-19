-- Bob device wake word: only a wake word the user picked on the web is ever
-- sent to a device (#1228). A computed default (board, host brand) is display
-- only, and a wake word the device reported is its own truth, so neither is
-- pushed back.
-- wake_word_pending: the stored wake_word is a web pick the device has not yet
-- confirmed in device_state. It is the only wake word device_control carries,
-- and it clears when the device reports it (or reports another one after its
-- one re-push, which then wins).
-- model: refreshed from the hello board, so a Waveshare paired by older
-- firmware as "M5Stack Cardputer" is listed as Bob.
-- Additive only: a constant default needs no rewrite. The devices RLS
-- policies cover the new column; the column-level update grants match the
-- other settings columns (20261020100000_device_wake_word.sql).

alter table bob.devices
  add column if not exists wake_word_pending boolean not null default false;

grant update (wake_word_pending, model) on bob.devices to authenticated;
