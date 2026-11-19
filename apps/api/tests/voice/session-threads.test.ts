/**
 * #565 unit U4: the Cardputer's own picker lists and selects space threads
 * (plan D2, D3, D7). A thread reaches the device as the ordinary conversation
 * id `thr_<uuid>`, so the wire DTOs and the firmware are unchanged; every reply
 * here is parsed with the existing DTO schemas and compared to the firmware's
 * wire fixtures. Per-file test database injected into getDb() (session-spaces.test.ts).
 */
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { handleControl } from '../../src/voice/session.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import type { AccountEvent } from '../../src/account/events-bus.ts';
import { threadRef } from '../../src/devices/conversation-ref.ts';
import {
  ActiveConversationDtoSchema,
  CONVERSATIONS_LIST_CAP,
  ClientControlDtoSchema,
  ServerControlDtoSchema,
  V2_VERSION,
  type ClientControlDto,
} from '../../src/voice/protocol.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, setSharedDb, withUser, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace, revokeMember } from '../../src/spaces/store.ts';
import { archiveThread, createThread, listThreads } from '../../src/conversations/thread-store.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { getActive, setActive } from '../../src/conversations/active.ts';
import { getActiveSpace, setActiveSpace } from '../../src/spaces/active.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
interface FakeSocket { readyState: number; send: ReturnType<typeof vi.fn> }
type Sent = { type: string; id: string; payload: Record<string, unknown> };
type Row = { id: string; title: string };

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const OPAQUE_ID = /^[A-Za-z0-9_-]{8,64}$/;
let pg: TestDb;
let db: Db;
let journalLines: string[];

function control(type: string, extra: Record<string, unknown> = {}): ClientControlDto {
  return { v: V2_VERSION, type, id: 'test_ctrl_000001', payload: {}, ...extra } as unknown as ClientControlDto;
}

function raw(socket: FakeSocket): string[] {
  return socket.send.mock.calls.map((call) => call[0] as string);
}

function last(socket: FakeSocket): Sent {
  const all = raw(socket);
  expect(all.length).toBeGreaterThan(0);
  return JSON.parse(all[all.length - 1]!) as Sent;
}

function fixture(name: string): string {
  const url = new URL(`../../../cardputer/test/fixtures/wire/${name}.json`, import.meta.url);
  return JSON.stringify(JSON.parse(readFileSync(url, 'utf8')));
}

/** A device session for the account, taken through hello (send history kept). */
async function hello(userId: string): Promise<{ socket: FakeSocket; session: DeviceSession }> {
  const socket: FakeSocket = { readyState: 1, send: vi.fn() };
  const session = createSession({ kind: 'device', userId, deviceId: DEVICE_ID, name: 'Test Card' });
  await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
  return { socket, session };
}

async function run(socket: FakeSocket, session: DeviceSession, dto: ClientControlDto): Promise<void> {
  await handleControl(appDeps, socket as unknown as WebSocket, session, dto, vi.fn());
}

const selectConversation = (id: string): ClientControlDto => control('select_conversation', { payload: { conversation_id: id } });

/** Collects the account's events while fn runs. */
async function events(userId: string, fn: () => Promise<void>): Promise<AccountEvent[]> {
  const received: AccountEvent[] = [];
  const stop = getAccountEvents().subscribe(userId, (event) => received.push(event));
  try { await fn(); } finally { stop(); }
  return received.filter((event) => event.type === 'active.changed' || event.type === 'active_space.changed');
}

async function pointAt(userId: string, ref: string | null): Promise<void> {
  await withUser(db, userId, (tx) => setActive(tx, userId, ref, 'web_text'));
}

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
});

beforeEach(() => {
  journalLines = [];
  setJournalSink((line: string) => journalLines.push(line));
  getDeviceSessions().clear();
});

afterEach(() => {
  setJournalSink(null);
  setSharedDb(Promise.resolve(db));
});

