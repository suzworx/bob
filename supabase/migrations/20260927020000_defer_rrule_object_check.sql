-- RRULE-CHECK-DEFER: keep the main2 -> main release rollback-safe.
--
-- 20260926100000_reminders_rrule_object converted the double-encoded reminder
-- rules to jsonb objects and added CHECK reminders_rrule_object (rrule is null
-- or an object). The server still on main binds JSON.stringify(rrule) to a bare
-- $n::jsonb, which stores a jsonb STRING: under that CHECK it cannot create or
-- update a recurring reminder, during the Railway switchover or for the whole
-- of a rollback.
--
-- This drops the CHECK only. The row conversion stays; the new server writes
-- objects and normalizeRrule still reads strings, so old and new servers both
-- work. The CHECK comes back in a later release, once the old server can no
-- longer return (docs/deploy.md#deferred-constraints). Idempotent.

alter table bob.reminders
  drop constraint if exists reminders_rrule_object;
