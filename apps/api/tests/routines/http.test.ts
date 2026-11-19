import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createRoutineRouter, createInsightsRouter } from '../../src/routines/http.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addGoogleAccount } from '../../src/integrations/google-store.ts';
import type { GoogleCapability } from '../../src/integrations/google-credentials.ts';
import type { createInsightRefresh } from '../../src/integrations/insight-refresh.ts';
import { RoutineSchema, InsightsResponseSchema } from '../../src/web-schemas.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
const servers: Server[] = [];
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
afterAll(async () => { if (pg) await closeTestDb(pg); });
async function fixture() {
  const owner = await addAccount(pg);
  const other = await addAccount(pg);
  const account = await addGoogleAccount(db, owner.userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'test@example.test' });
  await withUser(db, owner.userId, tx => tx.query("update bob.google_accounts set authorization_capabilities=array['gmail.read','calendar.read'] where id=$1", [account.id]));
  const token = await signToken(owner);
  const otherToken = await signToken(other);
  const capabilities = vi.fn(async (): Promise<GoogleCapability[]> => ['gmail.read', 'calendar.read']);
  const refresh = {
    future: vi.fn<ReturnType<typeof createInsightRefresh>['future']>(),
    reflections: vi.fn<ReturnType<typeof createInsightRefresh>['reflections']>(async () => null),
  };
  const deps = { getDb: async () => db, connection: { capabilities }, refresh };
  const app = express();
  app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.use('/api/routines', createRoutineRouter(deps));
  app.use('/api/insights', createInsightsRouter(deps));
  const server = await new Promise<Server>(resolve => { const listening = app.listen(0, () => resolve(listening)); });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, method = 'GET', body?: unknown, bearer = token): Promise<Response> => fetch(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { owner: owner.userId, accountId: account.id, otherToken, capabilities, refresh, request };
}
function creation(accountId: string) {
  return { googleAccountId: accountId, kind: 'daily_gmail_digest', localTime: '08:00', timeZone: 'UTC', scheduledReadConsent: true };
}
async function routine(response: Response) {
  const body = await response.json() as { routine: unknown };
  return RoutineSchema.parse(body.routine);
}
it('serves the authenticated HTTP lifecycle with revision conflicts and owner isolation', async () => {
  const f = await fixture();
  const created = await f.request('/api/routines', 'POST', creation(f.accountId));
  expect(created.status).toBe(201);
  const saved = await routine(created);
  expect(saved.nextRunAt).toBeGreaterThan(saved.createdAt);
  expect(f.capabilities).toHaveBeenCalledWith(f.owner, f.accountId, expect.any(AbortSignal));
  expect(await (await f.request('/api/routines', 'GET', undefined, f.otherToken)).json()).toEqual({ routines: [] });
  expect((await f.request(`/api/routines/${saved.id}`, 'PATCH', { expectedRevision: 1, status: 'paused' }, f.otherToken)).status).toBe(404);
  expect((await f.request(`/api/routines/${saved.id}`, 'DELETE', { expectedRevision: 1 }, f.otherToken)).status).toBe(404);
  const paused = await f.request(`/api/routines/${saved.id}`, 'PATCH', { expectedRevision: 1, status: 'paused' });
  expect(paused.status).toBe(200);
  expect(await routine(paused)).toMatchObject({ status: 'paused', nextRunAt: null, revision: 2 });
  expect((await f.request(`/api/routines/${saved.id}`, 'PATCH', { expectedRevision: 1, status: 'active' })).status).toBe(409);
  const edited = await f.request(`/api/routines/${saved.id}`, 'PATCH', { expectedRevision: 2, status: 'active', localTime: '09:00' });
  expect(await routine(edited)).toMatchObject({ status: 'active', localTime: '09:00', revision: 3 });
  expect(await (await f.request(`/api/routines/${saved.id}/runs`, 'GET', undefined, f.otherToken)).json()).toEqual({ runs: [] });
  expect((await f.request(`/api/routines/${saved.id}`, 'DELETE', { expectedRevision: 3 })).status).toBe(204);
  expect(await (await f.request('/api/routines')).json()).toEqual({ routines: [] });
});
it('rejects missing consent, unauthenticated requests and freshly revoked grants without saving', async () => {
  const f = await fixture();
  expect((await f.request('/api/routines', 'GET', undefined, 'invalid')).status).toBe(401);
  expect((await f.request('/api/routines', 'POST', { ...creation(f.accountId), scheduledReadConsent: false })).status).toBe(400);
  f.capabilities.mockResolvedValue([]);
  const denied = await f.request('/api/routines', 'POST', creation(f.accountId));
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: { code: 'permission_required' } });
  expect(await (await f.request('/api/routines')).json()).toEqual({ routines: [] });
});
it('returns the persisted newest snapshot on an out-of-order refresh and isolates saved results', async () => {
  const f = await fixture();
  const generatedAt = Date.parse('2026-10-22T08:00:00Z');
  const draft = { googleAccountId: f.accountId, category: 'future' as const, title: 'Calendar forecast', summary: 'New snapshot',
    periodStart: generatedAt, periodEnd: generatedAt + 86400000, generatedAt,
    sources: [{ kind: 'calendar' as const, id: 'event', label: 'Source', url: 'https://calendar.google.com/calendar/event?eid=actual' }], partial: false, messageCount: 0 };
  f.refresh.future.mockResolvedValueOnce(draft).mockResolvedValueOnce({ ...draft, generatedAt: generatedAt - 1000, summary: 'Stale snapshot' });
  const body = { googleAccountId: f.accountId, category: 'future' };
  const first = await f.request('/api/insights/refresh', 'POST', body);
  expect(first.status).toBe(200);
  const latest = InsightsResponseSchema.parse(await first.json()).insights[0];
  expect(latest?.summary).toBe('New snapshot');
  const stale = await f.request('/api/insights/refresh', 'POST', body);
  expect(stale.status).toBe(200);
  expect(InsightsResponseSchema.parse(await stale.json()).insights[0]).toEqual(latest);
  expect(InsightsResponseSchema.parse(await (await f.request('/api/insights?category=future')).json()).insights).toEqual([latest]);
  expect(await (await f.request('/api/insights?category=future', 'GET', undefined, f.otherToken)).json()).toEqual({ insights: [] });
});
it('blocks publication after grant revocation and preserves honest insufficient reflection history', async () => {
  const f = await fixture();
  f.refresh.future.mockImplementation(async () => {
    f.capabilities.mockResolvedValue([]);
    return { googleAccountId: f.accountId, category: 'future', title: 'Private', summary: 'Must not save',
      periodStart: 1000, periodEnd: 2000, generatedAt: 1000, sources: [], partial: false, messageCount: 0 };
  });
  const response = await f.request('/api/insights/refresh', 'POST', { googleAccountId: f.accountId, category: 'future' });
  expect(response.status).toBe(403);
  expect(await (await f.request('/api/insights?category=future')).json()).toEqual({ insights: [] });
  const reflections = await f.request('/api/insights/refresh', 'POST', { googleAccountId: f.accountId, category: 'reflections' });
  expect(reflections.status).toBe(200);
  expect(await reflections.json()).toEqual({ insights: [] });
  expect((await f.request('/api/insights/refresh', 'POST', { googleAccountId: f.accountId, category: 'past' })).status).toBe(400);
});

