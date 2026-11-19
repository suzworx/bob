import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));

import { fetchUsage, type UsageResponse } from './usage-api';

const USAGE: UsageResponse = {
  range: '30d',
  from: '2026-09-04',
  to: '2026-10-03',
  generated_at: '2026-10-03T08:00:00.000Z',
  active_days: 12,
  turns: {
    total: 132,
    by_surface: { device: 58, web_voice: 31, web_text: 43 },
    by_day: [{ day: '2026-10-02', device: 4, web_voice: 2, web_text: 3 }],
    by_weekday_hour: [{ dow: 1, hour: 9, count: 5 }],
  },
  conversations_created: 20,
  created: { tasks: 9, notes: 3, reminders: 4 },
  todos_done: 6,
  memories: null,
  game_minutes: null,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('fetchUsage', () => {
  it('requests the chosen range and returns the body', async () => {
    fetchWithAuth.mockResolvedValue(json(200, USAGE));
    await expect(fetchUsage('30d')).resolves.toEqual(USAGE);
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/me/usage?range=30d');
  });

  it.each([400, 401, 500])('throws usage_failed on a %i answer', async (status) => {
    fetchWithAuth.mockResolvedValue(json(status, { error: { code: 'x' } }));
    await expect(fetchUsage('7d')).rejects.toThrow('usage_failed');
  });
});
