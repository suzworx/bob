/**
 * Wire contract fixtures shared with the Cardputer firmware
 * (apps/cardputer/test/fixtures/wire). The firmware's host tests
 * (apps/cardputer/test/host) parse these exact bytes with the real
 * src/protocol.cpp and compare its builders' output against them; this suite
 * proves the same bytes are what the server accepts and sends:
 *
 * 1. every fixture passes its Zod schema (device->server: ClientControlDtoSchema;
 *    server->device: ServerControlDtoSchema or the pairing/active schemas
 *    outside that union) and is compact JSON.stringify output;
 * 2. for the messages the firmware parses by substring, the real handleControl
 *    produces the fixture byte for byte once the random ids are pinned. The
 *    firmware parser is key-order-sensitive, so a server change that reorders
 *    or renames a field fails here before it strands a device.
 *
 * The store is mocked, not Postgres: only the bytes on the socket matter here,
 * and the gate must run without a database.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ZodType } from 'zod';

const store = vi.hoisted(() => ({
  getActive: vi.fn(),
  setActive: vi.fn(),
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  getActiveSpace: vi.fn(),
  setActiveSpace: vi.fn(),
  listSpaces: vi.fn(),
  listPendingTimers: vi.fn(),
}));
vi.mock('../../src/timers/store.ts', async (original) => ({
  ...(await original<object>()),
  listPendingTimers: store.listPendingTimers,
}));
vi.mock('../../src/conversations/active.ts', async (original) => ({
  ...(await original<object>()),
  getActive: store.getActive,
  setActive: store.setActive,
}));
vi.mock('../../src/conversations/store.ts', async (original) => ({
  ...(await original<object>()),
  listConversations: store.listConversations,
  getConversation: store.getConversation,
}));
vi.mock('../../src/spaces/active.ts', async (original) => ({
  ...(await original<object>()),
  getActiveSpace: store.getActiveSpace,
  setActiveSpace: store.setActiveSpace,
}));
vi.mock('../../src/spaces/store.ts', async (original) => ({
  ...(await original<object>()),
  listSpaces: store.listSpaces,
}));

import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { handleBinary, handleControl } from '../../src/voice/session.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { pushTimersState, resetTimersState } from '../../src/voice/device-tools.ts';
import { setSharedDb, StoreNotFoundError, type Db } from '../../src/platform/db/db.ts';
import {
  ActiveConversationDtoSchema,
  ActiveSpaceDtoSchema,
  AUDIO_HEADER_BYTES,
  ClientControlDtoSchema,
  encodeAudioDown,
  EndOfTurnDtoSchema,
  endOfTurnDto,
  PairCodeDtoSchema,
  parseAudioUp,
  PairDeniedDtoSchema,
  PairedDtoSchema,
  PairExpiredDtoSchema,
  PairingRequiredDtoSchema,
  replyTextDto,
  serializeAudioFrame,
  ServerControlDtoSchema,
  type ClientControlDto,
} from '../../src/voice/protocol.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const timersDeps = { registry: appDeps.deviceSessions, getDb: appDeps.getDb };
const FIXTURES = resolve(import.meta.dirname, '../../../cardputer/test/fixtures/wire');

/** A fixture's exact wire bytes (the file's trailing line break dropped). */
function raw(name: string): string {
  return readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8').replace(/\r?\n$/, '');
}

const DEVICE_TO_SERVER = [
  'hello', 'hello_versioned', 'turn_start', 'turn_start_conversation', 'turn_start_conversation_assistant_name', 'turn_end', 'list_conversations', 'select_conversation',
  'new_conversation', 'pair_request', 'pair_request_resume', 'list_spaces', 'select_space',
  'select_space_none', 'device_state', 'device_state_unknown_battery', 'device_log', 'announce_ack', 'announce_ack_missed', 'cancel',
  'turn_timing', 'turn_timing_stopped',
];

