import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createMarketingRouter } from '../../src/bob-apps/marketing-http.ts';
import { createBobAppsRouter } from '../../src/bob-apps/http.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, isWebSessionActive } from '../../src/platform/http/auth-guard.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb; let server: Server; let origin: string; let token: string; let strangerToken: string; let staleToken: string;
const ALL_VIEWS = ['campaign', 'content', 'schedule', 'results'];

beforeAll(async () => {
  pg = await createTestDb();
  const owner = await addAccount(pg); const stranger = await addAccount(pg);
  token = await signToken({ userId: owner.userId, sessionId: owner.sessionId });
  staleToken = await signToken({ userId: owner.userId, sessionId: randomUUID() });
  strangerToken = await signToken({ userId: stranger.userId, sessionId: stranger.sessionId });
  const app = express(); app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer }), [], (account) => isWebSessionActive(async () => asDb(pg), account)));
  app.use('/api/bob-apps', createMarketingRouter({ getDb: async () => asDb(pg) }));
  app.use('/api/bob-apps', createBobAppsRouter({ getDb: async () => asDb(pg) }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  origin = `http://127.0.0.1:${address.port}/api/bob-apps`;
});

async function request(path: string, method = 'GET', body?: unknown, bearer = token): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

it('serves the package display behind authentication, with identity, six roles and truthful capabilities', async () => {
  expect((await request('/marketing/package', 'GET', undefined, staleToken)).status).toBe(401);
  const response = await request('/marketing/package');
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.package).toMatchObject({ packageId: 'bob-marketing', name: 'Bob' });
  expect(body.package.roles).toHaveLength(6);
  expect(body.package.assets.map((asset: { id: string }) => asset.id)).toEqual(['bob-playful', 'bob-helper']);
  expect(body.package.capabilities).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'publishing', status: 'unavailable' })]));
});

it('installs once, replays the same mutation, and rejects a second installation with a kind conflict', async () => {
  const mutationId = randomUUID();
  const created = await request('/marketing/install', 'POST', { packageId: 'bob-marketing', mutationId });
  expect(created.status).toBe(201);
  const { installation } = await created.json();
  expect(installation).toMatchObject({ state: 'draft', revision: 1, configRevision: 1, config: { visibleViews: ALL_VIEWS, contentGrouping: 'none', defaultChannels: ['instagram', 'linkedin'] } });
  const replay = await request('/marketing/install', 'POST', { packageId: 'bob-marketing', mutationId });
  expect((await replay.json()).installation.id).toBe(installation.id);
  const second = await request('/marketing/install', 'POST', { packageId: 'bob-marketing', mutationId: randomUUID() });
  expect(second.status).toBe(409);
  expect(await second.json()).toMatchObject({ error: { code: 'conflict' } });
});

it('rejects config and grant injection with a strict 400 before any write', async () => {
  const injected = [{ packageId: 'bob-marketing', mutationId: randomUUID(), config: { visibleViews: ['campaign'] } },
    { packageId: 'bob-marketing', mutationId: randomUUID(), grantedCapabilities: ['campaign.publish'] },
    { packageId: 'other-package', mutationId: randomUUID() }];
  for (const body of injected) expect((await request('/marketing/install', 'POST', body)).status).toBe(400);
});

it('lists installations, hides other owners, and answers 404 for another owner or a malformed id', async () => {
  const list = await request('/marketing/installations');
  const body = await list.json();
  expect(list.status).toBe(200);
  expect(body.installations).toHaveLength(1);
  expect(body).toMatchObject({ selectedInstallationId: null });
  const id = body.installations[0].id;
  expect((await request(`/marketing/installations/${id}`)).status).toBe(200);
  expect((await request(`/marketing/installations/${id}`, 'GET', undefined, strangerToken)).status).toBe(404);
  expect((await request('/marketing/installations/not-a-uuid')).status).toBe(400);
  expect((await request('/marketing/installations')).status).toBe(200);
  expect((await (await request('/marketing/installations', 'GET', undefined, strangerToken)).json()).installations).toEqual([]);
});

it('activates with the expected revision, conflicts on a stale revision or a changed intent, and gates selection', async () => {
  const id = (await (await request('/marketing/installations')).json()).installations[0].id;
  const path = `/marketing/installations/${id}/lifecycle`;
  expect((await request(path, 'POST', { operation: 'activate', expectedRevision: 9, mutationId: randomUUID() })).status).toBe(409);
  const mutationId = randomUUID();
  const activated = await request(path, 'POST', { operation: 'activate', expectedRevision: 1, mutationId });
  expect(activated.status).toBe(200);
  expect(await activated.json()).toMatchObject({ installation: { id, state: 'active', revision: 2 } });
  expect((await request(path, 'POST', { operation: 'pause', expectedRevision: 1, mutationId })).status).toBe(409);
  const selected = await request('/marketing/selection', 'POST', { installationId: id, mutationId: randomUUID() });
  expect(selected.status).toBe(200);
  expect((await selected.json()).selection).toMatchObject({ installationId: id });
  expect((await request('/marketing/selection', 'POST', { installationId: id, mutationId: randomUUID() }, strangerToken)).status).toBe(404);
});

it('answers unavailable as 503 with a kind code when the store cannot be reached', async () => {
  const broken = express(); broken.use(express.json());
  broken.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer }), [], (account) => isWebSessionActive(async () => asDb(pg), account)));
  broken.use('/api/bob-apps', createMarketingRouter({ getDb: async () => { throw new Error('down'); } }));
  const server2 = broken.listen(0, '127.0.0.1'); await once(server2, 'listening');
  const address = server2.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/bob-apps/marketing/installations`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'unavailable' } });
  await new Promise<void>((resolve) => server2.close(() => resolve()));
});

afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await closeTestDb(pg); });
