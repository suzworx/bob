// Following a task (#511): a real HTTP server over real Postgres with the real store
// and the real notify producers. A follower gets exactly one 'task_update'
// inbox item when someone else changes the task's status, assignee or due; the
// actor never notifies themself; an unfollowed task, a notes-only edit and a
// muted type send nothing; and a follower who left the space is neither listed
// nor notified.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db } from '../../src/platform/db/db.ts';
import { listNotifications, upsertPreference, type StoredNotification } from '../../src/notifications/store.ts';
import { addMember, createSpace, revokeMember } from '../../src/spaces/store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { createTasksRouter } from '../../src/tasks/http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;
let owner: TestAccount;
let spaceId: string;

type Task = { id: string; revision: number };

async function send(method: string, path: string, account: TestAccount, body?: unknown): Promise<Response> {
  const token = await signToken({ userId: account.userId, sessionId: account.sessionId });
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function member(): Promise<TestAccount> {
  const account = await addAccount(pg);
  await addMember(db, owner.userId, spaceId, account.userId, 'member');
  return account;
}

async function newTask(): Promise<Task> {
  const res = await send('POST', `/api/spaces/${spaceId}/tasks`, owner, { title: 'Water the plants' });
  expect(res.status).toBe(201);
  return (await res.json()) as Task;
}

async function follow(task: Task, account: TestAccount): Promise<void> {
  const res = await send('POST', `/api/tasks/${task.id}/subscribers`, account, { user_id: account.userId });
  expect(res.status).toBe(201);
}

async function patch(task: Task, actor: TestAccount, body: Record<string, unknown>): Promise<Task> {
  const res = await send('PATCH', `/api/tasks/${task.id}`, actor, { revision: task.revision, ...body });
  expect(res.status).toBe(200);
  return (await res.json()) as Task;
}

async function inbox(account: TestAccount, type: StoredNotification['type']): Promise<StoredNotification[]> {
  return (await listNotifications(db, account.userId, { limit: 100 })).filter((n) => n.type === type);
}

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  owner = await addAccount(pg);
  spaceId = (await createSpace(db, owner.userId, { kind: 'group', name: 'Family' })).id;
  const app = express();
  app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.use('/api', createTasksRouter({ getDb: () => Promise.resolve(db) }));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.close();
  await closeTestDb(pg).catch(() => undefined);
});

describe('following a task (#511)', () => {
  it('a follower gets exactly one inbox item when another member completes the task', async () => {
    const follower = await member();
    const task = await newTask();
    await follow(task, follower);
    const done = await patch(task, owner, { status: 'completed' });

    const items = await inbox(follower, 'task_update');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ resourceType: 'task', resourceId: task.id, revision: done.revision,
      spaceId });
  });

  it('the actor never notifies themself', async () => {
    const task = await newTask();
    await follow(task, owner);
    await patch(task, owner, { status: 'completed' });
    expect(await inbox(owner, 'task_update')).toHaveLength(0);
  });

  it('an unfollowed task sends nothing', async () => {
    const follower = await member();
    const task = await newTask();
    await follow(task, follower);
    expect((await send('DELETE', `/api/tasks/${task.id}/subscribers/${follower.userId}`, follower)).status)
      .toBe(204);
    await patch(task, owner, { status: 'completed' });
    expect(await inbox(follower, 'task_update')).toHaveLength(0);
  });

  it('a notes-only edit tells no follower; a due change does', async () => {
    const follower = await member();
    const task = await newTask();
    await follow(task, follower);
    const edited = await patch(task, owner, { body: 'the ferns too' });
    expect(await inbox(follower, 'task_update')).toHaveLength(0);
    await patch(edited, owner, { due: { kind: 'date', date: '2026-10-02' } });
    expect(await inbox(follower, 'task_update')).toHaveLength(1);
  });

  it('respects a per-type mute', async () => {
    const follower = await member();
    await upsertPreference(db, follower.userId, { type: 'task_update', muted: true });
    const task = await newTask();
    await follow(task, follower);
    await patch(task, owner, { status: 'completed' });
    expect(await inbox(follower, 'task_update')).toHaveLength(0);
  });

  it('a follower newly assigned gets the assignment, not a second item', async () => {
    const follower = await member();
    const task = await newTask();
    await follow(task, follower);
    await patch(task, owner, { assignee_user_id: follower.userId });
    expect(await inbox(follower, 'assignment')).toHaveLength(1);
    expect(await inbox(follower, 'task_update')).toHaveLength(0);
  });

  it('a follower who left the space is neither listed nor notified', async () => {
    const stays = await member();
    const leaves = await member();
    const task = await newTask();
    await follow(task, stays);
    await follow(task, leaves);
    await revokeMember(db, leaves.userId, spaceId, leaves.userId);

    const list = await send('GET', `/api/tasks/${task.id}/subscribers`, owner);
    expect(((await list.json()) as { subscribers: Array<{ user_id: string }> }).subscribers
      .map((s) => s.user_id)).toEqual([stays.userId]);
    await patch(task, owner, { status: 'completed' });
    expect(await inbox(stays, 'task_update')).toHaveLength(1);
    expect(await inbox(leaves, 'task_update')).toHaveLength(0);
  });
});
