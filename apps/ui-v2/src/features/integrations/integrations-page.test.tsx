import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { BRAND } from '@/lib/brand';
import { IntegrationsPage } from './integrations-page';

const fetchWithAuth = vi.hoisted(() => vi.fn<typeof fetch>());
HTMLDialogElement.prototype.showModal = function showModal(): void { this.setAttribute('open', ''); };
HTMLDialogElement.prototype.close = function close(): void { this.removeAttribute('open'); };
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth, useSession: () => ({ session: { user: { id: 'owner' } } }) }));
vi.mock('../../lib/use-refresh-on-focus', () => ({ useRefreshOnFocus: () => 0 }));

const account = { id: '7a0f3c3f-8d2b-5e4f-ab6c-1d2e3f4a5b6c', email: 'b@example.com', name: null, selected: true, createdAt: 1, access: ['gmail.read'], needsReconnect: false };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => { fetchWithAuth.mockReset(); window.history.replaceState(null, '', '/integrations'); });

it('shows the Integrations title, its description and the Google section under it', async () => {
  fetchWithAuth.mockResolvedValue(json(200, { accounts: [account] }));
  render(<IntegrationsPage />);
  expect(screen.getByRole('heading', { level: 1, name: 'Integrations' })).toBeTruthy();
  expect(screen.getByText(`Accounts ${BRAND.assistantName} can use for you. Only you can see these.`)).toBeTruthy();
  expect(screen.getByRole('heading', { level: 2, name: 'Google' })).toBeTruthy();
  expect(await screen.findByRole('button', { name: 'Actions for b@example.com' })).toBeTruthy();
});

it('finishes a Google return that lands on /integrations', async () => {
  const state = 'a'.repeat(43);
  window.history.replaceState(null, '', `/integrations?state=${state}`);
  fetchWithAuth.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/callback')) {
      expect(JSON.parse(String(init?.body))).toEqual({ state });
      return json(201, { account });
    }
    return json(200, { accounts: [account] });
  });
  render(<IntegrationsPage />);
  expect(await screen.findByText('Connected b@example.com')).toBeTruthy();
  expect(`${window.location.pathname}${window.location.search}`).toBe('/integrations');
  expect(fetchWithAuth.mock.calls.filter(([url]) => String(url).endsWith('/callback'))).toHaveLength(1);
});
