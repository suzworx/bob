// Notification producer tests for thread @mentions (gap G17, spec 014 FR-018).
// A real HTTP server over real Postgres with the real store: an @mention in a NEW
// thread message enqueues a 'mention' notification in the same request,
// respects thread-scoped mute, resolves only known member handles (never
// @bob, never a self-mention), collapses duplicate mentions of the same
// person, never notifies on a retried post, and never fails the write when
// the enqueue itself throws.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setJournalSink } from '../../src/platform/logger.ts';
import { type Db } from '../../src/platform/db/db.ts';
import { upsertPreference } from '../../src/notifications/store.ts';
import { addMember, createSpace, listMembers } from '../../src/spaces/store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { createNotificationsRouter } from '../../src/notifications/http.ts';
import { createThreadsRouter } from '../../src/spaces/threads-http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import {
  addAccount,
  asDb,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb,
} from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
let activeDb: Db;
let server: Server;
let baseUrl: string;
const lines: string[] = [];

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

async function tokenFor(account: TestAccount): Promise<string> {
  return signToken({ userId: account.userId, sessionId: account.sessionId });
}

type JournalLine = { ts: string; event: string; [key: string]: unknown };

function events(name: string): JournalLine[] {
  return lines.map((line) => JSON.parse(line) as JournalLine).filter((entry) => entry.event === name);
}

/** A Db whose query() rejects any SQL that enqueues notifications, so a
 *  producer's enqueue fails while the underlying write still commits. */
function failingEnqueueDb(real: Db): Db {
  return {
    query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (sql.includes('notifications_enqueue')) return Promise.reject(new Error('injected enqueue failure'));
      return real.query<T>(sql, params);
    },
    tx<T>(fn: (txDb: Db) => Promise<T>): Promise<T> {
      return real.tx(fn);
    },
  };
}

type NotificationItem = {
  id: string;
  space_id: string | null;
  type: string;
  resource_type: string;
  resource_id: string;
  revision: number;
  cursor: number;
  read_at: number | null;
};

