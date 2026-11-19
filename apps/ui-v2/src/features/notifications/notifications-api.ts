// Typed client for the durable notifications inbox and per-type preferences
// (/api/notifications, /api/notifications/read, /api/notification-preferences).
// Inbox items carry ids, types, revisions, a created time and `about`: who did
// it, to what, where and when, read by the server under the caller's own
// authorization on every list (null when the item is gone or hidden). Never a
// message body. Every call goes through fetchWithAuth, so a 401 refreshes the
// session once, as elsewhere.

import { fetchWithAuth } from '@/lib/auth/use-session';

const NOTIFICATION_TYPES = [
  'mention',
  'assignment',
  'reminder',
  'event_change',
  'invitation',
  'security',
  'task_update',
  'bob_message',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

type NotificationAction =
  | 'invited'
  | 'updated'
  | 'cancelled'
  | 'accepted'
  | 'declined'
  | 'tentative'
  | 'google_linked'
  | 'google_unlinked'
  | 'device_paired'
  | 'device_removed';

export type NotificationAbout = {
  actor_name: string | null;
  title: string | null;
  /** Null for a private space. */
  space_name: string | null;
  /** The instant the item is about (epoch ms): a reminder's ring, an event's start, a due time. */
  at: number | null;
  /** An all-day date (YYYY-MM-DD) when there is no instant. */
  date: string | null;
  action: NotificationAction | null;
};

export type InboxNotification = {
  id: string;
  space_id: string | null;
  type: NotificationType;
  resource_type: string;
  resource_id: string;
  revision: number;
  cursor: number;
  read_at: number | null;
  created_at: number;
  /** Absent from an older server; null when the item is gone or hidden. */
  about?: NotificationAbout | null;
};

type InboxPage = {
  notifications: InboxNotification[];
  nextCursor: number | null;
  unreadCount: number;
};

export type NotificationPreference = {
  id: string;
  user_id: string;
  space_id: string | null;
  thread_id: string | null;
  type: NotificationType | null;
  muted: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  quiet_zone: string | null;
};

type MarkReadTarget = { ids: string[] } | { upToCursor: number };

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function listNotifications(options?: {
  limit?: number;
  after?: number;
  unreadOnly?: boolean;
}): Promise<InboxPage> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  if (options?.after !== undefined) params.set('after', String(options.after));
  if (options?.unreadOnly) params.set('unread', 'true');
  const query = params.toString();
  const response = await fetchWithAuth(query ? `/api/notifications?${query}` : '/api/notifications');
  if (!response.ok) throw new Error('notifications_failed');
  const body = (await response.json()) as {
    notifications: InboxNotification[];
    next_cursor: number | null;
    unread_count: number;
  };
  return { notifications: body.notifications, nextCursor: body.next_cursor, unreadCount: body.unread_count };
}

export async function unreadNotificationCount(): Promise<number> {
  return (await listNotifications({ limit: 1, unreadOnly: true })).unreadCount;
}

export async function markNotificationsRead(target: MarkReadTarget): Promise<number> {
  if ('ids' in target && target.ids.length === 0) return 0;
  const body = 'ids' in target ? { ids: target.ids } : { up_to_cursor: target.upToCursor };
  const response = await fetchWithAuth('/api/notifications/read', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('mark_read_failed');
  const result = (await response.json()) as { moved: number };
  return result.moved;
}

export async function listNotificationPreferences(): Promise<NotificationPreference[]> {
  const response = await fetchWithAuth('/api/notification-preferences');
  if (!response.ok) throw new Error('preferences_failed');
  const result = (await response.json()) as { preferences: NotificationPreference[] };
  return result.preferences;
}

export async function setNotificationTypeMuted(
  type: NotificationType,
  muted: boolean,
): Promise<NotificationPreference> {
  const response = await fetchWithAuth('/api/notification-preferences', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ type, muted }),
  });
  if (!response.ok) throw new Error('preference_save_failed');
  return (await response.json()) as NotificationPreference;
}

export function isTypeMuted(preferences: NotificationPreference[], type: NotificationType): boolean {
  return preferences.some(
    (preference) => preference.space_id === null && preference.thread_id === null && preference.type === type && preference.muted,
  );
}
