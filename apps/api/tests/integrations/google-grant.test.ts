import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyGoogleGrant } from '../../src/integrations/google-grant.ts';

const token = 'secret-token';
const options = { expectedClientId: 'client', expectedProviderAccountId: 'account' };
const info = { aud: 'client', azp: 'client', sub: 'account', expires_in: '3600', scope: 'openid https://www.googleapis.com/auth/gmail.readonly' };
const user = { sub: 'account', email: 'test@example.com', email_verified: true, name: 'Test' };
function responses(first: unknown = info, second: unknown = user): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(first)).mockResolvedValueOnce(Response.json(second));
}
afterEach(() => { vi.useRealTimers(); });

describe('Google grant verification', () => {
  it('verifies client and stable identity and returns only actual capabilities', async () => {
    const fetchImpl = responses();
    await expect(verifyGoogleGrant(token, options, fetchImpl)).resolves.toEqual({ providerAccountId: 'account', email: user.email, name: 'Test', capabilities: ['gmail.read'] });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://oauth2.googleapis.com/tokeninfo');
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}` } });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://openidconnect.googleapis.com/v1/userinfo');
    expect(JSON.stringify(fetchImpl.mock.calls.map(([url]) => url))).not.toContain(token);
  });
  it.each([{ aud: 'foreign' }, { azp: 'foreign' }, { sub: 'foreign' }])('rejects token identity mismatch %j', async (change) => {
    await expect(verifyGoogleGrant(token, options, responses({ ...info, ...change }))).rejects.toMatchObject({ code: 'reconnect_required' });
  });
  it('rejects a different expected account', async () => {
    await expect(verifyGoogleGrant(token, { ...options, expectedProviderAccountId: 'other' }, responses())).rejects.toMatchObject({ code: 'reconnect_required' });
  });
  it.each([0, -1, '0', 'garbage', null])('rejects invalid expiry %j', async (expires_in) => {
    await expect(verifyGoogleGrant(token, options, responses({ ...info, expires_in }))).rejects.toThrow('google_credentials_');
  });
  it('returns an empty grant without promoting metadata or identity scopes', async () => {
    await expect(verifyGoogleGrant(token, options, responses({ ...info, scope: 'openid email https://www.googleapis.com/auth/gmail.metadata' }))).resolves.toMatchObject({ capabilities: [] });
  });
  it.each([{ email_verified: false }, { email: 'invalid' }, { sub: undefined }])('rejects invalid user info %j', async (change) => {
    await expect(verifyGoogleGrant(token, options, responses(info, { ...user, ...change }))).rejects.toThrow('google_credentials_');
  });
  it('bounds streamed responses without relying on content length', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(32769)));
    await expect(verifyGoogleGrant(token, options, fetchImpl)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('sanitizes malformed responses and transport failures', async () => {
    for (const fetchImpl of [vi.fn<typeof fetch>().mockResolvedValue(new Response(token)), vi.fn<typeof fetch>().mockRejectedValue(new Error(token))]) {
      await expect(verifyGoogleGrant(token, options, fetchImpl)).rejects.toThrow(/^google_credentials_unavailable$/);
    }
  });
  it.each([302, 500, 401])('rejects HTTP status %s without reading the response error', async (status) => {
    await expect(verifyGoogleGrant(token, options, vi.fn<typeof fetch>().mockResolvedValue(new Response(token, { status })))).rejects.toThrow(/^google_credentials_(unavailable|reconnect_required)$/);
  });
  it('does not call Google when already aborted', async () => {
    const fetchImpl = responses();
    await expect(verifyGoogleGrant(token, { ...options, signal: AbortSignal.abort() }, fetchImpl)).rejects.toMatchObject({ code: 'unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('bounds an uncooperative fetch and consumes its late rejection', async () => {
    vi.useFakeTimers();
    let rejectLate: (error: Error) => void = () => undefined;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise((_resolve, reject) => { rejectLate = reject; }));
    const assertion = expect(verifyGoogleGrant(token, options, fetchImpl)).rejects.toMatchObject({ code: 'unavailable' });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    rejectLate(new Error(token));
    await Promise.resolve();
  });
  it('cancels an in-flight fetch immediately', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const assertion = expect(verifyGoogleGrant(token, { ...options, signal: controller.signal }, fetchImpl)).rejects.toMatchObject({ code: 'unavailable' });
    controller.abort();
    await assertion;
  });
  it('bounds a stalled response body and cancels its reader', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    const assertion = expect(verifyGoogleGrant(token, options, fetchImpl)).rejects.toMatchObject({ code: 'unavailable' });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    expect(cancel).toHaveBeenCalled();
  });
  it('rejects a token that expires while identity is being checked', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ...info, expires_in: 1 }))
      .mockImplementationOnce(async () => { await new Promise((resolve) => setTimeout(resolve, 2000)); return Response.json(user); });
    const assertion = expect(verifyGoogleGrant(token, options, fetchImpl)).rejects.toMatchObject({ code: 'reconnect_required' });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
  });
});
