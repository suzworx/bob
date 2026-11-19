// web-tasks.ts route tests (spec 014, S14-T005, contracts/api.md). A real
// HTTP server over real Postgres with the real store, so the identity-leak rule, the
// optimistic-concurrency 409 body and the Zod rejections are exercised against
// genuine store behaviour rather than fakes. Each state-changing route also has
// one failure-injection test: drive the store to throw and assert the route
// returns the mapped error and does not continue to a success status.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createTask, trashTask } from '../../src/tasks/store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { createTasksRouter } from '../../src/tasks/http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
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
let token: string;

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

describe('tasks HTTP API', () => {
  let owner: TestAccount;
  let member: TestAccount;
  let outsider: TestAccount;
  let ownerToken: string;
  let outsiderToken: string;
  let spaceId: string;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    owner = await addAccount(pg);
    member = await addAccount(pg);
    outsider = await addAccount(pg);
    ownerToken = await tokenFor(owner);
    outsiderToken = await tokenFor(outsider);

    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });
    spaceId = space.id;
    await addMember(db, owner.userId, space.id, member.userId, 'member');

    const app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use('/api', createTasksRouter({ getDb: () => Promise.resolve(db) }));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    token = ownerToken;
  });

  afterAll(async () => {
    server?.close();
    await closeTestDb(pg).catch(() => undefined);
  });

  it('creates, lists, reads and edits a task', async () => {
    const created = await send('POST', `/api/spaces/${spaceId}/tasks`, token, {
      title: 'buy groceries',
      body: 'milk, bread',
      due: { kind: 'date', date: '2026-09-20' },
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string; revision: number; due: unknown };
    expect(task.revision).toBe(1);
    expect(task.due).toEqual({ kind: 'date', date: '2026-09-20' });

    const list = await send('GET', `/api/spaces/${spaceId}/tasks`, token);
    expect(list.status).toBe(200);
    expect((await list.json()) as { tasks: unknown[] }).toMatchObject({ tasks: [expect.objectContaining({ id: task.id })] });

    const read = await send('GET', `/api/tasks/${task.id}`, token);
    expect(read.status).toBe(200);
    expect((await read.json()) as { title: string }).toMatchObject({ title: 'buy groceries' });

    const patched = await send('PATCH', `/api/tasks/${task.id}`, token, {
      revision: 1,
      title: 'buy groceries + eggs',
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()) as { title: string; revision: number }).toMatchObject({
      title: 'buy groceries + eggs',
      revision: 2,
    });
  });

  it('PATCH space_id moves a task to another of the caller\'s spaces', async () => {
    const other = await createSpace(db, owner.userId, { kind: 'group', name: 'Work' });
    const task = await createTask(db, owner.userId, spaceId, { title: 'file taxes' });
    const moved = await send('PATCH', `/api/tasks/${task.id}`, token, { revision: 1, space_id: other.id });
    expect(moved.status).toBe(200);
    expect((await moved.json()) as { space_id: string }).toMatchObject({ space_id: other.id, revision: 2 });

    const hidden = await createSpace(db, outsider.userId, { kind: 'group', name: 'Elsewhere' });
    const refused = await send('PATCH', `/api/tasks/${task.id}`, token, { revision: 2, space_id: hidden.id });
    expect(refused.status).toBe(404);
  });

  it('404 not_found for an id outside the audience equals a missing id', async () => {
    const task = await createTask(db, owner.userId, spaceId, { title: 'secret plan' });
    const hidden = await send('GET', `/api/tasks/${task.id}`, outsiderToken);
    const missing = await send('GET', `/api/tasks/${randomUUID()}`, outsiderToken);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const hiddenBody = (await hidden.json()) as { error: { code: string } };
    const missingBody = (await missing.json()) as { error: { code: string } };
    expect(hiddenBody).toEqual(missingBody);
    expect(hiddenBody).toMatchObject({ error: { code: 'not_found' } });
  });

  it('409 conflict body carries the current revision on a stale PATCH', async () => {
    const task = await createTask(db, owner.userId, spaceId, { title: 'contended' });
    const first = await send('PATCH', `/api/tasks/${task.id}`, token, { revision: 1, title: 'v2' });
    expect(first.status).toBe(200);

    const stale = await send('PATCH', `/api/tasks/${task.id}`, token, { revision: 1, title: 'stale' });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { error: { code: string; current_revision: number } };
    expect(body.error.code).toBe('conflict');
    expect(body.error.current_revision).toBe(2);
  });

  it('400 invalid_request for a Zod-rejected body', async () => {
    const res = await send('POST', `/api/spaces/${spaceId}/tasks`, token, {
      title: '   ',
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'invalid_request' },
    });
  });

  it('401 without a token', async () => {
    const res = await send('GET', `/api/spaces/${spaceId}/tasks`, null);
    expect(res.status).toBe(401);
  });

  it('failure-injection: POST create maps a store throw to 409 and does not continue', async () => {
    const res = await send('POST', `/api/spaces/${spaceId}/tasks`, token, {
      title: 'assigned to an outsider',
      assignee_user_id: outsider.userId,
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'conflict' },
    });
  });

  it('failure-injection: PATCH maps a store conflict and does not continue', async () => {
    const task = await createTask(db, owner.userId, spaceId, { title: 'patch target' });
    const res = await send('PATCH', `/api/tasks/${task.id}`, token, { revision: 999, title: 'x' });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'conflict' },
    });
  });

  it('completes and reopens a task over HTTP, and a stale status change is 409', async () => {
    const task = await createTask(db, owner.userId, spaceId, { title: 'tickable' });

    // Complete: 200, status completed, completed_at/completed_by set.
    const done = await send('PATCH', `/api/tasks/${task.id}`, token, {
      revision: 1,
      status: 'completed',
    });
    expect(done.status).toBe(200);
    const doneBody = (await done.json()) as {
      status: string;
      revision: number;
      completed_at: number | null;
      completed_by: string | null;
    };
    expect(doneBody.status).toBe('completed');
    expect(doneBody.revision).toBe(2);
    expect(doneBody.completed_at).not.toBeNull();
    expect(doneBody.completed_by).toBe(owner.userId);

    // Reopen: 200, status open, both cleared.
    const reopened = await send('PATCH', `/api/tasks/${task.id}`, token, {
      revision: 2,
      status: 'open',
    });
    expect(reopened.status).toBe(200);
    const reopenedBody = (await reopened.json()) as {
      status: string;
      revision: number;
      completed_at: number | null;
      completed_by: string | null;
    };
    expect(reopenedBody.status).toBe('open');
    expect(reopenedBody.revision).toBe(3);
    expect(reopenedBody.completed_at).toBeNull();
    expect(reopenedBody.completed_by).toBeNull();

    // A stale revision on a status change returns 409, not 400 and not 200.
    const stale = await send('PATCH', `/api/tasks/${task.id}`, token, {
      revision: 2,
      status: 'completed',
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()) as { error: { code: string; current_revision: number } }).toMatchObject({
      error: { code: 'conflict', current_revision: 3 },
    });
  });

  it('applies status and other fields atomically against the same revision', async () => {
    const task = await createTask(db, owner.userId, spaceId, { title: 'atomic' });
    const res = await send('PATCH', `/api/tasks/${task.id}`, token, {
      revision: 1,
      status: 'completed',
      title: 'atomic + done',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; title: string; revision: number };
    expect(body.status).toBe('completed');
    expect(body.title).toBe('atomic + done');
    expect(body.revision).toBe(2);
  });

  it('failure-injection: DELETE maps a store throw and does not continue', async () => {
    const task = await createTask(db, owner.userId, spaceId, { title: 'delete target' });
    // An outsider cannot trash it -> the store throws StoreNotFoundError -> 404.
    const res = await send('DELETE', `/api/tasks/${task.id}`, outsiderToken);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'not_found' },
    });
  });

  it('failure-injection: restore maps a store throw and does not continue', async () => {
    const task = await createTask(db, owner.userId, spaceId, { title: 'restore target' });
    await trashTask(db, owner.userId, task.id);
    const res = await send('POST', `/api/tasks/${task.id}/restore`, outsiderToken);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'not_found' },
    });
  });

  it('failure-injection: POST items maps a store throw and does not continue', async () => {
    const task = await createTask(db, owner.userId, spaceId, { title: 'list with items' });
    const res = await send('POST', `/api/tasks/${task.id}/items`, token, {
      title: 'item',
      assignee_user_id: outsider.userId, // store throws: not an active member
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'conflict' },
    });
  });

  it('failure-injection: POST subscribers maps a store throw and does not continue', async () => {
    const task = await createTask(db, owner.userId, spaceId, { title: 'watch target' });
    const res = await send('POST', `/api/tasks/${task.id}/subscribers`, token, {
      user_id: outsider.userId, // store throws: not an active member
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'conflict' },
    });
  });

  it('failure-injection: DELETE subscriber maps a store throw and does not continue', async () => {
    const task = await createTask(db, owner.userId, spaceId, { title: 'unwatch target' });
    const res = await send('DELETE', `/api/tasks/${task.id}/subscribers/${member.userId}`, outsiderToken);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'not_found' },
    });
  });

  it('items and subscribers happy paths', async () => {
    const list = await createTask(db, owner.userId, spaceId, { title: 'project plan' });
    const itemRes = await send('POST', `/api/tasks/${list.id}/items`, token, { title: 'step one' });
    expect(itemRes.status).toBe(201);
    const item = (await itemRes.json()) as { id: string };
    expect(item.id).toBeDefined();

    const items = await send('GET', `/api/tasks/${list.id}/items`, token);
    expect(items.status).toBe(200);
    expect((await items.json()) as { items: unknown[] }).toMatchObject({
      items: [expect.objectContaining({ id: item.id })],
    });

    const subRes = await send('POST', `/api/tasks/${list.id}/subscribers`, token, {
      user_id: member.userId,
    });
    expect(subRes.status).toBe(201);

    const subs = await send('GET', `/api/tasks/${list.id}/subscribers`, token);
    expect(subs.status).toBe(200);
    expect((await subs.json()) as { subscribers: unknown[] }).toMatchObject({
      subscribers: [expect.objectContaining({ user_id: member.userId })],
    });

    const del = await send('DELETE', `/api/tasks/${list.id}/subscribers/${member.userId}`, token);
    expect(del.status).toBe(204);
  });

  describe('PATCH /api/tasks/:id/items/:itemId reorders (#510)', () => {
    type Item = { id: string; title: string; order_key: string; revision: number };

    async function makeList(titles: string[]): Promise<{ listId: string; items: Item[] }> {
      const list = await createTask(db, owner.userId, spaceId, { title: 'reorder list' });
      for (const title of titles) {
        await createTask(db, owner.userId, spaceId, { title, parentTaskId: list.id });
      }
      return { listId: list.id, items: await readItems(list.id, ownerToken) };
    }

    async function readItems(listId: string, tok: string): Promise<Item[]> {
      const res = await send('GET', `/api/tasks/${listId}/items`, tok);
      expect(res.status).toBe(200);
      return ((await res.json()) as { items: Item[] }).items;
    }

    it('moving C before A: two independent GETs both return [C, A, B]', async () => {
      const { listId, items } = await makeList(['A', 'B', 'C']);
      const [a, , c] = items;
      const moved = await send('PATCH', `/api/tasks/${listId}/items/${c!.id}`, ownerToken, {
        before_item_id: a!.id,
        revision: c!.revision,
      });
      expect(moved.status).toBe(200);
      expect(((await moved.json()) as Item).revision).toBe(c!.revision + 1);
      const memberToken = await tokenFor(member);
      const [first, second] = await Promise.all([readItems(listId, ownerToken), readItems(listId, memberToken)]);
      expect(first.map((i) => i.title)).toEqual(['C', 'A', 'B']);
      expect(second.map((i) => i.title)).toEqual(['C', 'A', 'B']);
    });

    it('concurrent moves from two clients converge on one order with unique keys', async () => {
      const { listId, items } = await makeList(['A', 'B', 'C', 'D']);
      const [a, b, c, d] = items;
      const memberToken = await tokenFor(member);
      const results = await Promise.all([
        send('PATCH', `/api/tasks/${listId}/items/${d!.id}`, ownerToken, { after_item_id: a!.id, revision: d!.revision }),
        send('PATCH', `/api/tasks/${listId}/items/${c!.id}`, memberToken, { after_item_id: a!.id, revision: c!.revision }),
        send('PATCH', `/api/tasks/${listId}/items/${b!.id}`, memberToken, { before_item_id: a!.id, revision: b!.revision }),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      const [first, second] = await Promise.all([readItems(listId, ownerToken), readItems(listId, memberToken)]);
      expect(second).toEqual(first);
      expect(new Set(first.map((i) => i.order_key)).size).toBe(4);
      const titles = first.map((i) => i.title);
      expect(titles[0]).toBe('B');
      expect(titles[1]).toBe('A');
      expect(titles.slice(2).sort()).toEqual(['C', 'D']);
    });

    it('a stale revision answers 409 with the current revision and keeps the order', async () => {
      const { listId, items } = await makeList(['A', 'B', 'C']);
      const [a, b, c] = items;
      const ok = await send('PATCH', `/api/tasks/${listId}/items/${c!.id}`, ownerToken, {
        before_item_id: a!.id,
        revision: c!.revision,
      });
      expect(ok.status).toBe(200);
      const stale = await send('PATCH', `/api/tasks/${listId}/items/${c!.id}`, ownerToken, {
        after_item_id: b!.id,
        revision: c!.revision,
      });
      expect(stale.status).toBe(409);
      const body = (await stale.json()) as { error: { code: string; current_revision: number } };
      expect(body.error).toMatchObject({ code: 'conflict', current_revision: c!.revision + 1 });
      expect((await readItems(listId, ownerToken)).map((i) => i.title)).toEqual(['C', 'A', 'B']);
    });

    it('400 for both or neither anchor, 404 for an item of another list or an outsider', async () => {
      const { listId, items } = await makeList(['A', 'B']);
      const other = await makeList(['X']);
      const [a, b] = items;
      const both = await send('PATCH', `/api/tasks/${listId}/items/${a!.id}`, ownerToken, {
        after_item_id: b!.id,
        before_item_id: b!.id,
        revision: 1,
      });
      expect(both.status).toBe(400);
      const neither = await send('PATCH', `/api/tasks/${listId}/items/${a!.id}`, ownerToken, { revision: 1 });
      expect(neither.status).toBe(400);
      const wrongList = await send('PATCH', `/api/tasks/${other.listId}/items/${a!.id}`, ownerToken, {
        after_item_id: b!.id,
        revision: 1,
      });
      expect(wrongList.status).toBe(404);
      const hidden = await send('PATCH', `/api/tasks/${listId}/items/${a!.id}`, outsiderToken, {
        after_item_id: b!.id,
        revision: 1,
      });
      expect(hidden.status).toBe(404);
    });
  });
});