// #301 U5: a device turn's task/agenda tools act on the account's active
// Space when it is valid, else on the private space. Mirrors turn.test.ts's
// store-backed setup and its agents.ts mock; memory is flipped on so the
// productivity wiring runs, with retrieval stubbed to an empty block.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from 'ai';
import type { WebSocket } from 'ws';
import { closeDb, setSharedDb, withUser, type Db } from '../../src/platform/db/db.ts';
import { addMember, archiveSpace, createSpace, ensurePrivateSpace, revokeMember } from '../../src/spaces/store.ts';
import { getActiveSpace, setActiveSpace } from '../../src/spaces/active.ts';
import { listTasks } from '../../src/tasks/store.ts';
import { loadCardputerHistory } from '../../src/voice/cardputer-conversation.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { setToolPreference } from '../../src/tools/store.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';

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
    ((() => ({
  bobAgent: { generate: vi.fn(async () => ({ text: 'done', toolCalls: [] })) },
  BOB_SYSTEM_TEST_MODE: false,
  AI_STUB_MODE: false,
  isProviderError: () => false,
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
vi.mock('../../src/memory/available.ts', () => ({
  memoryAvailable: vi.fn(async () => true),
  resetMemoryAvailability: vi.fn(),
}));
vi.mock('../../src/memory/retrieval.ts', () => ({
  startMemoryRetrieval: vi.fn(() => ({ result: Promise.resolve({ block: null }) })),
}));
const activeRead = vi.hoisted(() => ({ fail: false }));
vi.mock('../../src/spaces/active.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/spaces/active.ts')>();
  return {
    ...real,
    getActiveSpace: vi.fn((...args: Parameters<typeof real.getActiveSpace>) =>
      activeRead.fail ? Promise.reject(new Error('store down')) : real.getActiveSpace(...args)),
  };
});

import { createBobAgent } from '@bob/ai';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const SPACE_NAME = 'Zephyr Kitchen';
let pg: TestDb;
let db: Db;
const journals: string[] = [];

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
  setJournalSink((line) => journals.push(line));
});
afterEach(() => {
  setJournalSink(null);
  activeRead.fail = false;
  vi.clearAllMocks();
});

/** Runs one device turn for userId and returns the session it ran on. */
async function turn(userId: string): Promise<DeviceSession> {
  const session = createSession() as DeviceSession;
  session.stage = 'responding';
  session.turnRef = 'turn_space1';
  session.auth = { kind: 'device', userId, deviceId: '11111111-1111-4111-8111-111111111111', name: 'Test Card' };
  session.audioChunks = [Buffer.alloc(320)];
  const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
  await runTurn(appDeps.turn, socket, session, 'turn_space1');
  return session;
}

/** Calls the create_task tool the turn's agent was offered. */
async function createTaskViaAgent(title: string): Promise<void> {
  const opts = vi.mocked(createBobAgent).mock.calls.at(-1)![0]!;
  const tool = (opts.capabilityTools as Record<string, Tool>).create_task!;
  await tool.execute!({ title }, { toolCallId: 'call_1', messages: [], context: {} });
}

function toolsLine(): Record<string, unknown> {
  const line = journals.find((entry) => entry.includes('"v2.agent_tools"'));
  return JSON.parse(line!) as Record<string, unknown>;
}

async function select(userId: string, spaceId: string): Promise<void> {
  await withUser(db, userId, (tx) => setActiveSpace(tx, userId, spaceId, 'device'));
}

async function titlesIn(userId: string, spaceId: string): Promise<string[]> {
  return (await listTasks(db, userId, spaceId, {})).map((task) => task.title);
}

