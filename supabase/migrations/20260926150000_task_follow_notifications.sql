-- Task followers are told when a task they follow changes (#511).
--
-- A new notification type, 'task_update', joins the fixed list on both
-- bob.notifications.type and bob.notification_preferences.type, so an
-- inbox row can carry it and a member can mute it like any other type (#127).
-- The rows still carry ids, a type and a revision only.
--
-- Additive: each CHECK is replaced by a strictly wider one. Every existing row
-- satisfies the new list, and nothing that was accepted before is refused.

alter table bob.notifications
  drop constraint if exists notifications_type_check;
alter table bob.notifications
  add constraint notifications_type_check
  check (type in ('mention', 'assignment', 'reminder', 'event_change',
                  'invitation', 'security', 'task_update'));

alter table bob.notification_preferences
  drop constraint if exists notification_preferences_type_check;
alter table bob.notification_preferences
  add constraint notification_preferences_type_check
  check (type is null or type in ('mention', 'assignment', 'reminder',
                                  'event_change', 'invitation', 'security',
                                  'task_update'));
