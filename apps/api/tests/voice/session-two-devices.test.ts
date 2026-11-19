/**
 * #900 MD-U5: two Cardputers paired to one account use their OWN pointers,
 * not a shared "newest wins" account pointer. Same per-file test database and
 * session harness as session-spaces.test.ts / session-threads.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { handleControl } from '../../src/voice/session.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import * as pairing from '../../src/devices/pairing-service.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import type { AccountEvent } from '../../src/account/events-bus.ts';
import { V2_VERSION, type ClientControlDto } from '../../src/voice/protocol.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { createThread } from '../../src/conversations/thread-store.ts';
import { threadRef } from '../../src/devices/conversation-ref.ts';
import { getActiveSpace } from '../../src/spaces/active.ts';
import { createSpace } from '../../src/spaces/store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
interface FakeSocket { readyState: number; send: ReturnType<typeof vi.fn> }
type Sent = { type: string; payload: Record<string, unknown> };
type Row = { id: string; title: string };

let pg: TestDb;
let db: Db;

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

/** A real paired device row for userId (not just a literal id), so the
 *  device's own pointer columns on bob.devices actually get written. */
async function pairDevice(userId: string, name: string): Promise<string> {
  const issued = await pairing.issueCode(db, { model: 'M5Stack Cardputer', fwVersion: '0.9.0', claim: `claim-${randomUUID()}`, ip: '203.0.113.7' });
  return pairing.approve(db, userId, issued.pairingId, name);
}

async function hello(userId: string, deviceId: string): Promise<{ socket: FakeSocket; session: DeviceSession }> {
  const socket: FakeSocket = { readyState: 1, send: vi.fn() };
  const session = createSession({ kind: 'device', userId, deviceId, name: 'Test Card' });
  await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
  return { socket, session };
}

const run = (socket: FakeSocket, session: DeviceSession, dto: ClientControlDto): Promise<void> =>
  handleControl(appDeps, socket as unknown as WebSocket, session, dto, vi.fn());

const selectConversation = (id: string): ClientControlDto => control('select_conversation', { payload: { conversation_id: id } });
const selectSpace = (id: string | null): ClientControlDto => control('select_space', { payload: { space_id: id } });
const newConversation = (requestId: string): ClientControlDto => control('new_conversation', { payload: { request_id: requestId } });
const turnStart = (turnRef: string): ClientControlDto => control('turn_start', { turn_ref: turnRef });
const listConversations = (): ClientControlDto => control('list_conversations');

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
});

beforeEach(() => {
  setJournalSink(() => undefined);
  getDeviceSessions().clear();
});

afterEach(() => setJournalSink(null));

