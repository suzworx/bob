import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createBobAppsRouter } from '../../src/bob-apps/http.ts';
import { createBobAppRefreshRouter } from '../../src/bob-apps/refresh-http.ts';
import { BobAppExportSchema, BobAppResponseSchema, BobAppsResponseSchema } from '../../src/bob-apps/api-schemas.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, isWebSessionActive } from '../../src/platform/http/auth-guard.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { appResponseSchema, appsResponseSchema, appExportSchema } from '../../../ui-v2/src/features/bob-apps/app-schemas.ts';
import { createSpace, addMember, revokeMember } from '../../src/spaces/store.ts';
import { openAppConversation } from '../../src/workflows/workflow-app-conversation.ts';

let pg: TestDb; let server: Server; let origin: string; let token: string; let strangerToken: string; let staleToken: string;
let ownerId: string;
let memberId: string;
beforeAll(async () => {
  pg = await createTestDb();
  const owner = await addAccount(pg); const stranger = await addAccount(pg);
  ownerId = owner.userId; memberId = stranger.userId;
  token = await signToken({ userId: owner.userId, sessionId: owner.sessionId });
  staleToken = await signToken({ userId: owner.userId, sessionId: randomUUID() });
  strangerToken = await signToken({ userId: stranger.userId, sessionId: stranger.sessionId });
  const app = express(); app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer }), [], (account) => isWebSessionActive(async () => asDb(pg), account)));
  app.use('/api/bob-apps', createBobAppsRouter({ getDb: async () => asDb(pg), openAppConversation: (actor, appId) => openAppConversation(asDb(pg), actor, appId) }));
  app.use('/api/bob-apps', createBobAppRefreshRouter({ getDb: async () => asDb(pg) }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  origin = `http://127.0.0.1:${address.port}/api/bob-apps`;
});
it('protects refresh settings and run history with session, ownership and revision checks', async () => {
  const created = await request('', 'POST', { definition, mutationId: randomUUID() });
  const { app } = BobAppResponseSchema.parse(await created.json());
  expect((await request(`/${app.id}/refresh`, 'GET', undefined, staleToken)).status).toBe(401);
  expect((await request(`/${app.id}/refresh`, 'GET', undefined, strangerToken)).status).toBe(404);
  expect((await request(`/${app.id}/runs`, 'GET', undefined, strangerToken)).status).toBe(404);
  expect((await request(`/${app.id}/runs`)).status).toBe(200);
  expect((await (await request(`/${app.id}/refresh`)).json()).enabled).toBe(false);
  const input = { expectedRevision: app.revision, mutationId: randomUUID(), enabled: false, consent: true, config: null };
  expect((await request(`/${app.id}/refresh`, 'PUT', { ...input, consent: false })).status).toBe(400);
  expect((await request(`/${app.id}/refresh`, 'PUT', input, strangerToken)).status).toBe(404);
  expect((await request(`/${app.id}/refresh`, 'PUT', input, staleToken)).status).toBe(401);
  expect((await request(`/${app.id}/refresh`, 'PUT', input)).status).toBe(200);
  expect((await request(`/${app.id}/refresh`, 'PUT', { ...input, mutationId: randomUUID() })).status).toBe(409);
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await closeTestDb(pg); });
async function request(path = '', method = 'GET', body?: unknown, bearer = token): Promise<Response> {
  return fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const definition = { schemaVersion: 1, title: 'Things', lifecycle: 'keep', tables: [{ id: 'items', fields: [{ id: 'title', type: 'text' }] }], actions: [], metrics: [], views: [{ id: 'list', kind: 'table', title: 'Things', table: 'items', fields: ['title'], actions: [] }] };
it('authenticates and rejects unknown owner fields and invalid IDs', async () => {
  expect((await fetch(origin)).status).toBe(401);
  expect((await request('', 'POST', { definition, mutationId: randomUUID(), userId: randomUUID() })).status).toBe(400);
  expect((await request('/invalid')).status).toBe(400);
});
it('roundtrips private apps, summaries, revision conflicts and portable exports', async () => {
  const created = await request('', 'POST', { definition, mutationId: randomUUID() }); expect(created.status).toBe(201);
  const { app } = BobAppResponseSchema.parse(await created.json());
  expect(appResponseSchema.parse({ app }).app).toEqual(app);
  expect((await request(`/${app.id}`, 'GET', undefined, strangerToken)).status).toBe(404);
  const list = BobAppsResponseSchema.parse(await (await request()).json()); expect(list.apps.some((item) => item.id === app.id)).toBe(true); expect(list.apps[0]).not.toHaveProperty('state');
  expect(appsResponseSchema.parse(list)).toEqual(list);
  const activation = { operation: 'activate', expectedRevision: 1, mutationId: randomUUID() };
  expect((await request(`/${app.id}`, 'PATCH', activation)).status).toBe(200);
  expect((await request(`/${app.id}`, 'PATCH', { ...activation, mutationId: randomUUID() })).status).toBe(409);
  const exported = await request(`/${app.id}/export`); expect(exported.headers.get('content-disposition')).toContain('attachment');
  const data = BobAppExportSchema.parse(await exported.json());
  expect(data).toEqual({ schemaVersion: 1, updatedAt: expect.any(Number), definition, state: {} }); expect(appExportSchema.parse(data)).toEqual(data);
  expect(data.updatedAt).toBe((await (await request(`/${app.id}`)).json()).app.updatedAt);
  expect((await request(`/${app.id}`, 'DELETE', { expectedRevision: 2, mutationId: randomUUID() })).status).toBe(204);
});

it('opens the same shared composer for members, rejects bodies and removes access after leave', async () => {
  const db = asDb(pg);
  const space = await createSpace(db, ownerId, { kind: 'group', name: 'Shared apps' });
  await addMember(db, ownerId, space.id, memberId, 'member');
  const created = await request('', 'POST', { definition, spaceId: space.id, mutationId: randomUUID() });
  expect(created.status).toBe(201);
  const { app } = BobAppResponseSchema.parse(await created.json());
  const path = `/${app.id}/conversation`;
  expect((await request(path, 'POST', {}, token)).status).toBe(400);
  expect((await request(path, 'POST', undefined, staleToken)).status).toBe(401);
  const opened = await request(path, 'POST');
  expect(opened.status, JSON.stringify(await opened.clone().json())).toBe(200);
  const conversation = await opened.json();
  expect(conversation).toMatchObject({ spaceId: space.id, conversationId: expect.any(String) });
  expect(await (await request(path, 'POST', undefined, strangerToken)).json()).toEqual(conversation);
  await revokeMember(db, ownerId, space.id, memberId);
  expect((await request(path, 'POST', undefined, strangerToken)).status).toBe(404);
});
