import { readFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordObservationMetrics, traceSpan } from '@bob/ai';
import { createAppDeps } from '../../src/app-deps.ts';
import { createV2Server } from '../../src/server.ts';
import type { HttpRoute } from '../../src/platform/observability/http-route-inventory.ts';

vi.mock('@bob/ai', async (original) => ({
  ...(await original<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, fn: () => unknown) => fn()),
  recordObservationMetrics: vi.fn(),
}));
vi.mock('../../src/platform/http/static-ui.ts', async (original) => ({
  ...(await original<typeof import('../../src/platform/http/static-ui.ts')>()),
  resolveUiDist: () => null,
}));

const expected = JSON.parse(readFileSync(new URL('../fixtures/http-route-inventory.json', import.meta.url), 'utf8')) as HttpRoute[];
type Handler = (request: Request, response: Response, next: NextFunction) => void;
interface TestLayer { handle: Handler & { stack?: TestLayer[] }; route?: { stack: TestLayer[] } }
type RegisteredApp = { app: { router: { stack: TestLayer[] } } };

/** Exercise the real registered dispatch graph without invoking any business
 * action. The middleware under test remains installed. Every terminal route is
 * replaced with a success stub; auth/parser rejection paths are tested separately.
 */
function replaceBusinessHandlers(layers: TestLayer[]): void {
  for (const layer of layers) {
    if (layer.route) {
      for (const handler of layer.route.stack) {
        handler.handle = (_request, response): void => { response.setHeader('x-route-visited', 'yes'); response.status(204).end(); };
      }
    } else if (layer.handle.stack) {
      replaceBusinessHandlers(layer.handle.stack);
    } else if (layer.handle.name !== 'diagnoseHttp') {
      layer.handle = (_request, _response, next): void => next();
    }
  }
}

let server: Server;
let origin: string;
let actual: readonly HttpRoute[];
let dispatchMethod = 'GET';
const getDb = vi.fn(async () => { throw new Error('route coverage must not access a database'); });

beforeAll(async () => {
  vi.stubEnv('BOB_SYSTEM_TEST', '1');
  vi.stubEnv('BOB_V2_HOST', '127.0.0.1');
  const deps = createAppDeps();
  deps.getDb = getDb;
  const created = await createV2Server(deps);
  actual = created.httpRoutes.routes();
  replaceBusinessHandlers((created.app as unknown as RegisteredApp).app.router.stack);
  server = created.server;
  // WebSocketExpress registers its upgrade route with every Node method.
  // Rewrite only inside this isolated harness so CONNECT and other methods are
  // safely traversed as HTTP without opening tunnels or invoking real handlers.
  server.prependListener('request', (request) => { request.method = dispatchMethod; });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

async function traverse(route: HttpRoute): Promise<void> {
  dispatchMethod = route.method;
  const path = route.path.replace(/:[A-Za-z][A-Za-z0-9_]*/g, 'private-path-value');
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(`${origin}${path}?private=query`, { method: 'GET' }, (response) => {
      response.resume();
      response.once('end', () => {
        try {
          expect(response.statusCode).toBe(204);
          expect(response.headers['x-route-visited']).toBe('yes');
          resolve();
        } catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
    request.end();
  });
}

describe('complete registered HTTP coverage', () => {
  it('pins every registered method and full mounted path so new routes cannot silently miss coverage', () => {
    expect(actual).toEqual(expected);
  });

  it.each(expected)('$method $path emits one safe HTTP observation and completion metrics', async (route) => {
    await traverse(route);
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(route.method) ? route.method : 'OTHER';
    const calls = vi.mocked(traceSpan).mock.calls.filter(([name]) => name.startsWith('http '));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      `http ${method} ${route.path}`,
      expect.objectContaining({ metadata: expect.objectContaining({ route_template: route.path, http_method: method }) }),
      expect.any(Function),
    ]);
    expect(recordObservationMetrics).toHaveBeenCalledWith(expect.arrayContaining([
      { name: 'http.request.failed', value: 0 }, { name: 'http.request.aborted', value: 0 },
    ]));
    expect(JSON.stringify(calls)).not.toContain('private-');
    expect(getDb).not.toHaveBeenCalled();
  });
});

describe('anonymous telemetry admission in the real server', () => {
  it('admits only the restricted pre-auth route and diagnoses auth and body rejections', async () => {
    const deps = createAppDeps();
    deps.getDb = getDb;
    const created = await createV2Server(deps);
    const actualServer = created.server;
    await new Promise<void>((resolve) => actualServer.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(actualServer.address() as AddressInfo).port}`;
    const event = { event: 'ui_navigation', page: 'signin', route: 'signin', view_id: '11111111-1111-4111-8111-111111111111', duration_ms: 0 };
    const send = (path: string, body: string): Promise<globalThis.Response> => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    try {
      expect((await send('/api/telemetry/anonymous', JSON.stringify({ events: [event] }))).status).toBe(204);
      expect((await send('/api/telemetry', JSON.stringify({ events: [event] }))).status).toBe(401);
      expect((await send('/api/telemetry/anonymous', JSON.stringify({ events: [{ ...event, page: 'home', route: 'home' }] }))).status).toBe(400);
      expect((await send('/api/telemetry/anonymous', '{"private-body":')).status).toBe(400);
      expect((await send('/api/telemetry/anonymous', JSON.stringify({ secret: 'private-body'.repeat(2000) }))).status).toBe(413);
      const calls = vi.mocked(traceSpan).mock.calls.filter(([name]) => name.startsWith('http '));
      expect(calls.map(([name]) => name)).toEqual([
        'http POST /api/telemetry/anonymous', 'http POST /api/telemetry',
        'http POST /api/telemetry/anonymous', 'http POST /api/telemetry/anonymous', 'http POST /api/telemetry/anonymous',
      ]);
      expect(JSON.stringify(calls)).not.toContain('private-');
    } finally {
      actualServer.closeAllConnections();
      await new Promise<void>((resolve) => actualServer.close(() => resolve()));
    }
  });
});
