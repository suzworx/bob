import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

describe('anonymous authentication outcome delivery', () => {
  const fetcher = vi.fn<typeof fetch>();
  let registrations: MockInstance<Window['addEventListener']>;
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    fetcher.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    registrations = vi.spyOn(window, 'addEventListener');
  });
  afterEach(() => {
    for (const [event, listener] of registrations.mock.calls) if (event === 'pagehide') window.removeEventListener(event, listener);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  function batch(index: number): Array<Record<string, unknown>> {
    return (JSON.parse(String(fetcher.mock.calls[index]?.[1]?.body)) as { events: Array<Record<string, unknown>> }).events;
  }
  it('keeps failed authentication outcomes after navigation and selects only fixed safe fields', async () => {
    const { reportUiAuth } = await import('./ui-auth-events');
    reportUiAuth({ operation: 'signInWithPassword', outcome: 'error', duration_ms: 12.4,
      ...{ password: 'private-value', page: 'account', error: new Error('private-error') } });
    history.replaceState({}, '', '/account?private-url');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/telemetry/anonymous');
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has('Authorization')).toBe(false);
    expect(batch(0)).toEqual([expect.objectContaining({ event: 'ui_auth', operation: 'signInWithPassword', outcome: 'error', duration_ms: 12 })]);
    expect(JSON.stringify(batch(0))).not.toMatch(/private-|password|page|account/);
  });
  it('reports failed batch loss on the next outcome and marks duration overflow instead of clipping latency', async () => {
    const { reportUiAuth } = await import('./ui-auth-events');
    fetcher.mockResolvedValueOnce(new Response(null, { status: 500 }));
    reportUiAuth({ operation: 'verifyOtp', outcome: 'error', duration_ms: 604_800_001 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(batch(0)[0]).toMatchObject({ duration_ms: 0, duration_overflow: true });
    reportUiAuth({ operation: 'signOut', outcome: 'ok', duration_ms: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(batch(1)[0]).toMatchObject({ events_dropped: 1, batches_failed: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('bounds pending outcomes during a hung batch and accurately carries dropped counts forward', async () => {
    const { reportUiAuth } = await import('./ui-auth-events');
    let resolve: (response: Response) => void = () => undefined;
    fetcher.mockReturnValueOnce(new Promise<Response>((finish) => { resolve = finish; }));
    for (let i = 0; i < 30; i++) reportUiAuth({ operation: 'refreshSession', outcome: 'error', duration_ms: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(batch(0)).toHaveLength(10);
    resolve(new Response(null, { status: 204 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(batch(1)).toHaveLength(10);
    expect(batch(1)[0]).toMatchObject({ events_dropped: 10, batches_failed: 0 });
  });
});
