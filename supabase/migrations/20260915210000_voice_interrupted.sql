-- 013 hands-free web mode, R6: the interrupted flag on an assistant reply so
-- the heard portion can be recorded without mutating version history. UNMARKED
-- (no Postgres extension), so this applies on PGlite and Supabase alike and the
-- R6 PATCH is testable offline (plan Technical Context "Storage").
alter table bob.messages add column if not exists interrupted boolean not null default false;

-- authenticated has select/insert/delete on bob.messages but no update
-- (bob_init.sql §4); the R6 PATCH sets only this flag, through withUser as the
-- authenticated role. The truncation itself reuses the addReplyVersion pattern
-- (insert a new selected version + update (is_selected)), whose grants already
-- exist, so no new grant is needed on bob.message_versions.
grant update (interrupted) on bob.messages to authenticated;