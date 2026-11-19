// TZ-FIX: a timed task due is local wall time in the ACCOUNT zone, never a zone
// the model picks (docs/investigations/tz-due.md on fw/TZ-DUE). Dark behind
// BOB_LOCAL_TIME_DUES=on; unset keeps the legacy schema and pass-through.
// Real Postgres test db, through all three binders and the real tools.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Db } from '../../src/platform/db/db.ts';
import { ensurePrivateSpace } from '../../src/spaces/store.ts';
import { getTask } from '../../src/tasks/store.ts';
import { bindPrivateCallbacks as bindWeb } from '../../src/tasks/agent-callbacks.ts';
import { bindPrivateCallbacks as bindTurn } from '../../src/tasks/agent-callbacks.ts';
import { bindCallbacks } from '../../src/workflows/workflow-thread-invocation.ts';
import { type LocalTimeScope } from '../../src/conversations/invocations-service.ts';
import { createProductivityTools, localTimeDuesEnabled, type ProductivityCallbacks } from '@bob/ai';
import { createTaskInputSchema, localCreateTaskInputSchema, updateTaskInputSchema } from '@bob/ai/testing';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

type Binder = (userId: string, spaceId: string, scope: LocalTimeScope) => ProductivityCallbacks;
const BINDERS: Array<[string, Binder]> = [
  ['web-chat', (userId, spaceId, scope) => bindWeb(db, userId, spaceId, scope)],
  ['turn', (userId, spaceId, scope) => bindTurn(db, userId, spaceId, scope)],
  ['invocations', (userId, spaceId, scope) => bindCallbacks(db, {
    actorUserId: userId, spaceId, threadId: 'unused', triggerMessageId: 'unused', contextHighWater: 0,
  }, scope)],
];

type Result = { ok: boolean; taskId?: string; reason?: string; items?: Array<{ due: string | null }> };

/** A private space, its tools under `timeZone` and the flag, and a store reader. */
async function setup(bind: Binder, timeZone: string, localTimeDues = true) {
  const { userId } = await addAccount(pg);
  const space = await ensurePrivateSpace(db, userId);
  const tools = createProductivityTools(bind(userId, space.id, { timeZone, localTimeDues }), { localTimeDues });
  const call = (name: string, input: unknown): Promise<Result> =>
    (tools[name] as unknown as { execute(i: unknown): Promise<Result> }).execute(input);
  const stored = async (taskId: string) => {
    const task = await getTask(db, userId, taskId);
    return { at: task.dueAt === null ? null : new Date(task.dueAt).toISOString(), zone: task.dueZone };
  };
  return { call, stored };
}

describe.each(BINDERS)('BOB_LOCAL_TIME_DUES=on: %s binder', (_name, bind) => {
  it.each([
    ['America/Los_Angeles', '2026-09-24T09:00', '2026-09-24T16:00:00.000Z'],
    ['Asia/Kolkata', '2026-09-24T09:00', '2026-09-24T03:30:00.000Z'],
    ['America/Los_Angeles', '2027-03-14T02:30', '2027-03-14T10:30:00.000Z'], // DST gap moves forward
  ])('create_task in %s at %s stores %s', async (zone, at, expected) => {
    const { call, stored } = await setup(bind, zone);
    const res = await call('create_task', { title: 'Have breakfast with eggs', due: { kind: 'instant', at } });
    expect(res.ok).toBe(true);
    expect(await stored(res.taskId!)).toEqual({ at: expected, zone });
  });

  it.each(['2026-09-24T09:00:00Z', '2026-09-24T09:00+05:30'])('refuses %s, naming the expected shape', async (at) => {
    const { call } = await setup(bind, 'America/Los_Angeles');
    const create = await call('create_task', { title: 'x', due: { kind: 'instant', at } });
    expect(create).toEqual({ ok: false, reason: expect.stringContaining('YYYY-MM-DDTHH:mm') });
    const { taskId } = await call('create_task', { title: 'y' });
    const update = await call('update_task', { taskId, due: { kind: 'instant', at } });
    expect(update).toEqual({ ok: false, reason: expect.stringContaining('no Z or offset') });
  });

  it('update_task converts in the account zone; list_tasks reads back local time plus zone', async () => {
    const { call, stored } = await setup(bind, 'America/Los_Angeles');
    const { taskId } = await call('create_task', { title: 'Call mum', due: { kind: 'date', date: '2026-09-25' } });
    expect(await stored(taskId!)).toEqual({ at: null, zone: null }); // date-only stays date-only
    const res = await call('update_task', { taskId, due: { kind: 'instant', at: '2026-09-25T18:15' } });
    expect(res.ok).toBe(true);
    expect(await stored(taskId!)).toEqual({ at: '2026-09-26T01:15:00.000Z', zone: 'America/Los_Angeles' });
    const list = await call('list_tasks', {});
    expect(list.items?.map((item) => item.due)).toEqual(['2026-09-25T18:15 America/Los_Angeles']);
  });
});

