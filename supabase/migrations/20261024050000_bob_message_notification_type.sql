-- Bob email notifications use a distinct inbox type and can be muted by
-- notification preferences like every other notification type.
alter table bob.notifications
  drop constraint if exists notifications_type_check;
alter table bob.notifications
  add constraint notifications_type_check
  check (type in ('mention', 'assignment', 'reminder', 'event_change',
                  'invitation', 'security', 'task_update', 'bob_message'));

alter table bob.notification_preferences
  drop constraint if exists notification_preferences_type_check;
alter table bob.notification_preferences
  add constraint notification_preferences_type_check
  check (type is null or type in ('mention', 'assignment', 'reminder',
                                  'event_change', 'invitation', 'security',
                                  'task_update', 'bob_message'));
