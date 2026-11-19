// Notification producer tests for task assignment (gap G17, spec 014 FR-018).
// A real HTTP server over real Postgres with the real store: assigning a task
// enqueues an 'assignment' notification in the same request, respects the
// recipient's own mute preference, and never fails the write when the
// enqueue itself throws.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setJournalSink } from '../../src/platform/logger.ts';
import { type Db } from '../../src/platform/db/db.ts';
import { upsertPreference } from '../../src/notifications/store.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { createNotificationsRouter } from '../../src/notifications/http.ts';
import { createTasksRouter } from '../../src/tasks/http.ts';
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

describe('task assignment notifications', () => {
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
    app.use('/api', createTasksRouter({ getDb: () => Promise.resolve(activeDb) }));
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

  async function inbox(token: string): Promise<{ notifications: NotificationItem[]; unread_count: number }> {
    const response = await send('GET', '/api/notifications?limit=100', token);
    expect(response.status).toBe(200);
    return (await response.json()) as { notifications: NotificationItem[]; unread_count: number };
  }

  it('a. task creation assigned to someone else notifies the recipient only', async () => {
    const { account: recipient, token: recipientToken } = await freshMember();

    const created = await send('POST', `/api/spaces/${spaceId}/tasks`, ownerToken, {
      title: 'buy groceries',
      assignee_user_id: recipient.userId,
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string };

    const recipientInbox = await inbox(recipientToken);
    expect(recipientInbox.unread_count).toBe(1);
    expect(recipientInbox.notifications).toHaveLength(1);
    expect(recipientInbox.notifications[0]).toMatchObject({
      type: 'assignment',
      resource_type: 'task',
      resource_id: task.id,
      space_id: spaceId,
      revision: 1,
      read_at: null,
    });

    const ownerInbox = await inbox(ownerToken);
    expect(ownerInbox.notifications.find((n) => n.resource_id === task.id)).toBeUndefined();
  });

  it('b. self-assignment notifies nobody', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/tasks`, ownerToken, {
      title: 'self task',
      assignee_user_id: owner.userId,
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string };

    const ownerInbox = await inbox(ownerToken);
    expect(ownerInbox.notifications.find((n) => n.resource_id === task.id)).toBeUndefined();
  });

  it('c. PATCH assignment notifies once per real assignee change', async () => {
    const { account: recipient, token: recipientToken } = await freshMember();

    const created = await send('POST', `/api/spaces/${spaceId}/tasks`, ownerToken, { title: 'unassigned' });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string; revision: number };
    expect(task.revision).toBe(1);

    const p1 = await send('PATCH', `/api/tasks/${task.id}`, ownerToken, {
      revision: 1,
      assignee_user_id: recipient.userId,
    });
    expect(p1.status).toBe(200);
    expect(((await p1.json()) as { revision: number }).revision).toBe(2);

    let recipientInbox = await inbox(recipientToken);
    expect(recipientInbox.notifications.filter((n) => n.resource_id === task.id)).toHaveLength(1);

    const p2 = await send('PATCH', `/api/tasks/${task.id}`, ownerToken, {
      revision: 2,
      title: 'renamed',
      assignee_user_id: recipient.userId,
    });
    expect(p2.status).toBe(200);

    recipientInbox = await inbox(recipientToken);
    expect(recipientInbox.notifications.filter((n) => n.resource_id === task.id)).toHaveLength(1);

    const p3 = await send('PATCH', `/api/tasks/${task.id}`, ownerToken, {
      revision: 3,
      assignee_user_id: null,
    });
    expect(p3.status).toBe(200);

    recipientInbox = await inbox(recipientToken);
    expect(recipientInbox.notifications.filter((n) => n.resource_id === task.id)).toHaveLength(1);

    const p4 = await send('PATCH', `/api/tasks/${task.id}`, ownerToken, {
      revision: 4,
      assignee_user_id: recipient.userId,
    });
    expect(p4.status).toBe(200);
    expect(((await p4.json()) as { revision: number }).revision).toBe(5);

    recipientInbox = await inbox(recipientToken);
    const matches = recipientInbox.notifications.filter((n) => n.resource_id === task.id);
    expect(matches).toHaveLength(2);
    expect(matches.map((n) => n.revision).sort((a, b) => a - b)).toEqual([2, 5]);
  });

  it('d. checklist item assignment notifies the recipient', async () => {
    const { account: recipient, token: recipientToken } = await freshMember();

    const parent = await send('POST', `/api/spaces/${spaceId}/tasks`, ownerToken, { title: 'list' });
    expect(parent.status).toBe(201);
    const parentTask = (await parent.json()) as { id: string };

    const item = await send('POST', `/api/tasks/${parentTask.id}/items`, ownerToken, {
      title: 'checklist item',
      assignee_user_id: recipient.userId,
    });
    expect(item.status).toBe(201);
    const itemTask = (await item.json()) as { id: string };

    const recipientInbox = await inbox(recipientToken);
    const matches = recipientInbox.notifications.filter((n) => n.resource_id === itemTask.id);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ type: 'assignment', resource_type: 'task' });
  });

  it('e. a muted recipient gets nothing and the enqueue event reports it', async () => {
    const { account: recipient, token: recipientToken } = await freshMember();
    await upsertPreference(db, recipient.userId, { type: 'assignment', muted: true });

    const created = await send('POST', `/api/spaces/${spaceId}/tasks`, ownerToken, {
      title: 'muted assignment',
      assignee_user_id: recipient.userId,
    });
    expect(created.status).toBe(201);

    const recipientInbox = await inbox(recipientToken);
    expect(recipientInbox.notifications).toHaveLength(0);

    const enqueued = events('v2.notifications_enqueued');
    expect(enqueued.length).toBeGreaterThan(0);
    const last = enqueued[enqueued.length - 1]!;
    expect(last).toMatchObject({ type: 'assignment', count: 0, muted: 1 });
  });

  it('f. an enqueue failure never fails the write', async () => {
    const { account: recipient, token: recipientToken } = await freshMember();
    activeDb = failingEnqueueDb(db);

    const created = await send('POST', `/api/spaces/${spaceId}/tasks`, ownerToken, {
      title: 'failing enqueue',
      assignee_user_id: recipient.userId,
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string };

    const read = await send('GET', `/api/tasks/${task.id}`, ownerToken);
    expect(read.status).toBe(200);

    const recipientInbox = await inbox(recipientToken);
    expect(recipientInbox.notifications.filter((n) => n.resource_id === task.id)).toHaveLength(0);

    const failed = events('v2.notifications_enqueue_failed');
    expect(failed).toHaveLength(1);
    expect(Object.keys(failed[0]!).sort()).toEqual(['conversation_id', 'conversation_source', 'count', 'event', 'level', 'message', 'module', 'source', 'ts', 'type']);
    expect(failed[0]).toMatchObject({ type: 'assignment', count: 1 });
  });

  it('g. journal lines carry no recipient id or task id', async () => {
    const { account: recipient } = await freshMember();

    const created = await send('POST', `/api/spaces/${spaceId}/tasks`, ownerToken, {
      title: 'privacy check',
      assignee_user_id: recipient.userId,
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string };

    const relevant = [...events('v2.notifications_enqueued'), ...events('v2.notifications_enqueue_failed')];
    expect(relevant.length).toBeGreaterThan(0);
    const allowedKeys = ['ts', 'level', 'message', 'trace_id', 'span_id', 'event', 'type', 'count', 'muted', 'source', 'module', 'conversation_id', 'conversation_source'];
    for (const entry of relevant) {
      expect(Object.keys(entry).every((k) => allowedKeys.includes(k))).toBe(true);
      const text = JSON.stringify(entry);
      expect(text.includes(recipient.userId)).toBe(false);
      expect(text.includes(task.id)).toBe(false);
    }
  });
});
