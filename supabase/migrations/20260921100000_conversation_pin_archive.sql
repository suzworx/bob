-- Conversation pin and archive (CU-CHAT-1, G21). Additive and idempotent: two
-- nullable timestamps on an existing table. Its RLS policies and table-level
-- grants already cover new columns, so no policy or grant changes.
alter table bob.conversations add column if not exists pinned_at timestamptz null;
alter table bob.conversations add column if not exists archived_at timestamptz null;
