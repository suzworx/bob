import { cloneElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));
vi.mock('recharts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement }) => cloneElement(children, { width: 600, height: 300 } as object),
}));

import { MetricsPage } from './metrics-page';
import { resetOperatorAccess } from './use-operator-access';

const json = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const WINDOW = { from: '2026-10-01T00:00:00Z', to: '2026-10-03T00:00:00Z', bucket: 'day' };
const T1 = '2026-10-01T00:00:00Z';
const T2 = '2026-10-02T00:00:00Z';
const OTHER = 'other (fewer than 3)';

const AI = {
  window: WINDOW,
  turns: 42,
  tokens: { input: 1000, output: 200, cached_input: 500, cache_write: 0, reasoning: 0 },
  cache_hit_ratio: 0.5,
  avg_steps: 2.5,
  avg_output_tokens: null,
  interrupted_rate: 0.1,
  by_model: [
    { model: 'gemini-2.5-flash', turns: 40, input: 900, output: 150, cached_input: 450 },
    { model: 'other', turns: 2, input: 100, output: 50, cached_input: 50 },
  ],
  tools: Array.from({ length: 12 }, (_, i) => ({ tool: `tool_${i + 1}`, count: 100 - i })),
  intents: [{ intent: 'chat', turns: 5, success_rate: 0.8, p95_total_ms: null }],
  tokens_by_bucket: [
    { t: T1, input: 400, output: 80, cached_input: 200 },
    { t: T2, input: 600, output: 120, cached_input: 300 },
  ],
};
const DEVICES = {
  window: WINDOW,
  devices: { paired: 17, active_in_window: 13, revoked: 4 },
  by_fw_version: [{ fw_version: '1.2.0', count: 15 }, { fw_version: OTHER, count: 2 }],
  by_model: [{ model: 'bob-one', count: 14 }, { model: OTHER, count: 3 }],
  freshness: { under_1h: 6, under_24h: 5, under_7d: 2, older: 3, never: 1 },
  pairing: { requested: 21, approved: 19, expired: 7, other: 8 },
};
const FEATURES = {
  window: WINDOW,
  created_by_bucket: [
    { t: T1, tasks: 11, notes: 2, reminders: 4 },
    { t: T2, tasks: 12, notes: 5, reminders: 6 },
  ],
  tasks: { created: 99, completed: 15 },
  reminders: { created: 10, delivered: 9, acknowledged: 8, snoozed: 1 },
  notifications: { created: 31, read: 14, by_type: [{ type: 'reminder', count: 12 }] },
  calendar: { events_created: 0, by_origin: [] },
  spaces: { created: 18, by_kind: { private: 5, pair: 2, group: 1 } },
  game_minutes: 1234,
};
const USERS = {
  window: WINDOW,
  accounts: { total: 0, enabled: 0, disabled: 0, awaitingConfirmation: 0 },
  signups: 0, signups_by_bucket: [],
  active_users: { day: null, week: null, month: null, in_window: null }, activated_users: null,
  waitlist: { total: 0, verified: 0, pending: 0, withAccount: 0, waitingVerified: 0 },
};
const DOCS: Record<string, unknown> = { ai: AI, devices: DEVICES, features: FEATURES, users: USERS };

function serve(failing?: string): void {
  fetchWithAuth.mockImplementation(async (path: string) => {
    if (path === '/api/operator/access') return json(204);
    const page = /metrics\/([a-z]+)\?/.exec(path)?.[1] ?? '';
    return page === failing ? json(500) : json(200, DOCS[page]);
  });
}
const metricsCalls = (): string[] => fetchWithAuth.mock.calls.map((c) => String(c[0])).filter((p) => p.includes('/metrics/'));

async function openLens(name: 'AI' | 'Devices' | 'Features', heading: string): Promise<void> {
  render(<MetricsPage />);
  await screen.findByRole('heading', { level: 1, name: 'Metrics' });
  await userEvent.click(screen.getByRole('tab', { name }));
  await screen.findByRole('heading', { name: heading });
}
const seen = (...texts: string[]): void => texts.forEach((text) => expect(screen.getAllByText(text).length).toBeGreaterThan(0));

describe('operator metrics lenses', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    resetOperatorAccess();
    window.history.replaceState(null, '', '/admin/monitoring');
    serve();
  });
  afterEach(cleanup);

  it('shows the AI lens and requests only the ai document', async () => {
    await openLens('AI', 'Models');
    const afterUsers = metricsCalls().slice(1);
    expect(afterUsers).toEqual(['/api/operator/metrics/ai?range=7d']);
    seen('Turns', 'Cache hit', '50%', '2.5', '10%', '1,000 / 200', 'gemini-2.5-flash', 'other', 'chat', '80%');
    expect(screen.getByRole('heading', { name: 'Intents' })).toBeTruthy();
  });

  it('renders a dash for a null average and a null p95, and charts only the top 10 tools', async () => {
    await openLens('AI', 'Models');
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
    const summary = screen.getByText(/Most used tools/).textContent ?? '';
    expect(summary).toContain('tool_10 91');
    expect(summary).not.toContain('tool_11');
  });

  it('shows the Devices lens with the small-group label as given and a note', async () => {
    await openLens('Devices', 'Firmware versions');
    expect(metricsCalls().at(-1)).toBe('/api/operator/metrics/devices?range=7d');
    seen('Paired', '17', 'Active in range', '13', 'Revoked', '4', '1.2.0', 'bob-one', OTHER, 'Requested', '21', 'Expired', '1 to 24 hours', '1 to 7 days');
    expect(screen.getAllByText(/fewer than 3 devices are hidden/).length).toBeGreaterThan(0);
  });

  it('shows the Features lens with tiles summed over the buckets', async () => {
    await openLens('Features', 'Reminder funnel');
    expect(metricsCalls().at(-1)).toBe('/api/operator/metrics/features?range=7d');
    seen('Tasks created', '23', 'Notes created', '7', 'Reminders created', '10', '1,234', 'Tasks completed', '15', 'Acknowledged', 'Reminders', 'Private');
    expect(screen.queryByText(/Type:/)).toBeNull();
    expect(screen.queryByText('99')).toBeNull();
  });

  it('shows the error banner when the lens request fails', async () => {
    serve('devices');
    render(<MetricsPage />);
    await screen.findByRole('heading', { level: 1, name: 'Metrics' });
    await userEvent.click(screen.getByRole('tab', { name: 'Devices' }));
    expect(await screen.findByText('Metrics could not be loaded.')).toBeTruthy();
  });

  it('shows each device model by its product name, adding up rows that share one', async () => {
    DOCS.devices = { ...DEVICES, by_model: [
      { model: 'Waveshare ESP32-S3 Round', count: 5 }, { model: 'Bob (Waveshare 1.85C)', count: 4 }, { model: 'M5Stack Cardputer', count: 3 },
    ] };
    try {
      await openLens('Devices', 'Models');
      seen('Bob (Waveshare 1.85C)', '9', 'M5Stack Cardputer');
      expect(screen.queryByText('Waveshare ESP32-S3 Round')).toBeNull();
    } finally {
      DOCS.devices = DEVICES;
    }
  });

  it('refetches the active lens with range=30d when the range changes', async () => {
    await openLens('AI', 'Models');
    await userEvent.click(screen.getByRole('radio', { name: '30 days' }));
    await waitFor(() => expect(metricsCalls()).toContain('/api/operator/metrics/ai?range=30d'));
    expect(metricsCalls().some((p) => p.includes('/metrics/devices'))).toBe(false);
  });
});
