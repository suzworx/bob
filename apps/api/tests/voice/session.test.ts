/**
 * Vitest suite for session.ts: the per-connection lifecycle state machine,
 * hello/turn_start/turn_end/cancel/pong control handling, credit and sequence
 * accounting, and uplink accumulation limits. Runs through the root
 * vitest.config.ts.
 *
 * The store is a per-file test database (T009, specs/008-supabase-auth-pairing)
 * injected into getDb() so the async handleControl resolves the dev account
 * against the same instance the tests seed. With BOB_TEST_GUARD_ROLE=1 the
 * connection first switches to bob_server (the production role) to prove
 * every store path still works under the RLS guard.
 */
import { describe, expect, it, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import type { WebSocket } from 'ws';
import { createSession, errorDto, resetSession, sendDto, updateRequiredReason, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { handleBinary, handleControl } from '../../src/voice/session.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import {
  ACCUMULATE_MAX_BYTES,
  AUDIO_HEADER_BYTES,
  CONVERSATIONS_LIST_CAP,
  INITIAL_CREDIT_BYTES,
  MP3_16K_MONO_FORMAT,
  PCM16_16K_MONO_FORMAT,
  V2_VERSION,
  type ClientControlDto,
  type SessionDto,
} from '../../src/voice/protocol.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, setSharedDb, withUser, type Db } from '../../src/platform/db/db.ts';
import { createConversation, deleteConversation, listConversations } from '../../src/conversations/store.ts';
import { getActive, setActive } from '../../src/conversations/active.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import type { AccountEvent } from '../../src/account/events-bus.ts';
import { resolveDevAccount, DEV_ACCOUNT_ID } from '../../src/account/dev-account.ts';
import {
  addAccount,
  asDb,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb,
} from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
/** Minimal stand-in for a ws socket; send is a mock, readyState controls no-ops. */
interface FakeSocket {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
}

function makeSocket(readyState = 1): FakeSocket {
  return { readyState, send: vi.fn() };
}

/** Builds a client control DTO with the required envelope fields. */
function control(type: string, extra: Record<string, unknown> = {}): ClientControlDto {
  return { v: V2_VERSION, type, id: 'test_ctrl_000001', payload: {}, ...extra } as unknown as ClientControlDto;
}

/** Builds a valid 20-byte-header OLX2 uplink frame with the given sequence. */
function uplinkFrame(sequence: number, payloadBytes = 320): Buffer {
  const frame = Buffer.alloc(AUDIO_HEADER_BYTES + payloadBytes);
  frame.write('OLX2', 0, 'ascii');
  frame.writeUInt8(V2_VERSION, 4);
  frame.writeUInt8(1, 5); // kind audio_up
  frame.writeUInt8(1, 6); // PCM16 16 kHz mono
  frame.writeUInt8(1, 7); // channels
  frame.writeUInt32BE(1, 8); // turn handle
  frame.writeUInt32BE(sequence, 12);
  frame.writeUInt32BE(payloadBytes, 16);
  return frame;
}

/** Parses the most recently sent JSON DTO from the fake socket. */
function lastSent(socket: FakeSocket): unknown {
  const calls = socket.send.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return JSON.parse(calls[calls.length - 1]![0] as string);
}

/** Returns a fresh session moved to ready via a hello (send history cleared). */
async function readySession(socket: FakeSocket): Promise<DeviceSession> {
  const session = createSession(deviceAuth());
  await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
  socket.send.mockClear();
  return session;
}

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_NAME = 'Test Card';

/** A paired-device upgrade outcome (P-13/P-25): the account `userId` must own
 *  the row the hello resolves, so it is the dev account the suite seeds. */
function deviceAuth() {
  return { kind: 'device' as const, userId, deviceId: DEVICE_ID, name: DEVICE_NAME };
}

/** deviceAuth for an arbitrary account (pointer tests use fresh accounts so
 *  they never disturb the dev account's welcome bytes). */
function deviceAuthFor(accountUserId: string) {
  return { kind: 'device' as const, userId: accountUserId, deviceId: DEVICE_ID, name: DEVICE_NAME };
}

/** Returns a fresh session in the capturing stage with a turn ref. */
async function capturingSession(socket: FakeSocket, turnRef = 'turn_test_000001'): Promise<SessionDto> {
  const session = await readySession(socket);
  await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: turnRef }), vi.fn());
  socket.send.mockClear();
  return session;
}

let journalLines: string[];
let pg: TestDb;
let db: Db;
let userId: string;

const guardRole = process.env.BOB_TEST_GUARD_ROLE === '1';

/** The dev-account row, seeded through the sanctioned helper (resolveDevAccount
 *  cannot write auth.users as bob_server, so the FK target must exist). */
async function addAccountSafe(options: Parameters<typeof addAccount>[1] = {}): Promise<TestAccount> {
  return addAccount(pg, options);
}

/** A Db whose every call rejects: simulates a store outage cheaply (no test database
 *  instance churn), so the degradation paths stay testable per file. */
function deadDb(): Db {
  return {
    query: async <T>(): Promise<T[]> => {
      throw new Error('store unavailable');
    },
    tx: async <T>(): Promise<T> => {
      throw new Error('store unavailable');
    },
  };
}

beforeAll(async () => {
  journalLines = [];
  setJournalSink((line: string) => journalLines.push(line));
  pg = await createTestDb();
  db = asDb(pg);
  await addAccount(pg, { id: DEV_ACCOUNT_ID });
  userId = await resolveDevAccount(db);
  if (guardRole) await pg.exec('set role bob_server');
  setSharedDb(Promise.resolve(db));
});

