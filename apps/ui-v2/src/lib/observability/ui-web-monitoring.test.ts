import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installUiObservability } from './ui-observability';

type VitalCallback = (metric: { name: string; value: number; rating: string }) => void;
const vitals = vi.hoisted(() => ({ callbacks: new Map<string, VitalCallback>() }));
vi.mock('web-vitals', () => {
  const on = (name: string) => (callback: VitalCallback) => { vitals.callbacks.set(name, callback); };
  return { onLCP: on('LCP'), onINP: on('INP'), onCLS: on('CLS'), onFCP: on('FCP'), onTTFB: on('TTFB') };
});

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;

describe('web monitoring', () => {
  const fetcher = vi.fn<typeof fetch>();
  let stop: (() => void) | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    // A random UUID can contain the payload canary 'abc' by coincidence.
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
    history.replaceState({}, '', '/');
    fetcher.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
  });
  afterEach(() => { stop?.(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  async function start(): Promise<void> {
    stop = installUiObservability(() => 'secret-token').dispose;
    await vi.advanceTimersByTimeAsync(0);
  }
  async function sent(): Promise<Array<Record<string, unknown>>> {
    await vi.advanceTimersByTimeAsync(5000);
    return fetcher.mock.calls.filter(([url, init]) => url === '/api/telemetry' && init?.body)
      .flatMap(([, init]) => (JSON.parse(String(init?.body)) as { events: Array<Record<string, unknown>> }).events);
  }
  function fail(kind: 'error' | 'unhandledrejection', value: unknown): void {
    if (kind === 'error') window.dispatchEvent(Object.assign(new Event('error'), { error: value, message: 'private message' }));
    else window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: value }));
  }

  it('gives a same-origin API request a traceparent whose trace id lands on its ui_request event', async () => {
    await start();
    await fetch('/api/tasks/private-task');
    const headers = new Headers(fetcher.mock.calls.find(([url]) => url === '/api/tasks/private-task')?.[1]?.headers);
    const match = TRACEPARENT.exec(headers.get('traceparent') ?? '');
    expect(match).not.toBeNull();
    const request = (await sent()).find((event) => event.event === 'ui_request');
    expect(request?.trace_id).toBe(match?.[1]);
  });

  it('sends no traceparent to a cross-origin request', async () => {
    await start();
    await fetch('https://example.com/api/tasks');
    expect(new Headers(fetcher.mock.calls.find(([url]) => url === 'https://example.com/api/tasks')?.[1]?.headers).has('traceparent')).toBe(false);
  });

  it('reports each web vital as a strict event, CLS as an integer times 1000', async () => {
    await start();
    vitals.callbacks.get('LCP')?.({ name: 'LCP', value: 2512.4, rating: 'needs-improvement' });
    vitals.callbacks.get('CLS')?.({ name: 'CLS', value: 0.1234, rating: 'good' });
    const events = await sent();
    expect(events).toContainEqual(expect.objectContaining({ event: 'web_vital', name: 'LCP', value: 2512, rating: 'needs-improvement', route: '/' }));
    expect(events).toContainEqual(expect.objectContaining({ event: 'web_vital', name: 'CLS', value: 123, rating: 'good' }));
  });

  it('reports an error by constructor name only: never the message, the stack text or a query string', async () => {
    // view_id is a random hex UUID that can contain "abc"; pin it so the privacy match below is deterministic.
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
    await start();
    const error = new TypeError('private message token=abc');
    error.stack = `TypeError: private message token=abc\n    at run (${location.origin}/assets/index-Ab12.js?token=abc:10:20)\n    at other (https://cdn.example/x.js:1:2)`;
    fail('error', error);
    const [event] = (await sent()).filter((e) => e.event === 'ui_error');
    expect(event).toMatchObject({ event: 'ui_error', kind: 'error', error_name: 'TypeError', frame: 'index-Ab12.js:10:20', route: '/' });
    expect(JSON.stringify(event)).not.toMatch(/private|token|abc|http/);
  });

  it('omits the frame when the top frame is foreign, and names a non-Error rejection Error', async () => {
    await start();
    const foreign = new RangeError('x');
    foreign.stack = 'RangeError: x\n    at f (https://cdn.example/lib.js:3:4)';
    fail('error', foreign);
    fail('unhandledrejection', 'a typed string');
    const events = (await sent()).filter((e) => e.event === 'ui_error');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ error_name: 'RangeError' });
    expect(events[0]).not.toHaveProperty('frame');
    expect(events[1]).toMatchObject({ kind: 'rejection', error_name: 'Error' });
  });

  it('dedupes identical name and frame and sends at most 10 errors a minute', async () => {
    await start();
    for (let i = 0; i < 5; i++) fail('error', new TypeError('same'));
    expect((await sent()).filter((e) => e.event === 'ui_error')).toHaveLength(1);
    class Variant extends Error {}
    for (let i = 0; i < 30; i++) {
      const error = new Variant('x');
      Object.defineProperty(error, 'constructor', { value: { name: `Kind${'abcdefghijklmnopqrstuvwxyzABCDEFGH'[i]}` } });
      fail('error', error);
    }
    expect((await sent()).filter((e) => e.event === 'ui_error')).toHaveLength(10);
  });

  it('does not collect web vitals or errors on the anonymous lane', async () => {
    const observer = installUiObservability(() => null, { anonymous: true });
    stop = observer.dispose;
    await vi.advanceTimersByTimeAsync(0);
    vitals.callbacks.get('FCP')?.({ name: 'FCP', value: 900, rating: 'good' });
    const ignore = (event: Event): void => event.preventDefault();
    window.addEventListener('error', ignore);
    fail('error', new TypeError('x'));
    window.removeEventListener('error', ignore);
    const events = await sent();
    expect(events.some((e) => e.event === 'web_vital' || e.event === 'ui_error')).toBe(false);
  });
});
