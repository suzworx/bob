import { get, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createCalendarsRouter } from '../../src/calendar/http.ts';
import type { GoogleAgendaProjector } from '../../src/integrations/google-agenda-service.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => { throw new Error('uninitialized deferred'); };
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
let pg: TestDb;
let server: Server;
let url: string;
let token: string;
let project: GoogleAgendaProjector = async () => ({ remote_items: [], sources: [] });
beforeAll(async () => {
  pg = await createTestDb();
  const owner = await addAccount(pg);
  token = await signToken({ userId: owner.userId, sessionId: owner.sessionId });
  const app = express();
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.use('/api', createCalendarsRouter({ getDb: async () => asDb(pg), projectGoogleAgenda: (...args) => project(...args) }));
  server = await new Promise<Server>((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  url = `${base}/api/agenda?from=1790812800000&to=1793491200000`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await closeTestDb(pg);
});

it('aborts an in-flight projection when the actual HTTP client disconnects', async () => {
  const started = deferred<AbortSignal>();
  const cancelled = deferred<void>();
  project = async (_userId, _window, signal) => {
    if (!signal) throw new Error('projection must receive request cancellation');
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        cancelled.resolve();
        reject(new Error('provider call cancelled'));
      }, { once: true });
      started.resolve(signal);
    });
  };
  const closed = deferred<void>();
  const request = get(url, { headers: { authorization: `Bearer ${token}` } });
  // Destroying an unfinished HTTP request produces ECONNRESET; observe it so
  // cancellation is tested through the server socket rather than a fake signal.
  request.on('error', () => undefined);
  request.on('close', () => closed.resolve());
  try {
    const signal = await started.promise;
    expect(signal.aborted).toBe(false);
    request.destroy();
    await cancelled.promise;
    await closed.promise;
    expect(signal.aborted).toBe(true);
  } finally { request.destroy(); }
});

it('marks successful agenda responses no-store and does not cancel a completed projection', async () => {
  let projectionSignal: AbortSignal | undefined;
  project = async (_userId, _window, signal) => {
    projectionSignal = signal;
    return { remote_items: [], sources: [] };
  };
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ items: [], remote_items: [], sources: [] });
  expect(projectionSignal).toBeInstanceOf(AbortSignal);
  expect(projectionSignal?.aborted).toBe(false);
});