beforeEach(() => {
  journalLines = [];
  setJournalSink((line: string) => journalLines.push(line));
  // The fake sockets never close, so a registered session would linger across
  // tests and leak its account's active.changed subscription into later ones.
  getDeviceSessions().clear();
});

afterEach(() => {
  setJournalSink(null);
});

afterAll(async () => {
  setJournalSink(null);
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

describe('createSession', () => {
  it('starts in await_hello with full credit and empty buffers', () => {
    const session = createSession();
    expect(session.stage).toBe('await_hello');
    expect(session.nextUplinkSeq).toBe(0);
    expect(session.creditBytes).toBe(INITIAL_CREDIT_BYTES);
    expect(session.totalAudioBytes).toBe(0);
    expect(session.audioChunks).toEqual([]);
    expect(session.messages).toEqual([]);
    expect(session.turnRef).toBeUndefined();
  });
});

describe('hello', () => {
  it('welcomes a fresh session and moves it to ready', async () => {
    const socket = makeSocket();
    const session = createSession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    expect(session.stage).toBe('ready');
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(lastSent(socket)).toMatchObject({
      v: 1,
      type: 'welcome',
      payload: { protocol: 'bob.v2', format_id: 1, max_audio_bytes: 4096, credit_bytes: INITIAL_CREDIT_BYTES, session_id: session.id },
    });
    expect(String((lastSent(socket) as { id: unknown }).id)).toMatch(/^welcome_/);
  });

  it('rejects a second hello with STATE_VIOLATION', async () => {
    const socket = makeSocket();
    const session = await readySession(socket);
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'STATE_VIOLATION' } });
    expect(session.stage).toBe('ready');
  });

  describe('BOB_MIN_FW_VERSION gates only a reported version (HELLO-COMPAT)', () => {
    const sentTypes = (socket: FakeSocket): string[] =>
      socket.send.mock.calls.map((call) => (JSON.parse(call[0] as string) as { type: string }).type);
    const helloWith = async (socket: FakeSocket, payload: Record<string, unknown>): Promise<DeviceSession> => {
      const session = createSession();
      await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload }), vi.fn());
      return session;
    };

    beforeEach(() => {
      vi.stubEnv('BOB_MIN_FW_VERSION', '0.2.0');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('never gates an absent version: field firmware keeps taking turns', async () => {
      expect(updateRequiredReason(undefined, '0.2.0')).toBeUndefined();
      const socket = makeSocket();
      const session = await helloWith(socket, { format_id: 2 });
      expect(sentTypes(socket)).toEqual(['welcome']);
      expect(session.updateRequired).toBeUndefined();
      await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_0001_abcd' }), vi.fn());
      expect(session.stage).toBe('capturing');
    });

    it('gates a reported version below the minimum', async () => {
      const socket = makeSocket();
      await helloWith(socket, { format_id: 2, fw_version: '0.1.9' });
      expect(sentTypes(socket)).toEqual(['welcome', 'update_required']);
      expect(lastSent(socket)).toMatchObject({ payload: { reason: 'below_minimum', min_version: '0.2.0' } });
    });

    it('gates a reported version that is not SemVer as unknown_version', async () => {
      const socket = makeSocket();
      await helloWith(socket, { format_id: 2, fw_version: 'latest' });
      expect(sentTypes(socket)).toEqual(['welcome', 'update_required']);
      expect(lastSent(socket)).toMatchObject({ payload: { reason: 'unknown_version' } });
    });
  });

  it('negotiates MP3 when the client requests format_id 2', async () => {
    const socket = makeSocket();
    const session = createSession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: MP3_16K_MONO_FORMAT } }), vi.fn());
    expect(session.stage).toBe('ready');
    expect(session.formatId).toBe(MP3_16K_MONO_FORMAT);
    expect(lastSent(socket)).toMatchObject({
      type: 'welcome',
      payload: { format_id: MP3_16K_MONO_FORMAT },
    });
  });

  it('falls back to PCM when the client requests format_id 1', async () => {
    const socket = makeSocket();
    const session = createSession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: PCM16_16K_MONO_FORMAT } }), vi.fn());
    expect(session.formatId).toBe(PCM16_16K_MONO_FORMAT);
    expect(lastSent(socket)).toMatchObject({
      type: 'welcome',
      payload: { format_id: PCM16_16K_MONO_FORMAT },
    });
  });

  it('resolves the active pointer on hello and carries it in the welcome', async () => {
    const account = await addAccountSafe({});
    const conversation = await createConversation(db, account.userId, 'pointer chat');
    await withUser(db, account.userId, (tx) => setActive(tx, account.userId, conversation.id, 'picker'));

    const socket = makeSocket();
    const session = createSession(deviceAuthFor(account.userId));
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    expect(session.stage).toBe('ready');
    expect(session.activeConversationId).toBe(conversation.id);
    expect(lastSent(socket)).toMatchObject({
      type: 'welcome',
      payload: {
        device: { id: DEVICE_ID, name: DEVICE_NAME },
        active_conversation: { id: conversation.id, title: 'pointer chat' },
      },
    });
  });

  it('leaves the session unpinned when no pointer exists (welcome active_conversation null)', async () => {
    const account = await addAccountSafe({});
    const socket = makeSocket();
    const session = createSession(deviceAuthFor(account.userId));
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    expect(session.stage).toBe('ready');
    expect(session.activeConversationId).toBeUndefined();
    expect(lastSent(socket)).toMatchObject({
      type: 'welcome',
      payload: { device: { id: DEVICE_ID, name: DEVICE_NAME }, active_conversation: null },
    });
  });

  it('sends the null form when the pointer was cleared (active conversation deleted)', async () => {
    const account = await addAccountSafe({});
    const conversation = await createConversation(db, account.userId, 'gone');
    await withUser(db, account.userId, (tx) => setActive(tx, account.userId, conversation.id, 'device'));
    await deleteConversation(db, account.userId, conversation.id);

    const socket = makeSocket();
    const session = createSession(deviceAuthFor(account.userId));
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    expect(session.activeConversationId).toBeUndefined();
    expect(lastSent(socket)).toMatchObject({
      type: 'welcome',
      payload: { active_conversation: { id: null, title: null } },
    });
  });

  it('completes hello when the conversation store is unavailable', async () => {
    setSharedDb(Promise.resolve(deadDb()));
    const socket = makeSocket();
    const session = createSession(deviceAuth());
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    expect(session.stage).toBe('ready');
    expect(session.activeConversationId).toBeUndefined();
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(lastSent(socket)).toMatchObject({
      type: 'welcome',
      payload: { protocol: 'bob.v2', format_id: 1, max_audio_bytes: 4096, credit_bytes: INITIAL_CREDIT_BYTES, session_id: session.id },
    });
    expect(journalLines.some((line) => line.includes('v2.conversation_resolve_failed'))).toBe(true);
    setSharedDb(Promise.resolve(db));
  });
});