/** Server->device message type -> the schema that owns it. */
const SERVER_SCHEMAS: Record<string, ZodType> = {
  welcome: ServerControlDtoSchema, playback_start: ServerControlDtoSchema,
  playback_end: ServerControlDtoSchema, status: ServerControlDtoSchema, error: ServerControlDtoSchema,
  conversations: ServerControlDtoSchema, conversation_selected: ServerControlDtoSchema,
  conversation_cleared: ServerControlDtoSchema, pairing_required: PairingRequiredDtoSchema,
  pair_code: PairCodeDtoSchema, paired: PairedDtoSchema, pair_expired: PairExpiredDtoSchema,
  pair_denied: PairDeniedDtoSchema, active_conversation: ActiveConversationDtoSchema,
  spaces: ServerControlDtoSchema, space_selected: ServerControlDtoSchema, active_space: ActiveSpaceDtoSchema,
  device_control: ServerControlDtoSchema, reply_text: ServerControlDtoSchema, announce: ServerControlDtoSchema,
  timers_state: ServerControlDtoSchema, update_required: ServerControlDtoSchema,
  end_of_turn: EndOfTurnDtoSchema,
};

const fixtureNames = readdirSync(FIXTURES)
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length));

describe('wire fixtures: every file is a valid, canonical message', () => {
  it('finds the fixtures', () => {
    expect(fixtureNames.length).toBeGreaterThanOrEqual(29);
  });

  it.each(fixtureNames)('%s is compact JSON.stringify output', (name) => {
    expect(JSON.stringify(JSON.parse(raw(name)))).toBe(raw(name));
  });

  it.each(fixtureNames)('%s passes its schema', (name) => {
    const message = JSON.parse(raw(name)) as { type: string };
    const schema = DEVICE_TO_SERVER.includes(name) ? ClientControlDtoSchema : SERVER_SCHEMAS[message.type];
    expect(schema, `no schema mapped for type ${message.type}`).toBeDefined();
    const result = schema!.safeParse(message);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('the OLX2 downlink headers equal serializeAudioFrame output', () => {
    const { frames } = JSON.parse(readFileSync(resolve(FIXTURES, 'frames/olx2_audio_down.json'), 'utf8')) as {
      frames: { name: string; formatId: 1 | 2; turnHandle: number; sequence: number; payloadBytes: number; headerHex: string }[];
    };
    const pcm = frames.find((frame) => frame.name === 'pcm')!;
    expect(serializeAudioFrame(encodeAudioDown(pcm.turnHandle, pcm.sequence)).subarray(0, AUDIO_HEADER_BYTES).toString('hex'))
      .toBe(pcm.headerHex);
    for (const frame of frames) {
      const bytes = serializeAudioFrame({
        header: {
          magic: 'OLX2', version: 1, kind: 'audio_down', formatId: frame.formatId, channels: 1,
          turnHandle: frame.turnHandle, sequence: frame.sequence, payloadBytes: frame.payloadBytes,
        },
        payload: Buffer.alloc(frame.payloadBytes),
      });
      expect(bytes.subarray(0, AUDIO_HEADER_BYTES).toString('hex')).toBe(frame.headerHex);
    }
  });
});

// ---- The real handleControl, captured off a fake socket (session.test.ts harness).

const USER_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const deviceAuth = { kind: 'device' as const, userId: USER_ID, deviceId: DEVICE_ID, name: 'Test Card' };

/** send is a mock; once() keeps close listeners so afterEach can fire them and
 *  clear the unpaired idle-close timer handleControl arms. */
interface FakeSocket { readyState: number; send: ReturnType<typeof vi.fn>; once: (event: string, fn: () => void) => void }
const closeListeners: (() => void)[] = [];
const makeSocket = (): FakeSocket => ({
  readyState: 1,
  send: vi.fn(),
  once: (event, fn) => {
    if (event === 'close') closeListeners.push(fn);
  },
});
const control = (type: string, extra: Record<string, unknown> = {}): ClientControlDto =>
  ({ v: 1, type, id: 'test_ctrl_000001', payload: {}, ...extra }) as unknown as ClientControlDto;

/** Every text frame sent so far, as raw strings. */
const sentText = (socket: FakeSocket): string[] =>
  socket.send.mock.calls.map((call) => call[0]).filter((data): data is string => typeof data === 'string');

/** The one sent frame of `type`, raw. */
function sentOfType(socket: FakeSocket, type: string): string {
  const matches = sentText(socket).filter((text) => (JSON.parse(text) as { type: string }).type === type);
  expect(matches, `expected exactly one ${type}`).toHaveLength(1);
  return matches[0]!;
}

/** Pins the random fields (message id, welcome session_id) to the fixture's
 *  values by assignment, which keeps key order, then requires identical bytes. */
function expectFixtureBytes(sent: string, name: string): void {
  const fixture = JSON.parse(raw(name)) as { id: string; payload: Record<string, unknown> };
  const message = JSON.parse(sent) as { id: string; payload: Record<string, unknown> };
  message.id = fixture.id;
  if ('session_id' in message.payload) message.payload.session_id = fixture.payload.session_id;
  expect(JSON.stringify(message)).toBe(raw(name));
}

async function hello(socket: FakeSocket, auth?: DeviceSession['auth']): Promise<DeviceSession> {
  const session = createSession(auth);
  await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 2 } }), vi.fn());
  return session;
}

