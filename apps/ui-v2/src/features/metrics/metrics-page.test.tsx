import { cloneElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));
vi.mock('recharts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement }) => cloneElement(children, { width: 600, height: 300 } as object),
}));

import { MetricsPage } from './metrics-page';
import { resetOperatorAccess } from './use-operator-access';

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const WINDOW = { from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z', bucket: 'day' };
const PERCENTILES = { p50: 400, p95: 850 };
const LATENCY = { first_audio: PERCENTILES, stt: PERCENTILES, model: PERCENTILES, tts: PERCENTILES, total: PERCENTILES };
const surface = (turns: number, completed: number, failed: number, rate: number | null) => ({
  turns,
  outcomes: { completed, failed, cancelled: 1, empty: 2 },
  success_rate: rate,
  latency_ms: LATENCY,
});

const USAGE = {
  window: WINDOW,
  turns_by_bucket: [
    { t: '2026-10-01T00:00:00Z', device: 10, web_voice: 5, web_text: 3 },
    { t: '2026-10-02T00:00:00Z', device: 12, web_voice: 4, web_text: 6 },
  ],
  turns_total: 240,
  conversations_created: 9,
  signups: 2,
  active_users: { day: 4, week: 5, month: 8, in_window: 8 },
};
const VOICE = {
  window: WINDOW,
  by_surface: { device: surface(100, 92, 4, 0.95), web_voice: surface(60, 50, 5, 0.8), web_text: surface(80, 70, 2, null) },
  failed_by_stage: { input: 1, stt: 2, agent: 3, tts: 5 },
  first_audio_p95_by_bucket: [
    { t: '2026-10-01T00:00:00Z', device: 850, web_voice: null },
    { t: '2026-10-02T00:00:00Z', device: null, web_voice: 1200 },
  ],
};
const PLATFORM = {
  window: WINDOW,
  backlog: 37,
  oldest_pending_seconds: 600,
  retried: 1,
  failed_by_event_type: [{ event_type: 'task.reminder', count: 6 }],
};

const USERS = {
  window: WINDOW,
  accounts: { total: 24, enabled: 22, disabled: 2, awaitingConfirmation: 5 },
  signups: 6, signups_by_bucket: [{ t: '2026-10-01T00:00:00Z', count: 6 }],
  active_users: { day: null, week: 7, month: 12, in_window: 7 }, activated_users: 16,
  waitlist: { total: 30, verified: 20, pending: 10, withAccount: 6, waitingVerified: 14 },
};

function serve(access: number, overrides: Record<string, unknown> = {}): void {
  fetchWithAuth.mockImplementation(async (path: string) => {
    if (path === '/api/operator/access') return json(access);
    const page = /metrics\/(usage|voice|platform|users)\?/.exec(path)?.[1] as 'usage' | 'voice' | 'platform' | 'users';
    const docs = { usage: USAGE, voice: VOICE, platform: PLATFORM, users: USERS, ...overrides };
    return json(200, docs[page]);
  });
}
const metricsCalls = (): string[] => fetchWithAuth.mock.calls.map((c) => String(c[0])).filter((p) => p.includes('/metrics/'));

describe('MetricsPage', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    resetOperatorAccess();
    // Most cases read the Reliability lens; the URL carries the lens.
    window.history.replaceState(null, '', '/admin/monitoring?lens=reliability');
  });
  afterEach(cleanup);

  it('shows "Not available" to a non-operator and requests no metrics', async () => {
    serve(404);
    render(<MetricsPage />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Not available' })).toBeTruthy();
    expect(screen.getByText('Metrics are only shown to the people who run this service.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to chat' })).toBeTruthy();
    expect(metricsCalls()).toEqual([]);
  });

  it('offers Retry when the access check fails, and asks again', async () => {
    const user = userEvent.setup();
    let probes = 0;
    fetchWithAuth.mockImplementation(async (path: string) => {
      if (path === '/api/operator/access') return json(++probes === 1 ? 500 : 404);
      return json(500);
    });
    render(<MetricsPage />);
    expect(await screen.findByText('Access could not be checked.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Not available' })).toBeTruthy();
    expect(probes).toBe(2);
  });

  it('opens on the first tab (Users) when the URL names no lens, and keeps lens and range in the URL', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/admin/monitoring');
    serve(204);
    render(<MetricsPage />);
    await screen.findByText('6 new accounts in the selected range.');
    expect(screen.getByRole('tab', { name: 'Users', selected: true })).toBeTruthy();
    expect(metricsCalls()).toEqual(['/api/operator/metrics/users?range=7d']);
    await user.click(screen.getByRole('radio', { name: '30 days' }));
    await user.click(screen.getByRole('tab', { name: 'Reliability' }));
    expect(new URLSearchParams(window.location.search).get('lens')).toBe('reliability');
    expect(new URLSearchParams(window.location.search).get('range')).toBe('30d');
    cleanup();
    render(<MetricsPage />);
    expect(await screen.findByRole('tab', { name: 'Reliability', selected: true })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '30 days', checked: true })).toBeTruthy();
  });

  it('renders without its own title or frame when embedded, and still gates on operator access', async () => {
    serve(204);
    render(<MetricsPage embedded />);
    await screen.findByRole('heading', { name: 'Outcomes by surface' });
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByRole('tablist')).toBeTruthy();
    cleanup();
    resetOperatorAccess();
    fetchWithAuth.mockReset();
    serve(404);
    render(<MetricsPage embedded />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Not available' })).toBeTruthy();
    expect(metricsCalls()).toEqual([]);
  });

  it('shows the title and the tiles for an operator', async () => {
    serve(204);
    render(<MetricsPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Metrics' })).toBeTruthy();
    await screen.findByRole('heading', { name: 'Outcomes by surface' });
    for (const value of ['95%', '850 ms', '11', '240', '37', '10 min']) expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    expect(screen.queryByText('Active users this week')).toBeNull();
    expect(metricsCalls()).toHaveLength(3);
    expect(metricsCalls().every((p) => p.includes('range=7d'))).toBe(true);
  });

  it('renders a dash for a null success rate', async () => {
    const quiet = { ...VOICE, by_surface: { ...VOICE.by_surface, device: surface(0, 0, 0, null) } };
    serve(204, { voice: quiet });
    render(<MetricsPage />);
    await screen.findByRole('heading', { name: 'Outcomes by surface' });
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('refetches all three pages when the range changes', async () => {
    const user = userEvent.setup();
    serve(204);
    render(<MetricsPage />);
    await screen.findByRole('heading', { name: 'Outcomes by surface' });
    await user.click(screen.getByRole('radio', { name: '30 days' }));
    await waitFor(() => expect(metricsCalls().filter((p) => p.includes('range=30d'))).toHaveLength(3));
  });

  it('shows the error with Retry when a metrics request fails, and Retry loads it', async () => {
    const user = userEvent.setup();
    fetchWithAuth.mockImplementation(async (path: string) => (path === '/api/operator/access' ? json(204) : json(500)));
    render(<MetricsPage />);
    expect(await screen.findByText('Metrics could not be loaded.')).toBeTruthy();
    serve(204);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Outcomes by surface' })).toBeTruthy();
  });

  it('lists each surface in the outcomes table', async () => {
    serve(204);
    render(<MetricsPage />);
    await screen.findByRole('heading', { name: 'Outcomes by surface' });
    const table = within(screen.getAllByRole('table')[0] as HTMLElement);
    for (const name of ['Device', 'Web voice', 'Web text']) expect(table.getByText(name)).toBeTruthy();
  });
});