describe('turn_start', () => {
  it('#396: v2.turn_started and v2.turn_ended carry the turn_id', async () => {
    const socket = makeSocket();
    const session = await capturingSession(socket, 'turn_test_000396');
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_end', { turn_ref: 'turn_test_000396', seq: 0 }), vi.fn());
    const entries = journalLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.find((entry) => entry.event === 'v2.turn_started')).toMatchObject({ turn_id: 'turn_test_000396' });
    expect(entries.find((entry) => entry.event === 'v2.turn_ended')).toMatchObject({ turn_id: 'turn_test_000396' });
  });

  it('starts capturing a turn from ready and resets uplink state', async () => {
    const socket = makeSocket();
    const session = await readySession(socket);
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_test_000001' }), vi.fn());
    expect(session.stage).toBe('capturing');
    expect(session.turnRef).toBe('turn_test_000001');
    expect(session.nextUplinkSeq).toBe(0);
    expect(session.creditBytes).toBe(INITIAL_CREDIT_BYTES);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('rejects turn_start before hello with STATE_VIOLATION', async () => {
    const socket = makeSocket();
    const session = createSession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_test_000001' }), vi.fn());
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'STATE_VIOLATION' } });
    expect(session.stage).toBe('await_hello');
  });

  it('FR-025: turn_start re-resolves the pointer and pins the conversation for the turn', async () => {
    const account = await addAccountSafe({});
    const conversation = await createConversation(db, account.userId, 'pinned');
    await withUser(db, account.userId, (tx) => setActive(tx, account.userId, conversation.id, 'web_text'));

    const socket = makeSocket();
    const session = createSession(deviceAuthFor(account.userId));
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_test_000001' }), vi.fn());

    expect(session.stage).toBe('capturing');
    expect(session.activeConversationId).toBe(conversation.id);
    expect(session.activeConversationTitle).toBe('pinned');
  });

  it('FR-025: turn_start re-resolves the pointer and unpins when its conversation was deleted', async () => {
    const account = await addAccountSafe({});
    const conversation = await createConversation(db, account.userId, 'deleted after hello');
    await withUser(db, account.userId, (tx) => setActive(tx, account.userId, conversation.id, 'device'));

    const socket = makeSocket();
    const session = createSession(deviceAuthFor(account.userId));
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    expect(session.activeConversationId).toBe(conversation.id);

    // The pointer's conversation is deleted on the web while the device is
    // idle: turn_start's refresh must see the cleared pointer and unpin.
    await deleteConversation(db, account.userId, conversation.id);
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_test_000001' }), vi.fn());

    expect(session.stage).toBe('capturing');
    expect(session.activeConversationId).toBeUndefined();
  });
});

