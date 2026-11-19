import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GroupChatControls } from './group-chat-controls';

vi.mock('@/lib/auth/use-session', () => ({ useSession: () => ({ session: { user: { id: 'successor' } } }), fetchWithAuth: (url: string, init?: RequestInit) => fetch(url, init) }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(): void { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function close(): void { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function openPeople(): void {
  render(<QueryClientProvider client={new QueryClient()}><Theme theme={neutralTheme}><GroupChatControls chat={{ id: 'shared-chat', space_id: 'space', title: 'Dinner', created_by: 'original', role: 'member', created_at: 1, updated_at: 1 }} onChanged={vi.fn()} /></Theme></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'People' }));
}

describe('group ownership controls', () => {
  it('sends an email only on explicit action and confirms only after the server accepts it', async () => {
    let finish: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    const request = vi.fn((url: string) => url.endsWith('/members')
      ? Promise.resolve(new Response(JSON.stringify({ members: [] }))) : pending);
    vi.stubGlobal('fetch', request);
    openPeople();
    const email = screen.getByRole('textbox', { name: 'Email address' });
    expect((email as HTMLInputElement).type).toBe('email');
    const send = screen.getByRole('button', { name: 'Send invitation' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(email, { target: { value: 'not-an-email' } });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(email, { target: { value: 'friend@example.test' } });
    expect(request.mock.calls.filter(([url]) => url.endsWith('/invitations'))).toHaveLength(0);
    fireEvent.click(send);
    await waitFor(() => expect(request).toHaveBeenCalledWith('/api/group-chats/shared-chat/invitations', expect.objectContaining({ method: 'POST', body: JSON.stringify({ email: 'friend@example.test' }) })));
    expect(screen.queryByText(/Invitation sent/)).toBeNull();
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(send);
    expect(request.mock.calls.filter(([url]) => url.endsWith('/invitations'))).toHaveLength(1);
    await act(async () => { finish(new Response(JSON.stringify({ sent: true }))); });
    expect(await screen.findByText('Invitation sent. They can choose whether to join.')).toBeTruthy();
    expect((email as HTMLInputElement).value).toBe('');
  });

  it.each([502, 200])('retains the email and reports a failed or unconfirmed send (%s)', async (status) => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(
      url.endsWith('/members') ? { members: [] } : { sent: false, error: { code: 'email_send_failed' } },
    ), { status: url.endsWith('/members') ? 200 : status }))));
    openPeople();
    const email = screen.getByRole('textbox', { name: 'Email address' });
    fireEvent.change(email, { target: { value: 'friend@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText("We couldn't send the invitation. Check the address and try again.")).toBeTruthy();
    expect((email as HTMLInputElement).value).toBe('friend@example.test');
    expect(screen.queryByText(/Invitation sent/)).toBeNull();
  });

  it('lets the successor owner manage the group after its original creator leaves', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ members: [
      { user_id: 'successor', display_name: 'New owner', role: 'owner' },
      { user_id: 'participant', display_name: 'Friend', role: 'member' },
    ] }))));
    render(<QueryClientProvider client={new QueryClient()}><Theme theme={neutralTheme}><GroupChatControls chat={{ id: 'group', space_id: 'space', title: 'Group', created_by: 'original', role: 'owner', created_at: 1, updated_at: 1 }} onChanged={vi.fn()} /></Theme></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'People' }));
    await screen.findByText('Friend');
    expect(screen.getByRole('button', { name: 'Save name' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disable invite links' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Friend' }));
    expect(screen.getByText(/fresh invitation to return/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirm departure' })).toBeTruthy();
  });
});
