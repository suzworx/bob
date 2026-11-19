// Prod 2026-10-06: the assistant said a task was "assigned to Samir" but no binder ever
// passed the assignee to the store (create_task dropped assigneeHandle) and update_task had
// no assignee at all, so "assign it to sameer4work" could only be restated, never done.
// Real Postgres, both binders, the real tools: an assignment the tool reports is one
// the store holds, and an unknown or ambiguous name changes nothing and names the members.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { getTask, listTasks } from '../../src/tasks/store.ts';
import { bindPrivateCallbacks } from '../../src/tasks/agent-callbacks.ts';
import { bindCallbacks } from '../../src/workflows/workflow-thread-invocation.ts';
import { createProductivityTools, type ProductivityCallbacks } from '@bob/ai';
import { asDb, addAccount, closeTestDb, createTestDb, withAdminAuth, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

type Binder = (userId: string, spaceId: string) => ProductivityCallbacks;
const SCOPE = { timeZone: 'UTC', localTimeDues: false };
const BINDERS: Array<[string, Binder]> = [
  ['turn/web-chat', (userId, spaceId) => bindPrivateCallbacks(db, userId, spaceId, SCOPE)],
  ['invocations', (userId, spaceId) => bindCallbacks(db, {
    actorUserId: userId, spaceId, threadId: 'unused', triggerMessageId: 'unused', contextHighWater: 0,
  }, SCOPE)],
];

type Result = { ok: boolean; taskId?: string; assignee?: string | null; reason?: string };

/** A group space: the owner "Sameer Rivera", a member @sameer4work and a member Maya. */
async function setup(bind: Binder) {
  const owner = await addAccount(pg);
  const work = await addAccount(pg);
  const maya = await addAccount(pg);
  await withAdminAuth(pg, async (admin) => {
    await admin.setProfile(owner.userId, { name: 'Sameer Rivera' });
    await admin.setProfile(work.userId, { name: 'sameer4work' });
    await admin.setProfile(maya.userId, { name: 'Maya' });
  });
  const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Home' });
  await addMember(db, owner.userId, space.id, work.userId, 'member');
  await addMember(db, owner.userId, space.id, maya.userId, 'member');
  const tools = createProductivityTools(bind(owner.userId, space.id), { localTimeDues: false });
  const call = (name: string, input: unknown): Promise<Result> =>
    (tools[name] as unknown as { execute(i: unknown): Promise<Result> }).execute(input);
  const assigneeOf = async (taskId: string) => (await getTask(db, owner.userId, taskId)).assigneeUserId;
  return { owner, work, maya, space, call, assigneeOf };
}

describe.each(BINDERS)('task assignment through the %s binder', (_name, bind) => {
  it('update_task reassigns an existing task to a spoken handle and names who it set', async () => {
    const { work, call, assigneeOf } = await setup(bind);
    const { taskId } = await call('create_task', { title: 'work' });
    const res = await call('update_task', { taskId, assigneeHandle: 'Samir number four work' });
    expect(res).toMatchObject({ ok: true, taskId, assignee: '@sameer4work' });
    expect(await assigneeOf(taskId!)).toBe(work.userId);
  });

  it('create_task assigns the named member, and null on update_task unassigns', async () => {
    const { maya, call, assigneeOf } = await setup(bind);
    const created = await call('create_task', { title: 'water the plants', assigneeHandle: 'maya' });
    expect(created).toMatchObject({ ok: true, assignee: '@maya' });
    expect(await assigneeOf(created.taskId!)).toBe(maya.userId);
    const cleared = await call('update_task', { taskId: created.taskId, assigneeHandle: null });
    expect(cleared).toMatchObject({ ok: true, assignee: null });
    expect(await assigneeOf(created.taskId!)).toBeNull();
  });

  it('an unknown name fails naming the members and creates nothing', async () => {
    const { owner, space, call } = await setup(bind);
    const res = await call('create_task', { title: 'work', assigneeHandle: 'Priya' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('@sameer4work');
    expect(res.reason).toContain('@maya');
    expect(await listTasks(db, owner.userId, space.id, {})).toEqual([]);
  });

  it('"assign it to Mark" matches no one in the space and creates nothing', async () => {
    const { owner, space, call } = await setup(bind);
    const res = await call('create_task', { title: 'work', assigneeHandle: 'Mark' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('@sameer4work');
    expect(res.reason).toContain('@maya');
    expect(await listTasks(db, owner.userId, space.id, {})).toEqual([]);
  });

  it('an ambiguous name leaves the task as it was and lists only the matches', async () => {
    const { owner, space, call, assigneeOf } = await setup(bind);
    const kumar = await addAccount(pg);
    await withAdminAuth(pg, (admin) => admin.setProfile(kumar.userId, { name: 'Sameer Kumar' }));
    await addMember(db, owner.userId, space.id, kumar.userId, 'member');
    const { taskId } = await call('create_task', { title: 'work' });
    const res = await call('update_task', { taskId, assigneeHandle: 'Sameer' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('Sameer Rivera (@sameer.rivera)');
    expect(res.reason).toContain('Sameer Kumar (@sameer.kumar)');
    expect(res.reason).not.toContain('@maya');
    expect(await assigneeOf(taskId!)).toBeNull();
  });
});