const fakeDb: Db = { query: async <T>(): Promise<T[]> => [], tx: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(fakeDb) };

describe('wire fixtures: handleControl sends exactly the fixture bytes', () => {
  beforeAll(() => setSharedDb(Promise.resolve(fakeDb)));
  // Defaults: no conversation pointer, no Space pointer. Cases override.
  beforeEach(() => {
    store.getActive.mockResolvedValue(null);
    store.getActiveSpace.mockResolvedValue(null);
    store.listPendingTimers.mockResolvedValue([]);
  });
  afterEach(() => {
    for (const fn of closeListeners.splice(0)) fn();
    getDeviceSessions().clear();
    resetTimersState();
    vi.resetAllMocks();
  });

  const FAMILY = { spaceId: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', name: 'Family, friends and neighbours' };

  it.each([
    ['welcome', { conversationId: 'cnv_0123456789abcdef', title: 'Planning the spring vegetable garden' }, FAMILY],
    ['welcome_active_null', null, null],
    ['welcome_active_cleared', { conversationId: null, title: null }, { spaceId: null, name: null }],
  ])('%s (paired device)', async (name, active, space) => {
    store.getActive.mockResolvedValue(active === null ? null : { ...active, surface: 'picker', changedAt: 1 });
    store.getActiveSpace.mockResolvedValue(space === null ? null : { ...space, changedAt: 1, cleared: false });
    const socket = makeSocket();
    await hello(socket, deviceAuth);
    expectFixtureBytes(sentOfType(socket, 'welcome'), name);
  });

  it('welcome_space_omitted: a Space store outage drops active_space, the pre-#301 shape', async () => {
    store.getActiveSpace.mockRejectedValue(new Error('store unavailable'));
    const socket = makeSocket();
    await hello(socket, deviceAuth);
    expectFixtureBytes(sentOfType(socket, 'welcome'), 'welcome_space_omitted');
  });

  it('welcome_legacy (legacy shared-secret device)', async () => {
    const socket = makeSocket();
    await hello(socket, { kind: 'legacy', userId: USER_ID, deviceId: null });
    expectFixtureBytes(sentOfType(socket, 'welcome'), 'welcome_legacy');
  });

  it('welcome_absent (no upgrade auth: the pre-pairing server shape)', async () => {
    const socket = makeSocket();
    await hello(socket);
    expectFixtureBytes(sentOfType(socket, 'welcome'), 'welcome_absent');
  });

  it('pairing_required (unpaired device)', async () => {
    const socket = makeSocket();
    await hello(socket, { kind: 'unpaired', reason: 'revoked' });
    expectFixtureBytes(sentOfType(socket, 'pairing_required'), 'pairing_required');
  });

  it.each([
    ['conversations', [
      { id: 'cnv_0123456789abcdef', title: 'Planning the spring vegetable garden' },
      { id: 'cnv_fedcba9876543210', title: 'Groceries' },
      { id: 'cnv_aaaaaaaaaaaaaaaa', title: 'Trip to Lisbon' },
    ]],
    ['conversations_empty', []],
  ])('%s', async (name, rows) => {
    store.getActive.mockResolvedValue(null);
    // Extra store columns must not leak onto the wire.
    store.listConversations.mockResolvedValue(rows.map((row) => ({ ...row, updatedAt: 1, archived: false })));
    const socket = makeSocket();
    const session = await hello(socket, deviceAuth);
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('list_conversations'), vi.fn());
    expectFixtureBytes(sentOfType(socket, 'conversations'), name);
  });

  it('conversation_selected, and the active_conversation push it triggers', async () => {
    store.getActive.mockResolvedValue(null);
    store.getConversation.mockResolvedValue({ id: 'cnv_fedcba9876543210', title: 'Groceries', messages: [] });
    store.setActive.mockResolvedValue(1790000000000);
    const socket = makeSocket();
    const session = await hello(socket, deviceAuth);
    await handleControl(appDeps, socket as unknown as WebSocket, session,
      control('select_conversation', { payload: { conversation_id: 'cnv_fedcba9876543210' } }), vi.fn());
    expectFixtureBytes(sentOfType(socket, 'conversation_selected'), 'conversation_selected');
    expectFixtureBytes(sentOfType(socket, 'active_conversation'), 'active_conversation');
  });

  it('conversation_cleared, and the null active_conversation push', async () => {
    store.getActive.mockResolvedValue(null);
    store.setActive.mockResolvedValue(1790000000000);
    const socket = makeSocket();
    const session = await hello(socket, deviceAuth);
    await handleControl(appDeps, socket as unknown as WebSocket, session,
      control('new_conversation', { payload: { request_id: 'ncreq_123456_v2' } }), vi.fn());
    expectFixtureBytes(sentOfType(socket, 'conversation_cleared'), 'conversation_cleared');
    expectFixtureBytes(sentOfType(socket, 'active_conversation'), 'active_conversation_null');
  });

  it('error (no turn): a second hello', async () => {
    const socket = makeSocket();
    const session = await hello(socket);
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 2 } }), vi.fn());
    expectFixtureBytes(sentOfType(socket, 'error'), 'error');
  });

  it('error_turn: an uplink sequence gap mid-turn carries the turn_ref', async () => {
    const socket = makeSocket();
    const session = await hello(socket);
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_0001_abcd' }), vi.fn());
    const frame = Buffer.alloc(AUDIO_HEADER_BYTES + 320);
    frame.write('OLX2', 0, 'ascii');
    frame.writeUInt8(1, 4); frame.writeUInt8(1, 5); frame.writeUInt8(1, 6); frame.writeUInt8(1, 7);
    frame.writeUInt32BE(1, 8); frame.writeUInt32BE(5, 12); frame.writeUInt32BE(320, 16);
    handleBinary(appDeps, socket as unknown as WebSocket, session, frame);
    expectFixtureBytes(sentOfType(socket, 'error'), 'error_turn');
  });

  // The firmware batches 4-8 10 ms frames into one audio_up with one sequence
  // per message; test_olx2.cpp packs these exact bytes with packUplinkBatch.
  it('olx2_audio_up_batch: batched audio_up messages with consecutive seq, then turn_end at messages - 1', async () => {
    const { turnEndSeq, messages } = JSON.parse(readFileSync(resolve(FIXTURES, 'frames/olx2_audio_up_batch.json'), 'utf8')) as {
      turnEndSeq: number; messages: { sequence: number; frames: number; payloadBytes: number; hex: string }[];
    };
    const socket = makeSocket();
    const session = await hello(socket);
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_0001_abcd' }), vi.fn());
    messages.forEach((message, index) => {
      const bytes = Buffer.from(message.hex, 'hex');
      const decoded = parseAudioUp(bytes, session);
      expect(decoded).toMatchObject({ ok: true, value: { header: { kind: 'audio_up', formatId: 1, channels: 1, sequence: index, payloadBytes: message.frames * 320 } } });
      handleBinary(appDeps, socket as unknown as WebSocket, session, bytes);
    });
    expect(sentText(socket).filter((text) => (JSON.parse(text) as { type: string }).type === 'error')).toEqual([]);
    expect(turnEndSeq).toBe(messages.length - 1);
    // A frame count, not the last message's sequence, is a gap.
    const frames = messages.reduce((sum, message) => sum + message.frames, 0);
    const onTurnEnd = vi.fn();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_end', { turn_ref: 'turn_0001_abcd', seq: frames - 1 }), onTurnEnd);
    expect(JSON.parse(sentOfType(socket, 'error'))).toMatchObject({ payload: { code: 'SEQUENCE_GAP' } });
    expect(session.stage).toBe('capturing');
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_end', { turn_ref: 'turn_0001_abcd', seq: turnEndSeq }), onTurnEnd);
    expect(session.stage).toBe('responding');
    expect(onTurnEnd).toHaveBeenCalledOnce();
    expect(session.totalAudioBytes).toBe(frames * 320);
    expect(session.totalAudioBytes).toBe(messages.reduce((sum, message) => sum + message.payloadBytes, 0));
  });

  // #301: the Space picker. The device sends list_spaces / select_space
  // (fixtures shared with test_builders.cpp) and parses these replies.

  it.each([
    ['spaces', [
      { id: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', name: 'Family, friends and neighbours' },
      { id: '6b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e', name: 'Work' },
      { id: '7c3d4e5f-6a7b-4c8d-ae9f-1a2b3c4d5e6f', name: 'Book club' },
    ]],
    ['spaces_empty', []],
  ])('%s (a list_spaces reply)', async (name, rows) => {
    // Extra store columns must not leak onto the wire.
    store.listSpaces.mockResolvedValue(rows.map((row) => ({ ...row, role: 'owner', archivedAt: null })));
    const socket = makeSocket();
    const session = await hello(socket, deviceAuth);
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('list_spaces'), vi.fn());
    expectFixtureBytes(sentOfType(socket, 'spaces'), name);
  });

  it.each([
    ['space_selected', 'active_space', 'select_space'],
    ['space_selected_none', 'active_space_null', 'select_space_none'],
  ])('%s, and the %s push it triggers', async (ack, push, request) => {
    store.setActiveSpace.mockResolvedValue({ changedAt: 1790000000000, name: 'Work' });
    const socket = makeSocket();
    const session = await hello(socket, deviceAuth);
    // Replay the device's own bytes (the builder fixture), as the server would parse them.
    await handleControl(appDeps, socket as unknown as WebSocket, session,
      ClientControlDtoSchema.parse(JSON.parse(raw(request))), vi.fn());
    expectFixtureBytes(sentOfType(socket, 'space_selected'), ack);
    expectFixtureBytes(sentOfType(socket, 'active_space'), push);
  });

  it('error_space_not_found: selecting a Space the account cannot use', async () => {
    store.setActiveSpace.mockRejectedValue(new StoreNotFoundError('space not found'));
    const socket = makeSocket();
    const session = await hello(socket, deviceAuth);
    await handleControl(appDeps, socket as unknown as WebSocket, session,
      ClientControlDtoSchema.parse(JSON.parse(raw('select_space'))), vi.fn());
    expectFixtureBytes(sentOfType(socket, 'error'), 'error_space_not_found');
    expect(sentText(socket).some((text) => text.includes('"active_space"') && !text.includes('"welcome"'))).toBe(false);
  });

  // Epic #311. The firmware reads these by key order and by envelope vs
  // payload (reply_text's turn_ref is on the envelope), so the bytes come from
  // the real registry sends and builders, not from hand-written JSON.

  it.each([
    ['device_control_volume', { volume: 3 }],
    ['device_control_mode_dnd', { dnd: false, mode: 'wake' as const }],
    ['device_control_all', {
      ring_sound: 'pulse' as const, ring_seconds: 120, dnd: true, mode: 'announce_only' as const, muted: true, volume: 10,
    }],
    ['device_control_ring', { ring_sound: 'chime' as const, ring_seconds: 60 }],
  ])('%s (sendDeviceControl to a welcomed device)', async (name, patch) => {
    const socket = makeSocket();
    await hello(socket, deviceAuth);
    expect(getDeviceSessions().sendDeviceControl(USER_ID, DEVICE_ID, patch)).toBe(1);
    expectFixtureBytes(sentOfType(socket, 'device_control'), name);
  });

  // The wake word (cap 'wake_word'). The bytes are pinned here until the
  // firmware adds its own fixture beside device_control_all: wake_word is the
  // last key, after ring_sound, and only a hello with the cap gets it.
  it('device_control with wake_word goes last, only to a hello with cap wake_word', async () => {
    const all = {
      wake_word: 'bob' as const, ring_sound: 'pulse' as const, ring_seconds: 120, dnd: true, mode: 'announce_only' as const, muted: true, volume: 10,
    };
    const capable = makeSocket();
    await handleControl(appDeps, capable as unknown as WebSocket, createSession(deviceAuth), control('hello', {
      payload: { format_id: 2, caps: ['device_control', 'wake_word'] },
    }), vi.fn());
    expect(getDeviceSessions().sendDeviceControl(USER_ID, DEVICE_ID, all)).toBe(1);
    const sent = JSON.parse(sentOfType(capable, 'device_control')) as { id: string };
    sent.id = 'dctl_0123456789abcdef0123';
    expect(JSON.stringify(sent)).toBe(
      '{"v":1,"type":"device_control","id":"dctl_0123456789abcdef0123","payload":{"volume":10,"muted":true,"mode":"announce_only",'
      + '"dnd":true,"ring_seconds":120,"ring_sound":"pulse","wake_word":"bob"}}',
    );
    getDeviceSessions().clear();
    const old = makeSocket();
    await hello(old, deviceAuth);
    expect(getDeviceSessions().sendDeviceControl(USER_ID, DEVICE_ID, all)).toBe(1);
    expectFixtureBytes(sentOfType(old, 'device_control'), 'device_control_all');
    expect(getDeviceSessions().sendDeviceControl(USER_ID, DEVICE_ID, { wake_word: 'bob' })).toBe(0);
  });

  it.each([
    ['announce_ring', {
      expires_at: 4102444800000, ring: true, body: '', title: 'Pasta', kind: 'timer' as const, announce_id: 'tm_0123456789abcdef',
    }],
    ['announce_notice', {
      expires_at: 4102444800000, ring: false, body: 'Collection is "early" tomorrow', title: 'Take the bins out',
      kind: 'reminder' as const, announce_id: 'rm_0123456789abcdef_1790000000000',
    }],
  ])('%s (announce to a welcomed device, fields given out of order)', async (name, announcement) => {
    const socket = makeSocket();
    await hello(socket, deviceAuth);
    expect(getDeviceSessions().announce(USER_ID, announcement)).toBe('queued');
    expectFixtureBytes(sentOfType(socket, 'announce'), name);
  });

  // #457: sent after welcome; the firmware reads the entries by key order.
  const pendingRow = (id: string, kind: 'timer' | 'alarm', label: string | null, remainingMs: number): object => ({
    id, userId: USER_ID, kind, label, firesAt: 1790000000000 + remainingMs, durationMs: null,
    status: 'pending', createdAt: 1790000000000, firedAt: null, remainingMs,
  });

  const pendingRows = [
    pendingRow('4a3c9d2f-8b5e-4f0c-ad2b-3c4d5e6f7081', 'alarm', null, 30_600_000),
    pendingRow('3f2b8c1e-7a4d-4e9b-9c1a-2b3c4d5e6f70', 'timer', 'Pasta', 272_000),
    pendingRow('5b4dae30-9c6f-4a1d-be3c-4d5e6f708192', 'timer', 'Laundry "whites"', 5_400_000),
  ];

  it('timers_state (sent after welcome to a paired device, rows given out of order)', async () => {
    store.listPendingTimers.mockResolvedValue(pendingRows);
    const socket = makeSocket();
    await hello(socket, deviceAuth);
    expectFixtureBytes(sentOfType(socket, 'timers_state'), 'timers_state');
  });

  it('timers_state_empty (pushed when the last timer goes; never sent on welcome)', async () => {
    store.listPendingTimers.mockResolvedValue(pendingRows);
    const socket = makeSocket();
    await hello(socket, deviceAuth);
    socket.send.mockClear();
    store.listPendingTimers.mockResolvedValue([]);
    await pushTimersState(timersDeps);
    expectFixtureBytes(sentOfType(socket, 'timers_state'), 'timers_state_empty');
    const quiet = makeSocket();
    await hello(quiet, { ...deviceAuth, deviceId: '44444444-4444-4444-8444-444444444444' });
    expect(sentText(quiet).some((text) => text.includes('"timers_state"'))).toBe(false);
  });

  it.each([
    ['reply_text', 'What is on "today"?', 'Two things — the dentist at 3 and book club at 7.'],
    ['reply_text_empty', '', ''],
  ])('%s (replyTextDto, turn_ref on the envelope)', (name, heard, reply) => {
    expectFixtureBytes(JSON.stringify(replyTextDto('turn_0001_abcd', heard, reply)), name);
  });

  it('end_of_turn (endOfTurnDto, turn_ref on the envelope)', () => {
    expectFixtureBytes(JSON.stringify(endOfTurnDto('turn_0001_abcd')), 'end_of_turn');
  });

  it.each(['device_state', 'device_state_unknown_battery', 'announce_ack', 'announce_ack_missed'])(
    '%s (the firmware builder bytes) is handled without an error', async (name) => {
      const socket = makeSocket();
      const session = await hello(socket, deviceAuth);
      await handleControl(appDeps, socket as unknown as WebSocket, session, ClientControlDtoSchema.parse(JSON.parse(raw(name))), vi.fn());
      expect(sentText(socket).filter((text) => text.includes('"type":"error"'))).toEqual([]);
    },
  );

  // #345: firmware version and the minimum. The firmware parses update_required
  // by key order and ignores welcome's min_fw_version.
  describe('the minimum firmware version', () => {
    afterEach(() => { vi.unstubAllEnvs(); });

    const helloWith = async (socket: FakeSocket, payload: object): Promise<DeviceSession> => {
      const session = createSession();
      await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload }), vi.fn());
      return session;
    };

    it('welcome_min_fw then update_required: a device below BOB_MIN_FW_VERSION', async () => {
      vi.stubEnv('BOB_MIN_FW_VERSION', '0.2.0');
      const socket = makeSocket();
      await helloWith(socket, { format_id: 2, fw_version: '0.1.9', caps: ['reply_text'] });
      expectFixtureBytes(sentOfType(socket, 'welcome'), 'welcome_min_fw');
      expectFixtureBytes(sentOfType(socket, 'update_required'), 'update_required');
      expect(sentText(socket).map((text) => (JSON.parse(text) as { type: string }).type)).toEqual(['welcome', 'update_required']);
    });

    it('update_required_unknown: a reported fw_version that is not SemVer while a minimum is set', async () => {
      vi.stubEnv('BOB_MIN_FW_VERSION', '0.2.0');
      const socket = makeSocket();
      const session = createSession();
      const dto = ClientControlDtoSchema.parse({ ...JSON.parse(raw('hello')), payload: { format_id: 2, fw_version: '1.2' } });
      await handleControl(appDeps, socket as unknown as WebSocket, session, dto, vi.fn());
      expectFixtureBytes(sentOfType(socket, 'update_required'), 'update_required_unknown');
      expect(sentText(socket).map((text) => (JSON.parse(text) as { type: string }).type)).toEqual(['welcome', 'update_required']);
    });

    it('the old hello (no fw_version) while a minimum is set: welcome only, never gated (HELLO-COMPAT)', async () => {
      vi.stubEnv('BOB_MIN_FW_VERSION', '0.2.0');
      const socket = makeSocket();
      const session = createSession();
      await handleControl(appDeps, socket as unknown as WebSocket, session, ClientControlDtoSchema.parse(JSON.parse(raw('hello'))), vi.fn());
      expect(sentText(socket).map((text) => (JSON.parse(text) as { type: string }).type)).toEqual(['welcome']);
      expect(session.updateRequired).toBeUndefined();
    });

    it('error_update_required: a turn after update_required is refused, not started', async () => {
      vi.stubEnv('BOB_MIN_FW_VERSION', '0.2.0');
      const socket = makeSocket();
      const session = await helloWith(socket, { format_id: 2, fw_version: '0.1.9' });
      const onTurnEnd = vi.fn();
      await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_0001_abcd' }), onTurnEnd);
      expectFixtureBytes(sentOfType(socket, 'error'), 'error_update_required');
      expect(session.stage).toBe('ready');
      expect(onTurnEnd).not.toHaveBeenCalled();
    });

    it('hello_versioned negotiates device diagnostics, the turn conversation, the assistant name and turn timing', async () => {
      const socket = makeSocket();
      const session = createSession();
      await handleControl(appDeps, socket as unknown as WebSocket, session,
        ClientControlDtoSchema.parse(JSON.parse(raw('hello_versioned'))), vi.fn());
      expectFixtureBytes(sentOfType(socket, 'welcome'), 'welcome_turn_conversation');
      expect(session.fwVersion).toBe('0.0.0-dev');
      expect(sentText(socket)).toHaveLength(1);
    });

    it('a firmware without turn_conversation gets only the assistant name ack', async () => {
      const socket = makeSocket();
      await helloWith(socket, { format_id: 2, caps: ['device_log', 'assistant_name'] });
      expectFixtureBytes(sentOfType(socket, 'welcome'), 'welcome_assistant_name');
    });

    it('a firmware advertising turn_timing gets the ack after the earlier keys (#1004)', async () => {
      const socket = makeSocket();
      await helloWith(socket, { format_id: 2, caps: ['device_log', 'assistant_name', 'turn_timing'] });
      expectFixtureBytes(sentOfType(socket, 'welcome'), 'welcome_turn_timing');
    });

    it('a diagnostics-only hello keeps the old welcome bytes', async () => {
      const socket = makeSocket();
      await helloWith(socket, { format_id: 2, caps: ['device_log'] });
      expectFixtureBytes(sentOfType(socket, 'welcome'), 'welcome_device_log');
    });
  });
});