afterAll(async () => {
  getDeviceSessions().clear();
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

/** An account with a Space holding `threads` threads (one more archived) and
 *  `general` General conversations; the Space is the active one. */
async function seed(threads: number, general: number): Promise<{ userId: string; spaceId: string; threadIds: string[] }> {
  const { userId } = await addAccount(pg);
  for (let i = 0; i < general; i += 1) await createConversation(db, userId, `General ${i}`);
  const space = await createSpace(db, userId, { kind: 'group', name: 'Kitchen' });
  const threadIds: string[] = [];
  for (let i = 0; i < threads; i += 1) threadIds.push((await createThread(db, userId, { spaceId: space.id, title: `Thread ${i}` })).id);
  const archived = await createThread(db, userId, { spaceId: space.id, title: 'Shelved' });
  await archiveThread(db, userId, archived.id);
  await withUser(db, userId, (tx) => setActiveSpace(tx, userId, space.id, 'web'));
  return { userId, spaceId: space.id, threadIds };
}

async function listed(userId: string): Promise<{ reply: Sent; rows: Row[]; text: string }> {
  const { socket, session } = await hello(userId);
  await run(socket, session, control('list_conversations'));
  const reply = last(socket);
  const text = raw(socket).at(-1)!;
  expect(ServerControlDtoSchema.safeParse(reply).success).toBe(true);
  return { reply, rows: reply.payload.conversations as Row[], text };
}

describe('list_conversations with an active Space', () => {
  it('lists up to 5 threads, most recently updated first, then General, capped', async () => {
    const { userId, spaceId } = await seed(7, 8);
    const { rows } = await listed(userId);
    const newest = (await listThreads(db, userId, spaceId)).slice(0, 5);
    expect(rows).toHaveLength(CONVERSATIONS_LIST_CAP);
    expect(rows.slice(0, 5)).toEqual(newest.map((thread) => ({ id: threadRef(thread.id), title: thread.title })));
    for (let i = 1; i < newest.length; i += 1) expect(newest[i - 1]!.updatedAt).toBeGreaterThanOrEqual(newest[i]!.updatedAt);
    expect(rows.slice(5).every((row) => row.id.startsWith('cnv_'))).toBe(true);
    expect(rows.map((row) => row.title)).not.toContain('Shelved');
    for (const row of rows) expect(row.id).toMatch(OPAQUE_ID);
    expect(journalLines.some((line) => line.includes('v2.conversation_listed') && line.includes(`"count":${CONVERSATIONS_LIST_CAP}`))).toBe(true);
    expect(journalLines.join('\n')).not.toContain('Thread ');
  });

  it('always lists the current thread pointer, in the last thread slot', async () => {
    const { userId, spaceId } = await seed(7, 8);
    const ordered = await listThreads(db, userId, spaceId);
    const oldest = ordered.at(-1)!;
    await pointAt(userId, threadRef(oldest.id));
    const { rows } = await listed(userId);
    expect(rows).toHaveLength(CONVERSATIONS_LIST_CAP);
    expect(rows[4]).toEqual({ id: threadRef(oldest.id), title: oldest.title });
    expect(rows.slice(0, 4).map((row) => row.id)).toEqual(ordered.slice(0, 4).map((thread) => threadRef(thread.id)));
  });

  it('a pointer already among the newest threads is not listed twice', async () => {
    const { userId, spaceId } = await seed(3, 2);
    const newest = (await listThreads(db, userId, spaceId))[0]!;
    await pointAt(userId, threadRef(newest.id));
    const { rows } = await listed(userId);
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => row.id === threadRef(newest.id))).toHaveLength(1);
  });

  it('with no active Space lists General only, byte-shaped like the firmware fixture', async () => {
    const { userId } = await addAccount(pg);
    for (let i = 0; i < 3; i += 1) await createConversation(db, userId, `General ${i}`);
    const { rows, reply, text } = await listed(userId);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.id.startsWith('cnv_'))).toBe(true);
    const shape = JSON.parse(fixture('conversations')) as Sent;
    expect(Object.keys(reply)).toEqual(Object.keys(shape));
    expect(text).toBe(JSON.stringify(reply));
  });

  it('thread rows keep the fixture key order and parse as old-firmware DTOs', async () => {
    const { userId } = await seed(2, 1);
    const { rows, text } = await listed(userId);
    const shape = JSON.parse(fixture('conversations')) as { payload: { conversations: Row[] } };
    const sample = shape.payload.conversations[0]!;
    for (const row of rows) expect(Object.keys(row)).toEqual(Object.keys(sample));
    const pinned = JSON.parse(text) as Sent;
    pinned.id = JSON.parse(fixture('conversations')).id as string;
    pinned.payload = shape.payload;
    expect(JSON.stringify(pinned)).toBe(fixture('conversations'));
  });
});