describe('handleBinary', () => {
  it('acknowledges valid uplink frames and advances sequence and totals', async () => {
    const socket = makeSocket();
    const session = await capturingSession(socket);
    handleBinary(appDeps, socket as unknown as WebSocket, session, uplinkFrame(0));
    expect(session.nextUplinkSeq).toBe(1);
    expect(session.totalAudioBytes).toBe(320);
    expect(session.audioChunks).toHaveLength(1);
    expect(session.audioChunks[0]!.length).toBe(320);
    expect(lastSent(socket)).toMatchObject({
      type: 'ack',
      turn_ref: 'turn_test_000001',
      payload: { credit_bytes: INITIAL_CREDIT_BYTES },
    });

    handleBinary(appDeps, socket as unknown as WebSocket, session, uplinkFrame(1));
    expect(session.nextUplinkSeq).toBe(2);
    expect(session.totalAudioBytes).toBe(640);
    expect(session.audioChunks).toHaveLength(2);
  });

  it('batched uplink: v2.turn_ended frames counts 10 ms PCM frames (bytes / 320), msgs the audio_up messages', async () => {
    const socket = makeSocket();
    const session = await capturingSession(socket);
    for (let sequence = 0; sequence < 3; sequence += 1) {
      handleBinary(appDeps, socket as unknown as WebSocket, session, uplinkFrame(sequence, 4 * 320));
    }
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_end', { turn_ref: session.turnRef, seq: 2 }), vi.fn());
    await session.turnDone;
    const ended = journalLines.map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => entry.event === 'v2.turn_ended');
    expect(ended).toMatchObject({ frames: 12, msgs: 3 });
  });

  it('#1331 C: with BOB_LEAN_UPLINK=1 sends no ack and journals no v2.audio_up, but turn_end keeps the frame total', async () => {
    vi.stubEnv('BOB_LEAN_UPLINK', '1');
    try {
      const socket = makeSocket();
      const session = await capturingSession(socket);
      const frames = 5;
      for (let sequence = 0; sequence < frames; sequence += 1) {
        handleBinary(appDeps, socket as unknown as WebSocket, session, uplinkFrame(sequence));
      }
      const sent = socket.send.mock.calls.map((call) => (JSON.parse(call[0] as string) as { type: string }).type);
      expect(sent.filter((type) => type === 'ack')).toHaveLength(0);
      expect(sent).toEqual([]);
      const entries = journalLines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entries.filter((entry) => entry.event === 'v2.audio_up')).toHaveLength(0);
      expect(session.nextUplinkSeq).toBe(frames);
      expect(session.totalAudioBytes).toBe(frames * 320);
      expect(session.audioChunks).toHaveLength(frames);

      await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_end', { turn_ref: session.turnRef, seq: frames - 1 }), vi.fn());
      await session.turnDone;
      const ended = journalLines.map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => entry.event === 'v2.turn_ended');
      expect(ended).toMatchObject({ frames });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('#1331 C: with BOB_LEAN_UPLINK=1 an over-limit uplink still reports QUEUE_FULL', async () => {
    vi.stubEnv('BOB_LEAN_UPLINK', '1');
    try {
      const socket = makeSocket();
      const session = await capturingSession(socket);
      const frame = uplinkFrame(0);
      const frameCount = Math.ceil(ACCUMULATE_MAX_BYTES / 320) + 1;
      for (let sequence = 0; sequence < frameCount; sequence += 1) {
        frame.writeUInt32BE(sequence, 12);
        handleBinary(appDeps, socket as unknown as WebSocket, session, frame);
      }
      expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'QUEUE_FULL' } });
      expect(session.stage).toBe('ready');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects binary audio outside the capturing stage with STATE_VIOLATION', async () => {
    const socket = makeSocket();
    const session = await readySession(socket);
    handleBinary(appDeps, socket as unknown as WebSocket, session, uplinkFrame(0));
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'STATE_VIOLATION' } });
    expect(session.stage).toBe('ready');
  });

  it('reports SEQUENCE_GAP for out-of-order frames', async () => {
    const socket = makeSocket();
    const session = await capturingSession(socket);
    handleBinary(appDeps, socket as unknown as WebSocket, session, uplinkFrame(1));
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'SEQUENCE_GAP' } });
    expect(session.nextUplinkSeq).toBe(0);
    expect(session.audioChunks).toHaveLength(0);
  });

  it('reports QUEUE_FULL when the frame exceeds the remaining credit', async () => {
    const socket = makeSocket();
    const session = await capturingSession(socket);
    session.creditBytes = 100;
    handleBinary(appDeps, socket as unknown as WebSocket, session, uplinkFrame(0, 320));
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'QUEUE_FULL' } });
    expect(session.nextUplinkSeq).toBe(0);
    expect(session.audioChunks).toHaveLength(0);
  });

  it('resets the session when accumulation exceeds the 1 MB bound', async () => {
    const socket = makeSocket();
    const session = await capturingSession(socket);
    const frame = uplinkFrame(0);
    const frameCount = Math.ceil(ACCUMULATE_MAX_BYTES / 320) + 1;
    for (let sequence = 0; sequence < frameCount; sequence += 1) {
      frame.writeUInt32BE(sequence, 12);
      handleBinary(appDeps, socket as unknown as WebSocket, session, frame);
    }
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'QUEUE_FULL' } });
    expect(session.stage).toBe('ready');
    expect(session.turnRef).toBeUndefined();
    expect(session.nextUplinkSeq).toBe(0);
    expect(session.creditBytes).toBe(INITIAL_CREDIT_BYTES);
    expect(session.audioChunks).toEqual([]);
    expect(session.totalAudioBytes).toBe(0);
    expect(journalLines.some((line) => line.includes('v2.accumulate_full'))).toBe(true);
  });
});

