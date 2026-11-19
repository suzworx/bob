// What one inbox row says and where it opens, from the payload alone: the
// server's `about` names who, what and where (read under the viewer's own
// authorization); this module only words it. A row whose item is gone or
// hidden (`about` null) keeps a generic line and opens nothing, so a click
// never looks broken.

import { devicePath, spacePath } from '@/app/routes';
import type { InboxNotification, NotificationAbout } from './notifications-api';

export type NotificationRow = {
  label: string;
  /** The kind, then where and when, joined with " · ". */
  description: string;
  /** The exact place the item lives, or null when the row is plain text. */
  target: string | null;
};

const GENERIC: Record<InboxNotification['type'], string> = {
  mention: 'You were mentioned',
  assignment: 'A task was assigned to you',
  reminder: 'Reminder',
  event_change: 'An event changed',
  invitation: 'Your invitation was accepted',
  security: 'Security notice',
  task_update: 'A task you follow changed',
  bob_message: 'Bob left you a note',
};

const KIND: Record<InboxNotification['type'], string> = {
  mention: 'Mention',
  assignment: 'Assigned to you',
  reminder: 'Reminder',
  event_change: 'Event',
  invitation: 'Space',
  security: 'Security',
  task_update: 'Task you follow',
  bob_message: 'Note',
};

function join(...parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' · ');
}

function withQuery(path: string, key: string, id: string): string {
  return `${path}?${key}=${encodeURIComponent(id)}`;
}

/** The calendar day of an instant in a zone, as YYYY-MM-DD. */
function dayIn(ms: number, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(ms),
  );
}

function safeZone(zone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

/** "today 9:00 AM", "tomorrow 9:00 AM", "Oct 4, 9:00 AM"; a date alone is "Oct 22". */
export function whenLabel(about: Pick<NotificationAbout, 'at' | 'date'>, zone: string, now: number): string | null {
  const tz = safeZone(zone);
  if (about.at !== null) {
    const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(
      new Date(about.at),
    );
    const day = dayIn(about.at, tz);
    if (day === dayIn(now, tz)) return `today ${time}`;
    if (day === dayIn(now + 24 * 60 * 60 * 1000, tz)) return `tomorrow ${time}`;
    const date = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(
      new Date(about.at),
    );
    return `${date}, ${time}`;
  }
  if (about.date !== null) {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(
      new Date(`${about.date}T00:00:00Z`),
    );
  }
  return null;
}

const EVENT_VERB: Record<string, string> = {
  invited: 'invited you to',
  updated: 'changed',
  cancelled: 'cancelled',
  accepted: 'accepted',
  declined: 'declined',
  tentative: 'said maybe to',
};

function eventRow(n: InboxNotification, about: NotificationAbout, when: string | null): NotificationRow {
  const title = about.title ?? 'an event';
  const verb = EVENT_VERB[about.action ?? 'updated'] ?? 'changed';
  const actor = about.actor_name ?? 'Someone';
  const label = about.action === 'cancelled' && about.actor_name === null ? `${title} was cancelled` : `${actor} ${verb} ${title}`;
  return {
    label,
    description: join(KIND.event_change, when, about.space_name),
    target: n.space_id === null ? null : withQuery(spacePath(n.space_id, 'agenda'), 'event', n.resource_id),
  };
}

function securityRow(n: InboxNotification, about: NotificationAbout): NotificationRow {
  switch (about.action) {
    case 'google_linked':
      return { label: 'Google account connected', description: join(KIND.security, about.title), target: '/integrations' };
    case 'google_unlinked':
      return { label: 'Google account removed', description: KIND.security, target: '/integrations' };
    case 'device_paired':
      return {
        label: about.title ? `${about.title} was paired` : 'A device was paired',
        description: KIND.security,
        target: devicePath(n.resource_id),
      };
    case 'device_removed':
      return {
        label: about.title ? `${about.title} was removed` : 'A device was removed',
        description: KIND.security,
        target: '/devices',
      };
    default:
      return { label: GENERIC.security, description: KIND.security, target: null };
  }
}

function taskRow(n: InboxNotification, about: NotificationAbout, when: string | null): NotificationRow {
  return {
    label: about.title ?? GENERIC[n.type],
    description: join(KIND[n.type], about.space_name, when ? `due ${when}` : null),
    target: n.space_id === null ? null : withQuery(spacePath(n.space_id, 'tasks'), 'task', n.resource_id),
  };
}

function invitationRow(n: InboxNotification, about: NotificationAbout): NotificationRow {
  const actor = about.actor_name ?? 'Someone';
  const where = about.space_name ?? 'your space';
  return {
    label: n.resource_type === 'space_member' ? `${actor} joined ${where}` : `${actor} accepted your invite to ${where}`,
    description: KIND.invitation,
    target: n.space_id === null ? null : spacePath(n.space_id, 'members'),
  };
}

function mentionRow(n: InboxNotification, about: NotificationAbout): NotificationRow {
  return {
    label: `${about.actor_name ?? 'Someone'} mentioned you in ${about.title ?? 'a conversation'}`,
    description: join(about.space_name),
    target: n.space_id === null ? null : spacePath(n.space_id, 'threads', n.resource_id),
  };
}

function reminderRow(n: InboxNotification, about: NotificationAbout, when: string | null): NotificationRow {
  return {
    label: about.title ?? GENERIC.reminder,
    description: join(KIND.reminder, when, about.space_name),
    target: withQuery('/today', 'reminder', n.resource_id),
  };
}

function bobMessageRow(n: InboxNotification, about: NotificationAbout): NotificationRow {
  return {
    label: about.title ? `Bob left you a note: ${about.title}` : GENERIC.bob_message,
    description: join(KIND.bob_message, about.space_name),
    target: n.space_id === null ? null : withQuery(spacePath(n.space_id, 'notes'), 'note', n.resource_id),
  };
}

export function notificationRow(n: InboxNotification, zone: string, now: number): NotificationRow {
  const about = n.about ?? null;
  if (about === null) {
    const generic = n.type === 'invitation' && n.resource_type === 'space_member' ? 'A new member joined' : GENERIC[n.type];
    return { label: generic, description: KIND[n.type], target: null };
  }
  const when = whenLabel(about, zone, now);
  switch (n.type) {
    case 'mention':
      return mentionRow(n, about);
    case 'assignment':
    case 'task_update':
      return taskRow(n, about, when);
    case 'reminder':
      return reminderRow(n, about, when);
    case 'event_change':
      return eventRow(n, about, when);
    case 'invitation':
      return invitationRow(n, about);
    case 'security':
      return securityRow(n, about);
    case 'bob_message':
      return bobMessageRow(n, about);
  }
}
