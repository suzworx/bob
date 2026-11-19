import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listGoogleAccounts, finishGoogleAuthorization, readGoogleCallback, renameGoogleAccount, startGoogleAuthorization, withoutGoogleCallback } from './google-accounts-api';

const fetchWithAuth = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));
beforeEach(() => fetchWithAuth.mockReset());
const state = 'a'.repeat(43);

describe('Google account authorization contract', () => {
  it('accepts an account response containing all six explicitly granted capabilities', async () => {
    const account = { id: '6f9f2b2e-7c1a-4d3e-9a5b-0c1d2e3f4a5b', email: 'a@example.com', name: null,
      customName: null, selected: true, createdAt: 1, needsReconnect: false,
      access: ['calendar.read', 'calendar.write', 'gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify'] };
    fetchWithAuth.mockResolvedValueOnce(Response.json({ accounts: [account] }));
    await expect(listGoogleAccounts()).resolves.toEqual([account]);
  });
  it('validates a custom name before posting and rejects malformed account replies', async () => {
    await expect(renameGoogleAccount('account', 'x'.repeat(61))).rejects.toThrow();
    expect(fetchWithAuth).not.toHaveBeenCalled();
    fetchWithAuth.mockResolvedValueOnce(Response.json({ account: {} }));
    await expect(renameGoogleAccount('account', ' Work ')).rejects.toThrow();
    expect(fetchWithAuth.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ customName: 'Work' }));
  });
  it('sends capabilities and optional reconnect account to authorize', async () => {
    fetchWithAuth.mockResolvedValue(Response.json({ url: 'https://connect.vercel.com/authorize', expiresAt: Date.now() + 60000 }));
    const input = { capabilities: ['gmail.read' as const], reconnectAccountId: '6f9f2b2e-7c1a-4d3e-9a5b-0c1d2e3f4a5b' };
    await expect(startGoogleAuthorization(input)).resolves.toBe('https://connect.vercel.com/authorize');
    expect(JSON.parse(String(fetchWithAuth.mock.calls[0]?.[1]?.body))).toEqual(input);
  });
  it.each(['javascript:alert(1)', 'http://example.com', 'https://user:password@example.com'])('refuses unsafe redirect %s', async (url) => {
    fetchWithAuth.mockResolvedValue(Response.json({ url, expiresAt: Date.now() + 60000 }));
    await expect(startGoogleAuthorization({ capabilities: ['calendar.read'] })).rejects.toThrow();
  });
  it('refuses expired authorization', async () => {
    fetchWithAuth.mockResolvedValue(Response.json({ url: 'https://connect.vercel.com/authorize', expiresAt: 1 }));
    await expect(startGoogleAuthorization({ capabilities: ['calendar.read'] })).rejects.toThrow('authorize_expired');
  });
  it('requires explicit capabilities', async () => {
    await expect(startGoogleAuthorization({ capabilities: [] })).rejects.toThrow();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
  it('posts only validated state to complete authorization', async () => {
    fetchWithAuth.mockResolvedValue(Response.json({}));
    await finishGoogleAuthorization(state);
    expect(JSON.parse(String(fetchWithAuth.mock.calls[0]?.[1]?.body))).toEqual({ state });
    await expect(finishGoogleAuthorization('')).rejects.toThrow();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });
  it('parses state without accepting code or request as proof', () => {
    expect(readGoogleCallback(`?state=${state}`)).toEqual({ state });
    expect(readGoogleCallback(`?state=${state}&request=old`)).toEqual({ error: 'invalid' });
    expect(readGoogleCallback(`?state=${state}&code=old`)).toEqual({ error: 'invalid' });
    expect(readGoogleCallback(`?state=${state}&error=access_denied`)).toEqual({ error: 'cancelled' });
    expect(readGoogleCallback('?page=1')).toBeNull();
  });
  it('does not surface raw provider error text', () => {
    expect(readGoogleCallback('?error=private-provider-text')).toEqual({ error: 'failed' });
  });
  it('strips only the OAuth keys, keeping other query and the hash', () => {
    expect(withoutGoogleCallback({ pathname: '/integrations', search: `?state=${state}&tab=x`, hash: '#google' })).toBe('/integrations?tab=x#google');
    expect(withoutGoogleCallback({ pathname: '/gmail', search: `?state=${state}`, hash: '' })).toBe('/gmail');
  });
});
