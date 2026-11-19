import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleAccountsSection } from './google-accounts-section';
import { BRAND } from '@/lib/brand';

const bob = BRAND.assistantName;

const fetchWithAuth = vi.hoisted(() => vi.fn<typeof fetch>());
HTMLDialogElement.prototype.showModal = function showModal(): void { this.setAttribute('open', ''); };
HTMLDialogElement.prototype.close = function close(): void { this.removeAttribute('open'); };
const owner = vi.hoisted(() => ({ id: 'owner-a' }));
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth, useSession: () => ({ session: { user: { id: owner.id } } }) }));
vi.mock('../../lib/use-refresh-on-focus', () => ({ useRefreshOnFocus: () => 0 }));

const first = { id: '6f9f2b2e-7c1a-4d3e-9a5b-0c1d2e3f4a5b', email: 'a@example.com', name: null, selected: true, createdAt: 1, access: ['calendar.read', 'gmail.read'], needsReconnect: false };
const second = { id: '7a0f3c3f-8d2b-5e4f-ab6c-1d2e3f4a5b6c', email: 'b@example.com', name: null, selected: false, createdAt: 2, access: ['calendar.write', 'calendar.read', 'gmail.read', 'gmail.draft'], needsReconnect: false };
const state = 'a'.repeat(43);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const calls = (suffix: string): unknown[][] => fetchWithAuth.mock.calls.filter(([url]) => String(url).endsWith(suffix));
async function openMenu(email: string): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: `Actions for ${email}` }));
}

beforeEach(() => { fetchWithAuth.mockReset(); owner.id = 'owner-a'; window.history.replaceState(null, '', '/integrations'); });

