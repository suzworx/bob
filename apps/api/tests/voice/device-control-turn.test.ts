// Epic #311 on a device turn: the account zone (#316) reaches the agent and
// every binder, reply_text (#318) precedes playback_start and is never
// journaled, set_volume (#314) pushes device_control before playback_start,
// and the timer/voice/device sets are offered -- or degrade with the rest.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from 'ai';
import type { WebSocket } from 'ws';

const ZONE = 'Pacific/Kiritimati'; // UTC+14: "today" differs from UTC for 14 hours a day
const turnState = vi.hoisted(() => ({ callTool: null as null | { name: string; input: unknown } }));

vi.mock('../../src/voice/audio/stt-tts.ts', () => ({
  assemblePcm16: (chunks: Buffer[]): Buffer => Buffer.concat(chunks),
  isEmptyTurn: vi.fn(() => false),
  isTooShortTurn: () => false,
  transcribePcm: vi.fn(async () => ({ text: 'secret question about Zyzzyva', model: 'stt-1', seconds: 1 })),
  synthesizePcm: vi.fn(async () => ({ pcm: Buffer.alloc(3200), sourceRateHz: 16000 })),
  synthesizeMp3: vi.fn(),
  downlinkFrames: vi.fn(() => [Buffer.alloc(340)]),
  downlinkMp3Frames: vi.fn(() => []),
}));
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((() => ({
  bobAgent: { generate: vi.fn(async () => ({ text: 'secret answer about Zyzzyva', toolCalls: [] })) },
  AI_STUB_MODE: false,
  isProviderError: () => false,
  providerErrorStatus: () => undefined,
  debugLog: vi.fn(),
  isFrameDebugEnabled: () => false,
}) ) as Factory),
    ((async (importOriginal) => {
  const { bobAgent } = await importOriginal<typeof import('@bob/ai')>();
  return {
    bobAgent,
    createBobAgent: vi.fn((opts: { capabilityTools?: Record<string, Tool>; lateTools?: Record<string, Tool> }) => ({
      generate: async () => {
        const call = turnState.callTool;
        if (call !== null) await { ...opts.capabilityTools, ...opts.lateTools }[call.name]!.execute!(call.input as never, {} as never);
        return { text: 'secret answer about Zyzzyva', toolCalls: [] };
      },
    })),
  };
} ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});
vi.mock('../../src/memory/available.ts', () => ({ memoryAvailable: vi.fn(async () => true), resetMemoryAvailability: vi.fn() }));
vi.mock('../../src/memory/retrieval.ts', () => ({ startMemoryRetrieval: vi.fn(() => ({ result: Promise.resolve({ block: null }) })) }));
vi.mock('../../src/devices/settings-store.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/devices/settings-store.ts')>()),
  getAccountTimeZone: vi.fn(async () => ZONE),
}));
vi.mock('../../src/timers/tools.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/timers/tools.ts')>();
  return { ...real, bindTimerTools: vi.fn(real.bindTimerTools) };
});
vi.mock('../../src/voice/voice-tools.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/voice/voice-tools.ts')>();
  return { ...real, bindVoiceTools: vi.fn(real.bindVoiceTools) };
});

import { createBobAgent } from '@bob/ai';
import { bindTimerTools } from '../../src/timers/tools.ts';
import { bindVoiceTools } from '../../src/voice/voice-tools.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
type Fake = { readyState: number; send: ReturnType<typeof vi.fn> };
let pg: TestDb;
let db: Db;
let journal: string[];
const types = (socket: Fake): string[] =>
  socket.send.mock.calls.map((c) => (typeof c[0] === 'string' ? (JSON.parse(c[0]) as { type: string }).type : 'audio'));

async function turn(): Promise<{ socket: Fake; session: DeviceSession }> {
  const { userId } = await addAccount(pg);
  const socket: Fake = { readyState: 1, send: vi.fn() };
  const session = createSession({ kind: 'device', userId, deviceId: crypto.randomUUID(), name: 'Card' });
  Object.assign(session, { stage: 'responding', turnRef: 'turn_dctl0001', audioChunks: [Buffer.alloc(320)] });
  session.deviceState = { volume: 5, muted: true, mode: 'ptt', dnd: false };
  getDeviceSessions().register(socket as unknown as WebSocket, session, userId, (session.auth as { deviceId: string }).deviceId);
  await runTurn(appDeps.turn, socket as unknown as WebSocket, session, 'turn_dctl0001');
  return { socket, session };
}

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
});
beforeEach(() => {
  journal = [];
  setJournalSink((line) => journal.push(line));
  turnState.callTool = null;
  getDeviceSessions().clear();
});
afterEach(() => { setJournalSink(null); vi.clearAllMocks(); });
afterAll(async () => {
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

describe('device turn wiring', () => {
  it('passes the account zone to the agent and to the timer and voice binders', async () => {
    await turn();
    expect(vi.mocked(createBobAgent).mock.calls[0]![0]).toMatchObject({ timeZone: ZONE });
    expect(vi.mocked(bindTimerTools).mock.calls[0]![2]).toMatchObject({ timeZone: ZONE });
    expect(vi.mocked(bindVoiceTools).mock.calls[0]![2]).toMatchObject({ timeZone: ZONE });
    expect(journal.join('\n')).not.toContain(ZONE);
  });

  it('offers timer, voice and device tools by name', async () => {
    await turn();
    const options = vi.mocked(createBobAgent).mock.calls[0]![0]!;
    const tools = [...Object.keys(options.capabilityTools!), ...Object.keys(options.lateTools!)];
    for (const name of ['set_timer', 'cancel_timer', 'create_reminder', 'read_inbox', 'set_volume', 'set_mode']) expect(tools).toContain(name);
  });

  it('sends reply_text before playback_start and never journals it', async () => {
    const { socket } = await turn();
    const sent = types(socket);
    expect(sent.indexOf('reply_text')).toBeGreaterThan(-1);
    expect(sent.indexOf('reply_text')).toBeLessThan(sent.indexOf('playback_start'));
    const reply = socket.send.mock.calls.map((c) => c[0]).find((c) => typeof c === 'string' && c.includes('reply_text'));
    expect(JSON.parse(reply as string).payload).toEqual({ heard: 'secret question about Zyzzyva', reply: 'secret answer about Zyzzyva' });
    expect(journal.join('\n')).not.toContain('Zyzzyva');
  });

  it('set_volume pushes device_control before playback_start, unmuting at the new level', async () => {
    turnState.callTool = { name: 'set_volume', input: { delta: 2 } };
    const { socket, session } = await turn();
    const sent = types(socket);
    expect(sent.indexOf('device_control')).toBeGreaterThan(-1);
    expect(sent.indexOf('device_control')).toBeLessThan(sent.indexOf('playback_start'));
    const control = socket.send.mock.calls.map((c) => c[0]).find((c) => typeof c === 'string' && c.includes('device_control'));
    expect(JSON.parse(control as string).payload).toEqual({ volume: 7, muted: false });
    expect(session.deviceState).toMatchObject({ volume: 7, muted: false });
  });

  it('a tool wiring failure degrades to the base agent and the turn still replies', async () => {
    // Every build throws: this turn has no pinned conversation, so prepare
    // creates one and the tools are built again for its scope.
    vi.mocked(bindTimerTools).mockImplementation(() => { throw new Error('timers broke'); });
    const { socket } = await turn().finally(() => { vi.mocked(bindTimerTools).mockReset(); });
    expect(journal.join('\n')).toContain('v2.agent_tools_degraded');
    expect(types(socket)).toContain('playback_start');
    expect(journal.join('\n')).not.toContain('v2.turn_failed');
  });
});