describe('turn_end', () => {
  it('ends a turn with audio frames and triggers onTurnEnd exactly once', async () => {
    const socket = makeSocket();
    const session = await capturingSession(socket);
    const onTurnEnd = vi.fn();
    handleBinary(appDeps, socket as unknown as WebSocket, session, uplinkFrame(0));
    handleBinary(appDeps, socket as unknown as WebSocket, session, uplinkFrame(1));
    handleBinary(appDeps, socket as unknown as WebSocket, session, uplinkFrame(2));
    socket.send.mockClear();

    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_end', { turn_ref: session.turnRef, seq: 2 }), onTurnEnd);
    // Configured telemetry starts the workflow asynchronously; await its owned completion.
    await session.turnDone;
    expect(session.stage).toBe('responding');
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd).toHaveBeenCalledWith(session, 'turn_test_000001');
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('ends a turn with no audio frames using seq 0', async () => {
    const socket = makeSocket();
    const session = await capturingSession(socket);
    const onTurnEnd = vi.fn();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_end', { turn_ref: session.turnRef, seq: 0 }), onTurnEnd);
    await session.turnDone;
    expect(session.stage).toBe('responding');
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd).toHaveBeenCalledWith(session, 'turn_test_000001');
  });

  it('rejects a mismatched turn_ref with SEQUENCE_GAP', async () => {
    const socket = makeSocket();
    const session = await capturingSession(socket);
    const onTurnEnd = vi.fn();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_end', { turn_ref: 'turn_other_000001', seq: 0 }), onTurnEnd);
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'SEQUENCE_GAP' } });
    expect(onTurnEnd).not.toHaveBeenCalled();
    expect(session.stage).toBe('capturing');
  });

  it('rejects a stale seq with SEQUENCE_GAP', async () => {
    const socket = makeSocket();
    const session = await capturingSession(socket);
    const onTurnEnd = vi.fn();
    handleBinary(appDeps, socket as unknown as WebSocket, session, uplinkFrame(0));
    handleBinary(appDeps, socket as unknown as WebSocket, session, uplinkFrame(1));
    socket.send.mockClear();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_end', { turn_ref: session.turnRef, seq: 0 }), onTurnEnd);
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'SEQUENCE_GAP' } });
    expect(onTurnEnd).not.toHaveBeenCalled();
    expect(session.stage).toBe('capturing');
  });

  it('rejects turn_end outside capturing with SEQUENCE_GAP, not STATE_VIOLATION', async () => {
    const socket = makeSocket();
    const session = await readySession(socket);
    const onTurnEnd = vi.fn();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_end', { turn_ref: 'turn_test_000001', seq: 0 }), onTurnEnd);
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'SEQUENCE_GAP' } });
    expect(onTurnEnd).not.toHaveBeenCalled();
    expect(session.stage).toBe('ready');
  });
});

describe('cancel', () => {
  it('cancels an active turn and resets the session to ready', async () => {
    const socket = makeSocket();
    const session = await capturingSession(socket);
    handleBinary(appDeps, socket as unknown as WebSocket, session, uplinkFrame(0));
    socket.send.mockClear();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('cancel'), vi.fn());
    expect(session.stage).toBe('ready');
    expect(session.turnRef).toBeUndefined();
    expect(session.nextUplinkSeq).toBe(0);
    expect(session.creditBytes).toBe(INITIAL_CREDIT_BYTES);
    expect(session.audioChunks).toEqual([]);
    expect(session.totalAudioBytes).toBe(0);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('cancels from ready without side effects', async () => {
    const socket = makeSocket();
    const session = await readySession(socket);
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('cancel'), vi.fn());
    expect(session.stage).toBe('ready');
    expect(session.turnRef).toBeUndefined();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('rejects cancel before hello with STATE_VIOLATION', async () => {
    const socket = makeSocket();
    const session = createSession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('cancel'), vi.fn());
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'STATE_VIOLATION' } });
    expect(session.stage).toBe('await_hello');
  });
});

describe('pong', () => {
  it('is ignored without a DTO or state change', async () => {
    const socket = makeSocket();
    const session = await capturingSession(socket);
    socket.send.mockClear();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('pong'), vi.fn());
    expect(socket.send).not.toHaveBeenCalled();
    expect(session.stage).toBe('capturing');
    expect(session.turnRef).toBe('turn_test_000001');
  });
});

describe('list_conversations', () => {
  it('rejects a list before hello with STATE_VIOLATION', async () => {
    const socket = makeSocket();
    const session = createSession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('list_conversations'), vi.fn());
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'STATE_VIOLATION' } });
    expect(session.stage).toBe('await_hello');
  });

  it('replies with only real store rows in updated_at DESC order, capped at 10', async () => {
    const socket = makeSocket();
    const session = await readySession(socket);
    const seeded = [];
    for (let index = 0; index < 12; index += 1) {
      seeded.push(await createConversation(db, userId, `conversation ${String(index).padStart(2, '0')}`));
    }
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('list_conversations'), vi.fn());
    const reply = lastSent(socket) as { type: string; payload: { conversations: { id: string; title: string }[] } };
    expect(reply.type).toBe('conversations');
    expect(reply.payload.conversations).toHaveLength(CONVERSATIONS_LIST_CAP);
    const expected = seeded.slice(-CONVERSATIONS_LIST_CAP).reverse();
    expect(reply.payload.conversations.map((entry) => entry.id)).toEqual(expected.map((entry) => entry.id));
    expect(reply.payload.conversations.map((entry) => entry.title)).toEqual(expected.map((entry) => entry.title));
    expect(journalLines.some((line) => line.includes('v2.conversation_listed'))).toBe(true);
  });

  it('replies an empty list on a store outage and stays ready', async () => {
    setSharedDb(Promise.resolve(deadDb()));
    const socket = makeSocket();
    const session = createSession(deviceAuth());
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    expect(session.stage).toBe('ready');
    socket.send.mockClear();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('list_conversations'), vi.fn());
    expect(lastSent(socket)).toMatchObject({ type: 'conversations', payload: { conversations: [] } });
    expect(session.stage).toBe('ready');
    expect(journalLines.some((line) => line.includes('v2.conversation_list_failed'))).toBe(true);
    setSharedDb(Promise.resolve(db));
  });
});