describe('select_conversation with a thr_ id', () => {
  it('moves both pointers in one write, publishes both events, answers conversation_selected', async () => {
    const { userId, threadIds } = await seed(2, 1);
    const other = await createSpace(db, userId, { kind: 'group', name: 'Garage' });
    const target = await createThread(db, userId, { spaceId: other.id, title: 'Bike repair' });
    const ref = threadRef(target.id);
    expect(ref).toMatch(OPAQUE_ID);
    const request = selectConversation(ref);
    expect(ClientControlDtoSchema.safeParse(request).success).toBe(true);
    const one = await hello(userId);
    const two = await hello(userId);
    two.socket.send.mockClear();
    const received = await events(userId, () => run(one.socket, one.session, request));
    const reply = last(one.socket);
    expect(ServerControlDtoSchema.safeParse(reply).success).toBe(true);
    expect(reply).toMatchObject({ type: 'conversation_selected', payload: { conversation_id: ref, title: 'Bike repair' } });
    const shape = JSON.parse(fixture('conversation_selected')) as Sent;
    expect(Object.keys(reply)).toEqual(Object.keys(shape));
    expect(Object.keys(reply.payload)).toEqual(Object.keys(shape.payload));
    expect(received).toEqual([
      expect.objectContaining({ type: 'active_space.changed', space_id: other.id, name: 'Garage', surface: 'device' }),
      expect.objectContaining({ type: 'active.changed', conversation_id: ref, title: 'Bike repair', surface: 'picker' }),
    ]);
    expect(await getActive(db, userId)).toMatchObject({ conversationId: ref, kind: 'thread', spaceId: other.id });
    expect(await getActiveSpace(db, userId)).toMatchObject({ spaceId: other.id });
    expect(one.session.activeConversationId).toBe(ref);
    const push = raw(two.socket).map((line) => JSON.parse(line) as Sent).find((dto) => dto.type === 'active_conversation');
    expect(ActiveConversationDtoSchema.safeParse(push).success).toBe(true);
    expect(push?.payload).toEqual({ id: ref, title: 'Bike repair' });
    expect(threadIds).not.toContain(target.id);
    expect(journalLines.join('\n')).not.toContain('Bike repair');
  });

  async function refusedLeavesPointers(userId: string, ref: string): Promise<void> {
    const general = await createConversation(db, userId, 'Kept');
    await pointAt(userId, general.id);
    const spaceBefore = await getActiveSpace(db, userId);
    const { socket, session } = await hello(userId);
    const received = await events(userId, () => run(socket, session, selectConversation(ref)));
    expect(last(socket)).toMatchObject({ type: 'error', payload: { code: 'CONVERSATION_NOT_FOUND' } });
    expect(received).toEqual([]);
    expect(await getActive(db, userId)).toMatchObject({ conversationId: general.id, kind: 'conversation' });
    expect((await getActiveSpace(db, userId))?.spaceId ?? null).toBe(spaceBefore?.spaceId ?? null);
  }

  it('an unknown thread is CONVERSATION_NOT_FOUND with the pointer untouched', async () => {
    const { userId } = await seed(1, 0);
    await refusedLeavesPointers(userId, threadRef('44444444-4444-4444-8444-444444444444'));
  });

  it('a malformed thr_ id is CONVERSATION_NOT_FOUND with the pointer untouched', async () => {
    const { userId } = await seed(1, 0);
    await refusedLeavesPointers(userId, 'thr_not-a-uuid-at-all');
  });

  it('an archived thread is CONVERSATION_NOT_FOUND with the pointer untouched', async () => {
    const { userId, spaceId } = await seed(1, 0);
    const shelved = await createThread(db, userId, { spaceId, title: 'Gone' });
    await archiveThread(db, userId, shelved.id);
    await refusedLeavesPointers(userId, threadRef(shelved.id));
  });

  it("another account's thread (not a member) is CONVERSATION_NOT_FOUND with the pointer untouched", async () => {
    const { userId } = await seed(1, 0);
    const owner = await seed(1, 0);
    await refusedLeavesPointers(userId, threadRef(owner.threadIds[0]!));
  });

  it('a revoked member is CONVERSATION_NOT_FOUND with the pointer untouched', async () => {
    const owner = await seed(1, 0);
    const { userId } = await addAccount(pg);
    await addMember(db, owner.userId, owner.spaceId, userId, 'member');
    await revokeMember(db, owner.userId, owner.spaceId, userId);
    await refusedLeavesPointers(userId, threadRef(owner.threadIds[0]!));
  });
});

