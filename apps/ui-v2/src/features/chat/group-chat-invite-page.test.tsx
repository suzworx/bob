import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { GroupChatInvitePage } from './group-chat-invite-page';

vi.mock('@/lib/auth/use-session', () => ({ useSession: () => ({ status: 'signed-in' }), fetchWithAuth: (url: string, init?: RequestInit) => fetch(url, init) }));
vi.mock('@/features/account/sign-in', () => ({ SignIn: () => null }));
vi.mock('@/app/routes', () => ({ groupChatPath: (id: string) => `/groups/${id}`, navigateTo: vi.fn() }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('group invitation', () => {
  it('shows only the preview until the reader explicitly joins', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ title: 'Our group', inviter_name: 'Alex', expires_at: 1893456000000 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ chat: { id: 'group' } })));
    vi.stubGlobal('fetch', request);
    render(<Theme theme={neutralTheme}><GroupChatInvitePage token="invitation-token" /></Theme>);
    await screen.findByText('Our group');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('/api/group-chats/invitations/invitation-token');
    expect(screen.getByText(/earlier messages/)).toBeTruthy();
    expect(screen.queryByRole('log')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Join chat' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1][0]).toBe('/api/group-chats/invitations/invitation-token/accept');
    expect(request.mock.calls[1][1].method).toBe('POST');
  });
});
