/**
 * Space selection over the device wire (#301, U2a): welcome.active_space,
 * list_spaces, select_space and the active_space push, against a per-file
 * test database injected into getDb() (the session.test.ts pattern). Kept apart from
 * session.test.ts so the two units never collide.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createSession, resetSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { handleControl } from '../../src/voice/session.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import type { AccountEvent } from '../../src/account/events-bus.ts';
import { SPACES_LIST_CAP, V2_VERSION, type ClientControlDto } from '../../src/voice/protocol.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, setSharedDb, withUser, type Db } from '../../src/platform/db/db.ts';
import { addMember, archiveSpace, createSpace, revokeMember } from '../../src/spaces/store.ts';
import { getActiveSpace, setActiveSpace } from '../../src/spaces/active.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
interface FakeSocket { readyState: number; send: ReturnType<typeof vi.fn> }
type Sent = { type: string; payload: Record<string, unknown> };

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
let pg: TestDb;
let db: Db;
let journalLines: string[];

function control(type: string, extra: Record<string, unknown> = {}): ClientControlDto {
  return { v: V2_VERSION, type, id: 'test_ctrl_000001', payload: {}, ...extra } as unknown as ClientControlDto;
}

function sent(socket: FakeSocket): Sent[] {
  return socket.send.mock.calls.map((call) => JSON.parse(call[0] as string) as Sent);
}

function last(socket: FakeSocket): Sent {
  const all = sent(socket);
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1]!;
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

const select = (spaceId: string | null): ClientControlDto => control('select_space', { payload: { space_id: spaceId } });

/** A Db that fails only the active-Space queries, so the conversation pointer still resolves. */
function spaceOutageDb(real: Db): Db {
  const guard = (inner: Db): Db => ({
    query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes('active_space_id') || sql.includes('bob.spaces')) throw new Error('store unavailable');
      return inner.query<T>(sql, params);
    },
    tx: <T>(fn: (tx: Db) => Promise<T>): Promise<T> => inner.tx((tx) => fn(guard(tx))),
  });
  return guard(real);
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

describe('welcome.active_space', () => {
  it('carries the set Space, after active_conversation', async () => {
    const a = await addAccount(pg);
    const space = await createSpace(db, a.userId, { kind: 'group', name: 'Kitchen' });
    await withUser(db, a.userId, (tx) => setActiveSpace(tx, a.userId, space.id, 'web'));
    const { socket } = await hello(a.userId);
    const welcome = last(socket);
    expect(welcome.type).toBe('welcome');
    expect(welcome.payload.active_space).toEqual({ id: space.id, name: 'Kitchen' });
    const keys = Object.keys(welcome.payload);
    expect(keys.indexOf('active_space')).toBeGreaterThan(keys.indexOf('active_conversation'));
  });

  it('is null when no Space was ever selected', async () => {
    const a = await addAccount(pg);
    const { socket } = await hello(a.userId);
    expect(last(socket).payload).toHaveProperty('active_space', null);
  });

  it('is omitted on a store outage, journaled, and the conversation pointer still resolves', async () => {
    const a = await addAccount(pg);
    setSharedDb(Promise.resolve(spaceOutageDb(db)));
    const { socket } = await hello(a.userId);
    const welcome = last(socket);
    expect(welcome.type).toBe('welcome');
    expect(welcome.payload).not.toHaveProperty('active_space');
    expect(welcome.payload).toHaveProperty('active_conversation', null);
    expect(journalLines.some((line) => line.includes('v2.active_space_resolve_failed'))).toBe(true);
  });

  it('a stale (archived) Space is cleared: welcome null and a null event published', async () => {
    const a = await addAccount(pg);
    const space = await createSpace(db, a.userId, { kind: 'group', name: 'Shelved' });
    await withUser(db, a.userId, (tx) => setActiveSpace(tx, a.userId, space.id, 'web'));
    await archiveSpace(db, a.userId, space.id);
    const received: AccountEvent[] = [];
    const stop = getAccountEvents().subscribe(a.userId, (event) => received.push(event));
    const { socket } = await hello(a.userId);
    stop();
    expect(last(socket).payload).toHaveProperty('active_space', null);
    // Only the Space event matters here; hello also publishes device.changed (presence).
    expect(received.filter((event) => event.type === 'active_space.changed'))
      .toEqual([expect.objectContaining({ type: 'active_space.changed', space_id: null, name: null, surface: 'device' })]);
  });
});

