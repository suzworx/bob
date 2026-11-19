// THREAD-ARCHIVE-CLEAR (escaped defect, found by the #565 e2e): archiving one
// thread must clear, at once, every member pointer that names it -- including
// other members' pointers -- and publish active.changed to exactly those
// accounts, as archiving a whole Space already does. A real HTTP server over
// real Postgres with the real store; the first server's bus is a recording double, the
// second mounts api-modules.ts's own threads entry so its wiring is proven too.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebSocketExpress } from 'websocket-express';
import { apiModules } from '../../src/api-modules.ts';
import { createAppDeps, type AppDeps } from '../../src/app-deps.ts';
import { AccountEvents, type AccountEvent } from '../../src/account/events-bus.ts';
import { threadRef } from '../../src/devices/conversation-ref.ts';
import { getActive, setActive } from '../../src/conversations/active.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createThread } from '../../src/conversations/thread-store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { createThreadsRouter } from '../../src/spaces/threads-http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;
let rootServer: Server;
let rootUrl: string;
const published: Array<{ userId: string; event: AccountEvent }> = [];
const bus = new AccountEvents();

async function point(userId: string, ref: string): Promise<void> {
  await withUser(db, userId, (tx) => setActive(tx, userId, ref, 'picker'));
}

async function listen(app: express.Express): Promise<[Server, string]> {
  const s = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  return [s, `http://127.0.0.1:${(s.address() as AddressInfo).port}`];
}

/** The composition root's own `threads` entry (api-modules.ts), mounted with AppDeps whose bus is `bus`. */
function mountThreadsModule(app: express.Express): void {
  const threads = apiModules.find((module) => module.name === 'threads');
  if (threads?.mount === undefined) throw new Error('api-modules.ts has no threads routes');
  const base = createAppDeps();
  const deps: AppDeps = {
    ...base,
    getDb: () => Promise.resolve(db),
    turn: { ...base.turn, accountEvents: () => bus },
  };
  threads.mount(app as unknown as WebSocketExpress, deps);
}

describe('archiving a thread clears the pointers that name it', () => {
  let a: TestAccount;
  let b: TestAccount;
  let c: TestAccount;
  let spaceId: string;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    a = await addAccount(pg);
    b = await addAccount(pg);
    c = await addAccount(pg);
    spaceId = (await createSpace(db, a.userId, { kind: 'group', name: 'Family' })).id;
    await addMember(db, a.userId, spaceId, b.userId, 'member');
    await addMember(db, a.userId, spaceId, c.userId, 'member');

    const app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use('/api', createThreadsRouter({
      getDb: () => Promise.resolve(db),
      events: { publish: (userId, event) => { published.push({ userId, event }); } },
    }));
    [server, baseUrl] = await listen(app);

    const root = express();
    root.use(express.json());
    root.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    mountThreadsModule(root);
    [rootServer, rootUrl] = await listen(root);
  });

  afterAll(async () => {
    server?.close();
    rootServer?.close();
    await closeTestDb(pg).catch(() => undefined);
  });

  it("member A's archive clears member B's pointer and tells only B", async () => {
    const threadId = (await createThread(db, a.userId, { spaceId, title: 'Weekend' })).id;
    const general = await createConversation(db, c.userId, 'General');
    await point(b.userId, threadRef(threadId));
    await point(c.userId, general.id);
    const before = await getActive(db, c.userId);
    published.length = 0;

    const token = await signToken({ userId: a.userId, sessionId: a.sessionId });
    const response = await fetch(`${baseUrl}/api/threads/${threadId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);

    // Read B's row directly (no getActive, whose stale check would mask the bug).
    // #757: the pointer holds the thread as user_state.active_conversation_id.
    const rows = await withUser(db, b.userId, (tx) => tx.query<{ conversationId: unknown }>(
      'SELECT active_conversation_id AS "conversationId" FROM bob.user_state WHERE user_id = $1',
      [b.userId],
    ));
    expect(rows[0]?.conversationId).toBeNull();

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      userId: b.userId,
      event: { type: 'active.changed', conversation_id: null, title: null, surface: 'activate' },
    });
    expect(published[0]!.event).toHaveProperty('changed_at', expect.any(Number));

    // C pointed at a General conversation: untouched, no event.
    expect(await getActive(db, c.userId)).toEqual(before);
  });

  it("the composition root wires the account bus: B's subscription hears the archive", async () => {
    const threadId = (await createThread(db, a.userId, { spaceId, title: 'Wired' })).id;
    await point(b.userId, threadRef(threadId));
    const heard: AccountEvent[] = [];
    const unsubscribe = bus.subscribe(b.userId, (event) => { heard.push(event); });
    try {
      const token = await signToken({ userId: a.userId, sessionId: a.sessionId });
      const response = await fetch(`${rootUrl}/api/threads/${threadId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
    } finally {
      unsubscribe();
    }
    expect(heard).toEqual([
      { type: 'active.changed', conversation_id: null, title: null, surface: 'activate', changed_at: expect.any(Number) },
    ]);
  });
});
