import { cloneElement, type ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MetricsPage } from './metrics-page';
import { LensUsers } from './lens-users';
import { resetOperatorAccess } from './use-operator-access';
import type { MetricsDocuments } from './metrics-api';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth: mocks.fetch }));
vi.mock('recharts', async (original) => ({
  ...(await original<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement }) => cloneElement(children, { width: 600, height: 240 } as object),
}));
const users: MetricsDocuments['users'] = {
  window: { from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z', bucket: 'day' },
  accounts: { total: 24, enabled: 22, disabled: 2, awaitingConfirmation: 5 },
  signups: 6, signups_by_bucket: [{ t: '2026-10-01T00:00:00Z', count: 6 }],
  active_users: { day: null, week: 7, month: 12, in_window: 7 }, activated_users: 16,
  waitlist: { total: 30, verified: 20, pending: 10, withAccount: 6, waitingVerified: 14 },
};
beforeEach(() => { mocks.fetch.mockReset(); resetOperatorAccess(); window.history.replaceState(null, '', '/admin/monitoring'); });
afterEach(cleanup);

it('distinguishes real activity, suppressed small counts and range growth, without repeating the Admin totals', () => {
  render(<LensUsers users={users} />);
  expect(screen.getByText('fewer than 3')).toBeTruthy();
  expect(screen.getByText(/Activity means sending a message, not signing in/)).toBeTruthy();
  expect(screen.getByText(/Counts below 3 are hidden, including zero/)).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Account access now' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Waitlist now' })).toBeNull();
  expect(screen.getByText('6 new accounts in the selected range.')).toBeTruthy();
  expect(screen.queryByText(/@/)).toBeNull();
});

it('loads Users on demand, carries range changes and handles endpoint failures', async () => {
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path.endsWith('/access')) return new Response(null, { status: 204 });
    if (!path.includes('/users?')) return new Response(null, { status: 500 });
    return Response.json(users);
  });
  render(<MetricsPage />);
  await screen.findByText('6 new accounts in the selected range.');
  expect(mocks.fetch).toHaveBeenCalledWith('/api/operator/metrics/users?range=7d');
  fireEvent.click(screen.getByRole('radio', { name: '30 days' }));
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith('/api/operator/metrics/users?range=30d'));
  mocks.fetch.mockResolvedValue(new Response(null, { status: 500 }));
  fireEvent.click(screen.getByRole('radio', { name: '90 days' }));
  await screen.findByText('Metrics could not be loaded.');
});

it('renders zero signups without treating suppressed activity as zero', () => {
  render(<LensUsers users={{ ...users, signups: 0, signups_by_bucket: [], accounts: { total: 0, enabled: 0, disabled: 0, awaitingConfirmation: 0 }, active_users: { day: null, week: null, month: null, in_window: null }, activated_users: null, waitlist: { total: 0, verified: 0, pending: 0, withAccount: 0, waitingVerified: 0 } }} />);
  expect(screen.getAllByText('fewer than 3')).toHaveLength(5);
  expect(screen.getByText('0 new accounts in the selected range.')).toBeTruthy();
});