describe('select_space and a thread pointer', () => {
  it('moving to a different Space clears the thread pointer and publishes the null', async () => {
    const { userId, threadIds } = await seed(1, 0);
    const other = await createSpace(db, userId, { kind: 'group', name: 'Garage' });
    await pointAt(userId, threadRef(threadIds[0]!));
    const { socket, session } = await hello(userId);
    expect(session.activeConversationId).toBe(threadRef(threadIds[0]!));
    const received = await events(userId, () => run(socket, session, control('select_space', { payload: { space_id: other.id } })));
    expect(last(socket)).toMatchObject({ type: 'space_selected', payload: { space_id: other.id, name: 'Garage' } });
    expect(received).toEqual([
      expect.objectContaining({ type: 'active_space.changed', space_id: other.id }),
      expect.objectContaining({ type: 'active.changed', conversation_id: null, title: null, surface: 'device' }),
    ]);
    expect(await getActive(db, userId)).toMatchObject({ conversationId: null, kind: null });
    expect(session.activeConversationId).toBeUndefined();
  });

  it('clearing the Space (null) clears the thread pointer too', async () => {
    const { userId, threadIds } = await seed(1, 0);
    await pointAt(userId, threadRef(threadIds[0]!));
    const { socket, session } = await hello(userId);
    await run(socket, session, control('select_space', { payload: { space_id: null } }));
    expect(await getActive(db, userId)).toMatchObject({ conversationId: null, kind: null });
  });

  it("re-selecting the thread's own Space keeps it, and a General pointer is never touched", async () => {
    const { userId, spaceId, threadIds } = await seed(1, 0);
    await pointAt(userId, threadRef(threadIds[0]!));
    const { socket, session } = await hello(userId);
    const kept = await events(userId, () => run(socket, session, control('select_space', { payload: { space_id: spaceId } })));
    expect(kept.filter((event) => event.type === 'active.changed')).toEqual([]);
    expect(await getActive(db, userId)).toMatchObject({ conversationId: threadRef(threadIds[0]!) });
    const general = await createConversation(db, userId, 'Plain');
    await pointAt(userId, general.id);
    const other = await createSpace(db, userId, { kind: 'group', name: 'Garage' });
    await run(socket, session, control('select_space', { payload: { space_id: other.id } }));
    expect(await getActive(db, userId)).toMatchObject({ conversationId: general.id, kind: 'conversation' });
  });
});

describe('a stale thread pointer is cleared and published', () => {
  async function revokedMember(): Promise<string> {
    const owner = await seed(1, 0);
    const { userId } = await addAccount(pg);
    await addMember(db, owner.userId, owner.spaceId, userId, 'member');
    await pointAt(userId, threadRef(owner.threadIds[0]!));
    await revokeMember(db, owner.userId, owner.spaceId, userId);
    return userId;
  }

  it('at hello: welcome carries the null pointer and active.changed null is published', async () => {
    const userId = await revokedMember();
    let socket: FakeSocket | undefined;
    const received = await events(userId, async () => { socket = (await hello(userId)).socket; });
    const welcome = last(socket!);
    expect(ServerControlDtoSchema.safeParse(welcome).success).toBe(true);
    expect(welcome.payload.active_conversation).toEqual({ id: null, title: null });
    expect(received).toContainEqual(expect.objectContaining({ type: 'active.changed', conversation_id: null, surface: 'device' }));
  });

  it('at turn_start: the turn is unpinned and active.changed null is published', async () => {
    const owner = await seed(1, 0);
    const { userId } = await addAccount(pg);
    await addMember(db, owner.userId, owner.spaceId, userId, 'member');
    await pointAt(userId, threadRef(owner.threadIds[0]!));
    const { socket, session } = await hello(userId);
    expect(session.activeConversationId).toBe(threadRef(owner.threadIds[0]!));
    await revokeMember(db, owner.userId, owner.spaceId, userId);
    const received = await events(userId, () => run(socket, session, control('turn_start', { turn_ref: 'turn_0001_abcd' })));
    expect(session.activeConversationId).toBeUndefined();
    expect(received).toEqual([expect.objectContaining({ type: 'active.changed', conversation_id: null, title: null })]);
  });
});

describe('welcome with a thread pointer', () => {
  it('carries the thr_ ref and the title cut to 64 chars', async () => {
    const { userId, spaceId } = await seed(0, 0);
    const title = 'A'.repeat(100);
    const thread = await createThread(db, userId, { spaceId, title });
    await pointAt(userId, threadRef(thread.id));
    const { socket } = await hello(userId);
    const welcome = last(socket);
    expect(ServerControlDtoSchema.safeParse(welcome).success).toBe(true);
    expect(welcome.payload.active_conversation).toEqual({ id: threadRef(thread.id), title: 'A'.repeat(64) });
  });
});
