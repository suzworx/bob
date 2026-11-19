import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Tool } from 'ai';
import { createBoundAppTools } from '../../src/bob-apps/bound-app-tools.ts';
import { createBobApp, getBobApp, mutateBobApp } from '../../src/bob-apps/store.ts';
import { saveAppIdea } from '../../src/workflows/workflow-app-idea.ts';
import { createThread, postMessage } from '../../src/conversations/thread-store.ts';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { setToolPreference } from '../../src/tools/store.ts';
import { trashNote, updateNote } from '../../src/notes/store.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addAccount, asDb, closeTestDb, createTestDb, withAdminAuth, type TestDb } from '../support/test-db.ts';
import { packing } from './fixtures.ts';
import { deleteAccount } from '../../src/workflows/workflow-account-deletion.ts';

vi.mock('../../src/notifications/email-client.ts', async (original) => ({ ...(await original<typeof import('../../src/notifications/email-client.ts')>()), recipientEmail: vi.fn(async () => null) }));

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => closeTestDb(pg));
async function fixture() {
  const owner = await addAccount(pg); const member = await addAccount(pg);
  const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Our app' });
  await addMember(db, owner.userId, space.id, member.userId, 'member');
  const app = await createBobApp(db, owner.userId, { definition: packing, state: { items: [{ id: 'keep', values: { label: 'Keep', packed: false } }] }, spaceId: space.id, mutationId: randomUUID() });
  const active = await mutateBobApp(db, owner.userId, app.id, { operation: 'activate', expectedRevision: app.revision, mutationId: randomUUID() });
  const thread = await createThread(db, member.userId, { spaceId: space.id, title: 'App changes' });
  const { message } = await postMessage(db, member.userId, { threadId: thread.id, body: 'Change this app', clientMessageId: randomUUID() });
  const context = { db, actor: member.userId, sessionId: member.sessionId, binding: { installationId: active.installationId, mode: 'refine' as const }, conversationId: thread.id, sourceId: message.id };
  return { owner, member, space, active, context, tools: createBoundAppTools(context, saveAppIdea) };
}
async function execute(tool: Tool | undefined, input: unknown): Promise<unknown> {
  if (!tool?.execute) throw new Error('Missing tool');
  return tool.execute(input, { toolCallId: randomUUID(), messages: [], context: undefined });
}
it('captures one app, saves a member proposal and leaves Apply/Undo to managers with records intact', async () => {
  const f = await fixture();
  expect(Object.keys(f.tools).sort()).toEqual(['read_bob_app', 'revise_bob_app', 'save_app_idea']);
  expect(await execute(f.tools.read_bob_app, {})).toMatchObject({ ok: true, data: { revision: f.active.revision, definition: packing } });
  const input = { expectedRevision: f.active.revision, definition: { ...packing, title: 'Our new title' } };
  expect(await execute(f.tools.revise_bob_app, input)).toMatchObject({ ok: true, data: { requiresApply: true } });
  expect(await execute(f.tools.revise_bob_app, input)).toMatchObject({ ok: true });
  expect(await execute(f.tools.revise_bob_app, { ...input, definition: { ...packing, title: 'Different retry' } })).toMatchObject({ ok: false });
  const proposed = await getBobApp(db, f.member.userId, f.active.id);
  expect(proposed.definition).toEqual(packing); expect(proposed.state).toEqual(f.active.state);
  await expect(mutateBobApp(db, f.member.userId, proposed.id, { operation: 'apply_revision', expectedRevision: proposed.revision, mutationId: randomUUID() })).rejects.toThrow();
  const applied = await mutateBobApp(db, f.owner.userId, proposed.id, { operation: 'apply_revision', expectedRevision: proposed.revision, mutationId: randomUUID() });
  const undone = await mutateBobApp(db, f.owner.userId, proposed.id, { operation: 'undo', expectedRevision: applied.revision, mutationId: randomUUID() });
  expect(undone.definition).toEqual(packing); expect(undone.state).toEqual(f.active.state);
});
it('saves an actual sender-attributed space Note once and rejects changed text, edits and trash replay', async () => {
  const f = await fixture();
  const saved = await execute(f.tools.save_app_idea, { text: 'Connect to our calendar' });
  expect(saved).toMatchObject({ ok: true, data: { note: { spaceId: f.space.id, createdBy: f.member.userId, aiAssisted: true } } });
  const result = saved as { data: { note: { id: string; revision: number }; url: string } };
  expect(result.data.url).toBe(`/spaces/${f.space.id}/notes?note=${result.data.note.id}`);
  expect(await execute(f.tools.save_app_idea, { text: 'Connect to our calendar' })).toEqual(saved);
  expect(await execute(f.tools.save_app_idea, { text: 'Different idea' })).toMatchObject({ ok: false });
  await updateNote(db, f.owner.userId, result.data.note.id, { revision: result.data.note.revision, body: 'Teammate edited this' });
  expect(await execute(f.tools.save_app_idea, { text: 'Connect to our calendar' })).toMatchObject({ ok: false });
  await trashNote(db, f.owner.userId, result.data.note.id);
  expect(await execute(f.tools.save_app_idea, { text: 'Connect to our calendar' })).toMatchObject({ ok: false });
});
it('rechecks policy, live app and sender source before read, write and replay', async () => {
  const f = await fixture();
  expect(await execute(f.tools.revise_bob_app, { expectedRevision: f.active.revision, definition: packing })).toMatchObject({ ok: true });
  await setToolPreference(db, f.owner.userId, { scope: 'space', scopeId: f.space.id, toolId: 'revise_bob_app', enabled: false });
  expect(await execute(f.tools.revise_bob_app, { expectedRevision: f.active.revision, definition: packing })).toMatchObject({ ok: false });
  await withUser(db, f.member.userId, (tx) => tx.query('update bob.messages set tombstoned_at=now() where id=$1', [f.context.sourceId]));
  expect(await execute(f.tools.read_bob_app, {})).toMatchObject({ ok: false });
  expect(await execute(f.tools.save_app_idea, { text: 'No save after source removal' })).toMatchObject({ ok: false });
});