describe('GoogleAccountsSection', () => {
  it('shows one row per account with what it is used for, and mounts the row menu only when opened', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { accounts: [first, second] }));
    render(<GoogleAccountsSection />);
    expect(await screen.findByText('a@example.com')).toBeTruthy();
    expect(screen.getByText(`${bob} reads your calendar, reads your mail · Used for ${bob}'s Google actions`)).toBeTruthy();
    expect(screen.getByText(`${bob} reads and edits your calendar, reads your mail, composes and updates drafts`)).toBeTruthy();
    expect(screen.queryByRole('menuitem')).toBeNull();
    await openMenu(second.email);
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Tools…', 'Rename…', 'Calendars…', 'Make default', 'Change access…', 'Remove']);
  });

  it('makes another account the default from its menu', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { accounts: [first, second] }))
      .mockResolvedValueOnce(json(200, { account: { ...second, selected: true } }))
      .mockResolvedValueOnce(json(200, { accounts: [{ ...first, selected: false }, { ...second, selected: true }] }));
    render(<GoogleAccountsSection />);
    await openMenu(second.email);
    await userEvent.click(await screen.findByRole('menuitem', { name: /Make default/ }));
    await waitFor(() => expect(screen.getByText(`${bob} reads and edits your calendar, reads your mail, composes and updates drafts · Used for ${bob}'s Google actions`)).toBeTruthy());
    expect(fetchWithAuth).toHaveBeenCalledWith(`/api/google-accounts/${second.id}/select`, { method: 'POST' });
  });

  // P0: Remove used to delete on one tap.
  it('asks before removing, naming the email, and only then deletes', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { accounts: [first, second] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json(200, { accounts: [first] }));
    render(<GoogleAccountsSection />);
    await openMenu(second.email);
    await userEvent.click(await screen.findByRole('menuitem', { name: /Remove/ }));
    expect(screen.getByRole('alertdialog', { name: 'Remove b@example.com?' })).toBeTruthy();
    expect(calls(second.id)).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('b@example.com')).toBeNull());
    expect(fetchWithAuth).toHaveBeenCalledWith(`/api/google-accounts/${second.id}`, { method: 'DELETE' });
  });

  it('cancelling the remove dialog keeps the account', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { accounts: [first] }));
    render(<GoogleAccountsSection />);
    await openMenu(first.email);
    await userEvent.click(await screen.findByRole('menuitem', { name: /Remove/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(screen.getByText('a@example.com')).toBeTruthy();
  });

  // P0: Reconnect always started from read-only, silently dropping write and drafts.
  it('Change access starts from the account current access, so continuing unchanged keeps it', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { accounts: [first, second] })).mockResolvedValueOnce(json(503, {}));
    render(<GoogleAccountsSection />);
    await openMenu(second.email);
    await userEvent.click(await screen.findByRole('menuitem', { name: /Change access/ }));
    expect((screen.getByRole('radio', { name: 'See and edit events' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: /Read mail and manage drafts/ }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await screen.findByText("Couldn't reach Google. Try again.");
    expect(JSON.parse(String(calls('/authorize')[0]?.[1] && (calls('/authorize')[0]?.[1] as RequestInit).body))).toEqual({
      capabilities: ['calendar.read', 'calendar.write', 'gmail.read', 'gmail.draft'], reconnectAccountId: second.id,
    });
  });

  it('a new connection defaults to read for both and sends one level per service', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { accounts: [] })).mockResolvedValueOnce(json(503, {}));
    render(<GoogleAccountsSection />);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Google' }));
    expect((screen.getByRole('radio', { name: 'See events' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: 'Read mail' }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getAllByRole('radio', { name: 'No access' })[0] as HTMLElement);
    await userEvent.click(screen.getByRole('radio', { name: /Read mail and manage drafts/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await screen.findByText("Couldn't reach Google. Try again.");
    expect(JSON.parse(String((calls('/authorize')[0]?.[1] as RequestInit).body))).toEqual({ capabilities: ['gmail.read', 'gmail.draft'] });
  });

  it.each([
    ['Send reviewed drafts', 'gmail.send'],
    ['Move mail to Trash and restore', 'gmail.modify'],
  ])('requires explicit independent consent for %s', async (label, capability) => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { accounts: [] })).mockResolvedValueOnce(json(503, {}));
    render(<GoogleAccountsSection />);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Google' }));
    expect((screen.getByRole('checkbox', { name: 'Send reviewed drafts' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Move mail to Trash and restore' }) as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole('checkbox', { name: label }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await screen.findByText("Couldn't reach Google. Try again.");
    expect(JSON.parse(String((calls('/authorize')[0]?.[1] as RequestInit).body))).toEqual({ capabilities: ['calendar.read', 'gmail.read', capability] });
  });

  it('keeps Gmail access consistent when extra actions are enabled or explicitly removed', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { accounts: [] })).mockResolvedValueOnce(json(503, {}));
    render(<GoogleAccountsSection />);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Google' }));
    await userEvent.click(screen.getAllByRole('radio', { name: 'No access' })[1] as HTMLElement);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Send reviewed drafts' }));
    expect((screen.getByRole('radio', { name: 'Read mail' }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Move mail to Trash and restore' }));
    await userEvent.click(screen.getByRole('radio', { name: /Read mail and manage drafts/ }));
    expect((screen.getByRole('checkbox', { name: 'Send reviewed drafts' }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: 'Read mail' }));
    expect((screen.getByRole('checkbox', { name: 'Move mail to Trash and restore' }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getAllByRole('radio', { name: 'No access' })[1] as HTMLElement);
    expect((screen.getByRole('checkbox', { name: 'Send reviewed drafts' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Move mail to Trash and restore' }) as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await screen.findByText("Couldn't reach Google. Try again.");
    expect(JSON.parse(String((calls('/authorize')[0]?.[1] as RequestInit).body))).toEqual({ capabilities: ['calendar.read'] });
  });

  it('preserves send and Trash grants on reconnect and describes them accurately', async () => {
    const access = ['calendar.read', 'gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify'];
    fetchWithAuth.mockResolvedValueOnce(json(200, { accounts: [{ ...first, access }] })).mockResolvedValueOnce(json(503, {}));
    render(<GoogleAccountsSection />);
    expect(await screen.findByText(/sends drafts when you ask, moves mail to Trash and restores it/)).toBeTruthy();
    await openMenu(first.email);
    await userEvent.click(await screen.findByRole('menuitem', { name: /Change access/ }));
    expect((screen.getByRole('checkbox', { name: 'Send reviewed drafts' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Move mail to Trash and restore' }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await screen.findByText("Couldn't reach Google. Try again.");
    expect(JSON.parse(String((calls('/authorize')[0]?.[1] as RequestInit).body))).toEqual({ capabilities: access, reconnectAccountId: first.id });
  });

  // P0: a failed load also said "No Google account", and the error never cleared.
  it('a failed load shows the error with Retry and no empty state, and clears after a good reload', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(500, {})).mockResolvedValueOnce(json(200, { accounts: [first] }));
    render(<GoogleAccountsSection />);
    expect(await screen.findByText("Couldn't load your Google accounts.")).toBeTruthy();
    expect(screen.queryByText('No Google account')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('a@example.com')).toBeTruthy();
    expect(screen.queryByText("Couldn't load your Google accounts.")).toBeNull();
  });

  // P0: the OAuth return must work wherever the section is mounted, keeping any hash.
  it.each([`/integrations?state=${state}`, `/integrations?state=${state}#google`])('finishes an OAuth return on %s once, even under StrictMode', async (url) => {
    window.history.replaceState(null, '', url);
    const hash = window.location.hash;
    fetchWithAuth.mockImplementation(async (path, init) => {
      if (String(path).endsWith('/callback')) {
        expect(window.location.search).toBe('');
        expect(window.location.hash).toBe(hash);
        expect(JSON.parse(String(init?.body))).toEqual({ state });
        return json(201, { account: second });
      }
      return json(200, { accounts: [second] });
    });
    render(<StrictMode><GoogleAccountsSection /></StrictMode>);
    expect(await screen.findByRole('button', { name: 'Actions for b@example.com' })).toBeTruthy();
    expect(calls('/callback')).toHaveLength(1);
    // Calendar access exists, so Calendars opens next.
    expect(await screen.findByRole('heading', { name: 'Google calendars' })).toBeTruthy();
  });

  it('keeps unrelated query keys when stripping the OAuth return', async () => {
    window.history.replaceState(null, '', `/integrations?tab=x&error=access_denied#google`);
    fetchWithAuth.mockResolvedValue(json(200, { accounts: [] }));
    render(<GoogleAccountsSection />);
    await screen.findByText('No Google account');
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe('/integrations?tab=x#google');
    expect(screen.queryByRole('button', { name: 'Connect again' })).toBeNull();
  });

  it.each(['code=legacy', 'request=legacy', 'state=short', `state=${state}&state=${'b'.repeat(43)}`])('rejects callback %s without exchanging credentials and offers Connect again', async (query) => {
    window.history.replaceState(null, '', `/integrations?${query}`);
    fetchWithAuth.mockResolvedValue(json(200, { accounts: [] }));
    render(<GoogleAccountsSection />);
    expect(await screen.findByText('This Google link is out of date.')).toBeTruthy();
    expect(window.location.search).toBe('');
    expect(calls('/callback')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Connect again' }));
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy();
  });

  it('keeps a failed completion visible after the list finishes', async () => {
    window.history.replaceState(null, '', `/integrations?state=${state}`);
    fetchWithAuth.mockImplementation(async (url) => String(url).endsWith('/callback') ? json(400, {}) : json(200, { accounts: [] }));
    render(<GoogleAccountsSection />);
    expect(await screen.findByText("Couldn't finish connecting Google.")).toBeTruthy();
  });

  it('clears account data and the consent target when the signed-in owner changes', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { accounts: [first] })).mockResolvedValueOnce(json(200, { accounts: [] }));
    const view = render(<GoogleAccountsSection />);
    await openMenu(first.email);
    await userEvent.click(await screen.findByRole('menuitem', { name: /Change access/ }));
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy();
    owner.id = 'owner-b';
    view.rerender(<GoogleAccountsSection />);
    await screen.findByText('No Google account');
    expect(screen.queryByText(first.email)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull();
  });

  it('ignores a previous owner account response after switching owners', async () => {
    let resolveOld: (response: Response) => void = () => undefined;
    fetchWithAuth.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValueOnce(json(200, { accounts: [second] }));
    const view = render(<GoogleAccountsSection />);
    owner.id = 'owner-b'; view.rerender(<GoogleAccountsSection />);
    await screen.findByText(second.email);
    await act(async () => { resolveOld(json(200, { accounts: [first] })); });
    expect(screen.queryByText(first.email)).toBeNull();
  });

  it('flags an account that needs reconnecting and offers Reconnect', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { accounts: [{ ...first, access: [], needsReconnect: true }] }));
    render(<GoogleAccountsSection />);
    expect(await screen.findByText(/Needs reconnecting/)).toBeTruthy();
    await openMenu(first.email);
    expect(await screen.findByRole('menuitem', { name: /Reconnect/ })).toBeTruthy();
  });

  it('saves a name and clears it after retrying a failed reset', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { accounts: [first] }))
      .mockResolvedValueOnce(json(200, { account: { ...first, customName: 'Work' } }))
      .mockResolvedValueOnce(json(503, {}))
      .mockResolvedValueOnce(json(200, { account: { ...first, customName: null } }));
    render(<GoogleAccountsSection />);
    await openMenu(first.email);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    await userEvent.type(screen.getByRole('textbox', { name: /Integration name/ }), 'Work');
    await userEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Work')).toBeTruthy();
    expect(screen.getByText(new RegExp(`a@example.com · ${bob}`))).toBeTruthy();
    expect(fetchWithAuth.mock.calls[1]).toEqual([`/api/google-accounts/${first.id}`, expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ customName: 'Work' }) })]);
    await openMenu(first.email);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    expect((screen.getByRole('textbox', { name: /Integration name/ }) as HTMLInputElement).value).toBe('Work');
    await userEvent.clear(screen.getByRole('textbox', { name: /Integration name/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await screen.findByText("Couldn't save the name. Try again.");
    expect(screen.getByText('Work')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(screen.queryByText('Work')).toBeNull());
    expect(await screen.findByText(first.email)).toBeTruthy();
    expect(fetchWithAuth.mock.calls[3]?.[1]?.body).toBe(JSON.stringify({ customName: null }));
  });

  it('opens the connected account tools without granting more Google access', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { accounts: [first] })).mockResolvedValueOnce(json(200, {
      scope: { scope: 'integration', scopeId: first.id }, canEdit: true,
      tools: [{ id: 'google_gmail_search', toolName: 'google_gmail_search', name: 'Search Gmail', description: 'Find mail.', group: 'Google', integrationKind: 'google', availability: 'context_dependent', enabled: false, preference: false, blockedBy: [{ scope: 'integration', scopeId: first.id }] }],
    }));
    render(<GoogleAccountsSection />);
    await openMenu(first.email);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Tools…' }));
    expect(await screen.findByRole('dialog', { name: 'Tools for a@example.com' })).toBeTruthy();
    const toggle = await screen.findByRole('switch', { name: 'Search Gmail' });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(fetchWithAuth).toHaveBeenCalledWith(`/api/tools?integrationId=${first.id}`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(calls('/authorize')).toHaveLength(0);
  });});
