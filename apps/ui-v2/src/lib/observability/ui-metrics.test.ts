import { afterEach, describe, expect, it, vi } from 'vitest';
import { installUiObservability } from './ui-observability';
import { createUiMetrics } from './ui-metrics';

describe('unsampled UI window counters', () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  function setup(): { observer: ReturnType<typeof installUiObservability>; fetcher: ReturnType<typeof vi.fn<typeof fetch>>; events: () => Array<Record<string, unknown>> } {
    vi.useFakeTimers();
    history.replaceState({}, '', '/');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    const observer = installUiObservability(() => 'private-token');
    stop = observer.dispose;
    const events = (): Array<Record<string, unknown>> => fetcher.mock.calls
      .filter(([url]) => url === '/api/telemetry')
      .flatMap(([, init]) => (JSON.parse(String(init?.body)) as { events: Array<Record<string, unknown>> }).events);
    return { observer, fetcher, events };
  }
  it('counts requests before sampling and reserves capacity after a render flood', async () => {
    const { observer, fetcher, events } = setup();
    for (let i = 0; i < 300; i++) observer.render('update', 1);
    await fetch('/api/chat');
    await vi.advanceTimersByTimeAsync(5000);
    expect(events()).toContainEqual(expect.objectContaining({ event: 'ui_request', outcome: 'ok' }));
    const windows = events().filter((event) => event.event === 'ui_metrics_window');
    expect(windows.reduce((sum, event) => sum + Number(event.requests_ok), 0)).toBe(1);
    expect(windows.reduce((sum, event) => sum + Number(event.events_observed), 0)).toBe(302);
    expect(windows.reduce((sum, event) => sum + Number(event.events_dropped), 0)).toBe(280);
    for (const [url, init] of fetcher.mock.calls) {
      if (url === '/api/telemetry') expect((JSON.parse(String(init?.body)) as { events: unknown[] }).events.length).toBeLessThanOrEqual(20);
    }
  });
  it('separates aborts, failures and successes and counts clipped timings', async () => {
    const { observer, fetcher, events } = setup();
    observer.render('update', 120001);
    await fetch('/api/chat');
    fetcher.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await fetch('/api/chat');
    fetcher.mockRejectedValueOnce(new DOMException('private', 'AbortError'));
    await expect(fetch('/api/chat')).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    expect(events()).toContainEqual(expect.objectContaining({ event: 'ui_metrics_window', requests_ok: 1, requests_error: 1, requests_aborted: 1, timing_overflow: 1 }));
    expect(events()).toContainEqual(expect.objectContaining({ event: 'ui_render', duration_ms: 120000 }));
  });
  it('reports failed HTTP sends next window without retrying details, then stays idle', async () => {
    const { fetcher, events } = setup();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await vi.advanceTimersByTimeAsync(10000);
    expect(events().filter((event) => event.event === 'ui_navigation')).toHaveLength(1);
    expect(events()).toContainEqual(expect.objectContaining({ event: 'ui_metrics_window', batches_failed: 1, events_observed: 0 }));
    const calls = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });
  it('marks mixed page windows other and discards counters when the session ends', async () => {
    const { observer, events } = setup();
    history.pushState({}, '', '/devices');
    window.dispatchEvent(new Event('popstate'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(events()).toContainEqual(expect.objectContaining({ event: 'ui_metrics_window', page: 'other' }));
    observer.render('update', 120001);
    observer.dispose();
    const next = installUiObservability(() => 'next-account');
    stop = next.dispose;
    await vi.advanceTimersByTimeAsync(5000);
    const last = events().filter((event) => event.event === 'ui_metrics_window').at(-1);
    expect(last).toMatchObject({ timing_overflow: 0, requests_ok: 0, events_observed: 1 });
  });
  it('saturates counters and leaves empty windows absent', () => {
    const metrics = createUiMetrics();
    const view = { page: 'chat' as const, view_id: '11111111-1111-4111-8111-111111111111' };
    expect(metrics.take(view)).toBeNull();
    for (let i = 0; i < 1_000_010; i++) metrics.observe({ ...view, event: 'ui_render', phase: 'update', duration_ms: 120001 }, false);
    expect(metrics.take(view)).toMatchObject({ events_observed: 1_000_000, events_dropped: 1_000_000, timing_overflow: 1_000_000 });
    expect(metrics.take(view)).toBeNull();
  });
  it('caps hide flush storms and preserves counters until refill', async () => {
    const { observer, fetcher, events } = setup();
    for (let i = 0; i < 50; i++) {
      observer.render('update', 1);
      window.dispatchEvent(new Event('pagehide'));
    }
    expect(fetcher).toHaveBeenCalledTimes(20);
    await vi.advanceTimersByTimeAsync(60000);
    const windows = events().filter((event) => event.event === 'ui_metrics_window');
    expect(windows.reduce((sum, event) => sum + Number(event.events_observed), 0)).toBe(51);
    expect(windows.reduce((sum, event) => sum + Number(event.events_dropped), 0)).toBe(30);
  });
  it('bounds pending details during a capped flush storm and discards them on disposal', async () => {
    const { observer, fetcher, events } = setup();
    for (let i = 0; i < 60; i++) {
      document.dispatchEvent(new MouseEvent('click'));
      window.dispatchEvent(new Event('pagehide'));
    }
    expect(fetcher).toHaveBeenCalledTimes(20);
    await vi.advanceTimersByTimeAsync(60000);
    const batches = fetcher.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as { events: unknown[] }).events);
    expect(Math.max(...batches.map((batch) => batch.length))).toBe(20);
    const windows = events().filter((event) => event.event === 'ui_metrics_window');
    expect(windows.reduce((sum, event) => sum + Number(event.events_observed), 0)).toBe(61);
    expect(windows.reduce((sum, event) => sum + Number(event.events_dropped), 0)).toBe(21);
    document.dispatchEvent(new MouseEvent('click'));
    observer.dispose();
    const count = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetcher).toHaveBeenCalledTimes(count);
  });
  it('counts missing credentials as a failed batch without retaining its details', async () => {
    const { observer, events } = setup();
    observer.dispose();
    let bearer: string | null = null;
    const next = installUiObservability(() => bearer);
    stop = next.dispose;
    await vi.advanceTimersByTimeAsync(5000);
    expect(events()).toHaveLength(0);
    bearer = 'token-restored';
    await vi.advanceTimersByTimeAsync(5000);
    expect(events()).toEqual([expect.objectContaining({ event: 'ui_metrics_window', batches_failed: 1, events_observed: 0 })]);
  });
});
