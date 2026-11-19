import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { GroupChatPage } from './group-chat-page';

const shell = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@astryxdesign/core/AppShell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@astryxdesign/core/AppShell')>();
  return { ...actual, useAppShellMobile: () => ({ ...actual.useAppShellMobile(), isMobile: shell.isMobile }) };
});
vi.mock('@/lib/auth/use-session', () => ({ useSession: () => ({ session: { user: { id: 'reader' } } }), fetchWithAuth: (url: string, init?: RequestInit) => fetch(url, init) }));
vi.mock('@/features/spaces/group-thread-content', () => ({
  GroupThreadContent: ({ phoneActions }: { phoneActions?: unknown }) => <div role="log" data-actions={String(Boolean(phoneActions))}>Shared transcript</div>,
}));
vi.mock('./group-chat-controls', () => ({
  GroupChatControls: ({ showButton }: { showButton?: boolean }) => (showButton ? <button type="button">People</button> : null),
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); shell.isMobile = false; });

function renderPage(): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ chat: { id: 'group', space_id: 'audience', title: 'Group' } }))));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Theme theme={neutralTheme}><GroupChatPage chatId="group" /></Theme></QueryClientProvider>);
}

describe('group access removal', () => {
  it('immediately hides the shared transcript when the account deletion event arrives', async () => {
    renderPage();
    await screen.findByRole('log');
    act(() => window.dispatchEvent(new CustomEvent('bob:group-chat-updated', { detail: { conversationId: 'group', deleted: true } })));
    expect(screen.queryByRole('log')).toBeNull();
    expect(screen.getByText(/fresh invitation/)).toBeTruthy();
  });
});

describe('group chat header', () => {
  it('keeps the People button in the desktop header', async () => {
    renderPage();
    await screen.findByRole('log');
    expect(screen.getByRole('button', { name: 'People' })).toBeTruthy();
    expect(screen.getByRole('log').getAttribute('data-actions')).toBe('false');
  });
  it('puts People on the composer top row on a phone and keeps the heading', async () => {
    shell.isMobile = true;
    renderPage();
    await screen.findByRole('log');
    expect(screen.queryByRole('button', { name: 'People' })).toBeNull();
    expect(screen.getByRole('log').getAttribute('data-actions')).toBe('true');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Group');
  });
});