describe('select_conversation', () => {
  it('switches activeConversationId and confirms with conversation_selected', async () => {
    const socket = makeSocket();
    const session = await readySession(socket);
    const target = await createConversation(db, userId, 'Trip planning');
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('select_conversation', { payload: { conversation_id: target.id } }), vi.fn());
    expect(session.activeConversationId).toBe(target.id);
    expect(lastSent(socket)).toMatchObject({
      type: 'conversation_selected',
      payload: { conversation_id: target.id, title: 'Trip planning' },
    });
    expect(journalLines.some((line) => line.includes('v2.conversation_selected'))).toBe(true);
  });

  it('rejects an unknown conversation with CONVERSATION_NOT_FOUND and leaves the selection unchanged', async () => {
    const socket = makeSocket();
    const session = await readySession(socket);
    const before = session.activeConversationId;
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('select_conversation', { payload: { conversation_id: 'cnv_00000000000000000000' } }), vi.fn());
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'CONVERSATION_NOT_FOUND' } });
    expect(session.activeConversationId).toBe(before);
  });

  it('rejects a select during capturing with STATE_VIOLATION and leaves the selection unchanged', async () => {
    const socket = makeSocket();
    const session = await capturingSession(socket);
    const before = session.activeConversationId;
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('select_conversation', { payload: { conversation_id: 'cnv_00000000000000000000' } }), vi.fn());
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'STATE_VIOLATION' } });
    expect(session.stage).toBe('capturing');
    expect(session.activeConversationId).toBe(before);
  });

  it('reports INTERNAL on a store outage and leaves the selection unchanged', async () => {
    const socket = makeSocket();
    const session = await readySession(socket);
    const before = session.activeConversationId;
    expect(before).toBeDefined();
    setSharedDb(Promise.resolve(deadDb()));
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('select_conversation', { payload: { conversation_id: 'cnv_00000000000000000000' } }), vi.fn());
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'INTERNAL' } });
    expect(session.activeConversationId).toBe(before);
    expect(journalLines.some((line) => line.includes('v2.conversation_select_failed'))).toBe(true);
    setSharedDb(Promise.resolve(db));
  });

  it('rejects a select before hello with STATE_VIOLATION', async () => {
    const socket = makeSocket();
    const session = createSession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('select_conversation', { payload: { conversation_id: 'cnv_00000000000000000000' } }), vi.fn());
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'STATE_VIOLATION' } });
    expect(session.stage).toBe('await_hello');
  });

  it('C-12 shape: a picker selection writes the pointer (surface picker) and publishes active.changed', async () => {
    const account = await addAccountSafe({});
    const target = await createConversation(db, account.userId, 'picked from device');
    const received: AccountEvent[] = [];
    const stop = getAccountEvents().subscribe(account.userId, (event) => received.push(event));

    const socket = makeSocket();
    const session = createSession(deviceAuthFor(account.userId));
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    socket.send.mockClear();
    await handleControl(appDeps, 
      socket as unknown as WebSocket,
      session,
      control('select_conversation', { payload: { conversation_id: target.id } }),
      vi.fn(),
    );

    expect(lastSent(socket)).toMatchObject({ type: 'conversation_selected', payload: { conversation_id: target.id } });
    const active = await getActive(db, account.userId);
    expect(active?.conversationId).toBe(target.id);
    expect(active?.surface).toBe('picker');
    const changed = received.filter((event) => event.type === 'active.changed');
    expect(changed).toHaveLength(1);
    if (changed[0]!.type === 'active.changed') {
      expect(changed[0]!.conversation_id).toBe(target.id);
      expect(changed[0]!.surface).toBe('picker');
    }
    stop();
  });
});

