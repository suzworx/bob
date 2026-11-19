// #565 U3: a Cardputer voice turn whose pointer names a space thread
// (`thr_<uuid>`) runs SHARED and is saved in that thread. Mirrors
// turn-space.test.ts: store-backed real Postgres, stubbed audio; the agent is the
// real-SDK harness (TG-AGENT-HARNESS), one per createBobAgent call, as
// paired-turn-invariants.test.ts wires it.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool, ToolLoopAgent } from 'ai';
import type { WebSocket } from 'ws';
import { closeDb, setSharedDb, withUser, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace, revokeMember } from '../../src/spaces/store.ts';
import { setActiveSpace } from '../../src/spaces/active.ts';
import { createThread, listMessages, postMessage } from '../../src/conversations/thread-store.ts';
import { listTasks } from '../../src/tasks/store.ts';
import { threadRef } from '../../src/devices/conversation-ref.ts';
import type { AccountEvent } from '../../src/account/events-bus.ts';
import type { MemoryExtractionWorker } from '../../src/memory/extract.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { createAgentHarness, type AgentHarness } from '../support/agent-harness.ts';
import { type CreateBobAgentOptions } from '@bob/ai/testing';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';

const slot = vi.hoisted(() => ({ build: null as null | ((opts: CreateBobAgentOptions) => ToolLoopAgent) }));

vi.mock('../../src/voice/audio/stt-tts.ts', () => ({
  assemblePcm16: (chunks: Buffer[]): Buffer => Buffer.concat(chunks),
  isEmptyTurn: vi.fn(() => false),
  isTooShortTurn: () => false,
  transcribePcm: vi.fn(async () => ({ text: 'add milk', model: 'stt-1', seconds: 1 })),
  synthesizePcm: vi.fn(async () => ({ pcm: Buffer.alloc(3200), sourceRateHz: 44100 })),
  synthesizeMp3: vi.fn(async () => ({ mp3: Buffer.alloc(1024) })),
  downlinkFrames: vi.fn(() => [Buffer.alloc(340)]),
  downlinkMp3Frames: vi.fn(() => []),
}));
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((async (importOriginal) => {
  const { createAgentHarness } = await import('../support/agent-harness.ts');
  // The shared singleton only runs on an unpaired or degraded turn: here it fails loudly.
  const singleton = createAgentHarness([[{ type: 'error', message: 'the singleton agent ran: the device thread turn degraded' }]]).agent;
  return {
    bobAgent: singleton,
    BOB_SYSTEM_TEST_MODE: false,
    AI_STUB_MODE: false,
    isProviderError: () => false,
    providerErrorStatus: () => undefined,
    debugLog: vi.fn(),
    isFrameDebugEnabled: () => false,
  };
} ) as Factory),
    ((async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bob/ai')>();
  const { bobAgent: singleton } = await importOriginal<typeof import('@bob/ai')>();
  return {
    ...actual,
    bobAgent: singleton,
    assistantAgent: singleton,
    createBobAgent: vi.fn((opts: CreateBobAgentOptions): ToolLoopAgent => {
      if (slot.build === null) throw new Error('turn-thread test: no agent builder');
      return slot.build(opts);
    }),
  };
} ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});
vi.mock('../../src/memory/available.ts', () => ({
  memoryAvailable: vi.fn(async () => true),
  resetMemoryAvailability: vi.fn(),
}));
vi.mock('../../src/memory/retrieval.ts', () => ({
  startMemoryRetrieval: vi.fn(() => ({ result: Promise.resolve({ block: null }) })),
}));

import { createBobAgent } from '@bob/ai';
import { startMemoryRetrieval } from '../../src/memory/retrieval.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
/** One harness (and a spy on its real `generate`) per createBobAgent call,
 *  so a test can read the last turn's model input without a hand-written double. */
function spyOnGenerate(agent: ToolLoopAgent) {
  return vi.spyOn(agent, 'generate');
}
const harnesses: AgentHarness[] = [];
const generateSpies: Array<ReturnType<typeof spyOnGenerate>> = [];

function buildTurnAgent(opts: CreateBobAgentOptions): ToolLoopAgent {
  const tools = { ...opts.capabilityTools, ...opts.memoryTools, ...opts.lateTools };
  const harness = createAgentHarness([[{ type: 'text', text: 'Added milk.' }]], { tools });
  harnesses.push(harness);
  generateSpies.push(spyOnGenerate(harness.agent));
  return harness.agent;
}
slot.build = buildTurnAgent;

let pg: TestDb;
let db: Db;
const journals: string[] = [];
const enqueue = vi.fn();
const worker = { enqueue } as unknown as MemoryExtractionWorker;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
});
afterAll(async () => {
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});
beforeEach(() => {
  journals.length = 0;
  harnesses.length = 0;
  generateSpies.length = 0;
  setJournalSink((line) => journals.push(line));
});
afterEach(() => {
  setJournalSink(null);
  vi.clearAllMocks();
});

