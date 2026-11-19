// notifications-http.test.ts (spec 014, S14-INBOX-API, contracts/api.md
// "Notifications"). Proves the inbox router's HTTP contract over the REAL
// mounted server: boots createV2Server() exactly like notes-http.test.ts, with
// the system-test dev auth path (BOB_SYSTEM_TEST=1 + loopback bind) minting
// tokens via /api/test-token that the real /api JWT guard accepts. The router
// is mounted in server.ts by this same change, so this file is the end-to-end
// proof that the mount works -- not a hand-built express app that could go
// green while the route is dead in the running app.
//
// Every assertion is on the HTTP response -- never on a store function's return
// value -- so a future unmount or misroute fails here. Notifications are seeded
// through the store's server-side enqueue path only as test setup.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createV2Server } from '../../src/server.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createTask } from '../../src/tasks/store.ts';
import { enqueueNotifications, listNotifications, type NewNotification } from '../../src/notifications/store.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb,
} from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;
let spaceId: string;
let ownerId: string;

async function issueToken(userId: string): Promise<string> {
  const issued = await fetch(`${baseUrl}/api/test-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  expect(issued.status).toBe(200);
  const body = (await issued.json()) as { token: string };
  return body.token;
}

async function send(method: string, path: string, tok: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tok}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A NewNotification for the shared space (the owner is a member, so RLS
 *  returns it) with a fresh resource id and a unique effect key. */
function notif(recipientUserId: string, effectKey: string): NewNotification {
  return {
    recipientUserId,
    spaceId,
    type: 'mention',
    resourceType: 'thread',
    resourceId: randomUUID(),
    effectKey,
  };
}

/** A fresh account + a bearer token, joined to the shared space so the
 *  notifications seeded into it are visible under the RLS select policy. */
async function newAccount(): Promise<{ account: TestAccount; token: string }> {
  const account = await addAccount(pg);
  await addMember(db, ownerId, spaceId, account.userId, 'member');
  return { account, token: await issueToken(account.userId) };
}

type WireNotification = {
  id: string;
  space_id: string | null;
  type: string;
  resource_type: string;
  resource_id: string;
  revision: number;
  cursor: number;
  read_at: number | null;
  created_at: number;
  about: {
    actor_name: string | null;
    title: string | null;
    space_name: string | null;
    at: number | null;
    date: string | null;
    action: string | null;
  } | null;
};

type InboxPage = {
  notifications: WireNotification[];
  next_cursor: number | null;
  unread_count: number;
};

/** Reject only this feature's read; real session admission and RLS setup still run. */
function rejectingDb(real: Db = db): Db {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (/\bfrom\s+bob\.notifications\b/i.test(sql)) {
        throw new Error('injected store failure');
      }
      return real.query<T>(sql, params);
    },
    tx<T>(run: (transaction: Db) => Promise<T>): Promise<T> {
      return real.tx(transaction => run(rejectingDb(transaction)));
    },
  };
}

describe('notifications HTTP API over the mounted server', () => {
  beforeAll(async () => {
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.BOB_V2_HOST = '127.0.0.1';
    pg = await createTestDb();
    db = asDb(pg);
    setSharedDb(Promise.resolve(db));
    const owner = await addAccount(pg);
    ownerId = owner.userId;
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });
    spaceId = space.id;

    const created = await createV2Server();
    server = created.server;
    await new Promise<void>((resolve) => created.server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(created.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(pg).catch(() => undefined);
    await closeDb().catch(() => undefined);
    delete process.env.BOB_SYSTEM_TEST;
    delete process.env.BOB_V2_HOST;
  });

  it('an empty inbox answers 200 with an empty list and unread_count 0', async () => {
    const { token } = await newAccount();
    const res = await send('GET', '/api/notifications', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InboxPage;
    expect(body).toEqual({ notifications: [], next_cursor: null, unread_count: 0 });
  });

  it('seeded notifications come back newest-first; paging returns each row exactly once', async () => {
    const { account, token } = await newAccount();
    for (let i = 0; i < 5; i += 1) {
      await enqueueNotifications(db, [notif(account.userId, `page-${i}`)]);
    }

    const seen: WireNotification[] = [];
    let after: number | null = null;
    for (let pages = 0; pages < 10; pages += 1) {
      const query = after === null ? 'limit=2' : `limit=2&after=${after}`;
      const res = await send('GET', `/api/notifications?${query}`, token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as InboxPage;
      seen.push(...body.notifications);
      if (body.next_cursor === null) break;
      after = body.next_cursor;
    }

    // All five rows, each exactly once, in strictly newest-first cursor order.
    expect(seen).toHaveLength(5);
    expect(new Set(seen.map((n) => n.id)).size).toBe(5);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i - 1]!.cursor).toBeGreaterThan(seen[i]!.cursor);
    }
    // Every item is from the shared space and carries the resource pointer.
    for (const item of seen) {
      expect(item.space_id).toBe(spaceId);
      expect(item.resource_type).toBe('thread');
      expect(item.resource_id).toBeTruthy();
      expect(item.type).toBe('mention');
      expect(item.revision).toBe(1);
      expect(item.read_at).toBeNull();
    }
    // #868: each item says when it happened: the stored created time, in epoch ms.
    const stored = new Map((await listNotifications(db, account.userId, { limit: 10 }))
      .map((row) => [row.id, row.createdAt]));
    for (const item of seen) {
      expect(item.created_at).toBe(stored.get(item.id));
      expect(Number.isInteger(item.created_at) && item.created_at > 0).toBe(true);
    }
  });

  it('each item says what it is about, read as the recipient; a missing resource is about nothing (redesign #1240)', async () => {
    const { account, token } = await newAccount();
    const task = await createTask(db, ownerId, spaceId, { title: 'Update Insurance', due: { kind: 'date', date: '2026-10-22' } });
    await enqueueNotifications(db, [
      { recipientUserId: account.userId, spaceId, type: 'assignment', resourceType: 'task',
        resourceId: task.id, revision: task.revision, effectKey: `about-task-${task.id}` },
      notif(account.userId, 'about-missing-thread'),
    ]);
    const res = await send('GET', '/api/notifications', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InboxPage;
    const [missing, assigned] = body.notifications;
    expect(assigned?.about).toEqual({
      actor_name: null, title: 'Update Insurance', space_name: 'Family', at: null, date: '2026-10-22', action: null,
    });
    // The thread id names nothing the recipient can read.
    expect(missing?.about).toBeNull();
  });

  it('unread=true filters, and PUT /read by ids moves exactly those', async () => {
    const { account, token } = await newAccount();
    for (let i = 0; i < 4; i += 1) {
      await enqueueNotifications(db, [notif(account.userId, `unread-${i}`)]);
    }

    const before = await send('GET', '/api/notifications?unread=true', token);
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as InboxPage;
    expect(beforeBody.notifications).toHaveLength(4);
    expect(beforeBody.unread_count).toBe(4);
    const newest = beforeBody.notifications[0]!;

    const marked = await send('PUT', '/api/notifications/read', token, { ids: [newest.id] });
    expect(marked.status).toBe(200);
    expect((await marked.json()) as { moved: number }).toEqual({ moved: 1 });

    const after = await send('GET', '/api/notifications?unread=true', token);
    const afterBody = (await after.json()) as InboxPage;
    expect(afterBody.notifications).toHaveLength(3);
    expect(afterBody.notifications.map((n) => n.id)).not.toContain(newest.id);
    expect(afterBody.unread_count).toBe(3);

    // The full inbox still lists the read row, now with a read_at timestamp.
    const full = await send('GET', '/api/notifications', token);
    const fullBody = (await full.json()) as InboxPage;
    expect(fullBody.notifications).toHaveLength(4);
    const readRow = fullBody.notifications.find((n) => n.id === newest.id);
    expect(readRow?.read_at).not.toBeNull();
    expect(fullBody.unread_count).toBe(3);
  });

  it('PUT /read with up_to_cursor moves everything at or below it and is idempotent on replay', async () => {
    const { account, token } = await newAccount();
    for (let i = 0; i < 4; i += 1) {
      await enqueueNotifications(db, [notif(account.userId, `cursor-${i}`)]);
    }
    const first = await send('GET', '/api/notifications', token);
    const firstBody = (await first.json()) as InboxPage;
    // Newest-first: [0] newest (highest cursor) ... [3] oldest.
    const secondNewest = firstBody.notifications[1]!;

    const marked = await send('PUT', '/api/notifications/read', token, {
      up_to_cursor: secondNewest.cursor,
    });
    expect(marked.status).toBe(200);
    expect((await marked.json()) as { moved: number }).toEqual({ moved: 3 });

    const remaining = await send('GET', '/api/notifications?unread=true', token);
    const remainingBody = (await remaining.json()) as InboxPage;
    expect(remainingBody.notifications).toHaveLength(1);
    expect(remainingBody.notifications[0]!.id).toBe(firstBody.notifications[0]!.id);
    expect(remainingBody.unread_count).toBe(1);

    // Replaying the same write is a no-op that still answers 200.
    const replayed = await send('PUT', '/api/notifications/read', token, {
      up_to_cursor: secondNewest.cursor,
    });
    expect(replayed.status).toBe(200);
    expect((await replayed.json()) as { moved: number }).toEqual({ moved: 0 });
  });

  it('a body with BOTH ids and up_to_cursor is a 400 with a named code', async () => {
    const { account, token } = await newAccount();
    await enqueueNotifications(db, [notif(account.userId, 'both-keys')]);
    const first = await send('GET', '/api/notifications', token);
    const body = (await first.json()) as InboxPage;
    const id = body.notifications[0]!.id;

    const res = await send('PUT', '/api/notifications/read', token, {
      ids: [id],
      up_to_cursor: 1,
    });
    expect(res.status).toBe(400);
    const error = (await res.json()) as { error: { code: string } };
    expect(error.error.code).toBe('invalid_request');
  });

  it('preferences round-trip, and quiet hours without a zone is a 400', async () => {
    const { token } = await newAccount();

    const empty = await send('GET', '/api/notification-preferences', token);
    expect(empty.status).toBe(200);
    expect((await empty.json()) as { preferences: unknown[] }).toEqual({ preferences: [] });

    const created = await send('PUT', '/api/notification-preferences', token, {
      type: 'mention',
      muted: true,
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      id: string;
      type: string | null;
      muted: boolean;
    };
    expect(createdBody.type).toBe('mention');
    expect(createdBody.muted).toBe(true);
    expect(createdBody.id).toBeTruthy();

    const listed = await send('GET', '/api/notification-preferences', token);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      preferences: Array<{ id: string; muted: boolean }>;
    };
    expect(listedBody.preferences).toHaveLength(1);
    expect(listedBody.preferences[0]!.id).toBe(createdBody.id);

    const bobMessages = await send('PUT', '/api/notification-preferences', token, {
      type: 'bob_message',
      muted: true,
    });
    expect(bobMessages.status).toBe(200);
    expect(await bobMessages.json()).toMatchObject({ type: 'bob_message', muted: true });

    const quiet = await send('PUT', '/api/notification-preferences', token, {
      muted: false,
      quiet_hours_start: '22:00:00',
      quiet_hours_end: '07:00:00',
      quiet_zone: 'Asia/Kolkata',
    });
    expect(quiet.status).toBe(200);
    const quietBody = (await quiet.json()) as {
      muted: boolean;
      quiet_hours_start: string | null;
      quiet_hours_end: string | null;
      quiet_zone: string | null;
    };
    expect(quietBody.muted).toBe(false);
    expect(quietBody.quiet_hours_start).toBe('22:00:00');
    expect(quietBody.quiet_hours_end).toBe('07:00:00');
    expect(quietBody.quiet_zone).toBe('Asia/Kolkata');

    // A partial quiet-hours body (start + end, no zone) is a 400 invalid_request.
    const partial = await send('PUT', '/api/notification-preferences', token, {
      quiet_hours_start: '22:00:00',
      quiet_hours_end: '07:00:00',
    });
    expect(partial.status).toBe(400);
    const partialBody = (await partial.json()) as { error: { code: string } };
    expect(partialBody.error.code).toBe('invalid_request');
  });

  it('failure-injection: a rejecting store answers a single 500 through the error handler', async () => {
    const { token } = await newAccount();
    setSharedDb(Promise.resolve(rejectingDb()));
    try {
      const res = await send('GET', '/api/notifications', token);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body).toEqual({ error: { code: 'internal', message: 'Internal server error' } });
    } finally {
      setSharedDb(Promise.resolve(db));
    }
  });
});