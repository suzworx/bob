import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTimelineRouter } from '../../src/timeline/http.ts';
import { TimelineResponseSchema } from '../../src/timeline/schemas.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { withUser } from '../../src/platform/db/db.ts';
import { ensurePrivateSpace } from '../../src/spaces/store.ts';
import { createTask } from '../../src/tasks/store.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let server: Server;
let origin: string;
let token: string;
let otherToken: string;
let taskId: string;
beforeAll(async () => {
  pg = await createTestDb();
  const db = asDb(pg);
  const owner = await addAccount(pg);
  const other = await addAccount(pg);
  token = await signToken(owner);
  otherToken = await signToken(other);
  const space = await ensurePrivateSpace(db, owner.userId);
  const task = await createTask(db, owner.userId, space.id, { title: 'Private planting plan' });
  taskId = task.id;
  await withUser(db, owner.userId, tx => tx.query('update bob.tasks set created_at=$2,updated_at=$2 where id=$1', [task.id, '2026-11-02T07:30:00Z']));
  const app = express();
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.use('/api/timeline', createTimelineRouter({ getDb: async () => db }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await closeTestDb(pg);
});
function get(query: string, bearer = token): Promise<Response> {
  return fetch(`${origin}/api/timeline?${query}`, { headers: { authorization: `Bearer ${bearer}` } });
}
it('requires authentication before returning activity', async () => {
  expect((await fetch(`${origin}/api/timeline?day=2026-11-01&timeZone=UTC`)).status).toBe(401);
  expect((await get('day=2026-11-01&timeZone=UTC', 'invalid')).status).toBe(401);
});
it('validates the local date, timezone, category, bounds and paired cursor', async () => {
  for (const query of ['day=2026-02-30&timeZone=UTC', 'day=2026-11-01&timeZone=Nowhere',
    'day=2026-11-01&timeZone=UTC&kind=email', 'day=2026-11-01&timeZone=UTC&limit=101',
    'day=2026-11-01&timeZone=UTC&before=123', 'day=2026-11-01&timeZone=UTC&owner=foreign']) {
    expect((await get(query)).status).toBe(400);
  }
});
it('returns only the signed-in account activity on the requested local day', async () => {
  const query = 'day=2026-11-01&timeZone=America%2FLos_Angeles&kind=task';
  const response = await get(query);
  expect(response.status).toBe(200);
  expect(TimelineResponseSchema.parse(await response.json()).entries).toMatchObject([{ recordId: taskId, title: 'Private planting plan' }]);
  expect(TimelineResponseSchema.parse(await (await get(query, otherToken)).json()).entries).toEqual([]);
  expect(TimelineResponseSchema.parse(await (await get('day=2026-11-02&timeZone=America%2FLos_Angeles&kind=task')).json()).entries).toEqual([]);
});
