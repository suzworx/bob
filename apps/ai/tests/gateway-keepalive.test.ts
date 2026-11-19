/**
 * #1331 phase 3 unit A: the AI Gateway provider always has its own keep-alive
 * connection pool, and is the SDK's default provider so STT (string model ids)
 * shares that pool. BOB_GATEWAY_KEEPALIVE_MS tunes the idle timeout.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const created = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock('@ai-sdk/gateway', async (orig) => {
  const actual = await orig<typeof import('@ai-sdk/gateway')>();
  return {
    ...actual,
    createGateway: (options: Record<string, unknown>) => {
      created.calls.push(options);
      return actual.createGateway(options);
    },
  };
});

type GlobalWithProvider = typeof globalThis & { AI_SDK_DEFAULT_PROVIDER?: unknown };

async function loadAgents(env: Record<string, string | undefined>): Promise<typeof import('../src/agents.ts')> {
  vi.resetModules();
  created.calls.length = 0;
  vi.stubEnv('BOB_GATEWAY_BASE_URL', undefined);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return import('../src/agents.ts');
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as GlobalWithProvider).AI_SDK_DEFAULT_PROVIDER;
});

describe('gateway keep-alive pool (#1331 unit A)', () => {
  it('hands the provider a fetch and makes it the default provider', async () => {
    const agents = await loadAgents({});
    expect(created.calls).toHaveLength(1);
    expect(Object.keys(created.calls[0]!).sort()).toEqual(['apiKey', 'fetch']);
    expect(created.calls[0]!.fetch).toBeTypeOf('function');
    expect((globalThis as GlobalWithProvider).AI_SDK_DEFAULT_PROVIDER).toBe(agents.gateway);
  });

  it('the fetch reuses one socket across requests a moment apart', async () => {
    await loadAgents({});
    expect(await socketsUsed(created.calls[0]!.fetch as typeof fetch, 50)).toBe(1);
  });

  it('BOB_GATEWAY_KEEPALIVE_MS sets how long an idle socket is kept', async () => {
    // Node's own fetch would keep this socket for 4 s; a 100 ms pool drops it.
    await loadAgents({ BOB_GATEWAY_KEEPALIVE_MS: '100' });
    expect(await socketsUsed(created.calls[0]!.fetch as typeof fetch, 400)).toBe(2);
  });
});

describe('TTS timing fetch wrapper (#1387)', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
  /** A base fetch whose headers arrive at once and whose body ends after `bodyMs`. */
  function slowBodyFetch(bodyMs: number): typeof fetch {
    return (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 3));
          setTimeout(() => {
            controller.enqueue(bytes.slice(3));
            controller.close();
          }, bodyMs);
        },
      });
      return new Response(body, { status: 201, statusText: 'Made', headers: { 'x-probe': 'kept' } });
    }) as unknown as typeof fetch;
  }

  it('marks headers before last_byte, leaves bytes, status and headers untouched', async () => {
    const { ttsTimingStore, withTtsTiming } = await import('../src/gateway.ts');
    const wrapped = withTtsTiming(slowBodyFetch(60));
    const marks: { start?: number; headers?: number; lastByte?: number } = {};
    const response = await ttsTimingStore.run(marks, () => wrapped('https://example.invalid/'));
    expect(marks.headers).toBeTypeOf('number');
    expect(marks.lastByte).toBeUndefined();
    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Made');
    expect(response.headers.get('x-probe')).toBe('kept');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(marks.lastByte).toBeGreaterThanOrEqual(marks.headers! + 40);
  });

  it('is a plain call-through without the store', async () => {
    const { withTtsTiming } = await import('../src/gateway.ts');
    const base = slowBodyFetch(0);
    const response = await withTtsTiming(base)('https://example.invalid/');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
});

/** POSTs twice to a local server, `gapMs` apart, and counts the sockets it saw. */
async function socketsUsed(fetchFn: typeof fetch, gapMs: number): Promise<number> {
  const sockets = new Set<unknown>();
  const server: Server = createServer((req, res) => {
    sockets.add(req.socket);
    req.resume();
    req.on('end', () => res.end('ok'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    // undici frees a socket a tick after the body resolves, so even the
    // shortest gap is a real pause, never back-to-back requests.
    expect(await (await fetchFn(url, { method: 'POST', body: 'x' })).text()).toBe('ok');
    await new Promise((resolve) => setTimeout(resolve, gapMs));
    expect(await (await fetchFn(url, { method: 'POST', body: 'x' })).text()).toBe('ok');
    return sockets.size;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
