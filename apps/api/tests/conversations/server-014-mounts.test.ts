// server-014-mounts.test.ts (spec 014, S14-T007). Proves the spaces/threads/
// tasks/calendars routers are reachable and correctly guarded when mounted under
// /api, using the repo's signToken/testJwks/testIssuer auth setup (the same
// pattern as web-tasks.test.ts) against a real HTTP server over real Postgres
// with the real store. The 404-not-equals-forbidden rule is exercised through the real router
// + real store stack, not only in store unit tests.
import { createAppTurnExtension } from '../../src/bob-apps/app-turn-extension.ts';
import { saveAppIdea } from '../../src/workflows/workflow-app-idea.ts';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createThread, postMessage } from '../../src/conversations/thread-store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createSpacesRouter } from '../../src/spaces/http.ts';
import { createThreadsRouter } from '../../src/spaces/threads-http.ts';
import { createTasksRouter } from '../../src/tasks/http.ts';
import { createCalendarsRouter } from '../../src/calendar/http.ts';
import { createInvocationsRouter } from '../../src/conversations/invocations-http.ts';
import { createSearchRouter } from '../../src/conversations/search-http.ts';
import { listConversationsRoute } from '../../src/conversations/http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb,
} from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;

async function send(method: string, path: string, tok: string | null, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const GUARDED_ROUTES = [
  ['GET', '/api/spaces'],
  ['GET', '/api/spaces/00000000-0000-4000-8000-000000000000'],
  ['GET', '/api/spaces/00000000-0000-4000-8000-000000000000/threads'],
  ['GET', '/api/threads/00000000-0000-4000-8000-000000000000'],
  ['GET', '/api/spaces/00000000-0000-4000-8000-000000000000/tasks'],
  ['GET', '/api/tasks/00000000-0000-4000-8000-000000000000'],
  ['GET', '/api/spaces/00000000-0000-4000-8000-000000000000/calendars'],
  ['GET', '/api/calendars/00000000-0000-4000-8000-000000000000/events'],
  ['GET', '/api/agenda'],
  ['POST', '/api/threads/00000000-0000-4000-8000-000000000000/invocations'],
  ['GET', '/api/search?q=milk'],
] as const;

describe('014 routers mounted under the /api JWT guard (S14-T007)', () => {
  let owner: TestAccount;
  let outsider: TestAccount;
  let ownerToken: string;
  let outsiderToken: string;
  let spaceId: string;
  let hiddenThreadId: string;
  let hiddenTriggerMessageId: string;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    // listConversationsRoute(appDeps) reads the database through the deps; point it at the
    // same store so the regression assertion hits a real, populated database.
    setSharedDb(Promise.resolve(db));
    owner = await addAccount(pg);
    outsider = await addAccount(pg);
    ownerToken = await signToken({ userId: owner.userId, sessionId: owner.sessionId });
    outsiderToken = await signToken({ userId: outsider.userId, sessionId: outsider.sessionId });

    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });
    spaceId = space.id;
    const thread = await createThread(db, owner.userId, { spaceId, title: 'private thread' });
    hiddenThreadId = thread.id;
    const posted = await postMessage(db, owner.userId, {
      threadId: hiddenThreadId,
      body: 'hidden trigger',
      clientMessageId: randomUUID(),
    });
    hiddenTriggerMessageId = posted.message.id;

    // Mirror server.ts: /health is unguarded; /api is behind the JWT guard.
    const app = express();
    app.use(express.json());
    app.get('/health', (_request, response) =>
      response.status(200).json({ ok: true, protocol: 'bob.v2', path: '/v2/cardputer' }),
    );
    app.use('/api', createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use(
      '/api',
      createSpacesRouter({ getDb: () => Promise.resolve(db), requireActiveSession: requireActiveSession(() => Promise.resolve(db)) }),
    );
    app.use('/api', createThreadsRouter({ getDb: () => Promise.resolve(db), events: { publish: () => undefined } }));
    app.use('/api', createTasksRouter({ getDb: () => Promise.resolve(db) }));
    app.use('/api', createCalendarsRouter({ getDb: () => Promise.resolve(db) }));
    app.use('/api', createInvocationsRouter({ appTurnTools: createAppTurnExtension(saveAppIdea), getDb: () => Promise.resolve(db) }));
    app.use('/api', createSearchRouter({ getDb: () => Promise.resolve(db) }));
    app.get('/api/conversations', listConversationsRoute(appDeps));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    await closeTestDb(pg).catch(() => undefined);
  });

  it.each(GUARDED_ROUTES)('%s %s answers 401 without a JWT', async (method, path) => {
    const response = await send(method, path, null);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('missing_token');
  });

  it('a space the caller is not a member of returns 404, not 403 and not 500', async () => {
    const missing = await send('GET', `/api/spaces/${randomUUID()}`, outsiderToken);
    const hidden = await send('GET', `/api/spaces/${spaceId}`, outsiderToken);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const hiddenBody = (await hidden.json()) as { error: { code: string } };
    const missingBody = (await missing.json()) as { error: { code: string } };
    expect(hiddenBody).toEqual(missingBody);
    expect(hiddenBody).toMatchObject({ error: { code: 'not_found' } });
  });

  it('POST /api/threads/:id/invocations is 401 without a token', async () => {
    const response = await send('POST', `/api/threads/${hiddenThreadId}/invocations`, null);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('missing_token');
  });

  it('an invocation in a thread the caller cannot see returns 404, identical to a missing id', async () => {
    const hidden = await send('POST', `/api/threads/${hiddenThreadId}/invocations`, outsiderToken, {
      trigger_message_id: hiddenTriggerMessageId,
    });
    const missing = await send('POST', `/api/threads/${randomUUID()}/invocations`, outsiderToken, {
      trigger_message_id: randomUUID(),
    });
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const hiddenBody = (await hidden.json()) as { error: { code: string } };
    const missingBody = (await missing.json()) as { error: { code: string } };
    expect(hiddenBody).toEqual(missingBody);
    expect(hiddenBody).toMatchObject({ error: { code: 'not_found' } });
  });

  it('an unknown /api/ path still 404s (no catch-all was introduced)', async () => {
    const response = await send('GET', '/api/no-such-route', ownerToken);
    expect(response.status).toBe(404);
  });

  it('keeps /health and an existing route behaving as before', async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
    const conversations = await send('GET', '/api/conversations', ownerToken);
    expect(conversations.status).toBe(200);
  });
});