/** Runs one device turn pinned to `ref` and returns its session. */
async function turn(userId: string, ref: string | undefined): Promise<DeviceSession> {
  const session = createSession() as DeviceSession;
  session.stage = 'responding';
  session.turnRef = 'turn_thread1';
  session.auth = { kind: 'device', userId, deviceId: randomUUID(), name: 'Test Card' };
  session.audioChunks = [Buffer.alloc(320)];
  session.activeConversationId = ref;
  await runTurn(appDeps.turn, { readyState: 1, send: vi.fn() } as unknown as WebSocket, session, 'turn_thread1', worker);
  return session;
}

/** A group space with a member and a revoked member, and one thread in it. */
async function room(): Promise<{ owner: string; member: string; gone: string; spaceId: string; threadId: string }> {
  const [owner, member, gone] = [(await addAccount(pg)).userId, (await addAccount(pg)).userId, (await addAccount(pg)).userId];
  const spaceId = (await createSpace(db, owner, { kind: 'group', name: 'Family' })).id;
  await addMember(db, owner, spaceId, member, 'member');
  await addMember(db, owner, spaceId, gone, 'member');
  await revokeMember(db, owner, spaceId, gone);
  const threadId = (await createThread(db, owner, { spaceId, title: 'Groceries' })).id;
  return { owner, member, gone, spaceId, threadId };
}

describe('a Cardputer turn in a space thread', () => {
  it('saves the account message then the reply, on the thread history, with no memory', async () => {
    const r = await room();
    await postMessage(db, r.member, { threadId: r.threadId, body: 'we need eggs', clientMessageId: randomUUID() });
    await turn(r.owner, threadRef(r.threadId));
    const { messages } = await listMessages(db, r.owner, r.threadId, { limit: 50 });
    expect(messages.map((m) => [m.authorUserId, m.body]))
      .toEqual([[r.member, 'we need eggs'], [r.owner, 'add milk'], [null, 'Added milk.']]);
    const input = generateSpies.at(-1)!.mock.calls.at(-1)![0] as { messages: { content: string }[] };
    expect(input.messages.map((m) => m.content)).toEqual(['we need eggs', 'add milk']);
    const opts = vi.mocked(createBobAgent).mock.calls.at(-1)![0]!;
    expect(opts.memoryTools).toBeUndefined();
    expect(startMemoryRetrieval).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    const invocation = await withUser(db, r.owner, (tx) => tx.query<{ state: string }>(
      `SELECT state FROM bob.ai_invocations WHERE trigger_message_id = $1`, [messages[1]!.id]));
    expect(invocation.map((row) => row.state)).toEqual(['completed']);
  });

  it("binds the tools to the thread's space, not the active Space", async () => {
    const r = await room();
    const other = (await createSpace(db, r.owner, { kind: 'group', name: 'Work' })).id;
    await withUser(db, r.owner, (tx) => setActiveSpace(tx, r.owner, other, 'device'));
    await turn(r.owner, threadRef(r.threadId));
    const tool = (vi.mocked(createBobAgent).mock.calls.at(-1)![0]!.capabilityTools as Record<string, Tool>).create_task!;
    await tool.execute!({ title: 'milk' }, { toolCallId: 'c1', messages: [], context: {} });
    expect((await listTasks(db, r.owner, r.spaceId, {})).map((t) => t.title)).toEqual(['milk']);
    expect(await listTasks(db, r.owner, other, {})).toEqual([]);
  });

  it('publishes thread.message_appended to every active member, and journals no text', async () => {
    const r = await room();
    const seen = new Map<string, AccountEvent[]>([[r.owner, []], [r.member, []], [r.gone, []]]);
    const stops = [...seen.keys()].map((user) => getAccountEvents().subscribe(user, (e) => seen.get(user)!.push(e)));
    await turn(r.owner, threadRef(r.threadId));
    stops.forEach((stop) => stop());
    expect(seen.get(r.owner)!.filter((e) => e.type === 'thread.message_appended')).toHaveLength(2);
    expect(seen.get(r.member)!.filter((e) => e.type === 'thread.message_appended')).toHaveLength(2);
    expect(seen.get(r.gone)).toEqual([]);
    expect(journals.some((line) => line.includes('"v2.device_thread_saved"'))).toBe(true);
    expect(journals.join('\n')).not.toMatch(/add milk|Added milk|eggs/);
  });

  it('a retried turn is one message', async () => {
    const r = await room();
    const session = await turn(r.owner, threadRef(r.threadId));
    await runTurn(appDeps.turn, { readyState: 1, send: vi.fn() } as unknown as WebSocket,
      Object.assign(session, { stage: 'responding', audioChunks: [Buffer.alloc(320)] }), 'turn_thread1', worker);
    expect((await listMessages(db, r.owner, r.threadId, { limit: 50 })).messages).toHaveLength(2);
  });

  it('a lost thread falls back to a new General conversation and publishes active.changed', async () => {
    const r = await room();
    const seen: AccountEvent[] = [];
    const stop = getAccountEvents().subscribe(r.gone, (e) => seen.push(e));
    const session = await turn(r.gone, threadRef(r.threadId));
    stop();
    expect(session.activeConversationId).toMatch(/^cnv_/);
    expect(seen.find((e) => e.type === 'active.changed')).toMatchObject({ conversation_id: session.activeConversationId });
    expect(journals.some((line) => line.includes('"v2.device_thread_lost"'))).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
