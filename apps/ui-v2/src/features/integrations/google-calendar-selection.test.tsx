import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { GoogleCalendarSelection } from './google-calendar-selection';

const fetchWithAuth = vi.hoisted(() => vi.fn<typeof fetch>());
HTMLDialogElement.prototype.showModal = function showModal(): void { this.setAttribute('open', ''); };
HTMLDialogElement.prototype.close = function close(): void { this.removeAttribute('open'); };
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));
const account = { id: '6f9f2b2e-7c1a-4d3e-9a5b-0c1d2e3f4a5b', email: 'a@example.com' };
function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status }); }
beforeEach(() => fetchWithAuth.mockReset());

it('keeps saved calendars outside the current provider page when saving', async () => {
  fetchWithAuth.mockResolvedValueOnce(json({ calendars: [{ id: 'visible', title: 'Work', time_zone: null, selected: false, selectable: true, read_only: true }], selected_calendar_ids: ['unseen'], next_page_token: 'next' }));
  fetchWithAuth.mockResolvedValueOnce(json({ selections: [] }));
  const close = vi.fn();
  render(<GoogleCalendarSelection account={account} onClose={close} />);
  await screen.findByText('1 calendar selected');
  await userEvent.click(screen.getByRole('button', { name: 'Save calendars' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(fetchWithAuth.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ calendarIds: ['unseen'] }));
});

it('does not default to primary and exposes credential failure without saving', async () => {
  fetchWithAuth.mockResolvedValueOnce(json({}, 403));
  render(<GoogleCalendarSelection account={account} onClose={vi.fn()} />);
  await screen.findByText('Reconnect this Google account and allow calendar access.');
  expect(screen.getByRole('button', { name: 'Save calendars' }).hasAttribute('disabled')).toBe(true);
  expect(fetchWithAuth).toHaveBeenCalledTimes(1);
});

it('drops the prior account choices and disables saving while another account loads', async () => {
  fetchWithAuth.mockResolvedValueOnce(json({ calendars: [], selected_calendar_ids: ['account-a-calendar'] }));
  fetchWithAuth.mockImplementationOnce(() => new Promise<Response>(() => {}));
  const view = render(<GoogleCalendarSelection account={account} onClose={vi.fn()} />);
  await screen.findByText('1 calendar selected');
  view.rerender(<GoogleCalendarSelection account={{ id: 'other-account', email: 'b@example.com' }} onClose={vi.fn()} />);
  expect(screen.getByText('0 calendars selected')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save calendars' }).hasAttribute('disabled')).toBe(true);
  expect(fetchWithAuth.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

it('loads another page without replacing the existing selections', async () => {
  fetchWithAuth.mockResolvedValueOnce(json({ calendars: [], selected_calendar_ids: ['saved'], next_page_token: 'page-two' }));
  fetchWithAuth.mockResolvedValueOnce(json({ calendars: [{ id: 'saved', title: 'Saved calendar', time_zone: null, selected: true, selectable: true, read_only: true }], selected_calendar_ids: ['saved'] }));
  fetchWithAuth.mockResolvedValueOnce(json({ selections: [] }));
  render(<GoogleCalendarSelection account={account} onClose={vi.fn()} />);
  await screen.findByText('1 calendar selected');
  await userEvent.click(screen.getByRole('button', { name: 'Load more calendars' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more calendars' })).toBeNull());
  await userEvent.click(screen.getByRole('button', { name: 'Save calendars' }));
  await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(3));
  expect(String(fetchWithAuth.mock.calls[1]?.[0])).toContain('pageToken=page-two');
  expect(fetchWithAuth.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ calendarIds: ['saved'] }));
});

it('says the 5-calendar limit only when the server says so, and a plain retry otherwise', async () => {
  const page = { calendars: [], selected_calendar_ids: ['a'] };
  fetchWithAuth.mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json({ error: { code: 'google_selection_limit' } }, 400));
  const first = render(<GoogleCalendarSelection account={account} onClose={vi.fn()} />);
  await screen.findByText('1 calendar selected');
  await userEvent.click(screen.getByRole('button', { name: 'Save calendars' }));
  expect(await screen.findByText('You can show up to 5 calendars across your Google accounts.')).toBeTruthy();
  first.unmount();
  fetchWithAuth.mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json({}, 503));
  render(<GoogleCalendarSelection account={account} onClose={vi.fn()} />);
  await screen.findByText('1 calendar selected');
  await userEvent.click(screen.getByRole('button', { name: 'Save calendars' }));
  expect(await screen.findByText("Couldn't save your calendars. Try again.")).toBeTruthy();
});

it('offers Reconnect when calendar access is missing', async () => {
  fetchWithAuth.mockResolvedValueOnce(json({}, 403));
  const reconnect = vi.fn();
  render(<GoogleCalendarSelection account={account} onClose={vi.fn()} onReconnect={reconnect} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
  expect(reconnect).toHaveBeenCalledOnce();
});
