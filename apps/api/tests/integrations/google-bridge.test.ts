import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGoogleBridge } from '../../src/integrations/google-bridge.ts';

const subject = 'a'.repeat(43);
const secret = 's'.repeat(48);
describe('Google server bridge', () => {
  afterEach(() => vi.useRealTimers());
  it('allows identity-only token inspection but not empty authorization intent', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ token: 'provider-token', expiresAt: 2000000000 }));
    const bridge = createGoogleBridge({ url: 'https://example.com', secret, fetch: fetcher });
    await expect(bridge.token(subject, [])).resolves.toHaveProperty('token', 'provider-token');
    expect(() => bridge.authorize(subject, [], 'https://app.example.com/gmail')).toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('sends credentials only to its configured HTTPS endpoint without redirects', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ token: 'provider-token', expiresAt: 2000000000 }));
    const bridge = createGoogleBridge({ url: 'https://example.vercel.app/internal/integrations/google', secret, fetch: fetcher });
    await expect(bridge.token(subject, ['gmail.read'])).resolves.toEqual({ token: 'provider-token', expiresAt: 2000000000 });
    expect(fetcher).toHaveBeenCalledWith('https://example.vercel.app/internal/integrations/google', expect.objectContaining({
      method: 'POST', redirect: 'error', cache: 'no-store',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'token', subject, capabilities: ['gmail.read'] }),
    }));
  });
  it('rejects insecure configuration before sending credentials', () => {
    for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/?secret=x']) {
      expect(() => createGoogleBridge({ url, secret })).toThrow('google_credentials_unavailable');
    }
  });
  it('does not echo upstream secrets or malformed token responses', async () => {
    for (const response of [Response.json({ error: 'SECRET' }, { status: 500 }), Response.json({ token: 'SECRET' }), new Response('x'.repeat(32769))]) {
      const bridge = createGoogleBridge({ url: 'https://example.com', secret, fetch: vi.fn<typeof fetch>().mockResolvedValue(response) });
      await expect(bridge.token(subject, ['gmail.read'])).rejects.toThrow('google_credentials_unavailable');
    }
  });
  it('preserves only actionable safe broker errors', async () => {
    const bridge = createGoogleBridge({ url: 'https://example.com', secret, fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: 'reconnect_required' } }, { status: 403 })) });
    await expect(bridge.token(subject, ['gmail.read'])).rejects.toMatchObject({ code: 'reconnect_required' });
  });
  it('bounds a fetch that ignores cancellation', async () => {
    vi.useFakeTimers();
    const bridge = createGoogleBridge({ url: 'https://example.com', secret, timeoutMs: 25, fetch: () => new Promise<Response>(() => undefined) });
    const result = expect(bridge.token(subject, ['gmail.read'])).rejects.toMatchObject({ code: 'unavailable' });
    await vi.advanceTimersByTimeAsync(25);
    await result;
  });
  it('does not send a request when already cancelled', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const bridge = createGoogleBridge({ url: 'https://example.com', secret, fetch: fetcher });
    await expect(bridge.token(subject, ['gmail.read'], AbortSignal.abort())).rejects.toMatchObject({ code: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
