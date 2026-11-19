import { cloneElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));
vi.mock('../../app/routes', () => ({ navigateTo: vi.fn() }));

// jsdom has no layout, so the real ResponsiveContainer measures 0x0.
vi.mock('recharts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) => cloneElement(children, { width: 400, height: 200 }),
}));

import { BRAND } from '@/lib/brand';
import { busiestHourSentence, hourLabel, UsageSection } from './usage-section';
import type { UsageResponse } from './usage-api';

const mockNavigateTo = vi.mocked((await import('../../app/routes')).navigateTo);

const USAGE: UsageResponse = {
  range: '7d',
  from: '2026-09-27T07:00:00.000Z',
  to: '2026-10-03T08:00:00.000Z',
  generated_at: '2026-10-03T08:00:00.000Z',
  active_days: 2,
  turns: {
    total: 132,
    by_surface: { device: 58, web_voice: 31, web_text: 43 },
    by_day: [
      { day: '2026-09-27', device: 0, web_voice: 0, web_text: 0 },
      { day: '2026-09-28', device: 0, web_voice: 0, web_text: 0 },
      { day: '2026-09-29', device: 0, web_voice: 0, web_text: 0 },
      { day: '2026-09-30', device: 0, web_voice: 0, web_text: 0 },
      { day: '2026-10-01', device: 30, web_voice: 10, web_text: 20 },
      { day: '2026-10-02', device: 28, web_voice: 21, web_text: 23 },
      { day: '2026-10-03', device: 0, web_voice: 0, web_text: 0 },
    ],
    by_weekday_hour: [
      { dow: 1, hour: 9, count: 5 },
      { dow: 3, hour: 20, count: 7 },
      { dow: 2, hour: 20, count: 3 },
    ],
  },
  conversations_created: 17,
  created: { tasks: 9, notes: 3, reminders: 4 },
  todos_done: 6,
  memories: { new_in_range: 2, total: 23 },
  game_minutes: null,
};

const EMPTY: UsageResponse = {
  ...USAGE,
  active_days: 0,
  turns: { total: 0, by_surface: { device: 0, web_voice: 0, web_text: 0 }, by_day: [], by_weekday_hour: [] },
  conversations_created: 0,
  created: { tasks: 0, notes: 0, reminders: 0 },
  todos_done: 0,
  memories: { new_in_range: 0, total: 0 },
};

function reply(status: number, body: unknown): void {
  fetchWithAuth.mockImplementation(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

function value(label: string): string {
  const term = screen.getByText(label);
  const row = term.closest('[class]')?.parentElement ?? term.parentElement;
  return (row as HTMLElement).textContent ?? '';
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  mockNavigateTo.mockReset();
});

afterEach(cleanup);

describe('UsageSection', () => {
  it('shows Skeleton rows while loading, not a line of text', async () => {
    fetchWithAuth.mockImplementation(() => new Promise(() => undefined));
    render(<UsageSection />);
    expect(screen.getByRole('status', { name: 'Loading your usage' })).toBeTruthy();
    expect(screen.queryByText(/Loading/)).toBeNull();
  });

  it('shows the counts in plain words, matching their source pages', async () => {
    reply(200, USAGE);
    render(<UsageSection />);
    expect(await screen.findByText('2 of 7')).toBeTruthy();
    expect(value('Messages')).toContain('132');
    expect(value('New conversations')).toContain('17');
    // To-dos done counts what Today counts, as one number, not "x / y".
    expect(value('To-dos done')).toContain('6');
    expect(screen.queryByText(/\d+ \/ \d+/)).toBeNull();
    // Memories: new in range next to the total Memory lists, with a link to Memory.
    expect(screen.getByText(/2 of 23 total/)).toBeTruthy();
    await userEvent.click(screen.getByRole('link', { name: 'Open Memory' }));
    expect(mockNavigateTo).toHaveBeenCalledWith('/memory');
  });

  it('has no device table: Devices is the one place for device facts', async () => {
    reply(200, USAGE);
    render(<UsageSection />);
    await screen.findByText('2 of 7');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(/firmware|Cardputer/i)).toBeNull();
  });

  it('hides memories when memory is off, instead of a bare dash', async () => {
    reply(200, { ...USAGE, memories: null });
    render(<UsageSection />);
    await screen.findByText('2 of 7');
    expect(screen.queryByText('New memories')).toBeNull();
    expect(screen.queryByText('—')).toBeNull();
  });

  it('says the busiest hour in the account zone as a 12-hour sentence', async () => {
    reply(200, USAGE);
    render(<UsageSection />);
    expect(await screen.findByText(`You talk to ${BRAND.assistantName} most around ${hourLabel(20)}.`)).toBeTruthy();
    expect(busiestHourSentence([])).toBeNull();
  });

  it('summarises the per-day chart in plain words', async () => {
    reply(200, USAGE);
    render(<UsageSection />);
    expect(await screen.findByText(`${BRAND.name} device 58, Voice on web 31, Typed 43`)).toBeTruthy();
    expect(screen.getByText('Messages per day')).toBeTruthy();
  });

  it('refetches with the chosen range', async () => {
    reply(200, USAGE);
    render(<UsageSection />);
    await screen.findByText('2 of 7');
    await userEvent.click(screen.getByRole('radio', { name: '30 days' }));
    expect(await screen.findByText('2 of 30')).toBeTruthy();
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/me/usage?range=30d');
  });

  it('shows an inline error with Try again, and retries', async () => {
    reply(500, {});
    render(<UsageSection />);
    expect(await screen.findByText("Couldn't load your usage.")).toBeTruthy();
    reply(200, USAGE);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('2 of 7')).toBeTruthy();
  });

  it('shows the empty state when there is no activity at all', async () => {
    reply(200, EMPTY);
    render(<UsageSection />);
    const empty = await screen.findByRole('heading', { level: 3, name: 'Nothing here yet' });
    expect(within(empty.parentElement as HTMLElement).queryByRole('table')).toBeNull();
  });
});
