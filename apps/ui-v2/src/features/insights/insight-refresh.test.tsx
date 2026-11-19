import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { InsightRefresh } from './insight-refresh';

const fetchWithAuth = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));
vi.mock('@/lib/use-refresh-on-focus', () => ({ useRefreshOnFocus: () => 0 }));
const account = { id: '7a0f3c3f-8d2b-5e4f-ab6c-1d2e3f4a5b6c', email: 'morning@example.com', name: null, selected: true, createdAt: 1, access: ['calendar.read', 'gmail.read'], needsReconnect: false };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => { fetchWithAuth.mockReset(); });

it('requires a chosen eligible account and requests only the selected category', async () => {
  fetchWithAuth.mockImplementation(async (url) => String(url) === '/api/google-accounts' ? json({ accounts: [account] }) : json({ insights: [] }));
  const prepared = vi.fn();
  render(<InsightRefresh category="future" onPrepared={prepared} />);
  const prepare = await screen.findByRole('button', { name: 'Prepare outlook' });
  expect(prepare.hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('combobox', { name: 'Google account' }));
  fireEvent.click(await screen.findByRole('option', { name: account.email }));
  fireEvent.click(prepare);
  await waitFor(() => expect(prepared).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetchWithAuth.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body))).toEqual({ googleAccountId: account.id, category: 'future' });
});

it('does not let Gmail-only or reconnect-needed accounts request a calendar outlook', async () => {
  fetchWithAuth.mockResolvedValue(json({ accounts: [{ ...account, access: ['gmail.read'] }, { ...account, id: 'reconnect', needsReconnect: true }] }));
  render(<InsightRefresh category="future" onPrepared={vi.fn()} />);
  expect(await screen.findByText('Connect an account with Calendar access')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Prepare outlook' })).toBeNull();
});

it('explains missing reflection evidence when the server has fewer than two saved periods', async () => {
  fetchWithAuth.mockImplementation(async (url) => String(url) === '/api/google-accounts' ? json({ accounts: [account] }) : json({ insights: [] }));
  render(<InsightRefresh category="reflections" onPrepared={vi.fn()} />);
  fireEvent.click(await screen.findByRole('combobox', { name: 'Google account' }));
  fireEvent.click(await screen.findByRole('option', { name: account.email }));
  fireEvent.click(screen.getByRole('button', { name: 'Reflect on summaries' }));
  expect(await screen.findByText('Bob needs at least two saved email summaries from different periods to reflect on.')).toBeTruthy();
});

it('keeps the account selection and a retryable error when preparing fails', async () => {
  fetchWithAuth.mockImplementation(async (url) => String(url) === '/api/google-accounts' ? json({ accounts: [account] }) : json({}, 503));
  const prepared = vi.fn();
  render(<InsightRefresh category="future" onPrepared={prepared} />);
  fireEvent.click(await screen.findByRole('combobox', { name: 'Google account' }));
  fireEvent.click(await screen.findByRole('option', { name: account.email }));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare outlook' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(prepared).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Prepare outlook' }).hasAttribute('disabled')).toBe(false);
});

it('directs an account with no selected calendars to Integrations', async () => {
  fetchWithAuth.mockImplementation(async (url) => String(url) === '/api/google-accounts' ? json({ accounts: [account] }) : json({ error: { code: 'insight_no_selected_calendars' } }, 409));
  const prepared = vi.fn();
  render(<InsightRefresh category="future" onPrepared={prepared} />);
  fireEvent.click(await screen.findByRole('combobox', { name: 'Google account' }));
  fireEvent.click(await screen.findByRole('option', { name: account.email }));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare outlook' }));
  expect(await screen.findByText('Choose calendars in Integrations before preparing your outlook.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Manage integrations' }).getAttribute('href')).toBe('/integrations');
  expect(prepared).not.toHaveBeenCalled();
});