afterAll(async () => {
  getDeviceSessions().clear();
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

describe('two devices on one account (#900)', () => {
  it("new_conversation on A does not move B's own conversation pointer", async () => {
    const { userId } = await addAccount(pg);
    const deviceA = await pairDevice(userId, 'A');
    const deviceB = await pairDevice(userId, 'B');
    const convB = await createConversation(db, userId, 'B convo');
    const b = await hello(userId, deviceB);
    await run(b.socket, b.session, selectConversation(convB.id));
    const a = await hello(userId, deviceA);
    await run(a.socket, a.session, newConversation('req_test_000001'));

    await run(b.socket, b.session, turnStart('turn_test_000001'));
    expect(b.session.activeConversationId).toBe(convB.id);

    await run(a.socket, a.session, turnStart('turn_test_000002'));
    expect(a.session.activeConversationId).toBeUndefined();
  });

  it("select_space on A does not move B's own space pointer or picker", async () => {
    const { userId } = await addAccount(pg);
    const deviceA = await pairDevice(userId, 'A');
    const deviceB = await pairDevice(userId, 'B');
    const spaceA = await createSpace(db, userId, { kind: 'group', name: 'Office' });
    const spaceB = await createSpace(db, userId, { kind: 'group', name: 'Kitchen' });
    const threadA = await createThread(db, userId, { spaceId: spaceA.id, title: 'A thread' });
    const threadB = await createThread(db, userId, { spaceId: spaceB.id, title: 'B thread' });
    const b = await hello(userId, deviceB);
    await run(b.socket, b.session, selectSpace(spaceB.id));
    await run(b.socket, b.session, selectConversation(threadRef(threadB.id)));
    const a = await hello(userId, deviceA);
    await run(a.socket, a.session, selectSpace(spaceA.id));
    await run(a.socket, a.session, selectConversation(threadRef(threadA.id)));

    expect((await getActiveSpace(db, userId, deviceB))?.spaceId).toBe(spaceB.id);
    expect((await getActiveSpace(db, userId, deviceA))?.spaceId).toBe(spaceA.id);

    b.socket.send.mockClear();
    await run(b.socket, b.session, listConversations());
    const rows = last(b.socket).payload.conversations as Row[];
    expect(rows.map((row) => row.id)).toContain(threadRef(threadB.id));
    expect(rows.map((row) => row.id)).not.toContain(threadRef(threadA.id));
  });

  it('a device with no own pointer still follows the account pointer', async () => {
    const { userId } = await addAccount(pg);
    const deviceB = await pairDevice(userId, 'B');
    const deviceC = await pairDevice(userId, 'C');
    const convB = await createConversation(db, userId, 'B convo');
    const b = await hello(userId, deviceB);
    await run(b.socket, b.session, selectConversation(convB.id));

    const c = await hello(userId, deviceC);
    await run(c.socket, c.session, turnStart('turn_test_000003'));
    expect(c.session.activeConversationId).toBe(convB.id);
  });

  it("B selects its own thread, then A switches space: B's own pointer and session are untouched (#900 MD-FIX)", async () => {
    const { userId } = await addAccount(pg);
    const deviceA = await pairDevice(userId, 'A');
    const deviceB = await pairDevice(userId, 'B');
    const spaceOld = await createSpace(db, userId, { kind: 'group', name: 'Old' });
    const spaceNew = await createSpace(db, userId, { kind: 'group', name: 'New' });
    const threadB = await createThread(db, userId, { spaceId: spaceOld.id, title: 'B thread' });
    const a = await hello(userId, deviceA);
    const b = await hello(userId, deviceB);
    // B's own action sets both B's own thread pointer and (today's follow-me)
    // the account pointer to thread B.
    await run(b.socket, b.session, selectSpace(spaceOld.id));
    await run(b.socket, b.session, selectConversation(threadRef(threadB.id)));
    await getDeviceSessions().flushDeliveries();
    b.socket.send.mockClear();

    // A has no pointer of its own, so it falls back to the (now stale, once it
    // switches) account pointer -- its space move must clear only ITS OWN
    // (absent) pointer in spaceOld, never B's, and never push B's socket.
    await run(a.socket, a.session, selectSpace(spaceNew.id));

    expect((await getActiveSpace(db, userId, deviceB))?.spaceId).toBe(spaceOld.id);
    await run(b.socket, b.session, turnStart('turn_test_x001'));
    expect(b.session.activeConversationId).toBe(threadRef(threadB.id));
    expect(sent(b.socket)).toEqual([]);
  });

  it("A's new conversation reaches the web's event stream but never B's screen (#900 MD-FIX)", async () => {
    const { userId } = await addAccount(pg);
    const deviceA = await pairDevice(userId, 'A');
    const deviceB = await pairDevice(userId, 'B');
    const convB = await createConversation(db, userId, 'B convo');
    const a = await hello(userId, deviceA);
    const b = await hello(userId, deviceB);
    await run(b.socket, b.session, selectConversation(convB.id));
    b.socket.send.mockClear();

    const events: AccountEvent[] = [];
    const unsubscribe = getAccountEvents().subscribe(userId, (event) => events.push(event));
    await run(a.socket, a.session, newConversation('req_test_x002'));
    unsubscribe();

    expect(events.some((event) => event.type === 'active.changed')).toBe(true);
    expect(sent(b.socket)).toEqual([]);
  });

  it('MD-NOTIFY: A moves the account -- B (no own pointer) hears it, C (own pointer) does not, the web does', async () => {
    const { userId } = await addAccount(pg);
    const deviceA = await pairDevice(userId, 'A');
    const deviceB = await pairDevice(userId, 'B');
    const deviceC = await pairDevice(userId, 'C');
    const convC = await createConversation(db, userId, 'C convo');
    const a = await hello(userId, deviceA);
    const b = await hello(userId, deviceB);
    const c = await hello(userId, deviceC);
    // C has its own pointer; B never set one, so it still follows the account.
    await run(c.socket, c.session, selectConversation(convC.id));
    await getDeviceSessions().flushDeliveries();
    b.socket.send.mockClear();
    c.socket.send.mockClear();

    const events: AccountEvent[] = [];
    const unsubscribe = getAccountEvents().subscribe(userId, (event) => events.push(event));
    await run(a.socket, a.session, newConversation('req_test_x003'));
    await getDeviceSessions().flushDeliveries();
    unsubscribe();

    expect(events.some((event) => event.type === 'active.changed')).toBe(true);
    expect(sent(b.socket).some((message) => message.type === 'active_conversation')).toBe(true);
    expect(sent(c.socket)).toEqual([]);
  });
});
