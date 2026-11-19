import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AdminPage, adminTab } from './admin-page';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), userId: 'admin-a', operator: 'yes' as 'yes' | 'no', navigate: vi.fn() }));
vi.mock('@/lib/auth/use-session', () => ({
  fetchWithAuth: mocks.fetch,
  useSession: () => ({ status: 'signed-in', session: { user: { id: mocks.userId } } }),
}));
vi.mock('@/app/routes', () => ({ navigateTo: mocks.navigate, useLocationHash: () => window.location.hash }));
vi.mock('@/features/metrics/use-operator-access', () => ({ useOperatorAccess: () => mocks.operator }));
vi.mock('@/features/metrics/metrics-page', () => ({
  MetricsPage: ({ embedded }: { embedded?: boolean }) => <p>{embedded ? 'Embedded metrics' : 'Metrics page'}</p>,
}));
const EMPTY = { accounts: [], counts: { total: 0, enabled: 0, disabled: 0, awaitingConfirmation: 0 }, nextCursor: null };
const WAITLIST = { entries: [], counts: { total: 0, verified: 0, pending: 0, withAccount: 0, waitingVerified: 0 }, nextCursor: null };
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  mocks.userId = 'admin-a';
  mocks.operator = 'yes';
  mocks.fetch.mockReset();
  mocks.navigate.mockReset();
  window.history.replaceState(null, '', '/admin');
});
/** Access allowed; search answers empty; `add` answers POST /api/admin/accounts. */
function serve(add: () => Response | Promise<Response>): void {
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path.endsWith('/access')) return new Response(null, { status: 204 });
    if (path.endsWith('/accounts/search')) return Response.json(EMPTY);
    if (path.endsWith('/waitlist/search')) return Response.json(WAITLIST);
    return add();
  });
}
async function openAdd(): Promise<HTMLElement> {
  render(<AdminPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add person' }));
  return screen.findByRole('dialog');
}
function enter(dialog: HTMLElement, value = 'person@example.test'): void {
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Email address' }), { target: { value } });
}
const adds = (): unknown[][] => mocks.fetch.mock.calls.filter(([path]) => path === '/api/admin/accounts');
describe('Admin page', () => {
  it('has tabs Users, Waitlist and Monitoring; Monitoring embeds the metrics page', async () => {
    serve(() => Response.json({}));
    window.history.replaceState(null, '', '/admin#monitoring');
    render(<AdminPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Admin' })).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    for (const name of ['Users', 'Waitlist', 'Monitoring']) expect(screen.getByRole('tab', { name })).toBeTruthy();
    expect(screen.getByText('Embedded metrics')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open monitoring' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Waitlist' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/admin#waitlist');
  });
  it('hides Monitoring from an admin who is not an operator', async () => {
    mocks.operator = 'no';
    serve(() => Response.json({}));
    render(<AdminPage />);
    await screen.findByRole('button', { name: 'Add person' });
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.queryByRole('tab', { name: 'Monitoring' })).toBeNull();
    expect(adminTab('#monitoring', false)).toBe('users');
    expect(adminTab('#waitlist', true)).toBe('waitlist');
  });
  it('toasts "Invite sent" and closes for a new account', async () => {
    serve(() => Response.json({ status: 'created', invitation: 'queued' }));
    const dialog = await openAdd();
    enter(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    expect(await screen.findByText('Invite sent to person@example.test')).toBeTruthy();
  });
  it('says the person already has an account instead of "Invitation queued"', async () => {
    serve(() => Response.json({ status: 'exists', invitation: 'queued' }));
    const dialog = await openAdd();
    enter(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    expect(await screen.findByText('person@example.test already has an account')).toBeTruthy();
    expect(screen.queryByText(/Invitation queued/)).toBeNull();
  });
  it('offers an explicit invitation retry while preserving account success', async () => {
    serve(() => Response.json({ status: 'created', invitation: 'failed' }));
    const dialog = await openAdd();
    enter(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    await screen.findByText('The account is ready, but the invite didn’t send.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry invite' }));
    await waitFor(() => expect(adds()).toHaveLength(2));
    expect(JSON.parse(String((adds().at(-1)?.[1] as RequestInit).body))).toEqual({
      email: 'person@example.test',
      retryInvitation: true,
    });
  });
  it('explains an invalid email instead of only disabling the button, and sends one request for a double Enter', async () => {
    let finish: ((value: Response) => void) | undefined;
    serve(() => new Promise<Response>((resolve) => {
      finish = resolve;
    }));
    const dialog = await openAdd();
    enter(dialog, 'not-an-email');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    expect(await within(dialog).findByText('Enter an email address, like you@example.com.')).toBeTruthy();
    expect(adds()).toHaveLength(0);
    enter(dialog);
    const field = within(dialog).getByRole('textbox', { name: 'Email address' });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(adds()).toHaveLength(1));
    finish?.(Response.json({ status: 'created', invitation: 'queued' }));
    await screen.findByText('Invite sent to person@example.test');
  });
  it.each([503, 429])('keeps failure %s inline with Try again', async (status) => {
    serve(() => new Response(null, { status }));
    const dialog = await openAdd();
    enter(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    expect(await within(dialog).findByText(status === 429 ? 'Please wait a moment before adding another person.' : 'Access could not be added.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
  it('rejects unexpected success payloads rather than reporting access', async () => {
    serve(() => Response.json({ status: 'created', role: 'admin' }));
    const dialog = await openAdd();
    enter(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    await within(dialog).findByText('Access could not be added.');
    expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
  it('hides everything while checking and after access is denied', async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 404 }));
    render(<AdminPage />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(await screen.findByText('Admin is for site admins.')).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add person' })).toBeNull();
  });
  it('offers Try again when the access check fails', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
    render(<AdminPage />);
    await screen.findByText("Access couldn't be checked.");
    mocks.fetch.mockImplementation(async (path: string) =>
      path.endsWith('/access') ? new Response(null, { status: 204 }) : Response.json(EMPTY));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Add person' })).toBeTruthy();
  });
  it('removes the page when a mutation reveals revoked access', async () => {
    serve(() => new Response(null, { status: 404 }));
    const dialog = await openAdd();
    enter(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    await screen.findByText('Admin is for site admins.');
    expect(screen.queryByRole('tab')).toBeNull();
  });
  it('does not let an older allowed probe overwrite mutation denial', async () => {
    let resolveProbe: ((value: Response) => void) | undefined;
    serve(() => new Response(null, { status: 404 }));
    const dialog = await openAdd();
    mocks.fetch.mockImplementation((path: string) =>
      path.endsWith('/access')
        ? new Promise<Response>((resolve) => {
            resolveProbe = resolve;
          })
        : Promise.resolve(new Response(null, { status: 404 })),
    );
    fireEvent.focus(window);
    enter(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    await screen.findByText('Admin is for site admins.');
    await act(async () => {
      resolveProbe?.(new Response(null, { status: 204 }));
    });
    expect(screen.queryByRole('tab')).toBeNull();
  });
  it('does not reuse access when the signed-in identity changes', async () => {
    mocks.fetch
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValue(new Response(null, { status: 404 }));
    const view = render(<AdminPage />);
    await screen.findByRole('button', { name: 'Add person' });
    mocks.userId = 'ordinary-b';
    view.rerender(<AdminPage />);
    expect(screen.queryByRole('button', { name: 'Add person' })).toBeNull();
    await screen.findByText('Admin is for site admins.');
  });
});