it('saves a personal app idea only in the actual private conversation space', async () => {
  const actor = await addAccount(pg);
  const app = await createBobApp(db, actor.userId, { definition: packing, mutationId: randomUUID() });
  const conversation = await createConversation(db, actor.userId, 'Private app');
  const sourceId = `msg_${randomUUID()}`;
  await appendMessage(db, actor.userId, conversation.id, { id: sourceId, role: 'user', parts: [{ type: 'text', text: 'Save an idea' }] });
  const tools = createBoundAppTools({ db, actor: actor.userId, sessionId: actor.sessionId, binding: { installationId: app.installationId, mode: 'refine' }, conversationId: conversation.id, sourceId }, saveAppIdea);
  const saved = await execute(tools.save_app_idea, { text: 'An optional connector' });
  expect(saved).toMatchObject({ ok: true, data: { note: { createdBy: actor.userId } } });
  const [scope] = await withUser(db, actor.userId, (tx) => tx.query<{ space_id: string }>('select space_id from bob.conversations where id=$1', [conversation.id]));
  expect(saved).toMatchObject({ data: { note: { spaceId: scope?.space_id } } });
});

function signal() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function gate(base: Db, match: (sql: string) => boolean, after: boolean) {
  const reached = signal(); const released = signal(); let used = false;
  function wrap(inner: Db): Db {
    return {
      async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
        if (used || !match(sql)) return inner.query<T>(sql, params);
        used = true; const rows = after ? await inner.query<T>(sql, params) : undefined;
        reached.resolve(); await released.promise; return rows ?? inner.query<T>(sql, params);
      },
      tx<T>(work: (tx: Db) => Promise<T>): Promise<T> { return inner.tx((tx) => work(wrap(tx))); },
    };
  }
  return { db: wrap(base), reached: reached.promise, release: released.resolve };
}
for (const name of ['revise_bob_app', 'save_app_idea'] as const) {
  for (const replay of [false, true]) {
    it(`refuses ended session while ${name} ${replay ? 'replay' : 'write'} waits on audience`, async () => {
      const f = await fixture();
      const input = name === 'revise_bob_app' ? { expectedRevision: f.active.revision, definition: packing } : { text: 'A requested idea' };
      if (replay) expect(await execute(f.tools[name], input)).toMatchObject({ ok: true });
      const held = signal(); const released = signal(); const queued = signal();
      const holding = withUser(db, f.owner.userId, async (tx) => {
        await tx.query('select bob_private.lock_thread_audience_revision($1)', [f.space.id]);
        held.resolve(); await released.promise;
      });
      await held.promise;
      function observe(inner: Db): Db {
        return {
          query<T>(sql: string, params?: unknown[]): Promise<T[]> { const pending = inner.query<T>(sql, params); if (sql.includes('lock_thread_audience_revision')) queued.resolve(); return pending; },
          tx<T>(work: (tx: Db) => Promise<T>): Promise<T> { return inner.tx((tx) => work(observe(tx))); },
        };
      }
      const tools = createBoundAppTools({ ...f.context, db: observe(db) }, saveAppIdea);
      const saving = execute(tools[name], input);
      try {
        await queued.promise; await withAdminAuth(pg, (admin) => admin.endSession(f.member.sessionId));
        released.resolve(); await holding;
        expect(await saving).toMatchObject({ ok: false });
      } finally { released.resolve(); await Promise.allSettled([holding, saving]); }
      const current = await getBobApp(db, f.owner.userId, f.active.id);
      expect(current.revision).toBe(f.active.revision + (name === 'revise_bob_app' && replay ? 1 : 0));
      const notes = await withUser(db, f.owner.userId, (tx) => tx.query('select id from bob.notes where space_id=$1', [f.space.id]));
      expect(notes).toHaveLength(name === 'save_app_idea' && replay ? 1 : 0);
    });
  }
}