describe('the flag-on schema', () => {
  it('has no zone and describes local wall time', () => {
    const due = { kind: 'instant', at: '2026-09-24T09:00' };
    expect(localCreateTaskInputSchema.safeParse({ title: 'x', due }).success).toBe(true);
    expect(localCreateTaskInputSchema.safeParse({ title: 'x', due: { ...due, zone: 'UTC' } }).success).toBe(false);
    expect(JSON.stringify(z.toJSONSchema(localCreateTaskInputSchema))).toContain(
      "local wall-clock time in the user's timezone, no offset",
    );
  });

  it('reads the flag only when exactly "on"', () => {
    expect(localTimeDuesEnabled({})).toBe(false);
    expect(localTimeDuesEnabled({ BOB_LOCAL_TIME_DUES: 'true' })).toBe(false);
    expect(localTimeDuesEnabled({ BOB_LOCAL_TIME_DUES: 'on' })).toBe(true);
  });
});

describe('BOB_LOCAL_TIME_DUES unset: the legacy contract', () => {
  it('offers the legacy task schemas, byte-identical', () => {
    const tools = createProductivityTools({} as ProductivityCallbacks, { localTimeDues: false });
    expect(tools.create_task?.inputSchema).toBe(createTaskInputSchema);
    expect(tools.update_task?.inputSchema).toBe(updateTaskInputSchema);
    expect(JSON.stringify(z.toJSONSchema(createTaskInputSchema))).toBe(LEGACY_CREATE_TASK_JSON);
  });

  it.each(BINDERS)('%s stores the model at and zone verbatim, reads back bare UTC', async (_name, bind) => {
    const { call, stored } = await setup(bind, 'America/Los_Angeles', false);
    const due = { kind: 'instant', at: '2026-09-24T09:00:00Z', zone: 'UTC' };
    const { taskId } = await call('create_task', { title: 'Have breakfast with eggs', due });
    expect(await stored(taskId!)).toEqual({ at: '2026-09-24T09:00:00.000Z', zone: 'UTC' });
    expect((await call('list_tasks', {})).items?.map((item) => item.due)).toEqual(['2026-09-24T09:00:00.000Z']);
  });
});

/** The pre-TZ-FIX create_task input schema, exactly as the provider receives it. */
const LEGACY_CREATE_TASK_JSON =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"title":{"type":"string","minLength":1,"maxLength":200},"assigneeHandle":{"type":"string","minLength":1,"description":"The name or @handle of a space member, exactly as the person said it; the server finds the member"},"due":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"date"},"date":{"type":"string"}},"required":["kind","date"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"instant"},"at":{"type":"string"},"zone":{"type":"string"}},"required":["kind","at","zone"],"additionalProperties":false}]}},"required":["title"],"additionalProperties":false}';
