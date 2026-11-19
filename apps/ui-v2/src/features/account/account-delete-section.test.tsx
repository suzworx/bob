import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteAccountSection } from './account-delete-section';

type User = ReturnType<typeof userEvent.setup>;

const fetchWithAuth = vi.hoisted(() => vi.fn<typeof fetch>());
const signOutEverywhere = vi.hoisted(() => vi.fn(async (): Promise<boolean> => true));
const signOut = vi.hoisted(() => vi.fn(async (): Promise<void> => {}));
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth, useSession: () => ({ signOut, signOutEverywhere }) }));
vi.mock('../../app/routes', () => ({ navigateTo: vi.fn() }));

const mockNavigateTo = vi.mocked((await import('../../app/routes')).navigateTo);
const FAILED_ERROR = "Your account couldn't be deleted.";

// jsdom has no modal <dialog>; the Astryx alert dialog calls showModal() on open.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const isDisabled = (element: HTMLElement): boolean =>
  element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';

function deleteButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Delete account' });
}

async function typeConfirmation(user: User, value: string): Promise<void> {
  await user.type(screen.getByLabelText('Type your email to confirm'), value);
}

async function openDialog(user: User, name = 'Delete ada@example.com?'): Promise<HTMLElement> {
  await user.click(deleteButton());
  return screen.findByRole('alertdialog', { name });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  signOutEverywhere.mockReset();
  signOutEverywhere.mockResolvedValue(true);
  signOut.mockReset();
  mockNavigateTo.mockReset();
});

describe('DeleteAccountSection', () => {
  it('shows the confirmation field only once Delete account is pressed, and Cancel hides it again', async () => {
    const user = userEvent.setup();
    render(<DeleteAccountSection email="ada@example.com" />);
    expect(screen.queryByLabelText('Type your email to confirm')).toBeNull();
    await user.click(deleteButton());
    await typeConfirmation(user, 'ada');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Type your email to confirm')).toBeNull();
    expect(isDisabled(deleteButton())).toBe(false);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('enables the delete button only once the email is typed, ignoring case and whitespace', async () => {
    const user = userEvent.setup();
    render(<DeleteAccountSection email="ada@example.com" />);
    await user.click(deleteButton());
    expect(isDisabled(deleteButton())).toBe(true);
    await typeConfirmation(user, 'ADA@example.com ');
    expect(isDisabled(deleteButton())).toBe(false);
  });

  it('enables the delete button with "delete my account" when there is no email', async () => {
    const user = userEvent.setup();
    render(<DeleteAccountSection email={null} />);
    await user.click(deleteButton());
    await typeConfirmation(user, 'delete my account');
    expect(isDisabled(deleteButton())).toBe(false);
    expect(await openDialog(user, 'Delete your account?')).toBeTruthy();
  });

  it('sends the DELETE request, signs out everywhere, and navigates home on a 204', async () => {
    const user = userEvent.setup();
    fetchWithAuth.mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(<DeleteAccountSection email="ada@example.com" />);
    await user.click(deleteButton());
    await typeConfirmation(user, 'ada@example.com');
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Delete account' }));
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      }),
    );
    await waitFor(() => expect(signOutEverywhere).toHaveBeenCalledTimes(1));
    expect(mockNavigateTo).toHaveBeenCalledWith('/');
  });

  it('signs this device out even when the global revoke fails after a delete', async () => {
    const user = userEvent.setup();
    fetchWithAuth.mockResolvedValueOnce(new Response(null, { status: 204 }));
    signOutEverywhere.mockResolvedValueOnce(false);
    render(<DeleteAccountSection email="ada@example.com" />);
    await user.click(deleteButton());
    await typeConfirmation(user, 'ada@example.com');
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Delete account' }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(mockNavigateTo).toHaveBeenCalledWith('/');
  });

  it('says "shared spaces", not "family groups", on a 409, links to them, and does not sign out', async () => {
    const user = userEvent.setup();
    fetchWithAuth.mockResolvedValueOnce(jsonResponse(409, { error: { code: 'owns_groups', count: 2 } }));
    render(<DeleteAccountSection email="ada@example.com" />);
    await user.click(deleteButton());
    await typeConfirmation(user, 'ada@example.com');
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Delete account' }));
    expect(
      await screen.findByText('You own 2 shared spaces. Give each one to another member first, then try again.'),
    ).toBeTruthy();
    expect(screen.queryByText(/family/i)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open spaces' }));
    expect(mockNavigateTo).toHaveBeenCalledWith('/spaces');
    mockNavigateTo.mockClear();
    expect(signOutEverywhere).not.toHaveBeenCalled();
    expect(mockNavigateTo).not.toHaveBeenCalled();
  });

  it('shows the neutral error and does not sign out on a 500 or a rejected fetch', async () => {
    const user = userEvent.setup();
    fetchWithAuth.mockResolvedValueOnce(new Response(null, { status: 500 }));
    render(<DeleteAccountSection email="ada@example.com" />);
    await user.click(deleteButton());
    await typeConfirmation(user, 'ada@example.com');
    let dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Delete account' }));
    expect(await screen.findByText(FAILED_ERROR)).toBeTruthy();
    expect(signOutEverywhere).not.toHaveBeenCalled();

    fetchWithAuth.mockRejectedValueOnce(new Error('network down'));
    dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Delete account' }));
    expect(await screen.findByText(FAILED_ERROR)).toBeTruthy();
    expect(signOutEverywhere).not.toHaveBeenCalled();
    expect(mockNavigateTo).not.toHaveBeenCalled();
  });

  it('sends nothing when the dialog is cancelled', async () => {
    const user = userEvent.setup();
    render(<DeleteAccountSection email="ada@example.com" />);
    await user.click(deleteButton());
    await typeConfirmation(user, 'ada@example.com');
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
