import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));

import { DeleteAllMemoriesSection } from './delete-all-memories';

HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
};

beforeEach(() => {
  fetchWithAuth.mockReset();
});

afterEach(() => {
  cleanup();
});

async function confirmDeleteAll(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'Delete all memories' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Delete all memories?' });
  expect(within(dialog).queryByRole('textbox')).toBeNull();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete all' }));
}

describe('DeleteAllMemoriesSection', () => {
  it('asks once in an AlertDialog, with no typed phrase, then deletes', async () => {
    fetchWithAuth.mockResolvedValue(new Response(null, { status: 204 }));
    render(<DeleteAllMemoriesSection />);
    expect(fetchWithAuth).not.toHaveBeenCalled();
    await confirmDeleteAll();
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/api/memories', { method: 'DELETE' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('Cancel sends nothing', async () => {
    render(<DeleteAllMemoriesSection />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete all memories' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('shows an inline error with Retry when the delete fails', async () => {
    fetchWithAuth.mockResolvedValue(new Response('{}', { status: 500 }));
    render(<DeleteAllMemoriesSection />);
    await confirmDeleteAll();
    expect(await screen.findByText("Your memories couldn't be deleted.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
