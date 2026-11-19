/**
 * #756 PR4 (consumer half): the device turn and web chat gate personal memory
 * on the conversation's space kind (allowsPersonalMemory). Pair and group: no
 * retrieval, no remember/forget, nothing enqueued; private runs as before and
 * stamps its space on new memories; a lost-shared fallback enqueues nothing.
 * Injected fakes over a real test database: no model, no network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

const state = vi.hoisted(() => ({
  kind: 'private' as 'private' | 'pair' | 'group' | null,
  fellBack: false,
  retrievals: 0,
  callbackDeps: [] as Array<{ spaceId?: string }>,
  agentOpts: [] as Array<Record<string, unknown>>,
  enqueued: 0,
  privateSpaceId: '',
  privateConversationId: '',
}));

vi.mock('../../src/memory/available.ts', () => ({ memoryAvailable: vi.fn(async () => true), resetMemoryAvailability: vi.fn() }));
// A personal-memory read: the web path's per-message search, or the device's memory pack.
vi.mock('../../src/memory/retrieval.ts', () => ({
  startMemoryRetrieval: vi.fn(() => { state.retrievals += 1; return { result: Promise.resolve({ block: null }) }; }),
  startMemoryPack: vi.fn(() => { state.retrievals += 1; return { result: Promise.resolve({ block: null }) }; }),
}));
vi.mock('../../src/memory/callbacks.ts', () => ({
  createMemoryCallbacks: vi.fn((_db: unknown, _userId: string, deps: { spaceId?: string }) => {
    state.callbackDeps.push(deps);
    return { listActions: vi.fn(), completeAction: vi.fn(), remember: vi.fn(), forget: vi.fn() };
  }),
}));
vi.mock('../../src/conversations/scope.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/conversations/scope.ts')>()),
  getConversationScope: vi.fn(async (_db: unknown, _userId: string, ref: string) => (state.kind === null ? null : {
    conversationId: state.kind === 'private' ? state.privateConversationId : ref,
    spaceId: state.kind === 'private' ? state.privateSpaceId : `space_${state.kind}`,
    spaceKind: state.kind, spaceName: 'S', spaceArchived: false, archivedAt: null, title: 't',
  })),
}));
vi.mock('@bob/ai', async (importOriginal) => {
  // TG-AGENT-HARNESS: real-SDK agents on scripted model parts, never a hand-written double.
  const { createAgentHarness, words } = await import('../support/agent-harness.ts');
  return {
    ...(await importOriginal<typeof import('@bob/ai')>()),
    AI_STUB_MODE: false,
    bobAgent: createAgentHarness([[{ type: 'error', message: 'the singleton agent ran: the turn degraded' }]]).agent,
    debugLog: vi.fn(),
    createMemoryTools: vi.fn(() => ({ remember: {}, forget: {} })),
    /** Records the options the turn built, then answers "ok" on a fresh harness agent. */
    createBobAgent: vi.fn((opts: Record<string, unknown>) => {
      state.agentOpts.push(opts);
      return createAgentHarness([words('ok')]).agent;
    }),
  };
});
vi.mock('../../src/voice/audio/stt-tts.ts', () => ({
  assemblePcm16: (chunks: Buffer[]): Buffer => Buffer.concat(chunks),
  isEmptyTurn: vi.fn(() => false),
  isTooShortTurn: () => false,
  transcribePcm: vi.fn(async () => ({ text: 'hello', model: 'stt', seconds: 1 })),
  synthesizePcm: vi.fn(async () => ({ pcm: Buffer.alloc(3200), sourceRateHz: 44100 })),
  synthesizeMp3: vi.fn(async () => ({ mp3: Buffer.alloc(1024) })),
  downlinkFrames: vi.fn(() => [Buffer.alloc(340)]),
  downlinkMp3Frames: vi.fn(() => []),
}));
vi.mock('../../src/voice/cardputer-conversation.ts', () => ({
  loadCardputerHistory: vi.fn(async () => []),
  loadDeviceThreadHistory: vi.fn(async () => []),
  persistDeviceTurn: vi.fn(async () => ({
    conversationId: 'cnv_device_1', created: false, title: 't', userMessageId: 'msg_device_1', changedAt: 1, fellBackFromShared: state.fellBack,
  })),
}));

import { createMemoryTools } from '@bob/ai';
import { webChat } from '../../src/conversations/chat-http.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { ensurePrivateSpace } from '../../src/spaces/store.ts';
import { resolveDevAccount } from '../../src/account/dev-account.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import { createSession } from '../../src/voice/session-handlers.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { createAppDeps } from '../../src/app-deps.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const appDeps = createAppDeps();
const worker = { enqueue: vi.fn(() => { state.enqueued += 1; }), scanUnprocessed: vi.fn(async () => 0), idle: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
const THREAD = 'thr_00000000-0000-4000-8000-000000000001';
let pg: TestDb;
let db: Db;
let userId: string;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  userId = await resolveDevAccount(db);
  state.privateSpaceId = (await ensurePrivateSpace(db, userId)).id;
  state.privateConversationId = (await createConversation(db, userId, 'Private memory')).id;
  setSharedDb(Promise.resolve(db));
  appDeps.memoryWorker = worker;
});
afterAll(async () => {
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});
afterEach(() => {
  Object.assign(state, { kind: 'private', fellBack: false, retrievals: 0, enqueued: 0, callbackDeps: [], agentOpts: [] });
  vi.mocked(createMemoryTools).mockClear();
});

async function deviceTurn(ref: string): Promise<void> {
  const session = createSession({ kind: 'device', userId, deviceId: 'dev', name: 'cardputer' });
  Object.assign(session, { stage: 'responding', turnRef: 'turn_dev', activeConversationId: ref, formatId: 1, audioChunks: [Buffer.alloc(320)] });
  await runTurn(appDeps.turn, { readyState: 1, send: vi.fn() } as unknown as WebSocket, session, 'turn_dev', worker);
}

async function webTurn(): Promise<void> {
  const conversation = await createConversation(db, userId, 'web');
  const res = { status() { return res; }, setHeader() {}, write() {}, end() {}, json() {}, on() { return res; }, writableEnded: false };
  await webChat(appDeps)({ body: { id: conversation.id, message: { id: `msg-web-${conversation.id.slice(-8)}`, role: 'user', parts: [{ type: 'text', text: 'hi' }] } }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never, res as never);
}

const memoryToolsOffered = (): boolean => state.agentOpts.some((opts) => opts.memoryTools !== undefined);

describe.each([['device', () => deviceTurn(THREAD)], ['web', webTurn]] as const)('%s turn', (_surface, run) => {
  it.each(['pair', 'group'] as const)('a %s space reads, offers and enqueues no personal memory', async (kind) => {
    state.kind = kind;
    await run();
    expect(state.retrievals).toBe(0);
    expect(createMemoryTools).not.toHaveBeenCalled();
    expect(memoryToolsOffered()).toBe(false);
    expect(state.enqueued).toBe(0);
  });

  it('a private space runs memory as before and stamps its space on remember', async () => {
    await run();
    expect(state.retrievals).toBe(1);
    expect(memoryToolsOffered()).toBe(true);
    expect(state.callbackDeps[0]?.spaceId).toBe(state.privateSpaceId);
    expect(state.enqueued).toBe(1);
  });
});

it('a lost-shared device fallback enqueues nothing', async () => {
  Object.assign(state, { kind: null, fellBack: true });
  await deviceTurn(THREAD);
  expect(state.retrievals).toBe(0);
  expect(state.enqueued).toBe(0);
});
