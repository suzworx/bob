-- RRULE-JSONB: reminder rules were stored double-encoded.
--
-- store/reminders.ts bound JSON.stringify(rrule) to a bare `$n::jsonb`
-- parameter; the driver typed it jsonb and JSON-encoded the serialized text a
-- second time, so every bob.reminders.rrule became a jsonb STRING scalar
-- ('"{\"freq\":\"daily\"}"') instead of an object. SQL such as rrule->>'freq',
-- other readers and jsonb indexing all saw a string. The store now binds the
-- text and casts ::text::jsonb. This migration:
--   1. converts the existing string rows in place (`#>> '{}'` unwraps the
--      scalar to its text, which is then parsed as the object it encodes);
--   2. adds a CHECK so only an object (or null, a one-shot) can be stored.
-- Idempotent: the update touches only string rows, and the constraint is
-- dropped before it is re-added.

update bob.reminders
   set rrule = (rrule #>> '{}')::jsonb
 where jsonb_typeof(rrule) = 'string';

alter table bob.reminders
  drop constraint if exists reminders_rrule_object;

alter table bob.reminders
  add constraint reminders_rrule_object
  check (rrule is null or jsonb_typeof(rrule) = 'object');