describe('new_conversation', () => {
  const REQUEST_ID = 'newc_req_000001';
  const OLD_MESSAGES = [{ role: 'user' as const, content: 'old turn' }, { role: 'assistant' as const, content: 'old reply' }];

  /** A fresh account with a pinned conversation and a ready, registered device session on it. */
  async function pinnedSession(): Promise<{ account: TestAccount; conversationId: string; socket: FakeSocket; session: DeviceSession }> {
    const account = await addAccountSafe({});
    const conversation = await createConversation(db, account.userId, 'previous chat');
    await withUser(db, account.userId, (tx) => setActive(tx, account.userId, conversation.id, 'picker'));
    const socket = makeSocket();
    const session = createSession(deviceAuthFor(account.userId));
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    expect(session.activeConversationId).toBe(conversation.id);
    session.messages = [...OLD_MESSAGES];
    socket.send.mockClear();
    return { account, conversationId: conversation.id, socket, session };
  }

  function newConversation(requestId = REQUEST_ID): ClientControlDto {
    return control('new_conversation', { payload: { request_id: requestId } });
  }

  function sentTypes(socket: FakeSocket): string[] {
    return socket.send.mock.calls.map((call) => (JSON.parse(call[0] as string) as { type: string }).type);
  }

  it('clears the pointer, publishes the null active.changed, pushes it, then acks', async () => {
    const { account, socket, session } = await pinnedSession();
    const received: AccountEvent[] = [];
    const stop = getAccountEvents().subscribe(account.userId, (event) => received.push(event));
    const before = (await listConversations(db, account.userId)).length;

    await handleControl(appDeps, socket as unknown as WebSocket, session, newConversation(), vi.fn());

    const ack = lastSent(socket) as { type: string; payload: { request_id: string; changed_at: number } };
    expect(ack).toMatchObject({ type: 'conversation_cleared', payload: { request_id: REQUEST_ID } });
    expect(Number.isInteger(ack.payload.changed_at) && ack.payload.changed_at > 0).toBe(true);
    expect(sentTypes(socket)).toEqual(['active_conversation', 'conversation_cleared']);
    expect(JSON.parse(socket.send.mock.calls[0]![0] as string)).toMatchObject({ payload: { id: null, title: null } });
    const active = await getActive(db, account.userId);
    expect(active).toMatchObject({ conversationId: null, surface: 'device', changedAt: ack.payload.changed_at });
    expect(session.activeConversationId).toBeUndefined();
    expect(session.activeConversationTitle).toBeUndefined();
    expect(session.messages).toEqual([]);
    expect(received).toEqual([{
      type: 'active.changed', conversation_id: null, title: null, surface: 'device', changed_at: ack.payload.changed_at,
    }]);
    expect((await listConversations(db, account.userId)).length).toBe(before);
    expect(journalLines.some((line) => line.includes('v2.new_conversation') && !line.includes('duplicate'))).toBe(true);
    expect(journalLines.some((line) => line.includes('v2.active_changed') && line.includes('device'))).toBe(true);
    stop();
  });

  it('a repeated request_id re-sends the same ack and does not clobber a later web activate', async () => {
    const { account, conversationId, socket, session } = await pinnedSession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, newConversation(), vi.fn());
    const first = lastSent(socket) as { payload: { changed_at: number } };
    await withUser(db, account.userId, (tx) => setActive(tx, account.userId, conversationId, 'activate'));
    const received: AccountEvent[] = [];
    const stop = getAccountEvents().subscribe(account.userId, (event) => received.push(event));
    socket.send.mockClear();

    await handleControl(appDeps, socket as unknown as WebSocket, session, newConversation(), vi.fn());

    expect(lastSent(socket)).toMatchObject({
      type: 'conversation_cleared', payload: { request_id: REQUEST_ID, changed_at: first.payload.changed_at },
    });
    expect(sentTypes(socket)).toEqual(['conversation_cleared']);
    expect(await getActive(db, account.userId)).toMatchObject({ conversationId, surface: 'activate' });
    expect(received).toEqual([]);
    expect(journalLines.some((line) => line.includes('v2.new_conversation_duplicate'))).toBe(true);
    stop();
  });

  it('rejects during capturing with STATE_VIOLATION and leaves the pointer alone', async () => {
    const { account, conversationId, socket, session } = await pinnedSession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_test_000001' }), vi.fn());
    socket.send.mockClear();
    await handleControl(appDeps, socket as unknown as WebSocket, session, newConversation(), vi.fn());
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'STATE_VIOLATION' } });
    expect(session.stage).toBe('capturing');
    expect(session.activeConversationId).toBe(conversationId);
    expect((await getActive(db, account.userId))?.conversationId).toBe(conversationId);
  });

  it('rejects before hello with STATE_VIOLATION', async () => {
    const socket = makeSocket();
    const session = createSession(deviceAuth());
    await handleControl(appDeps, socket as unknown as WebSocket, session, newConversation(), vi.fn());
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'STATE_VIOLATION' } });
    expect(session.stage).toBe('await_hello');
  });

  it('reports INTERNAL on a store outage and leaves the session untouched', async () => {
    const { conversationId, socket, session } = await pinnedSession();
    setSharedDb(Promise.resolve(deadDb()));
    try {
      await handleControl(appDeps, socket as unknown as WebSocket, session, newConversation(), vi.fn());
    } finally {
      setSharedDb(Promise.resolve(db));
    }
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'INTERNAL' } });
    expect(session.activeConversationId).toBe(conversationId);
    expect(session.messages).toEqual(OLD_MESSAGES);
    expect(journalLines.some((line) => line.includes('v2.active_write_failed') && line.includes('device'))).toBe(true);
  });

  it('reports INTERNAL for a session with no account', async () => {
    const socket = makeSocket();
    const session = createSession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    socket.send.mockClear();
    await handleControl(appDeps, socket as unknown as WebSocket, session, newConversation(), vi.fn());
    expect(lastSent(socket)).toMatchObject({ type: 'error', payload: { code: 'INTERNAL' } });
  });

  it('turn_start with a cleared pointer drops the in-memory history of the previous conversation', async () => {
    const { account, socket, session } = await pinnedSession();
    await withUser(db, account.userId, (tx) => setActive(tx, account.userId, null, 'activate'));
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_test_000001' }), vi.fn());
    expect(session.activeConversationId).toBeUndefined();
    expect(session.messages).toEqual([]);
  });
});