describe('list_spaces', () => {
  it(`caps at ${SPACES_LIST_CAP} and journals only the count`, async () => {
    const a = await addAccount(pg);
    for (let i = 0; i < SPACES_LIST_CAP + 2; i += 1) await createSpace(db, a.userId, { kind: 'group', name: `Space ${i}` });
    const { socket, session } = await hello(a.userId);
    await run(socket, session, control('list_spaces'));
    const reply = last(socket) as Sent & { payload: { spaces: Array<{ id: string; name: string }> } };
    expect(reply.type).toBe('spaces');
    expect(reply.payload.spaces).toHaveLength(SPACES_LIST_CAP);
    for (const entry of reply.payload.spaces) expect(Object.keys(entry).sort()).toEqual(['id', 'name']);
    expect(journalLines.some((line) => line.includes('v2.space_listed') && line.includes(`"count":${SPACES_LIST_CAP}`))).toBe(true);
  });

  it('excludes archived Spaces and revoked memberships', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const live = await createSpace(db, a.userId, { kind: 'group', name: 'Live' });
    const old = await createSpace(db, a.userId, { kind: 'group', name: 'Old' });
    await archiveSpace(db, a.userId, old.id);
    const theirs = await createSpace(db, b.userId, { kind: 'group', name: 'Theirs' });
    await addMember(db, b.userId, theirs.id, a.userId, 'member');
    await revokeMember(db, b.userId, theirs.id, a.userId);
    const { socket, session } = await hello(a.userId);
    await run(socket, session, control('list_spaces'));
    const ids = (last(socket).payload.spaces as Array<{ id: string }>).map((entry) => entry.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(old.id);
    expect(ids).not.toContain(theirs.id);
  });

  it('answers an empty list on a store outage', async () => {
    const a = await addAccount(pg);
    await createSpace(db, a.userId, { kind: 'group', name: 'Hidden by outage' });
    const { socket, session } = await hello(a.userId);
    setSharedDb(Promise.resolve(spaceOutageDb(db)));
    await run(socket, session, control('list_spaces'));
    expect(last(socket)).toMatchObject({ type: 'spaces', payload: { spaces: [] } });
    expect(journalLines.some((line) => line.includes('v2.space_list_failed'))).toBe(true);
  });
});

