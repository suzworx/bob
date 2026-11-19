import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));

import {
  isTypeMuted,
  listNotificationPreferences,
  listNotifications,
  markNotificationsRead,
  setNotificationTypeMuted,
  unreadNotificationCount,
  type NotificationPreference,
  type NotificationType,
} from './notifications-api';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('listNotifications', () => {
  it('builds the URL from no params, then limit/after in order', async () => {
    fetchWithAuth.mockImplementation(async () =>
      json(200, { notifications: [], next_cursor: null, unread_count: 0 }),
    );
    await listNotifications();
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/notifications');
    await listNotifications({ limit: 25, after: 40 });
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/notifications?limit=25&after=40');
  });

  it('maps next_cursor/unread_count to camelCase, and throws on failure', async () => {
    fetchWithAuth.mockResolvedValue(json(200, { notifications: [], next_cursor: 7, unread_count: 3 }));
    await expect(listNotifications()).resolves.toEqual({ notifications: [], nextCursor: 7, unreadCount: 3 });
    fetchWithAuth.mockResolvedValue(json(500, {}));
    await expect(listNotifications()).rejects.toThrow('notifications_failed');
  });
});

it('unreadNotificationCount hits the exact unread URL and returns unread_count', async () => {
  fetchWithAuth.mockResolvedValue(json(200, { notifications: [], next_cursor: null, unread_count: 5 }));
  await expect(unreadNotificationCount()).resolves.toBe(5);
  expect(fetchWithAuth).toHaveBeenCalledWith('/api/notifications?limit=1&unread=true');
});

describe('markNotificationsRead', () => {
  it('skips the fetch for an empty ids list', async () => {
    await expect(markNotificationsRead({ ids: [] })).resolves.toBe(0);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('PUTs ids or up_to_cursor and returns moved, throwing on failure', async () => {
    fetchWithAuth.mockResolvedValue(json(200, { moved: 2 }));
    await expect(markNotificationsRead({ ids: ['a', 'b'] })).resolves.toBe(2);
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/notifications/read', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['a', 'b'] }),
    });
    fetchWithAuth.mockResolvedValue(json(200, { moved: 9 }));
    await expect(markNotificationsRead({ upToCursor: 12 })).resolves.toBe(9);
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/notifications/read', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ up_to_cursor: 12 }),
    });
    fetchWithAuth.mockResolvedValue(json(500, {}));
    await expect(markNotificationsRead({ ids: ['a'] })).rejects.toThrow('mark_read_failed');
  });
});

it('listNotificationPreferences returns the array, and throws on failure', async () => {
  const rows = [{ id: 'p1' } as NotificationPreference];
  fetchWithAuth.mockResolvedValue(json(200, { preferences: rows }));
  await expect(listNotificationPreferences()).resolves.toEqual(rows);
  fetchWithAuth.mockResolvedValue(json(500, {}));
  await expect(listNotificationPreferences()).rejects.toThrow('preferences_failed');
});

it('setNotificationTypeMuted PUTs the account-wide row body, and throws on failure', async () => {
  const row = { id: 'p1' } as NotificationPreference;
  fetchWithAuth.mockResolvedValue(json(200, row));
  await expect(setNotificationTypeMuted('mention', true)).resolves.toEqual(row);
  expect(fetchWithAuth).toHaveBeenCalledWith('/api/notification-preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '{"type":"mention","muted":true}',
  });
  fetchWithAuth.mockResolvedValue(json(400, {}));
  await expect(setNotificationTypeMuted('mention', true)).rejects.toThrow('preference_save_failed');
});

it('supports muting Bob messages through the typed preferences client', async () => {
  const row = { id: 'p-bob', type: 'bob_message', muted: true } as NotificationPreference;
  fetchWithAuth.mockResolvedValue(json(200, row));
  await expect(setNotificationTypeMuted('bob_message' as NotificationType, true)).resolves.toEqual(row);
  expect(fetchWithAuth).toHaveBeenCalledWith('/api/notification-preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '{"type":"bob_message","muted":true}',
  });
});

describe('isTypeMuted', () => {
  const base: NotificationPreference = {
    id: 'p1',
    user_id: 'u1',
    space_id: null,
    thread_id: null,
    type: 'mention',
    muted: true,
    quiet_hours_start: null,
    quiet_hours_end: null,
    quiet_zone: null,
  };

  it('is true only for a muted account-wide row of that type', () => {
    expect(isTypeMuted([base], 'mention')).toBe(true);
    expect(isTypeMuted([{ ...base, space_id: 'sp1' }], 'mention')).toBe(false);
    expect(isTypeMuted([{ ...base, thread_id: 'th1' }], 'mention')).toBe(false);
    expect(isTypeMuted([{ ...base, muted: false }], 'mention')).toBe(false);
    expect(isTypeMuted([{ ...base, type: null }], 'mention')).toBe(false);
  });
});
