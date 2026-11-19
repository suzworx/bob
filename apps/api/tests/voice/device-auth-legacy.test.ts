/**
 * Legacy shared-secret device auth (T036, specs/008-supabase-auth-pairing,
 * contracts/cardputer-pairing-protocol.md). Covers P-21, P-22 (corrected) and
 * the startup gate for BOB_LEGACY_DEVICE_OWNER through the real guard and
 * validateAuthConfig, over one shared test database (createTestDb).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';


// S14-PG-AGENT-MOCK (as in turn.test.ts): on a pgvector store a device turn
// with an account builds a PER-TURN agent via createBobAgent, imported by
// this relative path -- a different module id than '@bob/ai' -- so without
// this mock P-21's turn reaches the live AI Gateway instead of the stub above.
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((() => ({
  audioFormatSchema: z.enum(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac']),
  bobAgent: { generate: vi.fn() },
  BOB_SYSTEM_TEST_MODE: false,
  AI_STUB_MODE: false,
  isProviderError: (error: unknown) =>
    error instanceof Error && (/fetch failed|timeout/i.test(error.message) || /^Gateway/.test(error.name)),
  providerErrorStatus: () => undefined,
  debugLog: vi.fn(),
  isFrameDebugEnabled: () => false,
}) ) as Factory),
    ((async (importOriginal) => {
  const { bobAgent: mockAgent } = await importOriginal<typeof import('@bob/ai')>();
  return {
    createBobAgent: vi.fn(() => mockAgent),
    bobAgent: mockAgent,
    assistantAgent: mockAgent,
    chatModel: {},
    gateway: Object.assign(vi.fn(() => ({})), { embeddingModel: vi.fn(() => ({})) }),
    logAgentConfig: vi.fn(),
  };
} ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

vi.mock('../../src/voice/audio/stt-tts.ts', () => ({
  assemblePcm16: (chunks: Buffer[]): Buffer => Buffer.concat(chunks),
  isEmptyTurn: vi.fn(),
  isTooShortTurn: vi.fn(),
  transcribePcm: vi.fn(),
  synthesizePcm: vi.fn(),
  synthesizeMp3: vi.fn(),
  downlinkFrames: vi.fn(),
  downlinkMp3Frames: vi.fn(),
}));

import {
  createDeviceAuthGuard,
  resetUnpairedSockets,
  type DeviceAuth,
} from '../../src/devices/device-auth.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { handleControl } from '../../src/voice/session.ts';
import { V2_VERSION, type ClientControlDto } from '../../src/voice/protocol.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { listConversations } from '../../src/conversations/store.ts';
import { getActive } from '../../src/conversations/active.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import { transcribePcm, synthesizePcm, downlinkFrames, isEmptyTurn } from '../../src/voice/audio/stt-tts.ts';
import { bobAgent } from '@bob/ai';
import { validateAuthConfig } from '../../src/account/auth.ts';
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
interface FakeSocket {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  _socket: { remoteAddress: string };
}

function makeSocket(ip = '203.0.113.1', readyState = 1): FakeSocket {
  return { readyState, send: vi.fn(), close: vi.fn(), once: vi.fn(), _socket: { remoteAddress: ip } };
}

interface GuardRequest {
  get: (name: string) => string | undefined;
  socket: { remoteAddress: string; once: (event: string, handler: () => void) => void };
  deviceAuth?: DeviceAuth;
}

function guardRequest(auth: string | undefined, ip: string, closeHandlers: Array<() => void>): GuardRequest {
  return {
    get: (name: string) => (name.toLowerCase() === 'authorization' ? auth : undefined),
    socket: {
      remoteAddress: ip,
      once: (event: string, handler: () => void): void => {
        if (event === 'close') closeHandlers.push(handler);
      },
    },
    deviceAuth: undefined,
  };
}

function wsResponse() {
  let rejected: { code?: number; message?: string } | null = null;
  return {
    reject(code?: number, message?: string) { rejected = { code, message }; },
    rejected: () => rejected,
  } as never;
}

function control(type: string, extra: Record<string, unknown> = {}): ClientControlDto {
  return { v: V2_VERSION, type, id: 'test_ctrl_000001', payload: {}, ...extra } as unknown as ClientControlDto;
}

function lastSent(socket: FakeSocket): unknown {
  const calls = socket.send.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return JSON.parse(calls[calls.length - 1]![0] as string);
}

let pg: TestDb;
let db: Db;
let account: TestAccount;

const LEGACY_SECRET = 'legacy-shared-secret';

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  account = await addAccount(pg);
  setSharedDb(Promise.resolve(db));
});

afterEach(() => {
  resetUnpairedSockets();
  setJournalSink(null);
  delete process.env.BOB_LEGACY_DEVICE_OWNER;
  delete process.env.DEVICE_SHARED_SECRET;
});

afterAll(async () => {
  setJournalSink(null);
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

describe('legacy shared-secret device (T036)', () => {
  it('P-21: with the owner set, the matching secret authenticates as the owner with device:null', async () => {
    const other = await addAccount(pg, {});
    process.env.BOB_LEGACY_DEVICE_OWNER = account.userId;
    const closeHandlers: Array<() => void> = [];
    const request = guardRequest(`Bearer ${LEGACY_SECRET}`, '203.0.113.1', closeHandlers);
    const next = vi.fn();
    await createDeviceAuthGuard(LEGACY_SECRET, appDeps.getDb)(request as never, wsResponse(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(request.deviceAuth).toEqual({ kind: 'legacy', userId: account.userId, deviceId: null });

    const socket = makeSocket();
    const session = createSession(request.deviceAuth);
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    const welcome = lastSent(socket) as { type: string; payload: Record<string, unknown> };
    expect(welcome.type).toBe('welcome');
    expect(welcome.payload.device).toBeNull();

    // A legacy device turn with no pointer yet creates a conversation titled
    // deriveTitle(transcript) and sets the account's pointer (surface device).
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    vi.mocked(transcribePcm).mockResolvedValue({ text: 'legacy device turn', model: 'stt-1', seconds: 1 });
    vi.mocked(bobAgent.generate).mockResolvedValue({
      text: 'legacy reply', toolCalls: [], modelId: 'model-x',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never);
    vi.mocked(synthesizePcm).mockResolvedValue({ pcm: Buffer.alloc(320), sourceRateHz: 44100 });
    vi.mocked(downlinkFrames).mockReturnValue([Buffer.alloc(340)]);
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_test_000001' }), vi.fn());
    session.audioChunks = [Buffer.alloc(320)];
    // Await the turn itself rather than polling for its side effect. The turn
    // does several round trips on the real Postgres store (memory probe and
    // retrieval, history, the persist transaction): ~200 ms alone, but over
    // vi.waitFor's 1 s default under a full parallel suite, which failed P-21
    // with "expected undefined to be defined" while the turn was still running.
    let turn: Promise<void> | undefined;
    await handleControl(appDeps, 
      socket as unknown as WebSocket,
      session,
      control('turn_end', { turn_ref: 'turn_test_000001', seq: 0 }),
      (turnSession, turnRef) => {
        turn = runTurn(appDeps.turn, socket as unknown as WebSocket, turnSession, turnRef);
      },
    );
    expect(turn, 'turn_end must dispatch the turn').toBeDefined();
    await turn;
    expect(session.activeConversationId).toBeDefined();

    // Turns scope to the owner account: the created conversation is the
    // owner's, the pointer points at it with surface 'device', and a second,
    // unrelated account sees neither the conversation nor a pointer.
    const ownerConversations = await listConversations(db, account.userId);
    expect(ownerConversations.some((conversation) => conversation.id === session.activeConversationId)).toBe(true);
    const active = await getActive(db, account.userId);
    expect(active?.conversationId).toBe(session.activeConversationId);
    expect(active?.surface).toBe('device');
    expect(await listConversations(db, other.userId)).toEqual([]);
    expect(await getActive(db, other.userId)).toBeNull();
    closeHandlers.forEach((handler) => handler());
  });

  it('P-22: with the owner unset, the shared secret is refused 401 invalid_token', async () => {
    const closeHandlers: Array<() => void> = [];
    const request = guardRequest(`Bearer ${LEGACY_SECRET}`, '203.0.113.2', closeHandlers);
    const res = wsResponse();
    await createDeviceAuthGuard(LEGACY_SECRET, appDeps.getDb)(request as never, res, vi.fn());
    expect((res as unknown as { rejected: () => { code?: number; message?: string } | null }).rejected()).toMatchObject({
      code: 401,
      message: 'invalid_token',
    });
    expect(request.deviceAuth).toBeUndefined();
  });

  it('P-22: with the owner unset, no header is still accepted as unpaired none', async () => {
    const closeHandlers: Array<() => void> = [];
    const request = guardRequest(undefined, '203.0.113.3', closeHandlers);
    const next = vi.fn();
    await createDeviceAuthGuard(LEGACY_SECRET, appDeps.getDb)(request as never, wsResponse(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(request.deviceAuth).toEqual({ kind: 'unpaired', reason: 'none' });

    const socket = makeSocket();
    const session = createSession(request.deviceAuth);
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: 1 } }), vi.fn());
    expect(lastSent(socket)).toMatchObject({ type: 'pairing_required', payload: { reason: 'none' } });
    closeHandlers.forEach((handler) => handler());
  });

  it('an olxd_ token always takes the pairing path even with legacy configured', async () => {
    process.env.BOB_LEGACY_DEVICE_OWNER = account.userId;
    const closeHandlers: Array<() => void> = [];
    const request = guardRequest(`Bearer olxd_${randomBytes(32).toString('base64url')}`, '203.0.113.4', closeHandlers);
    const next = vi.fn();
    await createDeviceAuthGuard(LEGACY_SECRET, appDeps.getDb)(request as never, wsResponse(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(request.deviceAuth).toEqual({ kind: 'unpaired', reason: 'unknown' });
    closeHandlers.forEach((handler) => handler());
  });

  it('a wrong secret with legacy configured is refused 401 invalid_token', async () => {
    process.env.BOB_LEGACY_DEVICE_OWNER = account.userId;
    const closeHandlers: Array<() => void> = [];
    const request = guardRequest('Bearer not-the-secret', '203.0.113.5', closeHandlers);
    const res = wsResponse();
    await createDeviceAuthGuard(LEGACY_SECRET, appDeps.getDb)(request as never, res, vi.fn());
    expect((res as unknown as { rejected: () => { code?: number; message?: string } | null }).rejected()).toMatchObject({
      code: 401,
      message: 'invalid_token',
    });
  });
});

describe('legacy owner startup gate', () => {
  const required = {
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
    BOB_DATABASE_URL: 'postgres://x',
  };

  it('refuses a malformed BOB_LEGACY_DEVICE_OWNER whether or not BOB_PRODUCTION is set', () => {
    expect(validateAuthConfig({ BOB_LEGACY_DEVICE_OWNER: 'not-a-uuid' })).toEqual({
      ok: false,
      invalid: 'BOB_LEGACY_DEVICE_OWNER',
    });
    expect(validateAuthConfig({ ...required, BOB_PRODUCTION: '1', BOB_LEGACY_DEVICE_OWNER: 'not-a-uuid' })).toEqual({
      ok: false,
      invalid: 'BOB_LEGACY_DEVICE_OWNER',
    });
    expect(validateAuthConfig({ BOB_LEGACY_DEVICE_OWNER: randomUUID() })).toEqual({ ok: true });
  });

  it('requires DEVICE_SHARED_SECRET only when the owner is set (production)', () => {
    expect(validateAuthConfig({ ...required, BOB_PRODUCTION: '1', BOB_LEGACY_DEVICE_OWNER: randomUUID() })).toEqual({
      ok: false,
      missing: 'DEVICE_SHARED_SECRET',
    });
    expect(
      validateAuthConfig({ ...required, BOB_PRODUCTION: '1', BOB_LEGACY_DEVICE_OWNER: randomUUID(), DEVICE_SHARED_SECRET: 's' }),
    ).toEqual({ ok: true });
    expect(validateAuthConfig({ ...required, BOB_PRODUCTION: '1' })).toEqual({ ok: true });
  });
});