describe('select_space', () => {
  it('acks, persists, and pushes active_space to a second session of the account', async () => {
    const a = await addAccount(pg);
    const space = await createSpace(db, a.userId, { kind: 'group', name: 'Kitchen' });
    const one = await hello(a.userId);
    const two = await hello(a.userId);
    two.socket.send.mockClear();
    await run(one.socket, one.session, select(space.id));
    expect(last(one.socket)).toMatchObject({ type: 'space_selected', payload: { space_id: space.id, name: 'Kitchen' } });
    expect(sent(two.socket)).toEqual([expect.objectContaining({ type: 'active_space', payload: { id: space.id, name: 'Kitchen' } })]);
    expect(await getActiveSpace(db, a.userId)).toMatchObject({ spaceId: space.id, name: 'Kitchen' });
    expect(journalLines.some((line) => line.includes('v2.active_space_changed') && line.includes('"surface":"device"'))).toBe(true);
    expect(journalLines.join('\n')).not.toContain('Kitchen');
  });

  it('a non-member Space is SPACE_NOT_FOUND and changes nothing', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const mine = await createSpace(db, a.userId, { kind: 'group', name: 'Mine' });
    const theirs = await createSpace(db, b.userId, { kind: 'group', name: 'Theirs' });
    const { socket, session } = await hello(a.userId);
    await run(socket, session, select(mine.id));
    const received: AccountEvent[] = [];
    const stop = getAccountEvents().subscribe(a.userId, (event) => received.push(event));
    await run(socket, session, select(theirs.id));
    stop();
    expect(last(socket)).toMatchObject({ type: 'error', payload: { code: 'SPACE_NOT_FOUND' } });
    expect(received).toEqual([]);
    expect(await getActiveSpace(db, a.userId)).toMatchObject({ spaceId: mine.id });
  });

  it('null clears the pointer and pushes the null form', async () => {
    const a = await addAccount(pg);
    const space = await createSpace(db, a.userId, { kind: 'group', name: 'Kitchen' });
    const one = await hello(a.userId);
    const two = await hello(a.userId);
    await run(one.socket, one.session, select(space.id));
    two.socket.send.mockClear();
    await run(one.socket, one.session, select(null));
    expect(last(one.socket)).toMatchObject({ type: 'space_selected', payload: { space_id: null, name: null } });
    expect(last(two.socket)).toMatchObject({ type: 'active_space', payload: { id: null, name: null } });
    expect(await getActiveSpace(db, a.userId)).toMatchObject({ spaceId: null, name: null });
  });

  it('a repeated select is deterministic: same ack, same pointer, a newer stamp', async () => {
    const a = await addAccount(pg);
    const space = await createSpace(db, a.userId, { kind: 'group', name: 'Kitchen' });
    const { socket, session } = await hello(a.userId);
    await run(socket, session, select(space.id));
    const first = await getActiveSpace(db, a.userId);
    const firstAck = last(socket);
    await run(socket, session, select(space.id));
    const second = await getActiveSpace(db, a.userId);
    expect(last(socket).payload).toEqual(firstAck.payload);
    expect(second).toMatchObject({ spaceId: space.id, name: 'Kitchen' });
    expect(second!.changedAt).toBeGreaterThan(first!.changedAt);
  });

  it('two sessions selecting concurrently end with the DB state equal to the last push', async () => {
    const a = await addAccount(pg);
    const x = await createSpace(db, a.userId, { kind: 'group', name: 'X' });
    const y = await createSpace(db, a.userId, { kind: 'group', name: 'Y' });
    const one = await hello(a.userId);
    const two = await hello(a.userId);
    const watcher = await hello(a.userId);
    watcher.socket.send.mockClear();
    await Promise.all([run(one.socket, one.session, select(x.id)), run(two.socket, two.session, select(y.id))]);
    const pushes = sent(watcher.socket).filter((dto) => dto.type === 'active_space');
    expect(pushes).toHaveLength(2);
    const stored = await getActiveSpace(db, a.userId);
    expect(pushes[pushes.length - 1]!.payload.id).toBe(stored!.spaceId);
  });

  it('is refused with STATE_VIOLATION during capture and writes nothing', async () => {
    const a = await addAccount(pg);
    const space = await createSpace(db, a.userId, { kind: 'group', name: 'Kitchen' });
    const { socket, session } = await hello(a.userId);
    await run(socket, session, control('turn_start', { turn_ref: 'turn_test_000001' }));
    await run(socket, session, select(space.id));
    expect(last(socket)).toMatchObject({ type: 'error', payload: { code: 'STATE_VIOLATION' } });
    await run(socket, session, control('list_spaces'));
    expect(last(socket)).toMatchObject({ type: 'error', payload: { code: 'STATE_VIOLATION' } });
    expect(await getActiveSpace(db, a.userId)).toBeNull();
  });

  it('a push to a responding session is held (latest wins) and flushed after playback_end', async () => {
    const a = await addAccount(pg);
    const x = await createSpace(db, a.userId, { kind: 'group', name: 'X' });
    const y = await createSpace(db, a.userId, { kind: 'group', name: 'Y' });
    const one = await hello(a.userId);
    const busy = await hello(a.userId);
    busy.session.stage = 'responding';
    busy.socket.send.mockClear();
    await run(one.socket, one.session, select(x.id));
    await run(one.socket, one.session, select(y.id));
    expect(sent(busy.socket)).toEqual([]);
    resetSession(appDeps, busy.session);
    expect(sent(busy.socket)).toEqual([expect.objectContaining({ type: 'active_space', payload: { id: y.id, name: 'Y' } })]);
  });

  it('an unpaired session is answered UNPAIRED for list_spaces and select_space', async () => {
    // The unpaired idle clock wires socket.once('close') and may call close().
    const socket = { readyState: 1, send: vi.fn(), once: vi.fn(), close: vi.fn() };
    const session = createSession({ kind: 'unpaired', reason: 'none' });
    await run(socket, session, control('hello', { payload: { format_id: 1 } }));
    await run(socket, session, control('list_spaces'));
    expect(last(socket)).toMatchObject({ type: 'error', payload: { code: 'UNPAIRED' } });
    await run(socket, session, select(null));
    expect(last(socket)).toMatchObject({ type: 'error', payload: { code: 'UNPAIRED' } });
  });
});
