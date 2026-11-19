import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { WaitlistManagement } from './waitlist-management';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), deny: vi.fn() }));
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth: mocks.fetch }));
vi.mock('./use-admin-access', () => ({ invalidateAdminAccess: mocks.deny }));
const entry = {
  id: '11111111-1111-4111-8111-111111111111', email: 'reader@example.test', source: 'website',
  createdAt: '2026-10-01T00:00:00Z', verifiedAt: '2026-10-02T00:00:00Z', accountStatus: 'none',
};
const result = { entries: [entry], counts: { total: 12, verified: 8, pending: 4, withAccount: 3, waitingVerified: 5 }, nextCursor: null };
beforeEach(() => { mocks.fetch.mockReset(); mocks.deny.mockReset(); });

it('shows waitlist interest separately from account access and sends email search only in the request body', async () => {
  mocks.fetch.mockImplementation(async () => Response.json(result));
  render(<WaitlistManagement />);
  await screen.findByText(entry.email);
  expect(screen.getByText('No account')).toBeTruthy();
  expect(screen.getByText('On the waitlist')).toBeTruthy();
  expect(screen.getByText('Source: website')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search waitlist by email prefix' }), { target: { value: 'reader@' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search waitlist' }));
  await waitFor(() => expect(mocks.fetch).toHaveBeenLastCalledWith('/api/admin/waitlist/search', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ query: 'reader@', status: 'all', limit: 25 }),
  })));
});

it('paginates with opaque cursors and resets pagination when status changes', async () => {
  const user = userEvent.setup();
  mocks.fetch.mockImplementation(async (_path: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as { cursor?: string };
    return Response.json({ ...result, nextCursor: body.cursor ? null : 'next-page' });
  });
  render(<WaitlistManagement />);
  await user.click(await screen.findByRole('button', { name: 'Next waitlist page' }));
  await screen.findByText(entry.email);
  expect(JSON.parse(String(mocks.fetch.mock.calls.at(-1)?.[1].body))).toMatchObject({ cursor: 'next-page' });
  await user.click(screen.getByRole('combobox', { name: 'Waitlist status' }));
  await user.click(await screen.findByRole('option', { name: 'Awaiting verification' }));
  await waitFor(() => expect(JSON.parse(String(mocks.fetch.mock.calls.at(-1)?.[1].body))).toEqual({ query: '', status: 'pending', limit: 25 }));
  expect(screen.queryByRole('button', { name: 'Previous waitlist page' })).toBeNull();
});

it('ignores stale responses after a new search', async () => {
  let resolveFirst: ((response: Response) => void) | undefined;
  mocks.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
    .mockImplementation(async () => Response.json({ ...result, entries: [{ ...entry, email: 'latest@example.test' }] }));
  render(<WaitlistManagement />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Search waitlist by email prefix' }), { target: { value: 'latest' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search waitlist by email prefix' }), { key: 'Enter' });
  await screen.findByText('latest@example.test');
  await act(async () => { resolveFirst?.(Response.json(result)); });
  expect(screen.queryByText(entry.email)).toBeNull();
});

it('clears personal data and invalidates administration when access is revoked', async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json(result)).mockResolvedValue(new Response(null, { status: 403 }));
  render(<WaitlistManagement />);
  await screen.findByText(entry.email);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh waitlist' }));
  await waitFor(() => expect(mocks.deny).toHaveBeenCalledOnce());
  expect(screen.queryByText(entry.email)).toBeNull();
});

it('offers refresh after failure and distinguishes an empty waitlist', async () => {
  mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 500 }))
    .mockImplementation(async () => Response.json({ ...result, entries: [] }));
  render(<WaitlistManagement />);
  await screen.findByText("The waitlist couldn't be loaded.");
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('No one has joined the waitlist yet.');
});

it('invites a verified person with no account from their row, with a toast', async () => {
  mocks.fetch.mockImplementation(async (path: string) =>
    path === '/api/admin/accounts' ? Response.json({ status: 'created', invitation: 'queued' }) : Response.json(result));
  const onInvited = vi.fn();
  render(<WaitlistManagement onInvited={onInvited} />);
  await screen.findByText(entry.email);
  fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
  expect(await screen.findByText('Invite sent to reader@example.test')).toBeTruthy();
  const add = mocks.fetch.mock.calls.find(([path]) => path === '/api/admin/accounts');
  expect(JSON.parse(String((add?.[1] as RequestInit).body))).toEqual({ email: 'reader@example.test' });
  expect(onInvited).toHaveBeenCalledOnce();
});

it('offers no Invite to someone unverified or who already has an account', async () => {
  mocks.fetch.mockImplementation(async () => Response.json({
    ...result,
    entries: [
      { ...entry, id: '22222222-2222-4222-8222-222222222222', email: 'pending@example.test', verifiedAt: null },
      { ...entry, id: '33333333-3333-4333-8333-333333333333', email: 'member@example.test', accountStatus: 'enabled' },
    ],
  }));
  render(<WaitlistManagement />);
  await screen.findByText('member@example.test');
  expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
});

it('keeps a failed invite inline with Retry invite', async () => {
  mocks.fetch.mockImplementation(async (path: string) =>
    path === '/api/admin/accounts' ? Response.json({ status: 'created', invitation: 'failed' }) : Response.json(result));
  render(<WaitlistManagement />);
  await screen.findByText(entry.email);
  fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
  expect(await screen.findByText("The invite to reader@example.test didn't send.")).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry invite' }));
  await waitFor(() => expect(JSON.parse(String((mocks.fetch.mock.calls.at(-1)?.[1] as RequestInit).body))).toEqual({ email: 'reader@example.test', retryInvitation: true }));
});
