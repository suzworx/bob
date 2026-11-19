-- Which device spoke each turn (issue #668, "Recent" on a device's page).
-- Additive: one nullable column on bob.messages and bob.thread_messages
-- naming the Cardputer that spoke the turn. Web turns leave it null, and so do
-- the rows written before this migration (no backfill). Unpairing that deletes
-- a device clears the attribution, never the turn.
--
-- RLS is unchanged: each row's existing policies decide who sees the column.
-- bob.messages grants authenticated no table-wide update, so the server
-- stamps the id in the turn's own transaction through a column grant, the
-- memory_extracted_at pattern (20260915200000_memory_init.sql). The activity
-- read filters by the owner as well as the device, so an id pointing at
-- another account's device shows nothing to anyone.
-- No vector / pg_cron / pgmq, so it applies under PGlite.

-- 1. Columns.
alter table bob.messages
  add column if not exists device_id uuid null
    references bob.devices (id) on delete set null;

alter table bob.thread_messages
  add column if not exists device_id uuid null
    references bob.devices (id) on delete set null;

-- 2. Indexes -- the per-device activity read (newest first) and the FK's
--    on-delete-set-null lookup. Partial: web turns (null) are never read here.
create index if not exists messages_device_created_idx
  on bob.messages (device_id, created_at desc)
  where device_id is not null;
create index if not exists thread_messages_device_created_idx
  on bob.thread_messages (device_id, created_at desc)
  where device_id is not null;

-- 3. Grants -- the stamp on an already-inserted device turn.
grant update (device_id) on bob.messages to authenticated;
