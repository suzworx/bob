import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createToolsRouter } from '../../src/tools/http.ts';
import { ToolCatalogResponseSchema } from '../../src/tools/schemas.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

describe('tools HTTP contract', () => {
  let pg: TestDb;
  let server: Server;
  let origin: string;
  let token: string;
  beforeAll(async () => {
    pg = await createTestDb();
    const account = await addAccount(pg);
    token = await signToken({ userId: account.userId, sessionId: account.sessionId });
    const app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use('/api/tools', createToolsRouter({ getDb: async () => asDb(pg) }));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await closeTestDb(pg); });
  async function patch(body: unknown): Promise<Response> {
    return fetch(`${origin}/api/tools/preferences`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  it('requires authentication and serves a validated catalog', async () => {
    expect((await fetch(`${origin}/api/tools`)).status).toBe(401);
    const response = await fetch(`${origin}/api/tools`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(ToolCatalogResponseSchema.parse(await response.json()).tools.length).toBeGreaterThan(30);
  });
  it('validates strict inputs and persists disable/reset through HTTP', async () => {
    for (const body of [{ scope: 'global', toolId: 'create_task', enabled: false }, { scope: 'account', toolId: 'create_task', enabled: 'false' }, { scope: 'account', toolId: 'create_task', enabled: false, owner: 'someone' }]) {
      expect((await patch(body)).status).toBe(400);
    }
    expect((await patch({ scope: 'account', toolId: 'invented', enabled: false })).status).toBe(404);
    const disabled = await patch({ scope: 'account', toolId: 'create_task', enabled: false });
    expect(disabled.status).toBe(200);
    expect(ToolCatalogResponseSchema.parse(await disabled.json()).tools.find((item) => item.id === 'create_task')?.enabled).toBe(false);
    const reset = await patch({ scope: 'account', toolId: 'create_task', enabled: null });
    expect(ToolCatalogResponseSchema.parse(await reset.json()).tools.find((item) => item.id === 'create_task')).toMatchObject({ enabled: true, preference: null });
  });
});