describe('device turn productivity tools and the active Space', () => {
  it('intersects active group policy with the private conversation and rechecks captured tools', async () => {
    const owner = await addAccount(pg);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Policy group' });
    await select(owner.userId, group.id);
    await turn(owner.userId);
    const options = vi.mocked(createBobAgent).mock.calls.at(-1)?.[0];
    const offered = options?.filterTools?.(options.capabilityTools ?? {});
    const captured = offered?.create_task;
    expect(captured?.execute).toBeDefined();
    await setToolPreference(db, owner.userId, { scope: 'space', scopeId: group.id, toolId: 'create_task', enabled: false });
    await expect(captured?.execute?.({ title: 'Must not be created' }, { toolCallId: 'policy', messages: [], context: {} })).rejects.toThrow('tool_disabled');
    journals.length = 0;
    await turn(owner.userId);
    const disabled = vi.mocked(createBobAgent).mock.calls.at(-1)?.[0];
    expect(disabled?.filterTools?.(disabled.capabilityTools ?? {}).create_task).toBeUndefined();
    expect(String(toolsLine().tools).split(',')).not.toContain('create_task');
    expect(await titlesIn(owner.userId, group.id)).toEqual([]);
  });
  it('an active Space receives create_task, and the agent is told its name', async () => {
    const a = await addAccount(pg);
    const group = await createSpace(db, a.userId, { kind: 'group', name: SPACE_NAME });
    await select(a.userId, group.id);
    await turn(a.userId);
    await createTaskViaAgent('milk');
    expect(await titlesIn(a.userId, group.id)).toEqual(['milk']);
    const priv = await ensurePrivateSpace(db, a.userId);
    expect(await titlesIn(a.userId, priv.id)).toEqual([]);
    expect(vi.mocked(createBobAgent).mock.calls.at(-1)![0]!.memoryContext).toContain(SPACE_NAME);
  });

  it('no active Space keeps the private space', async () => {
    const a = await addAccount(pg);
    await turn(a.userId);
    await createTaskViaAgent('bread');
    const priv = await ensurePrivateSpace(db, a.userId);
    expect(await titlesIn(a.userId, priv.id)).toEqual(['bread']);
    expect(toolsLine().scope).toBe('private');
  });

  it('a revoked membership falls back to private and clears the pointer', async () => {
    const owner = await addAccount(pg);
    const b = await addAccount(pg);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: SPACE_NAME });
    await addMember(db, owner.userId, group.id, b.userId, 'member');
    await select(b.userId, group.id);
    await revokeMember(db, owner.userId, group.id, b.userId);
    await turn(b.userId);
    await createTaskViaAgent('eggs');
    const priv = await ensurePrivateSpace(db, b.userId);
    expect(await titlesIn(b.userId, priv.id)).toEqual(['eggs']);
    expect(await titlesIn(owner.userId, group.id)).toEqual([]);
    expect(await getActiveSpace(db, b.userId)).toMatchObject({ spaceId: null, cleared: false });
    expect(toolsLine().scope).toBe('private');
  });

  it('an archived Space falls back to private', async () => {
    const a = await addAccount(pg);
    const group = await createSpace(db, a.userId, { kind: 'group', name: SPACE_NAME });
    await select(a.userId, group.id);
    await archiveSpace(db, a.userId, group.id);
    await turn(a.userId);
    await createTaskViaAgent('rice');
    const priv = await ensurePrivateSpace(db, a.userId);
    expect(await titlesIn(a.userId, priv.id)).toEqual(['rice']);
    expect(toolsLine().scope).toBe('private');
  });

  it('a getActiveSpace failure falls back to private; the turn replies and persists', async () => {
    const a = await addAccount(pg);
    const group = await createSpace(db, a.userId, { kind: 'group', name: SPACE_NAME });
    await select(a.userId, group.id);
    activeRead.fail = true;
    const session = await turn(a.userId);
    await createTaskViaAgent('tea');
    const priv = await ensurePrivateSpace(db, a.userId);
    expect(await titlesIn(a.userId, priv.id)).toEqual(['tea']);
    expect(toolsLine().scope).toBe('private');
    expect(journals.join('\n')).not.toContain('v2.turn_failed');
    expect(await loadCardputerHistory(db, a.userId, session.activeConversationId!)).toEqual([
      { role: 'user', content: 'add milk' },
      { role: 'assistant', content: 'done' },
    ]);
  });

  it('the journal carries the scope but never the Space name or id', async () => {
    const a = await addAccount(pg);
    const group = await createSpace(db, a.userId, { kind: 'group', name: SPACE_NAME });
    await select(a.userId, group.id);
    await turn(a.userId);
    expect(toolsLine().scope).toBe('space');
    const all = journals.join('\n');
    expect(all).not.toContain(SPACE_NAME);
    expect(all).not.toContain(group.id);
  });
});

describe('device turn list_space_members (owner gap 2026-10-06)', () => {
  /** Every tool the turn's agent was offered, early and late groups alike. */
  function offered(): Record<string, Tool> {
    const opts = vi.mocked(createBobAgent).mock.calls.at(-1)![0]!;
    return { ...(opts.capabilityTools as Record<string, Tool>), ...(opts.lateTools as Record<string, Tool> | undefined) };
  }

  it("an active Space offers it, answering that Space's active members with role and isYou", async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const gone = await addAccount(pg);
    const group = await createSpace(db, a.userId, { kind: 'group', name: SPACE_NAME });
    await addMember(db, a.userId, group.id, b.userId, 'member');
    await addMember(db, a.userId, group.id, gone.userId, 'member');
    await revokeMember(db, a.userId, group.id, gone.userId);
    await select(b.userId, group.id);
    await turn(b.userId);
    const tool = offered().list_space_members;
    expect(tool).toBeDefined();
    const result = await tool!.execute!({}, { toolCallId: 'call_m', messages: [], context: {} }) as {
      ok: boolean; members: Array<{ role: string; isYou: boolean }>;
    };
    expect(result.ok).toBe(true);
    expect(result.members.map((m) => [m.role, m.isYou])).toEqual([['owner', false], ['member', true]]);
    const text = JSON.stringify(result);
    for (const id of [a.userId, b.userId, gone.userId]) expect(text).not.toContain(id);
  });

  it('no active Space (a personal turn) does not offer it', async () => {
    const a = await addAccount(pg);
    await turn(a.userId);
    expect(offered().create_task).toBeDefined();
    expect(offered().list_space_members).toBeUndefined();
  });

  it("an active Space pointer naming the caller's own Private space does not offer it", async () => {
    const a = await addAccount(pg);
    const priv = await ensurePrivateSpace(db, a.userId);
    await select(a.userId, priv.id);
    await turn(a.userId);
    expect(offered().create_task).toBeDefined();
    expect(offered().list_space_members).toBeUndefined();
  });
});