it('serves bounded timeline queries and hides foreign run details', async () => {
 const f = await fixture();
 expect(await (await f.request('/api/routines/timeline?limit=1')).json()).toEqual({ runs: [], nextCursor: null });
 expect((await f.request('/api/routines/timeline?before=123')).status).toBe(400);
 expect((await f.request('/api/routines/timeline?limit=101')).status).toBe(400);
 expect((await f.request('/api/routines/'+randomUUID()+'/runs/'+randomUUID())).status).toBe(404);
});

it('keeps archived routine history discoverable only through an explicit owner-scoped list option', async () => {
  const f = await fixture();
  const saved = await routine(await f.request('/api/routines', 'POST', creation(f.accountId)));
  expect((await f.request(`/api/routines/${saved.id}`, 'DELETE', { expectedRevision: 1 })).status).toBe(204);
  expect(await (await f.request('/api/routines')).json()).toEqual({ routines: [] });
  expect(await (await f.request('/api/routines?includeArchived=false')).json()).toEqual({ routines: [] });
  const included = await f.request('/api/routines?includeArchived=true');
  expect(included.status).toBe(200);
  expect(await included.json()).toMatchObject({ routines: [{ id: saved.id, status: 'archived', nextRunAt: null }] });
  expect(await (await f.request('/api/routines?includeArchived=true', 'GET', undefined, f.otherToken)).json()).toEqual({ routines: [] });
  expect((await f.request('/api/routines?includeArchived=maybe')).status).toBe(400);
  expect((await f.request('/api/routines?includeArchived=true&owner=someone')).status).toBe(400);
});
