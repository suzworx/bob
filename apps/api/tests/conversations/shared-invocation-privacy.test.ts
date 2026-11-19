import { createAppTurnExtension } from '../../src/bob-apps/app-turn-extension.ts';
import { saveAppIdea } from '../../src/workflows/workflow-app-idea.ts';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { createBobAgent } from '@bob/ai';
import { createCalendar, createEvent } from '../../src/calendar/store.ts';
import { createThread, postMessage } from '../../src/conversations/thread-store.ts';
import { createSpace, ensurePrivateSpace } from '../../src/spaces/store.ts';
import { createTask, getTask } from '../../src/tasks/store.ts';
import { bindCallbacks, runInvocation } from '../../src/workflows/workflow-thread-invocation.ts';
import { createAgentHarness } from '../support/agent-harness.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import type { Db } from '../../src/platform/db/db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });
afterEach(() => { vi.restoreAllMocks(); });
const now = Date.UTC(2030, 5, 10, 10);

async function setup() {
  const actor = (await addAccount(pg)).userId;
  const privateSpace = await ensurePrivateSpace(db, actor);
  const current = await createSpace(db, actor, { kind: 'group', name: 'Current team' });
  const other = await createSpace(db, actor, { kind: 'group', name: 'Other team' });
  const thread = await createThread(db, actor, { spaceId: current.id, title: 'Our plans' });
  const { message } = await postMessage(db, actor, { threadId: thread.id, body: 'What is next?', clientMessageId: randomUUID() });
  const context = { actorUserId: actor, spaceId: current.id, threadId: thread.id, triggerMessageId: message.id, contextHighWater: message.sequence };
  return { actor, privateSpace, current, other, context };
}

async function events(actor: string, spaces: Array<{ id: string }>): Promise<void> {
  for (const [index, space] of spaces.entries()) {
    const calendar = await createCalendar(db, actor, space.id, { name: 'Events', zone: 'UTC' });
    await createEvent(db, actor, calendar.id, { title: ['Private appointment', 'Other team secret', 'Current team launch'][index] ?? '', zone: 'UTC', allDay: false, startAt: now + 60_000, endAt: now + 120_000 });
  }
}

it('includes only current-group events in shared model context', async () => {
  const { actor, privateSpace, current, other, context } = await setup();
  await events(actor, [privateSpace, other, current]);
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const harness = createAgentHarness([[{ type: 'text', text: 'Our launch is next.' }]]);
  const generate = vi.spyOn(harness.agent, 'generate');
  const createAgent = vi.fn<typeof createBobAgent>(() => harness.agent);
  await runInvocation(context, { appTurnTools: createAppTurnExtension(saveAppIdea), db, createAgent });
  const prompt = JSON.stringify(generate.mock.calls[0]?.[0]);
  expect(prompt).toContain('Current team launch');
  expect(prompt).not.toContain('Private appointment');
  expect(prompt).not.toContain('Other team secret');
});

it('lists only current-group agenda entries through the shared tool callback', async () => {
  const { actor, privateSpace, current, other, context } = await setup();
  await events(actor, [privateSpace, other, current]);
  const agenda = await bindCallbacks(db, context).listAgenda({ fromIso: new Date(now).toISOString(), toIso: new Date(now + 86_400_000).toISOString() });
  expect(agenda.map((item) => item.title)).toEqual(['Current team launch']);
});

it('completes only current-group tasks even when the actor can access other task IDs', async () => {
  const { actor, privateSpace, current, other, context } = await setup();
  const own = await createTask(db, actor, current.id, { title: 'Team task' });
  const privateTask = await createTask(db, actor, privateSpace.id, { title: 'Private task' });
  const otherTask = await createTask(db, actor, other.id, { title: 'Other team task' });
  const callbacks = bindCallbacks(db, context);
  for (const task of [privateTask, otherTask]) {
    await expect(callbacks.completeTask({ taskId: task.id })).rejects.toThrow('task not found');
    expect((await getTask(db, actor, task.id)).status).toBe('open');
  }
  expect(await callbacks.completeTask({ taskId: own.id })).toMatchObject({ taskId: own.id, spaceId: current.id });
  expect((await getTask(db, actor, own.id)).status).toBe('completed');
});
