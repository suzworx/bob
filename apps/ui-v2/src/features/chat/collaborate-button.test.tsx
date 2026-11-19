import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { CollaborateButton } from './collaborate-button';

const shell = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@astryxdesign/core/AppShell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@astryxdesign/core/AppShell')>();
  return { ...actual, useAppShellMobile: () => ({ ...actual.useAppShellMobile(), isMobile: shell.isMobile }) };
});
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth: (url: string, init?: RequestInit) => fetch(url, init) }));
vi.mock('@/app/routes', () => ({ groupChatPath: (id: string) => `/groups/${id}`, navigateTo: vi.fn() }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(): void { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function close(): void { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); shell.isMobile = false; });

describe('private chat collaboration consent', () => {
  it('keeps the compact phone action named and opens the consent dialog', () => {
    shell.isMobile = true;
    render(<Theme theme={neutralTheme}><CollaborateButton conversationId="private-chat" /></Theme>);
    const button = screen.getByRole('button', { name: 'Add people' });
    expect(button.getAttribute('aria-label')).toBe('Add people');
    fireEvent.click(button);
    expect(screen.getByText(/original stays private/i)).toBeTruthy();
  });
  it('creates a new empty group without selecting a private conversation', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ chat: { id: 'new-group' } }), { status: 201 }));
    vi.stubGlobal('fetch', request);
    render(<Theme theme={neutralTheme}><CollaborateButton /></Theme>);
    fireEvent.click(screen.getByRole('button', { name: 'Add people' }));
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Create chat' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(JSON.parse(request.mock.calls[0][1].body)).not.toHaveProperty('source_conversation_id');
  });
  it('does not copy history when opening or dismissing the dialog', () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    render(<Theme theme={neutralTheme}><CollaborateButton conversationId="private-chat" /></Theme>);
    fireEvent.click(screen.getByRole('button', { name: 'Add people' }));
    expect(screen.getByText(/original stays private/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(request).not.toHaveBeenCalled();
  });

  it('requires a separate text-only choice after unsupported history', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'unsupported_history', message: 'Choose text only' } }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ chat: { id: 'group-chat' } }), { status: 201 }));
    vi.stubGlobal('fetch', request);
    render(<Theme theme={neutralTheme}><CollaborateButton conversationId="private-chat" /></Theme>);
    fireEvent.click(screen.getByRole('button', { name: 'Add people' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create chat' }));
    await screen.findByRole('button', { name: 'Copy text only' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(request.mock.calls[0][1].body)).not.toHaveProperty('text_only');
    fireEvent.click(screen.getByRole('button', { name: 'Copy text only' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(JSON.parse(request.mock.calls[1][1].body)).toMatchObject({ source_conversation_id: 'private-chat', text_only: true });
    expect(JSON.parse(request.mock.calls[1][1].body).request_id).toBe(JSON.parse(request.mock.calls[0][1].body).request_id);
  });
});
