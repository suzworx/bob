// #315: `cancel` aborts the in-flight turn at any stage with slow fakes --
// nothing runs after it, playback_end follows only a started playback, the
// turn ends idle and ready, and a reply cut mid-stream is saved interrupted.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

vi.mock('../../src/voice/audio/stt-tts.ts', () => ({
  assemblePcm16: (chunks: Buffer[]): Buffer => Buffer.concat(chunks),
  isEmptyTurn: vi.fn(() => false),
  isTooShortTurn: () => false,
  transcribePcm: vi.fn(),
  synthesizePcm: vi.fn(),
  synthesizeMp3: vi.fn(),
  downlinkFrames: vi.fn(),
  downlinkMp3Frames: vi.fn(),
}));
vi.mock('../../src/memory/available.ts', () => ({ memoryAvailable: vi.fn(async () => false), resetMemoryAvailability: vi.fn() }));
// #409: a paired turn builds a per-turn agent even with memory off; it shares
// the mocked generate so cancel is proven on that path, with no network.
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((() => ({
  bobAgent: { generate: vi.fn() },
  AI_STUB_MODE: false,
  isProviderError: () => false,
  providerErrorStatus: () => undefined,
  debugLog: vi.fn(),
  isFrameDebugEnabled: () => false,
}) ) as Factory),
    ((async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bob/ai')>();
  const { bobAgent: mocked } = await importOriginal<typeof import('@bob/ai')>();
  return { ...actual, createBobAgent: vi.fn(() => mocked) };
} ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

import { downlinkFrames, synthesizePcm, transcribePcm } from '../../src/voice/audio/stt-tts.ts';
import { bobAgent, createBobAgent } from '@bob/ai';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { handleControl } from '../../src/voice/session.ts';
import { V2_VERSION, type ClientControlDto } from '../../src/voice/protocol.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { getConversation } from '../../src/conversations/store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const REPLY = 'First sentence here. Second sentence here. Third sentence here. Fourth sentence here.';
type Fake = { readyState: number; send: ReturnType<typeof vi.fn> };
let pg: TestDb;
let db: Db;
let journal: string[];
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const control = (type: string, extra: Record<string, unknown> = {}): ClientControlDto =>
  ({ v: V2_VERSION, type, id: 'test_ctrl_000001', payload: {}, ...extra }) as unknown as ClientControlDto;
const texts = (socket: Fake): Array<{ type: string; payload: Record<string, unknown> }> =>
  socket.send.mock.calls.filter((c) => typeof c[0] === 'string').map((c) => JSON.parse(c[0] as string));
const frames = (socket: Fake): number => socket.send.mock.calls.filter((c) => Buffer.isBuffer(c[0])).length;
const until = async (check: () => boolean): Promise<void> => { while (!check()) await new Promise((r) => setTimeout(r, 5)); };

/** A device session that ended its turn: runTurn is running. */
async function startTurn(userId: string): Promise<{ socket: Fake; session: DeviceSession }> {
  const socket: Fake = { readyState: 1, send: vi.fn() };
  const session = createSession({ kind: 'device', userId, deviceId: crypto.randomUUID(), name: 'Card' });
  Object.assign(session, { stage: 'capturing', turnRef: 'turn_cancel01', audioChunks: [Buffer.alloc(320)], nextUplinkSeq: 1 });
  await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_end', { turn_ref: 'turn_cancel01', seq: 0 }),
    (s, ref) => runTurn(appDeps.turn, socket as unknown as WebSocket, s, ref));
  return { socket, session };
}
const cancel = (socket: Fake, session: DeviceSession): Promise<void> =>
  handleControl(appDeps, socket as unknown as WebSocket, session, control('cancel'), vi.fn());

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
});
beforeEach(() => {
  journal = [];
  setJournalSink((line) => journal.push(line));
  vi.mocked(transcribePcm).mockResolvedValue({ text: 'tell me a story', model: 'stt', seconds: 1 });
  vi.mocked(bobAgent.generate).mockResolvedValue({ text: REPLY, toolCalls: [] } as never);
  vi.mocked(synthesizePcm).mockResolvedValue({ pcm: Buffer.alloc(32_000), sourceRateHz: 16_000 });
  vi.mocked(downlinkFrames).mockReturnValue(Array.from({ length: 100 }, () => Buffer.alloc(340)));
});
afterEach(() => { setJournalSink(null); vi.clearAllMocks(); });
afterAll(async () => {
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

function expectIdleAndReady(socket: Fake, session: DeviceSession): void {
  const sent = texts(socket);
  expect(sent.at(-1)).toMatchObject({ type: 'status', payload: { stage: 'idle' } });
  expect(sent.some((dto) => dto.type === 'error')).toBe(false);
  expect(session.stage).toBe('ready');
  expect(session.turnAbort).toBeUndefined();
}

describe('cancel', () => {
  it('mid-STT: the agent and TTS never run, no playback_end, idle', async () => {
    const { userId } = await addAccount(pg);
    vi.mocked(transcribePcm).mockReturnValue(never());
    const { socket, session } = await startTurn(userId);
    await cancel(socket, session);
    expect(bobAgent.generate).not.toHaveBeenCalled();
    expect(synthesizePcm).not.toHaveBeenCalled();
    expect(texts(socket).some((dto) => dto.type === 'playback_end')).toBe(false);
    expectIdleAndReady(socket, session);
    expect(journal.join('\n')).toContain('"event":"v2.turn_cancelled"');
  });

  it('mid-agent: the agent gets an aborted signal, TTS never runs, idle', async () => {
    const { userId } = await addAccount(pg);
    vi.mocked(bobAgent.generate).mockReturnValue(never());
    const { socket, session } = await startTurn(userId);
    await until(() => vi.mocked(bobAgent.generate).mock.calls.length > 0);
    await cancel(socket, session);
    // The per-turn agent (capability tools, memory off) received the abort.
    expect(createBobAgent).toHaveBeenCalledTimes(1);
    const call = vi.mocked(bobAgent.generate).mock.calls[0]![0] as { abortSignal?: AbortSignal };
    expect(call.abortSignal?.aborted).toBe(true);
    expect(synthesizePcm).not.toHaveBeenCalled();
    expectIdleAndReady(socket, session);
  });

  it('mid-stream: frames stop, playback_end then idle, the heard part is saved interrupted, the next turn starts', async () => {
    const { userId } = await addAccount(pg);
    const { socket, session } = await startTurn(userId);
    await until(() => frames(socket) >= 3);
    await cancel(socket, session);
    const sentFrames = frames(socket);
    await new Promise((r) => setTimeout(r, 100));
    expect(frames(socket)).toBe(sentFrames);
    expect(sentFrames).toBeLessThan(100);
    expect(texts(socket).slice(-2).map((dto) => dto.type)).toEqual(['playback_end', 'status']);
    expectIdleAndReady(socket, session);
    const saved = await getConversation(db, userId, session.activeConversationId!);
    const reply = saved!.messages.find((m) => m.role === 'assistant')!;
    const text = (reply.versions.find((v) => v.selected)!.parts[0] as { text: string }).text;
    expect(text.length).toBeLessThan(REPLY.length);
    expect(REPLY.startsWith(text)).toBe(true);
    expect(journal.join('\n')).toContain('"stage":"stream"');
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_next0001' }), vi.fn());
    expect(session.stage).toBe('capturing');
  });

  it('a cancel racing a normal end resolves to the completed turn, once', async () => {
    const { userId } = await addAccount(pg);
    vi.mocked(downlinkFrames).mockReturnValue([Buffer.alloc(340)]);
    const { socket, session } = await startTurn(userId);
    await session.turnDone;
    await cancel(socket, session);
    expect(texts(socket).filter((dto) => dto.type === 'playback_end')).toHaveLength(1);
    expect(journal.join('\n')).toContain('v2.turn_completed');
    expect(journal.join('\n')).not.toContain('v2.turn_cancelled');
    expect(session.stage).toBe('ready');
  });
});
