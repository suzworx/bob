import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AccountManagement } from './account-management';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), deny: vi.fn() }));
vi.mock('@/lib/auth/use-session', () => ({
  fetchWithAuth: mocks.fetch,
  useSession: () => ({ session: { user: { id: '99999999-9999-4999-8999-999999999999' } } }),
}));
vi.mock('./use-admin-access', () => ({ invalidateAdminAccess: mocks.deny }));
const account = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'person@example.test',
  createdAt: '2026-01-01T00:00:00Z',
  lastSignInAt: null,
  status: 'enabled',
  isAdmin: false,
  emailConfirmed: false,
};
const result = {
  accounts: [account],
  counts: { total: 10, enabled: 8, disabled: 2, awaitingConfirmation: 3 },
  nextCursor: null,
};
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  mocks.fetch.mockReset();
  mocks.deny.mockReset();
});
it('shows population counts separately from searched rows and posts search in the body', async () => {
  mocks.fetch.mockImplementation(async () => Response.json(result));
  render(<AccountManagement />);
  await screen.findByText('person@example.test');
  expect(screen.getByText('Sign-in enabled')).toBeTruthy();
  expect(screen.getByText('Email not confirmed')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search by email prefix' }), {
    target: { value: 'person@' },
  });
  // Enter submits the search, as the button does.
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search by email prefix' }), { key: 'Enter' });
  await waitFor(() =>
    expect(mocks.fetch).toHaveBeenCalledWith(
      '/api/admin/accounts/search',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: 'person@', limit: 25 }),
      }),
    ),
  );
});
it('confirms Disable sign-in in an AlertDialog that names the email, and removes privileged UI after revoked access', async () => {
  mocks.fetch.mockImplementation(async (path: string) =>
    path.endsWith('/search') ? Response.json(result) : new Response(null, { status: 403 }),
  );
  render(<AccountManagement />);
  await screen.findByText('person@example.test');
  fireEvent.click(screen.getByRole('button', { name: 'Manage account' }));
  const items = await screen.findAllByRole('menuitem');
  // Destructive last.
  expect(items.map((item) => item.textContent)).toEqual(['Make admin', 'Disable sign-in']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Disable sign-in' }));
  expect(mocks.fetch.mock.calls.some(([path]) => path.endsWith('/manage'))).toBe(false);
  const dialog = await screen.findByRole('alertdialog', { name: 'Disable sign-in for person@example.test?' });
  expect(within(dialog).queryByText(/Bob/)).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Disable sign-in' }));
  await waitFor(() => expect(mocks.deny).toHaveBeenCalledOnce());
});

it('confirms Remove admin naming the email; Make admin runs at once with a toast', async () => {
  const admin = { ...account, id: '22222222-2222-4222-8222-222222222222', email: 'boss@example.test', isAdmin: true };
  mocks.fetch.mockImplementation(async (path: string) =>
    path.endsWith('/search') ? Response.json({ ...result, accounts: [account, admin] }) : Response.json({ status: 'updated' }),
  );
  render(<AccountManagement />);
  await screen.findByText('boss@example.test');
  fireEvent.click(screen.getAllByRole('button', { name: 'Manage account' })[1] as HTMLElement);
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove admin' }));
  expect(await screen.findByRole('alertdialog', { name: 'Remove admin from boss@example.test?' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Manage account' })[0] as HTMLElement);
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Make admin' }));
  await waitFor(() => expect(mocks.fetch.mock.calls.filter(([path]) => path.endsWith('/manage'))).toHaveLength(1));
  expect(await screen.findByText('Now an admin: person@example.test')).toBeTruthy();
});

it('leaves self actions out of your own row instead of disabling them', async () => {
  const self = { ...account, id: '99999999-9999-4999-8999-999999999999', email: 'me@example.test', isAdmin: true };
  mocks.fetch.mockImplementation(async () => Response.json({ ...result, accounts: [self] }));
  render(<AccountManagement />);
  await screen.findByText('me@example.test');
  expect(screen.queryByRole('button', { name: 'Manage account' })).toBeNull();
  expect(screen.getByText('You')).toBeTruthy();
});
