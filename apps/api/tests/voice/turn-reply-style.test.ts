/**
 * FMT-U2 (#898): the device turn's per-turn agent carries replyStyle 'voice'
 * on the normal paired path and the unpaired path. c3: a tool-wiring failure
 * falls back to the bare singleton directly (#409's double-create
 * regression) -- the voice line is lost on that already-degraded path, by
 * design. tests/support/paired-turn.ts: production shape; TG-AGENT-HARNESS
 * -- no hand-written agent double.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolLoopAgent } from 'ai';
import type { WebSocket } from 'ws';
import { type CreateBobAgentOptions } from '@bob/ai/testing';

const slot = vi.hoisted(() => ({ build: null as null | ((opts: CreateBobAgentOptions) => ToolLoopAgent) }));

vi.mock('../../src/voice/audio/stt-tts.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/voice/audio/stt-tts.ts')>()),
  isEmptyTurn: vi.fn(() => false),
  isTooShortTurn: vi.fn(() => false),
  transcribePcm: vi.fn(),
  synthesizeMp3: vi.fn(),
  synthesizePcm: vi.fn(),
}));
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bob/ai')>();
  const { createAgentHarness } = await import('../support/agent-harness.ts');
  // The singleton remains the last resort if even minimal construction fails.
  const singleton = createAgentHarness([[{ type: 'error', message: 'singleton model error (expected on the degraded path)' }]]).agent;
  return {
    ...actual,
    bobAgent: singleton,
    assistantAgent: singleton,
    createBobAgent: (opts: CreateBobAgentOptions): ToolLoopAgent => {
      if (slot.build === null) throw new Error('turn: no agent builder');
      return slot.build(opts);
    },
  };
} ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});
vi.mock('../../src/memory/available.ts', () => ({ memoryAvailable: vi.fn(async () => true) }));
vi.mock('../../src/memory/retrieval.ts', () => ({
  startMemoryRetrieval: vi.fn(() => ({ result: Promise.resolve({ block: null, memories: [], dueSoon: [], degraded: false, latencyMs: 1, sourceFullText: 0, sourceSemantic: 0, sourceBoth: 0 }) })),
}));

import { words } from '../support/agent-harness.ts';
import { closePairedStore, openPairedStore, pairedAgent, pairedSession, runPairedTurn, stubSpeech, type PairedStore } from '../support/paired-turn.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { MP3_16K_MONO_FORMAT } from '../../src/voice/protocol.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import { createAppDeps } from '../../src/app-deps.ts';

const appDeps = createAppDeps();
let captured: CreateBobAgentOptions[] = [];
let store: PairedStore;

beforeAll(async () => {
  store = await openPairedStore();
  stubSpeech('who are you');
});
afterAll(async () => {
  await closePairedStore(store);
});
beforeEach(() => {
  captured = [];
  slot.build = (opts) => { captured.push(opts); return pairedAgent(opts); };
});

/** A device turn with no auth at all: resolveTurnMemory returns memory === null. */
function unpairedSession(): DeviceSession {
  const session = createSession();
  Object.assign(session, {
    stage: 'responding', turnRef: 'turn_unpaired', formatId: MP3_16K_MONO_FORMAT,
    audioChunks: [Buffer.alloc(32_000)], turnAbort: new AbortController(),
  });
  return session;
}

/** The unmocked agent factory, to check what the captured options build. */
async function realFactory(): Promise<typeof import('@bob/ai').createBobAgent> {
  return (await vi.importActual<typeof import('@bob/ai')>('@bob/ai')).createBobAgent;
}

describe('device turn: reply style (#898)', () => {
  it("the per-turn agent built for a paired device turn is the 'device' row", async () => {
    const session = await pairedSession(store, 'none');
    await runPairedTurn(store, session, [words('I can set timers.')]);
    expect(captured.at(-1)).toMatchObject({ mode: 'device' });
  });

  it('a factory failure retries once on the no-tools device row', async () => {
    slot.build = (opts) => { captured.push(opts); throw new Error('wiring broke'); };
    const session = await pairedSession(store, 'none');
    session.assistantName = 'Bob';
    await runPairedTurn(store, session, [words('still here.')]);
    expect(captured).toHaveLength(2);
    expect(captured[1]).toEqual({ mode: 'device_degraded' });
    expect((await realFactory())(captured[1]).tools).toEqual({});
  });

  it("an unpaired device turn gets the no-tools device row", async () => {
    const socket = { readyState: 1, bufferedAmount: 0, send: vi.fn() } as unknown as WebSocket;
    await runTurn(appDeps.turn, socket, unpairedSession(), 'turn_unpaired');
    expect(captured.at(-1)).toMatchObject({ mode: 'device_degraded' });
    expect((await realFactory())(captured.at(-1)).tools).toEqual({});
  });
});