describe('thread mention notifications', () => {
  let owner: TestAccount;
  let ownerToken: string;
  let spaceId: string;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    owner = await addAccount(pg);
    ownerToken = await tokenFor(owner);

    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });
    spaceId = space.id;

    const app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use('/api', createThreadsRouter({ getDb: () => Promise.resolve(activeDb), events: { publish: () => undefined } }));
    app.use('/api', createNotificationsRouter({ getDb: () => Promise.resolve(db) }));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    setJournalSink((line) => lines.push(line));
  });

  afterAll(async () => {
    setJournalSink(null);
    server?.close();
    await closeTestDb(pg).catch(() => undefined);
  });

  beforeEach(() => {
    activeDb = db;
    lines.length = 0;
  });

  async function freshMember(): Promise<{ account: TestAccount; token: string }> {
    const account = await addAccount(pg);
    await addMember(db, owner.userId, spaceId, account.userId, 'member');
    const token = await tokenFor(account);
    return { account, token };
  }

  async function handleOf(userId: string): Promise<string> {
    const members = await listMembers(db, owner.userId, spaceId);
    return members.find((m) => m.userId === userId)!.handle;
  }

  async function inbox(token: string): Promise<{ notifications: NotificationItem[]; unread_count: number }> {
    const response = await send('GET', '/api/notifications?limit=100', token);
    expect(response.status).toBe(200);
    return (await response.json()) as { notifications: NotificationItem[]; unread_count: number };
  }

  async function createThread(token: string, title: string): Promise<string> {
    const response = await send('POST', `/api/spaces/${spaceId}/threads`, token, { title });
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  async function postMessage(
    token: string,
    threadId: string,
    body: string,
    clientMessageId: string,
  ): Promise<Response> {
    return send('POST', `/api/threads/${threadId}/messages`, token, {
      body,
      client_message_id: clientMessageId,
    });
  }

  it('a. the owner mentions the recipient, who gets exactly one inbox item', async () => {
    const { account: recipient, token: recipientToken } = await freshMember();
    const h = await handleOf(recipient.userId);
    const threadId = await createThread(ownerToken, 'groceries');

    const posted = await postMessage(ownerToken, threadId, `please grab milk @${h} thanks`, 'a-1');
    expect(posted.status).toBe(201);
    const message = (await posted.json()) as { sequence: number };

    const recipientInbox = await inbox(recipientToken);
    expect(recipientInbox.notifications).toHaveLength(1);
    expect(recipientInbox.notifications[0]).toMatchObject({
      type: 'mention',
      resource_type: 'thread',
      resource_id: threadId,
      space_id: spaceId,
      revision: message.sequence,
      read_at: null,
    });

    const ownerInbox = await inbox(ownerToken);
    expect(ownerInbox.notifications.find((n) => n.resource_id === threadId)).toBeUndefined();
  });

  it('b. a retried post with the same client_message_id adds nothing', async () => {
    const { account: recipient, token: recipientToken } = await freshMember();
    const h = await handleOf(recipient.userId);
    const threadId = await createThread(ownerToken, 'retry thread');

    const first = await postMessage(ownerToken, threadId, `hi @${h} please review `, 'b-1');
    expect(first.status).toBe(201);

    const retry = await postMessage(ownerToken, threadId, `hi @${h} please review `, 'b-1');
    expect(retry.status).toBe(200);

    const recipientInbox = await inbox(recipientToken);
    expect(recipientInbox.notifications.filter((n) => n.resource_id === threadId)).toHaveLength(1);
  });

  it('c. a self-mention, @bob and an unknown handle never notify', async () => {
    // Handles are derived by user_id order and shift when a member joins, so
    // the join must happen before the handle is read.
    const { token: freshToken } = await freshMember();
    const ownerHandle = await handleOf(owner.userId);
    const threadId = await createThread(ownerToken, 'nobody thread');

    const posted = await postMessage(
      ownerToken,
      threadId,
      `@${ownerHandle} @bob @nobody-here `,
      'c-1',
    );
    expect(posted.status).toBe(201);

    const ownerInbox = await inbox(ownerToken);
    expect(ownerInbox.notifications.find((n) => n.resource_id === threadId)).toBeUndefined();

    const freshInbox = await inbox(freshToken);
    expect(freshInbox.notifications.find((n) => n.resource_id === threadId)).toBeUndefined();
  });

  it('d. two recipients, one mentioned twice, each get exactly one item', async () => {
    const { account: r1, token: r1Token } = await freshMember();
    const { account: r2, token: r2Token } = await freshMember();
    const h1 = await handleOf(r1.userId);
    const h2 = await handleOf(r2.userId);
    const threadId = await createThread(ownerToken, 'double mention thread');

    const posted = await postMessage(ownerToken, threadId, `@${h1} @${h2} and again @${h1} `, 'd-1');
    expect(posted.status).toBe(201);

    const r1Inbox = await inbox(r1Token);
    expect(r1Inbox.notifications.filter((n) => n.resource_id === threadId)).toHaveLength(1);
    const r2Inbox = await inbox(r2Token);
    expect(r2Inbox.notifications.filter((n) => n.resource_id === threadId)).toHaveLength(1);
  });

  it('e. a thread-scoped mute silences mentions in that thread only', async () => {
    const { account: recipient, token: recipientToken } = await freshMember();
    const h = await handleOf(recipient.userId);
    const threadA = await createThread(ownerToken, 'thread A');
    const threadB = await createThread(ownerToken, 'thread B');

    await upsertPreference(db, recipient.userId, { threadId: threadA, type: 'mention', muted: true });

    const postedA = await postMessage(ownerToken, threadA, `hey @${h} `, 'e-1');
    expect(postedA.status).toBe(201);

    let recipientInbox = await inbox(recipientToken);
    expect(recipientInbox.notifications.filter((n) => n.resource_id === threadA)).toHaveLength(0);

    const enqueued = events('v2.notifications_enqueued');
    expect(enqueued.length).toBeGreaterThan(0);
    const last = enqueued[enqueued.length - 1]!;
    expect(last).toMatchObject({ type: 'mention', count: 0, muted: 1 });

    const postedB = await postMessage(ownerToken, threadB, `hey @${h} `, 'e-2');
    expect(postedB.status).toBe(201);

    recipientInbox = await inbox(recipientToken);
    expect(recipientInbox.notifications.filter((n) => n.resource_id === threadB)).toHaveLength(1);
  });

  it('f. a message with no @ produces no enqueue events', async () => {
    const threadId = await createThread(ownerToken, 'plain thread');

    const posted = await postMessage(ownerToken, threadId, 'just an ordinary message', 'f-1');
    expect(posted.status).toBe(201);

    expect(events('v2.notifications_enqueued')).toHaveLength(0);
    expect(events('v2.notifications_enqueue_failed')).toHaveLength(0);
  });

  it('g. an enqueue failure never fails the write and journals no PII', async () => {
    const { account: recipient, token: recipientToken } = await freshMember();
    const h = await handleOf(recipient.userId);
    const threadId = await createThread(ownerToken, 'failing enqueue thread');
    activeDb = failingEnqueueDb(db);

    const posted = await postMessage(ownerToken, threadId, `hello @${h} `, 'g-1');
    expect(posted.status).toBe(201);

    const listed = await send('GET', `/api/threads/${threadId}/messages`, ownerToken);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { messages: Array<{ id: string }> };
    expect(listedBody.messages).toHaveLength(1);

    const recipientInbox = await inbox(recipientToken);
    expect(recipientInbox.notifications).toHaveLength(0);

    const failed = events('v2.notifications_enqueue_failed');
    expect(failed).toHaveLength(1);
    expect(Object.keys(failed[0]!).sort()).toEqual(['conversation_id', 'conversation_source', 'count', 'event', 'level', 'message', 'module', 'source', 'ts', 'type']);
    expect(failed[0]).toMatchObject({ type: 'mention' });

    for (const line of lines) {
      expect(line.includes('hello')).toBe(false);
      expect(line.includes(h)).toBe(false);
      expect(line.includes(recipient.userId)).toBe(false);
    }
  });
});
