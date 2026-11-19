/**
 * The HTTP/WebSocket route table, recorded as the server registers it (issue #619).
 * Every `use`, route verb and `ws` handler is captured with its path and the name
 * of each middleware, in registration order, then compared with the checked-in
 * snapshot. Restructuring how server.ts wires its modules must not change a
 * route, its method, or the order middleware runs in; when a route is added or
 * removed on purpose, regenerate with `UPDATE_ROUTE_TABLE=1 npx vitest run route-table`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, setSharedDb } from '../src/platform/db/db.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from './support/test-db.ts';

// Keep the route snapshot independent of an optional local production build.
// Static discovery and serving have their own platform/static-ui.test.ts suite.
vi.mock('../src/platform/http/static-ui.ts', async (original) => ({
  ...(await original<typeof import('../src/platform/http/static-ui.ts')>()),
  resolveUiDist: () => null,
}));

type Handler = { name?: string } | ((...args: never[]) => unknown);
type RouterLike = {
  prototype: Record<string, (...args: unknown[]) => unknown>;
};
const Route = (express as unknown as { Route: { prototype: Record<string, (...args: unknown[]) => unknown> } }).Route;
// express re-exports the router package's Router and Route, so no direct dependency on it is needed.
const Router = express.Router as unknown as RouterLike;
const SNAPSHOT = new URL('./fixtures/route-table.json', import.meta.url);
const VERBS = ['all', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

const recorded: string[] = [];
const restore: Array<() => void> = [];
const handlerName = (handler: Handler): string => (typeof handler === 'function' && handler.name !== '' ? handler.name : '<fn>');
const flatten = (args: unknown[]): unknown[] => args.flat(Infinity);

function patch(target: Record<string, (...args: unknown[]) => unknown>, method: string, record: (args: unknown[], self: Record<string, unknown>) => string): void {
  const original = target[method];
  if (typeof original !== 'function') return;
  target[method] = function patched(this: Record<string, unknown>, ...args: unknown[]): unknown {
    recorded.push(record(args, this));
    return original.apply(this, args);
  };
  restore.push(() => { target[method] = original; });
}

beforeAll(() => {
  // Router.use(path?, ...handlers)
  patch(Router.prototype, 'use', (args) => {
    const [first, ...rest] = args;
    const hasPath = typeof first === 'string' || first instanceof RegExp || Array.isArray(first);
    const handlers = flatten(hasPath ? rest : args) as Handler[];
    return `USE ${hasPath ? String(first) : '/'} ${handlers.map(handlerName).join(',')}`;
  });
  // Route verbs: `router.get(path, ...)` creates a Route, then calls route[verb](...handlers)
  for (const verb of VERBS) {
    patch(Route.prototype, verb, (args, self) =>
      `${verb.toUpperCase()} ${String(self.path)} ${(flatten(args) as Handler[]).map(handlerName).join(',')}`);
  }
});
afterAll(() => { for (const undo of restore.reverse()) undo(); });

describe('route table', () => {
  // createV2Server builds a memory extraction worker that resolves its Db
  // through getDb(): give it this file's test database.
  let pg: TestDb;
  beforeAll(async () => {
    pg = await createTestDb();
    setSharedDb(Promise.resolve(asDb(pg)));
  });
  afterAll(async () => {
    await closeDb().catch(() => undefined);
    await closeTestDb(pg).catch(() => undefined);
  });

  it('registers the same routes, methods and middleware order as the checked-in snapshot', async () => {
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.BOB_V2_HOST = '127.0.0.1';
    const { createV2Server } = await import('../src/server.ts');
    recorded.length = 0;
    const { memoryWorker } = await createV2Server();
    await memoryWorker.stop();
    expect(recorded).toContain('POST /push/devices wrapped');
    expect(recorded).toContain('DELETE /push/devices/:installationId wrapped');
    expect(recorded).toContain('GET /timers/notification-state wrapped');
    if (process.env.UPDATE_ROUTE_TABLE === '1') writeFileSync(SNAPSHOT, `${JSON.stringify(recorded, null, 2)}\n`);
    const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as string[];
    expect(recorded).toEqual(expected);
    expect(recorded.length).toBeGreaterThan(40);
    delete process.env.BOB_SYSTEM_TEST;
    delete process.env.BOB_V2_HOST;
  });
});