describe('active_conversation device push (P-23, P-24)', () => {
  it('P-23 shape: active.changed pushes active_conversation to a registered idle device', async () => {
    const account = await addAccountSafe({});
    const conversation = await createConversation(db, account.userId, 'push target');
    const socket = makeSocket();
    const session = createSession(deviceAuthFor(account.userId));
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    expect(session.stage).toBe('ready');
    socket.send.mockClear();

    getAccountEvents().publish(account.userId, {
      type: 'active.changed',
      conversation_id: conversation.id,
      title: 'push target',
      surface: 'activate',
      changed_at: Date.now(),
    });

    const sent = JSON.parse(String(socket.send.mock.calls.at(-1)![0])) as Record<string, unknown>;
    expect(sent).toMatchObject({
      type: 'active_conversation',
      payload: { id: conversation.id, title: 'push target' },
    });
  });

  it('P-24 shape: pushes during a turn are held, latest wins, and flushed only on ready', async () => {
    const account = await addAccountSafe({});
    const first = await createConversation(db, account.userId, 'held first');
    const latest = await createConversation(db, account.userId, 'held latest');
    const socket = makeSocket();
    const session = createSession(deviceAuthFor(account.userId));
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_test_000001' }), vi.fn());
    expect(session.stage).toBe('capturing');
    socket.send.mockClear();

    // Two pointer changes while mid-turn: nothing is sent, and only the latest
    // is kept for the flush (nothing may be sent during playback, R10).
    getAccountEvents().publish(account.userId, {
      type: 'active.changed',
      conversation_id: first.id,
      title: 'held first',
      surface: 'activate',
      changed_at: Date.now(),
    });
    getAccountEvents().publish(account.userId, {
      type: 'active.changed',
      conversation_id: latest.id,
      title: 'held latest',
      surface: 'activate',
      changed_at: Date.now(),
    });
    expect(socket.send).not.toHaveBeenCalled();

    // turn.ts calls resetSession right after playback_end; that is the flush.
    resetSession(appDeps, session);
    expect(session.stage).toBe('ready');
    const sent = JSON.parse(String(socket.send.mock.calls.at(-1)![0])) as Record<string, unknown>;
    expect(sent).toMatchObject({
      type: 'active_conversation',
      payload: { id: latest.id, title: 'held latest' },
    });
  });
});

describe('FR-017 golden sequence', () => {
  it('hello -> turn_start -> audio_up x1 -> turn_end sends byte-identical welcome and ack JSON', async () => {
    const socket = makeSocket();
    const session = createSession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_test_000001' }), vi.fn());
    handleBinary(appDeps, socket as unknown as WebSocket, session, uplinkFrame(0));
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_end', { turn_ref: 'turn_test_000001', seq: 0 }), vi.fn());
    const sent = socket.send.mock.calls.map((call) => String(call[0]));
    const welcomeId = (JSON.parse(sent[0]!) as { id: string }).id;
    const ackId = (JSON.parse(sent[1]!) as { id: string }).id;
    expect(sent).toEqual([
      `{"v":1,"type":"welcome","id":"${welcomeId}","payload":{"protocol":"bob.v2","format_id":1,"max_audio_bytes":4096,"credit_bytes":${INITIAL_CREDIT_BYTES},"session_id":"${session.id}"}}`,
      `{"v":1,"type":"ack","id":"${ackId}","turn_ref":"turn_test_000001","payload":{"credit_bytes":${INITIAL_CREDIT_BYTES}}}`,
    ]);
  });
});

describe('P-25/P-26 golden sequences for a paired device (FR-019)', () => {
  it('P-25: a paired device using only pre-008 messages gets the 007 welcome bytes plus device and active_conversation, and a byte-identical ack', async () => {
    // A fresh account guarantees no active pointer, so active_conversation
    // stays whole-object null in the golden bytes (the dev account's pointer
    // may have been moved by earlier picker tests).
    const account = await addAccountSafe({});
    const socket = makeSocket();
    const session = createSession(deviceAuthFor(account.userId));
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_test_000001' }), vi.fn());
    handleBinary(appDeps, socket as unknown as WebSocket, session, uplinkFrame(0));
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_end', { turn_ref: 'turn_test_000001', seq: 0 }), vi.fn());
    const sent = socket.send.mock.calls.map((call) => String(call[0]));
    const welcomeId = (JSON.parse(sent[0]!) as { id: string }).id;
    const ackId = (JSON.parse(sent[1]!) as { id: string }).id;
    expect(sent).toEqual([
      `{"v":1,"type":"welcome","id":"${welcomeId}","payload":{"protocol":"bob.v2","format_id":1,"max_audio_bytes":4096,"credit_bytes":${INITIAL_CREDIT_BYTES},"session_id":"${session.id}","device":{"id":"${DEVICE_ID}","name":"${DEVICE_NAME}"},"active_conversation":null,"active_space":null}}`,
      `{"v":1,"type":"ack","id":"${ackId}","turn_ref":"turn_test_000001","payload":{"credit_bytes":${INITIAL_CREDIT_BYTES}}}`,
    ]);
  });

  it('P-26: the 007 golden welcome is byte-identical for a session that never touches the new messages', async () => {
    // The pre-008 createSession() path (no upgrade auth attached) still
    // answers the pre-008 welcome: server.ts has not yet passed the guard's
    // deviceAuth through, so that transitional state keeps old behaviour.
    const socket = makeSocket();
    const session = createSession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    const welcome = JSON.parse(String(socket.send.mock.calls[0]![0])) as Record<string, unknown>;
    expect(welcome).toMatchObject({ type: 'welcome' });
    expect((welcome.payload as Record<string, unknown>).device).toBeUndefined();
    expect((welcome.payload as Record<string, unknown>).active_conversation).toBeUndefined();
  });
});

describe('sendDto', () => {
  it('no-ops when the socket is not open', () => {
    const closed = makeSocket(0);
    const session = createSession();
    sendDto(closed as unknown as WebSocket, errorDto(session, 'STATE_VIOLATION'));
    expect(closed.send).not.toHaveBeenCalled();
  });
});
