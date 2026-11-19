import { createServer, get, type Server } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindDiagnosticContext, currentDiagnosticTraceId, recordObservationMetrics, traceSpan, updateActiveSpanMetadata } from '@bob/ai';
import { httpDiagnostics } from '../../src/platform/observability/http-diagnostics.ts';
import { createHttpRouteInventory } from '../../src/platform/observability/http-route-inventory.ts';
import { createJwtWebAuthGuard, TokenVerificationError } from '../../src/platform/http/auth-guard.ts';
import { createCorsMiddleware } from '../../src/platform/http/cors.ts';
import { createApiRateLimitMiddleware } from '../../src/platform/http/rate-limit.ts';
import { webErrorHandler } from '../../src/platform/http/errors.ts';

vi.mock('@bob/ai', async (original) => ({
  ...(await original<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, fn: () => unknown) => fn()),
  recordObservationMetrics: vi.fn(),
  bindDiagnosticContext: vi.fn((fn: () => void) => fn),
  updateActiveSpanMetadata: vi.fn(),
  currentDiagnosticTraceId: vi.fn(() => undefined),
}));
const servers: Server[] = [];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
beforeEach(() => {
  vi.mocked(traceSpan).mockImplementation(async (_name, _attrs, fn) => fn());
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function diagnosed(clock?: () => number): express.Express {
  const app = express();
  app.use(httpDiagnostics(createHttpRouteInventory(app), clock));
  return app;
}
describe('HTTP response diagnostics', () => {
  it('keeps the request parent active across asynchronous handler work', async () => {
    const scope = new AsyncLocalStorage<string>();
    vi.mocked(traceSpan).mockImplementation((name, _attrs, fn) => Promise.resolve(scope.run(name, fn)));
    const app = express();
    const inventory = createHttpRouteInventory(app);
    app.use(httpDiagnostics(inventory));
    let parent: string | undefined;
    app.get('/api/items/:id', async (_request, response) => {
      await Promise.resolve();
      parent = scope.getStore();
      response.end();
    });
    await fetch(`${await listen(app)}/api/items/private-id`);
    expect(parent).toBe('http GET /api/items/:id');
  });
  it.each([200, 404, 503])('records registered nested route and status %i without URL values', async (status) => {
    const app = diagnosed();
    const router = express.Router();
    router.get('/:id', (_req, res) => res.status(status).end());
    app.use('/api/devices', router);
    await fetch(`${await listen(app)}/api/devices/private-id?secret=private-secret`);
    expect(traceSpan).toHaveBeenCalledTimes(1);
    expect(traceSpan).toHaveBeenCalledWith('http GET /api/devices/:id', expect.objectContaining({
      startTime: expect.any(Date), metadata: expect.objectContaining({ route_template: '/api/devices/:id' }),
    }), expect.any(Function));
    expect(updateActiveSpanMetadata).toHaveBeenCalledWith(expect.objectContaining({ http_status: String(status) }));
    expect(JSON.stringify(vi.mocked(traceSpan).mock.calls)).not.toMatch(/private-id|private-secret/);
    expect(recordObservationMetrics).toHaveBeenCalledWith(expect.arrayContaining([
      { name: 'http.request.server_error', value: Number(status >= 500) },
      { name: 'http.request.client_error', value: Number(status >= 400 && status < 500) },
    ]));
  });
  it('resolves early middleware rejection and uses a fixed fallback for unmatched paths', async () => {
    const app = diagnosed();
    app.use((_req, res) => res.status(401).end());
    app.get('/api/devices/:id', (_req, res) => res.end());
    const origin = await listen(app);
    await fetch(`${origin}/api/devices/private-id?token=secret`);
    expect(traceSpan).toHaveBeenCalledWith('http GET /api/devices/:id', expect.anything(), expect.any(Function));
    await fetch(`${origin}/private-email@example.com?token=secret`);
    expect(traceSpan).toHaveBeenCalledWith('http GET unmatched', expect.anything(), expect.any(Function));
  });
  it('leaves the request root to the JWT guard for identity: no id from the query or a header reaches the span', async () => {
    const app = diagnosed();
    let finish: (() => void) | undefined;
    app.use('/api', createJwtWebAuthGuard(async () => {
      await Promise.resolve();
      return { userId: 'account-uuid', sessionId: 'private-session-uuid', exp: 1 };
    }));
    app.get('/api/me', (_request, response) => {
      response.write('first');
      finish = () => response.end('last');
    });
    app.get('/health', (_req, res) => res.end());
    const url = await listen(app);
    const response = await fetch(`${url}/api/me?userId=private-query-user`, { headers: {
      authorization: 'Bearer private-token', 'X-Bob-Ui-Action-Id': '11111111-1111-4111-8111-111111111111',
      'X-Bob-User-Id': 'private-header-user',
    } });
    finish?.();
    await response.text();
    expect(traceSpan).toHaveBeenCalledTimes(1);
    expect(vi.mocked(traceSpan).mock.calls[0]?.[1]).not.toHaveProperty('userId');
    expect(recordObservationMetrics).toHaveBeenCalledTimes(1);
    await fetch(`${url}/health?userId=private-query-user`, { headers: { 'X-Bob-User-Id': 'private-header-user' } });
    expect(traceSpan).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(traceSpan).mock.calls)).not.toContain('private-');
  });
  it('completes a workflow route after its authenticated service returns, with identity from the guard\'s context, and leaves rejection anonymous', async () => {
    const app = diagnosed();
    app.use('/api', createJwtWebAuthGuard(async () => ({ userId: 'account-uuid', sessionId: 'private-session-uuid', exp: 1 })));
    app.post('/api/threads/:id/invocations', async (_request, response) => {
      await traceSpan('thread-invocation', { workflowNamespace: 'invocation', workflowId: 'server-workflow', userId: 'account-uuid' }, () => undefined);
      response.status(202).end();
    });
    const url = `${await listen(app)}/api/threads/private-thread/invocations?userId=private-user`;
    expect((await fetch(url, { method: 'POST', headers: { authorization: 'Bearer private-token' } })).status).toBe(202);
    const completion = vi.mocked(traceSpan).mock.calls.find(([name]) => name === 'http POST /api/threads/:id/invocations');
    expect(completion?.[1]).toMatchObject({ metadata: { http_status: '202' } });
    expect(completion?.[1]).not.toHaveProperty('userId');
    expect(traceSpan).toHaveBeenCalledTimes(2);
    expect(recordObservationMetrics).toHaveBeenCalledTimes(1);
    expect((await fetch(url, { method: 'POST', headers: { 'X-Bob-User-Id': 'private-user' } })).status).toBe(401);
    expect(vi.mocked(traceSpan).mock.lastCall?.[1]).not.toHaveProperty('userId');
    expect(traceSpan).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(vi.mocked(traceSpan).mock.calls)).not.toContain('private-');
  });
  it('still completes the original observation for an authenticated request', async () => {
    const app = diagnosed();
    app.use(createJwtWebAuthGuard(async () => ({ userId: 'account-uuid', sessionId: 'private-session-uuid', exp: 1 })));
    app.get('/api/me', (_request, response) => response.status(204).end());
    const response = await fetch(`${await listen(app)}/api/me`, { headers: { authorization: 'Bearer private-token' } });
    expect(response.status).toBe(204);
    expect(traceSpan).toHaveBeenCalledTimes(1);
    expect(recordObservationMetrics).toHaveBeenCalledExactlyOnceWith(expect.arrayContaining([{ name: 'http.request.failed', value: 0 }]));
  });
  it('measures a streamed response until completion, once despite subsequent close', async () => {
    let now = 100;
    let finish: (() => void) | undefined;
    const app = diagnosed(() => now);
    app.get('/api/events', (_req, res) => {
      res.write('first');
      finish = () => res.end('last');
    });
    const response = await fetch(`${await listen(app)}/api/events`);
    expect(traceSpan).toHaveBeenCalledTimes(1);
    expect(recordObservationMetrics).not.toHaveBeenCalled();
    now = 1_200_100;
    finish?.();
    await response.text();
    expect(traceSpan).toHaveBeenCalledTimes(1);
    expect(recordObservationMetrics).toHaveBeenCalledWith(expect.arrayContaining([{
      name: 'http.request.duration_ms', value: 1_200_000, attributes: { route: '/api/events', status_class: '2xx', outcome: 'ok' },
    }]));
  });
  it('records disconnect as aborted without inventing an HTTP error status', async () => {
    const app = diagnosed();
    app.get('/api/events', (_req, res) => { res.status(503).write('first'); });
    const url = await listen(app);
    await new Promise<void>((resolve, reject) => {
      const request = get(`${url}/api/events`, (response) => {
        response.once('data', () => { response.destroy(); resolve(); });
      });
      request.on('error', reject);
    });
    await vi.waitFor(() => expect(recordObservationMetrics).toHaveBeenCalledTimes(1));
    expect(recordObservationMetrics).toHaveBeenCalledWith(expect.arrayContaining([{ name: 'http.request.aborted', value: 1 }]));
    expect(recordObservationMetrics).toHaveBeenCalledWith(expect.arrayContaining([{ name: 'http.request.server_error', value: 0 }]));
    expect(bindDiagnosticContext).toHaveBeenCalledTimes(1);
  });
  describe('flag definitions (#880): failed = 5xx or a client abandoning a request; a closed stream is not a failure', () => {
    const metricsOf = (): ReadonlyArray<{ name: string; value: number }> => vi.mocked(recordObservationMetrics).mock.calls.at(-1)?.[0] ?? [];
    const flag = (name: string): number | undefined => metricsOf().find((m) => m.name === name)?.value;

    it('a 404 is a client error, not a failure', async () => {
      const app = diagnosed();
      app.get('/api/x', (_req, res) => res.status(404).end());
      await fetch(`${await listen(app)}/api/x`);
      await vi.waitFor(() => expect(recordObservationMetrics).toHaveBeenCalled());
      expect([flag('http.request.client_error'), flag('http.request.failed'), flag('http.request.server_error')]).toEqual([1, 0, 0]);
    });

    it('a 500 is a server error and a failure', async () => {
      const app = diagnosed();
      app.get('/api/x', (_req, res) => res.status(500).end());
      await fetch(`${await listen(app)}/api/x`);
      await vi.waitFor(() => expect(recordObservationMetrics).toHaveBeenCalled());
      expect([flag('http.request.server_error'), flag('http.request.failed'), flag('http.request.client_error')]).toEqual([1, 1, 0]);
    });

    it('a server-sent event stream the client closes is recorded as stream lifetime, never as latency or failure', async () => {
      let clock = 0;
      const app = diagnosed(() => clock);
      app.get('/api/events', (_req, res) => {
        res.status(200).set('Content-Type', 'text/event-stream');
        res.flushHeaders();
        res.write('data: hi\n\n');
        clock = 240_000;
      });
      const url = await listen(app);
      await new Promise<void>((resolve, reject) => {
        const request = get(`${url}/api/events`, (response) => { response.once('data', () => { response.destroy(); resolve(); }); });
        request.on('error', reject);
      });
      await vi.waitFor(() => expect(recordObservationMetrics).toHaveBeenCalled());
      expect(metricsOf().map((m) => m.name)).not.toContain('http.request.duration_ms');
      expect(flag('http.request.stream_ms')).toBe(240_000);
      expect([flag('http.request.aborted'), flag('http.request.failed')]).toEqual([0, 0]);
      expect(updateActiveSpanMetadata).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'closed' }));
    });
  });

  it('captures the header writer context and preserves writeHead arguments and return value', async () => {
    const bound = vi.fn();
    vi.mocked(bindDiagnosticContext).mockImplementationOnce((fn) => () => { bound(); fn(); });
    const app = diagnosed();
    app.post('/api/chat', (_req, res) => {
      expect(res.writeHead(201, 'Created', { 'x-test': 'preserved' })).toBe(res);
      res.end();
    });
    const response = await fetch(`${await listen(app)}/api/chat`, { method: 'POST' });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-test')).toBe('preserved');
    expect(bound).toHaveBeenCalled();
    expect(traceSpan).toHaveBeenCalledTimes(1);
  });
  it('does not break the response when instrumentation rejects', async () => {
    vi.mocked(traceSpan).mockRejectedValueOnce(new Error('private exporter error'));
    const app = diagnosed();
    app.get('/health', (_req, res) => res.send('ok'));
    expect(await (await fetch(`${await listen(app)}/health`)).text()).toBe('ok');
  });

  it('carries only validated UI correlation UUIDs and exposes the existing trace id', async () => {
    const app = diagnosed();
    vi.mocked(currentDiagnosticTraceId).mockReturnValueOnce('0123456789abcdef0123456789abcdef');
    app.get('/api/items', (_request, response) => response.end());
    const response = await fetch(`${await listen(app)}/api/items?secret=private-query`, { headers: {
      'X-Bob-Ui-Action-Id': '11111111-1111-4111-8111-111111111111',
      'X-Bob-Ui-Request-Id': 'private-request-secret', authorization: 'Bearer private-token',
    } });
    expect(response.headers.get('X-Bob-Trace-Id')).toBe('0123456789abcdef0123456789abcdef');
    expect(traceSpan).toHaveBeenCalledWith('http GET /api/items', expect.objectContaining({
      workflowNamespace: 'http-request', workflowId: expect.stringMatching(UUID), metadata: {
      route_template: '/api/items', http_method: 'GET', ui_action_id: '11111111-1111-4111-8111-111111111111',
    } }), expect.any(Function));
    expect(vi.mocked(traceSpan).mock.calls[0]?.[1].workflowId).not.toBe('11111111-1111-4111-8111-111111111111');
    expect(JSON.stringify(vi.mocked(traceSpan).mock.calls)).not.toContain('private-');
  });

  it.each(['missing', 'expired'])('names the rejected route before the real JWT guard (%s)', async (kind) => {
    const app = diagnosed();
    app.use('/api', createJwtWebAuthGuard(async () => { throw new TokenVerificationError('expired_token'); }));
    app.delete('/api/items/:id', (_request, response) => response.end());
    const response = await fetch(`${await listen(app)}/api/items/private-id`, {
      method: 'DELETE', ...(kind === 'expired' ? { headers: { authorization: 'Bearer private-token' } } : {}),
    });
    expect(response.status).toBe(401);
    expect(traceSpan).toHaveBeenCalledWith('http DELETE /api/items/:id', expect.anything(), expect.any(Function));
    expect(updateActiveSpanMetadata).toHaveBeenCalledWith(expect.objectContaining({ http_status: '401', outcome: 'error' }));
    expect(vi.mocked(traceSpan).mock.lastCall?.[1]).not.toHaveProperty('userId');
  });

  it('names a CORS preflight that ends before auth or its POST handler', async () => {
    const app = diagnosed();
    app.use('/api', createCorsMiddleware(['https://allowed.example']));
    const handler = vi.fn((_request: express.Request, response: express.Response) => response.end());
    app.post('/api/items/:id', handler);
    const response = await fetch(`${await listen(app)}/api/items/private-id`, { method: 'OPTIONS', headers: { origin: 'https://allowed.example' } });
    expect(response.status).toBe(204);
    expect(handler).not.toHaveBeenCalled();
    expect(traceSpan).toHaveBeenCalledWith('http OPTIONS /api/items/:id', expect.anything(), expect.any(Function));
  });

  it.each([['malformed', '{"private-body":', 400], ['oversized', JSON.stringify({ secret: 'private-body'.repeat(30) }), 413]])(
    'names a %s JSON parser failure without recording its body', async (_kind, body, status) => {
      const app = diagnosed();
      app.use(express.json({ limit: 32 }));
      app.post('/api/items/:id', (_request, response) => response.end());
      app.use(((error: { status?: number }, _request: express.Request, response: express.Response, _next: express.NextFunction): void => {
        response.status(error.status ?? 500).end();
      }) as express.ErrorRequestHandler);
      const response = await fetch(`${await listen(app)}/api/items/private-id`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: String(body) });
      expect(response.status).toBe(status);
      expect(traceSpan).toHaveBeenCalledWith('http POST /api/items/:id', expect.anything(), expect.any(Function));
      expect(updateActiveSpanMetadata).toHaveBeenCalledWith(expect.objectContaining({ http_status: String(status), outcome: 'error' }));
      expect(JSON.stringify(vi.mocked(traceSpan).mock.calls)).not.toContain('private-');
    },
  );

  it('names rate-limit rejection before a route runs', async () => {
    vi.stubEnv('BOB_RATE_LIMIT_API_RPM', '1');
    const app = diagnosed();
    app.use('/api', createApiRateLimitMiddleware());
    app.post('/api/items/:id', (_request, response) => response.status(204).end());
    const url = `${await listen(app)}/api/items/private-id`;
    expect((await fetch(url, { method: 'POST' })).status).toBe(204);
    expect((await fetch(url, { method: 'POST' })).status).toBe(429);
    expect(traceSpan).toHaveBeenCalledTimes(2);
    expect(updateActiveSpanMetadata).toHaveBeenLastCalledWith(expect.objectContaining({ http_status: '429', outcome: 'error' }));
  });

  it('records thrown handler errors through the real error middleware without exception payloads', async () => {
    const app = diagnosed();
    app.get('/api/items/:id', () => { throw new Error('private-error-text'); });
    app.use(webErrorHandler);
    expect((await fetch(`${await listen(app)}/api/items/private-id`)).status).toBe(500);
    expect(updateActiveSpanMetadata).toHaveBeenCalledWith(expect.objectContaining({ http_status: '500', outcome: 'error' }));
    expect(JSON.stringify(vi.mocked(traceSpan).mock.calls)).not.toContain('private-');
  });

  it('records actual implicit HEAD, automatic OPTIONS and an unmatched 404', async () => {
    const app = diagnosed();
    app.get('/api/items/:id', (_request, response) => response.status(204).end());
    const origin = await listen(app);
    expect((await fetch(`${origin}/api/items/private-id`, { method: 'HEAD' })).status).toBe(204);
    expect((await fetch(`${origin}/api/items/private-id`, { method: 'OPTIONS' })).status).toBe(200);
    expect((await fetch(`${origin}/private-id`)).status).toBe(404);
    expect(vi.mocked(traceSpan).mock.calls.map(([name]) => name)).toEqual([
      'http HEAD /api/items/:id', 'http OPTIONS /api/items/:id', 'http GET unmatched',
    ]);
  });

  it('records a disconnect that occurs while the telemetry context is still opening', async () => {
    let entered: (() => void) | undefined;
    const opening = new Promise<void>((resolve) => { entered = resolve; });
    let closed: (() => void) | undefined;
    const closing = new Promise<void>((resolve) => { closed = resolve; });
    let resume: (() => void) | undefined;
    vi.mocked(traceSpan).mockImplementation((_name, _attrs, fn) => new Promise((resolve, reject) => {
      resume = () => { Promise.resolve(fn()).then(resolve, reject); };
      entered?.();
    }));
    const app = express();
    const inventory = createHttpRouteInventory(app);
    app.use((_request, response, next) => { response.once('close', () => closed?.()); next(); });
    app.use(httpDiagnostics(inventory));
    app.get('/health', (_request, response) => response.end());
    const request = get(`${await listen(app)}/health`);
    request.on('error', () => undefined);
    await opening;
    request.destroy();
    await closing;
    resume?.();
    expect(recordObservationMetrics).toHaveBeenCalledExactlyOnceWith(expect.arrayContaining([{ name: 'http.request.aborted', value: 1 }]));
  });

  describe('edge trace continuation', () => {
    const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
    const PARENT = `00-${TRACE}-00f067aa0ba902b7-01`;

    it('continues a valid W3C traceparent instead of seeding a random http-request workflow', async () => {
      const app = diagnosed();
      app.get('/api/items', (_request, response) => response.end());
      await fetch(`${await listen(app)}/api/items`, { headers: { traceparent: PARENT } });
      const attrs = vi.mocked(traceSpan).mock.calls[0]?.[1];
      expect(attrs).toMatchObject({ traceparent: PARENT });
      expect(attrs).not.toHaveProperty('workflowNamespace');
      expect(attrs).not.toHaveProperty('workflowId');
      expect(attrs?.metadata).not.toHaveProperty('edge_trace_id');
    });

    it.each([
      ['malformed', 'private-garbage'],
      ['uppercase', PARENT.toUpperCase()],
      ['zero trace id', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`],
      ['zero span id', `00-${TRACE}-${'0'.repeat(16)}-01`],
      ['unsupported version', `ff-${TRACE}-00f067aa0ba902b7-01`],
    ])('keeps the random workflow seed for a %s traceparent', async (_kind, header) => {
      const app = diagnosed();
      app.get('/api/items', (_request, response) => response.end());
      await fetch(`${await listen(app)}/api/items`, { headers: { traceparent: header } });
      const attrs = vi.mocked(traceSpan).mock.calls[0]?.[1];
      expect(attrs).toMatchObject({ workflowNamespace: 'http-request', workflowId: expect.stringMatching(UUID) });
      expect(attrs).not.toHaveProperty('traceparent');
      expect(JSON.stringify(vi.mocked(traceSpan).mock.calls)).not.toContain('private-');
    });

    it('keeps the deterministic workflow route ids and records only a valid edge trace id as metadata', async () => {
      const app = diagnosed();
      app.post('/api/chat', (_request, response) => response.status(204).end());
      const url = `${await listen(app)}/api/chat`;
      await fetch(url, { method: 'POST', headers: { traceparent: PARENT } });
      const edge = vi.mocked(traceSpan).mock.calls.at(-1)?.[1];
      expect(edge).toMatchObject({ metadata: { edge_trace_id: TRACE, http_status: '204' } });
      for (const key of ['traceparent', 'workflowNamespace', 'workflowId']) expect(edge).not.toHaveProperty(key);
      await fetch(url, { method: 'POST', headers: { traceparent: 'private-garbage' } });
      const plain = vi.mocked(traceSpan).mock.calls.at(-1)?.[1];
      expect(plain?.metadata).not.toHaveProperty('edge_trace_id');
      expect(JSON.stringify(vi.mocked(traceSpan).mock.calls)).not.toContain('private-');
    });
  });
});
