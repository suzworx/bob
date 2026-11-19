import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgendaPanel } from '@/features/productivity/agenda-panel';
import { googleAgendaDay, googleAgendaDays, googleInclusiveEnd, type GoogleAgendaItem } from './google-agenda';

const fetchWithAuth = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('@/lib/auth/use-session', async (orig) => ({ ...(await orig<typeof import('@/lib/auth/use-session')>()), fetchWithAuth,
  useSession: () => ({ session: { user: { id: 'me', user_metadata: {} } } }) }));
HTMLDialogElement.prototype.showModal = function showModal(): void { this.setAttribute('open', ''); };
HTMLDialogElement.prototype.close = function close(): void { this.removeAttribute('open'); };
const remote: GoogleAgendaItem = { origin: 'google', source_key: `google:${'a'.repeat(64)}`, source: { account_id: 'account', calendar_id: 'calendar', event_id: 'remote-id', etag: 'etag' }, title: 'Google holiday', location: 'Park', start: { date: '2026-09-20' }, end: { date: '2026-09-22' }, read_only: true, fetched_at: Date.parse('2026-09-20T12:00:00Z') };
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 8, 20, 12)); fetchWithAuth.mockReset(); });
afterEach(() => vi.useRealTimers());

it('retains native rows alongside partial Google rows and opens only read-only details', async () => {
  fetchWithAuth.mockImplementation(async () => new Response(JSON.stringify({ items: [{ event_id: 'native', title: 'Native meeting', origin: 'native', all_day: true, start_date: '2026-09-20', end_date: '2026-09-20', can_edit: true }], remote_items: [remote], sources: [{ account_id: 'account', calendar_id: 'calendar', state: 'partial', last_success_at: remote.fetched_at, next_page_token: 'next' }] })));
  render(<AgendaPanel />);
  await screen.findByText('Native meeting');
  expect(screen.getAllByText('Google holiday')).toHaveLength(2);
  expect(screen.getByText('Some Google events could not be shown.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Edit Google holiday' })).toBeNull();
  await userEvent.click(screen.getAllByRole('button', { name: 'Details Google holiday' }).at(0) as HTMLElement);
  expect(screen.getByText('All day · 2026-09-20 – 2026-09-21')).toBeTruthy();
  expect(screen.getByText('Make changes in Google Calendar.')).toBeTruthy();
  expect(fetchWithAuth.mock.calls.every(([url]) => String(url).startsWith('/api/agenda?'))).toBe(true);
});

it('shows native rows when the entire Google projection is unavailable', async () => {
  fetchWithAuth.mockImplementation(async () => new Response(JSON.stringify({ items: [{ event_id: 'native', title: 'Native still here', origin: 'native', all_day: true, start_date: '2026-09-20', can_edit: true }], remote_unavailable: true })));
  render(<AgendaPanel />);
  await screen.findByText('Native still here');
  expect(screen.getByText('Some Google events could not be shown.')).toBeTruthy();
});

it('preserves date-only days and groups offset times by the viewer local day', () => {
  expect(googleAgendaDay(remote)).toBe('2026-09-20');
  expect(googleInclusiveEnd('2026-03-01')).toBe('2026-02-28');
  const instant = '2026-09-20T00:30:00+14:00';
  const date = new Date(instant);
  expect(googleAgendaDay({ ...remote, start: { dateTime: instant } })).toBe(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
});

it('includes overlapping remote events on each covered day, excluding the end day', () => {
  const month = new Date(2026, 8, 1);
  expect(googleAgendaDays({ ...remote, start: { date: '2026-08-30' }, end: { date: '2026-09-03' } }, month)).toEqual(['2026-09-01', '2026-09-02']);
  expect(googleAgendaDays(remote, month)).toEqual(['2026-09-20', '2026-09-21']);
});

it('keeps a prior-month event visible and includes the covered selected day', async () => {
  fetchWithAuth.mockImplementation(async () => new Response(JSON.stringify({ items: [], remote_items: [{ ...remote, start: { date: '2026-08-30' }, end: { date: '2026-09-03' } }], sources: [] })));
  render(<AgendaPanel />);
  await screen.findAllByText('Google holiday');
  await userEvent.click(screen.getByRole('button', { name: /^Wednesday, September 2, 2026/ }));
  expect(screen.getAllByText('Google holiday')).toHaveLength(1);
});

it('orders Google and native timed rows together by instant', async () => {
  const early = new Date(2026, 8, 20, 9).toISOString();
  const late = new Date(2026, 8, 20, 17).getTime();
  fetchWithAuth.mockImplementation(async () => new Response(JSON.stringify({ items: [{ event_id: 'native', title: 'Late native', origin: 'native', all_day: false, start_at: late, can_edit: true }], remote_items: [{ ...remote, title: 'Early Google', start: { dateTime: early }, end: { dateTime: new Date(Date.parse(early) + 3600000).toISOString() } }], sources: [] })));
  render(<AgendaPanel />);
  const google = await screen.findByText('Early Google');
  const native = screen.getByText('Late native');
  expect(google.compareDocumentPosition(native) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