it('does not adopt a changed caller binding, fake sender or paused app for execution or replay', async () => {
  const f = await fixture();
  const other = await createBobApp(db, f.owner.userId, { definition: packing, spaceId: f.space.id, mutationId: randomUUID() });
  f.context.binding.installationId = other.installationId;
  expect(await execute(f.tools.read_bob_app, {})).toMatchObject({ ok: true, data: { id: f.active.id } });
  const fake = createBoundAppTools({ ...f.context, binding: { installationId: f.active.installationId, mode: 'refine' }, actor: f.owner.userId, sessionId: f.owner.sessionId }, saveAppIdea);
  expect(await execute(fake.read_bob_app, {})).toMatchObject({ ok: false });
  const input = { expectedRevision: f.active.revision, definition: packing };
  expect(await execute(f.tools.revise_bob_app, input)).toMatchObject({ ok: true });
  const proposed = await getBobApp(db, f.owner.userId, f.active.id);
  await mutateBobApp(db, f.owner.userId, proposed.id, { operation: 'pause', expectedRevision: proposed.revision, mutationId: randomUUID() });
  expect(await execute(f.tools.revise_bob_app, input)).toMatchObject({ ok: false });
  expect(await execute(f.tools.read_bob_app, {})).toMatchObject({ ok: false });
});

it('requires the actual sender session for bound reads and writes, including receipt replay', async () => {
  const f = await fixture();
  const input = { expectedRevision: f.active.revision, definition: packing };
  expect(await execute(f.tools.revise_bob_app, input)).toMatchObject({ ok: true });
  for (const sessionId of [undefined, f.owner.sessionId]) {
    const tools = createBoundAppTools({ ...f.context, sessionId }, saveAppIdea);
    expect(await execute(tools.read_bob_app, {})).toMatchObject({ ok: false });
    expect(await execute(tools.revise_bob_app, input)).toMatchObject({ ok: false });
    expect(await execute(tools.save_app_idea, { text: 'Do not save' })).toMatchObject({ ok: false });
  }
});
for (const name of ['revise_bob_app', 'save_app_idea'] as const) {
  for (const replay of [false, true]) {
    for (const eraseFirst of [false, true]) {
      it(`serializes ${name} ${replay ? 'replay' : 'write'} with actor erasure (${eraseFirst ? 'erase' : 'tool'} first)`, async () => {
        const f = await fixture();
        const input = name === 'revise_bob_app' ? { expectedRevision: f.active.revision, definition: { ...packing, title: 'Retained work' } } : { text: 'A retained idea' };
        if (replay) expect(await execute(f.tools[name], input)).toMatchObject({ ok: true });
        const toolGate = gate(db, (sql) => sql.includes('lock_thread_audience_revision'), !eraseFirst);
        const eraseGate = gate(db, (sql) => sql.includes(eraseFirst ? 'bob_private.erase_account(' : 'lock_account_app_audiences'), eraseFirst);
        const tools = createBoundAppTools({ ...f.context, db: toolGate.db }, saveAppIdea);
        const toolWork = () => execute(tools[name], input);
        const eraseWork = () => deleteAccount({ db: eraseGate.db, now: () => Date.now(), googleConnection: { revoke: vi.fn(async () => undefined) }, deviceSessions: { closeDevice: vi.fn() } }, { userId: f.member.userId });
        const firstGate = eraseFirst ? eraseGate : toolGate; const secondGate = eraseFirst ? toolGate : eraseGate;
        const first = eraseFirst ? eraseWork() : toolWork();
        await firstGate.reached;
        const second = eraseFirst ? toolWork() : eraseWork();
        try {
          await secondGate.reached; secondGate.release(); firstGate.release();
          const outcomes = await Promise.all([first, second]);
          expect(outcomes[eraseFirst ? 0 : 1]).toEqual({ outcome: 'deleted' });
          expect(outcomes[eraseFirst ? 1 : 0]).toMatchObject({ ok: !eraseFirst });
        } finally { firstGate.release(); secondGate.release(); await Promise.allSettled([first, second]); }
        const retained = await getBobApp(db, f.owner.userId, f.active.id);
        expect(retained.state).toEqual(f.active.state);
        expect(await execute(f.tools[name], input)).toMatchObject({ ok: false });
        const notes = await withUser(db, f.owner.userId, (tx) => tx.query<{ created_by: string | null }>('select created_by from bob.notes where space_id=$1', [f.space.id]));
        expect(notes).toHaveLength(name === 'save_app_idea' && (replay || !eraseFirst) ? 1 : 0);
        for (const note of notes) expect(note.created_by).toBe('00000000-0000-4000-8000-0000000000de');
      });
    }
  }
}
