import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Tool } from 'ai';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace, ensurePrivateSpace, revokeMember } from '../../src/spaces/store.ts';
import { createConversation, appendMessage } from '../../src/conversations/store.ts';
import { createTask } from '../../src/tasks/store.ts';
import { createNote } from '../../src/notes/store.ts';
import { listTimeline } from '../../src/timeline/store.ts';
import { TimelineQuerySchema } from '../../src/timeline/schemas.ts';
import { createTimelineTools } from '../../src/timeline/tools.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });

it('combines real conversation and productivity activity without exposing another account', async () => {
  const { userId: owner } = await addAccount(pg);
  const { userId: other } = await addAccount(pg);
  const space = await ensurePrivateSpace(db, owner);
  const conversation = await createConversation(db, owner, 'Plan the garden');
  await appendMessage(db, owner, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'Plan vegetables' }] });
  const task = await createTask(db, owner, space.id, { title: 'Buy seeds' });
  const note = await createNote(db, owner, space.id, { title: 'Garden notes', body: 'Private body' });
  const day = new Date(task.createdAt).toISOString().slice(0, 10);
  const query = TimelineQuerySchema.parse({ day, timeZone: 'UTC' });
  const result = await listTimeline(db, owner, query);
  expect(result.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'conversation', recordId: conversation.id, title: 'Plan the garden', spaceId: null }),
    expect.objectContaining({ kind: 'task', recordId: task.id, title: 'Buy seeds', action: 'created' }),
    expect.objectContaining({ kind: 'note', recordId: note.id, title: 'Garden notes', action: 'created' }),
  ]));
  expect(JSON.stringify(result)).not.toContain('Private body');
  expect((await listTimeline(db, other, query)).entries).toEqual([]);
  const first = await listTimeline(db, owner, { ...query, limit: 1 });
  expect(first.entries).toHaveLength(1);
  expect(first.nextCursor).not.toBeNull();
  if (!first.nextCursor) throw new Error('missing cursor');
  const next = await listTimeline(db, owner, { ...query, ...first.nextCursor, limit: 1 });
  expect(next.entries[0]?.id).not.toBe(first.entries[0]?.id);
});

it('uses the selected local day across a DST boundary', async () => {
  const { userId: owner } = await addAccount(pg);
  const space = await ensurePrivateSpace(db, owner);
  const task = await createTask(db, owner, space.id, { title: 'Late evening' });
  await withUser(db, owner, tx => tx.query('update bob.tasks set created_at=$2, updated_at=$2 where id=$1', [task.id, '2026-11-02T07:30:00Z']));
  const onDay = await listTimeline(db, owner, TimelineQuerySchema.parse({ day: '2026-11-01', timeZone: 'America/Los_Angeles' }));
  expect(onDay.entries.some(entry => entry.recordId === task.id)).toBe(true);
  const nextDay = await listTimeline(db, owner, TimelineQuerySchema.parse({ day: '2026-11-02', timeZone: 'America/Los_Angeles' }));
  expect(nextDay.entries.some(entry => entry.recordId === task.id)).toBe(false);
});

it('rejects impossible dates, unknown zones and incomplete cursors', () => {
  expect(TimelineQuerySchema.safeParse({ day: '2026-02-30', timeZone: 'UTC' }).success).toBe(false);
  expect(TimelineQuerySchema.safeParse({ day: '2026-10-23', timeZone: 'Nowhere' }).success).toBe(false);
  expect(TimelineQuerySchema.safeParse({ day: '2026-10-23', timeZone: 'UTC', before: 123 }).success).toBe(false);
});

it('removes shared productivity activity immediately after membership is revoked', async () => {
  const { userId: owner } = await addAccount(pg);
  const { userId: member } = await addAccount(pg);
  const space = await createSpace(db, owner, { kind: 'group', name: 'Garden team' });
  await addMember(db, owner, space.id, member, 'member');
  const task = await createTask(db, owner, space.id, { title: 'Shared planting' });
  const query = TimelineQuerySchema.parse({ day: new Date(task.createdAt).toISOString().slice(0, 10), timeZone: 'UTC' });
  expect((await listTimeline(db, member, query)).entries.some(entry => entry.recordId === task.id)).toBe(true);
  await revokeMember(db, owner, space.id, member);
  expect((await listTimeline(db, member, query)).entries.some(entry => entry.recordId === task.id)).toBe(false);
});

it('rechecks the personal conversation before a captured timeline tool executes', async () => {
  const { userId: owner } = await addAccount(pg);
  const conversation = await createConversation(db, owner, 'Day review');
  const definition = createTimelineTools(db, owner, conversation.id).list_timeline as Tool<unknown, unknown> | undefined;
  if (!definition?.execute) throw new Error('missing timeline tool');
  const input = TimelineQuerySchema.parse({ day: '2026-10-23', timeZone: 'UTC' });
  const options = { toolCallId: 'timeline-test', messages: [], context: undefined };
  expect(await definition.execute(input, options)).toMatchObject({ ok: true });
  await withUser(db, owner, tx => tx.query('update bob.conversations set archived_at=now() where id=$1', [conversation.id]));
  expect(await definition.execute(input, options)).toEqual({ ok: false, error: 'scope_unavailable' });
});
