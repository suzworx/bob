/**
 * S18-TOOLWIRE: tool-wiring regression on BOTH turn surfaces (device
 * turn.ts, web web-chat.ts). Guards against the L-47 wiring-defect class: a
 * group of tools declared optional in createBobAgent and silently never
 * handed at a call site. Spies on the agent factory and asserts, BY NAME, that
 * each surface hands the base tools plus the memory tools plus the
 * productivity tools (tasks, agenda, events) -- a test that only checks the
 * object is non-empty cannot catch one specific group missing. Also asserts
 * the v2.agent_tools journal event records the offered names once per turn.
 *
 * Default suite: injected fakes, no model, no network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { WebSocket } from 'ws';

const state = vi.hoisted(() => ({
  available: true,
  retrievalBlock: '[BOB MEMORY] the user prefers chai over coffee',
  // The memory-tool names the mock registry carries; the real
  // createMemoryTools contract (@bob/ai memory-tools.ts).
  tools: { remember: {}, forget: {}, list_actions: {}, complete_action: {} },
  agentOpts: [] as Array<Record<string, unknown>>,
  createdAgent: {
    stream: vi.fn(async ({ prompt }: { prompt?: unknown }) => {
      state.streamedPrompt = prompt as unknown[];
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'start', messageId: 'a' });
            controller.enqueue({ type: 'text-start', id: 't', text: '' });
            controller.enqueue({ type: 'text-delta', id: 't', text: 'reply' });
            controller.enqueue({ type: 'text-end', id: 't' });
            controller.enqueue({ type: 'finish', finishReason: 'stop' });
            controller.close();
          },
        }),
      };
    }),
    generate: vi.fn(async ({ messages }: { messages: unknown }) => {
      state.generatedMessages = messages as unknown[];
      return { text: 'reply', toolCalls: [], modelId: 'm', usage: {} };
    }),
  },
  streamedPrompt: [] as unknown[],
  generatedMessages: [] as unknown[],
  journalLines: [] as string[],
}));


vi.mock('../../src/memory/available.ts', () => ({
  memoryAvailable: vi.fn(() => Promise.resolve(state.available)),
}));

vi.mock('../../src/memory/retrieval.ts', () => ({
  startMemoryRetrieval: vi.fn(() => ({
    result: Promise.resolve({
      block: state.retrievalBlock,
      memories: [],
      dueSoon: [],
      degraded: false,
      latencyMs: 1,
      sourceFullText: 0,
      sourceSemantic: 0,
      sourceBoth: 0,
    }),
  })),
}));

vi.mock('../../src/memory/callbacks.ts', () => ({
  createMemoryCallbacks: vi.fn(() => ({
    listActions: vi.fn(),
    completeAction: vi.fn(),
    remember: vi.fn(),
    forget: vi.fn(),
  })),
}));


// The seam under test: spy on the agent factory. The real assistantTools are
// kept (importOriginal) so the base group can be asserted by name.
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((() => ({
  AI_STUB_MODE: false,
  audioFormatSchema: z.enum(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac']),
  bobAgent: {
    stream: vi.fn(async ({ prompt }: { prompt?: unknown }) => {
      state.streamedPrompt = prompt as unknown[];
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'start', messageId: 'a' });
            controller.enqueue({ type: 'text-start', id: 't', text: '' });
            controller.enqueue({ type: 'text-delta', id: 't', text: 'reply' });
            controller.enqueue({ type: 'text-end', id: 't' });
            controller.enqueue({ type: 'finish', finishReason: 'stop' });
            controller.close();
          },
        }),
      };
    }),
    generate: vi.fn(async () => ({ text: 'reply', toolCalls: [], modelId: 'm', usage: {} })),
  },
  isProviderError: () => false,
  providerErrorStatus: () => undefined,
  debugLog: vi.fn(),
  isFrameDebugEnabled: () => false,
}) ) as Factory),
    ((() => ({
  createMemoryTools: vi.fn(() => state.tools),
}) ) as Factory),
    ((async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bob/ai')>();
  return {
    ...actual,
    createBobAgent: vi.fn((opts: unknown) => {
      state.agentOpts.push(opts as Record<string, unknown>);
      return state.createdAgent;
    }),
  };
} ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

vi.mock('../../src/spaces/store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/spaces/store.ts')>();
  return { ...actual, ensurePrivateSpace: vi.fn(actual.ensurePrivateSpace) };
});

// #409: no active-Space pointer by default; a test sets one to check the
// `[Active space]` context on a memory-off turn.
vi.mock('../../src/spaces/active.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/spaces/active.ts')>();
  return { ...actual, getActiveSpace: vi.fn(async () => null) };
});

vi.mock('../../src/voice/audio/stt-tts.ts', () => ({
  assemblePcm16: (chunks: Buffer[]): Buffer => Buffer.concat(chunks),
  isEmptyTurn: vi.fn(() => false),
  isTooShortTurn: () => false,
  transcribePcm: vi.fn(async () => ({ text: 'what do I have to do today', model: 'stt', seconds: 1 })),
  synthesizePcm: vi.fn(async () => ({ pcm: Buffer.alloc(3200), sourceRateHz: 44100 })),
  synthesizeMp3: vi.fn(async () => ({ mp3: Buffer.alloc(1024) })),
  downlinkFrames: vi.fn(() => [Buffer.alloc(340), Buffer.alloc(340)]),
  downlinkMp3Frames: vi.fn(() => []),
}));

vi.mock('../../src/voice/cardputer-conversation.ts', () => ({
  loadCardputerHistory: vi.fn(async () => []),
  persistDeviceTurn: vi.fn(async () => ({
    conversationId: 'cnv_device_1', created: false, title: 't', userMessageId: 'm', changedAt: 1,
  })),
}));

import { webChat } from '../../src/conversations/chat-http.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { resolveDevAccount } from '../../src/account/dev-account.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { assistantTools, createBobAgent } from '@bob/ai';
import { setJournalSink } from '../../src/platform/logger.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
/** The three groups the brief's expected registry names, as literal contract. */
const BASE_TOOLS = Object.keys(assistantTools).sort();
const MEMORY_TOOLS = ['remember', 'forget', 'list_actions', 'complete_action'].sort();
const PRODUCTIVITY_TOOLS = ['list_tasks', 'create_task', 'complete_task', 'update_task', 'list_agenda', 'create_event', 'notify_email'].sort();
// Epic #311: timers (#320), voice tools (#321/#323) and device tools (#314/#330)
// ride in the capability group; device tools only on a device turn (the web
// turn here has no connected device).
const TIMER_TOOLS = ['set_timer', 'set_alarm', 'list_timers', 'cancel_timer'];
const VOICE_TOOLS = ['create_reminder', 'list_reminders', 'cancel_reminder', 'create_note', 'append_note', 'read_note', 'search', 'read_inbox'];
const TIMELINE_TOOLS = ['list_timeline'];
const DEVICE_TOOLS = ['set_volume', 'set_mode'];
// Epic #460: with a game registered, a turn with no open game also offers these two.
const GAME_TOOLS = ['list_games', 'start_game'];
const BOB_APP_TOOLS = ['propose_bob_app', 'revise_bob_app', 'list_bob_apps', 'read_bob_app'];
const DEVICE_CAPABILITY_TOOLS = [...PRODUCTIVITY_TOOLS, ...TIMELINE_TOOLS, ...TIMER_TOOLS, ...GAME_TOOLS, ...VOICE_TOOLS, ...DEVICE_TOOLS, ...BOB_APP_TOOLS].sort();
const WEB_CAPABILITY_TOOLS = [...PRODUCTIVITY_TOOLS, ...TIMELINE_TOOLS, ...TIMER_TOOLS, ...GAME_TOOLS, ...VOICE_TOOLS, ...BOB_APP_TOOLS].sort();
const ALL_DEVICE_TOOLS = [...BASE_TOOLS, ...MEMORY_TOOLS, ...DEVICE_CAPABILITY_TOOLS].sort();
const ALL_WEB_TOOLS = [...BASE_TOOLS, ...MEMORY_TOOLS, ...WEB_CAPABILITY_TOOLS].sort();

function sortedKeys(registry: Record<string, unknown> | undefined): string[] {
  return Object.keys(registry ?? {}).sort();
}

/** The capability tools plus the conditional (voice, device) group a turn hands the agent. */
function capabilityAndLate(opts: Record<string, unknown>): Record<string, unknown> {
  return { ...(opts.capabilityTools as Record<string, unknown> | undefined), ...(opts.lateTools as Record<string, unknown> | undefined) };
}

function hasEvent(event: string): boolean {
  return state.journalLines.some((line) => (JSON.parse(line) as { event: string }).event === event);
}

function agentToolsEvents(): Array<{ interface: string; turn_id: string; tools: string; conversation_id?: string }> {
  return state.journalLines
    .map((line) => JSON.parse(line) as { event: string; tools: string; interface: string; turn_id: string; conversation_id?: string })
    .filter((entry) => entry.event === 'v2.agent_tools');
}

const worker = {
  enqueue: vi.fn(),
  scanUnprocessed: vi.fn(async () => 0),
  idle: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
};

function resetState(): void {
  state.agentOpts.length = 0;
  state.journalLines.length = 0;
  state.streamedPrompt = [];
  state.generatedMessages = [];
  state.available = true;
  vi.mocked(createBobAgent).mockClear();
  vi.mocked(state.createdAgent.stream).mockClear();
  vi.mocked(state.createdAgent.generate).mockClear();
}

function response() {
  const listeners: Record<string, () => void> = {};
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    writableEnded: false,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; },
    write(chunk: Buffer | string) { this.chunks.push(String(chunk)); },
    end() { this.writableEnded = true; listeners.close?.(); },
    json(body: unknown) { this.chunks.push(JSON.stringify(body)); },
    on(event: string, handler: () => void) { listeners[event] = handler; return this; },
    emit(event: string) { listeners[event]?.(); },
  };
}

function deviceSession(userId: string, conversationId: string): DeviceSession {
  const session = createSession({ kind: 'device', userId, deviceId: 'dev', name: 'cardputer' });
  session.stage = 'responding';
  session.turnRef = 'turn_dev';
  session.activeConversationId = conversationId;
  session.formatId = 1;
  session.audioChunks = [Buffer.alloc(320)];
  return session;
}

function fakeSocket(): WebSocket {
  return { readyState: 1, send: vi.fn() } as unknown as WebSocket;
}

function userMessage(id: string, text: string) {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

let pg: TestDb;
let db: Db;
let userId: string;
let deviceConversationId: string;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  userId = await resolveDevAccount(db);
  deviceConversationId = (await createConversation(db, userId, 'Device tools')).id;
  setSharedDb(Promise.resolve(db));
  setJournalSink((line) => state.journalLines.push(line));
});

afterAll(async () => {
  setJournalSink(null);
  const { closeDb } = await import('../../src/platform/db/db.ts');
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

afterEach(() => {
  resetState();
});

describe('device surface (turn.ts)', () => {
  it('hands base + memory + productivity tools by name when memory is on', async () => {
    const session = deviceSession(userId, deviceConversationId);
    await runTurn(appDeps.turn, fakeSocket(), session, 'turn_dev', worker);

    expect(createBobAgent).toHaveBeenCalledTimes(1);
    const opts = state.agentOpts[0]!;
    // Each group by name -- a silently-empty group fails here.
    expect(sortedKeys(opts.memoryTools as Record<string, unknown>)).toEqual(MEMORY_TOOLS);
    expect(sortedKeys(capabilityAndLate(opts))).toEqual(DEVICE_CAPABILITY_TOOLS);
    // The registry the factory merges: base + memory + productivity.
    const merged = [
      ...BASE_TOOLS,
      ...sortedKeys(opts.memoryTools as Record<string, unknown>),
      ...sortedKeys(capabilityAndLate(opts)),
    ].sort();
    expect(merged).toEqual(ALL_DEVICE_TOOLS);
    expect(BASE_TOOLS).toEqual(['currentDateTime']);
    // Memory-on device turn also includes timeline; no speech tools.
    expect(merged).toHaveLength(33);
    expect(merged).not.toContain('textToSpeech');
    expect(merged).not.toContain('speechToText');
  });

  it('journals the offered tool names once per turn', async () => {
    const session = deviceSession(userId, deviceConversationId);
    await runTurn(appDeps.turn, fakeSocket(), session, 'turn_dev', worker);

    const events = agentToolsEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.interface).toBe('cardputer');
    expect(events[0]!.turn_id).toBe('turn_dev');
    expect(events[0]!.tools.split(',').sort()).toEqual(ALL_DEVICE_TOOLS);
  });

  it('#409: memory off still offers base + capability tools (no memory tools), and journals them', async () => {
    state.available = false;
    const { startMemoryRetrieval } = await import('../../src/memory/retrieval.ts');
    vi.mocked(startMemoryRetrieval).mockClear();
    const session = deviceSession(userId, deviceConversationId);
    await runTurn(appDeps.turn, fakeSocket(), session, 'turn_dev', worker);

    expect(createBobAgent).toHaveBeenCalledTimes(1);
    const opts = state.agentOpts[0]!;
    expect(opts.memoryTools).toBeUndefined();
    expect(sortedKeys(capabilityAndLate(opts))).toEqual(DEVICE_CAPABILITY_TOOLS);
    expect(startMemoryRetrieval).not.toHaveBeenCalled();
    expect(state.journalLines.some((line) => (JSON.parse(line) as { event: string }).event.startsWith('v2.memory_'))).toBe(false);
    const events = agentToolsEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.tools.split(',').sort()).toEqual([...BASE_TOOLS, ...DEVICE_CAPABILITY_TOOLS].sort());
    // Tool order: base first, then capability (no memory group in between).
    expect(events[0]!.tools.split(',').slice(0, BASE_TOOLS.length).sort()).toEqual(BASE_TOOLS);
  });

  it('#409: memory off with an active Space carries the [Active space] context and no memory block', async () => {
    state.available = false;
    const { getActiveSpace } = await import('../../src/spaces/active.ts');
    const { createSpace } = await import('../../src/spaces/store.ts');
    const space = await createSpace(db, userId, { name: 'Team' });
    vi.mocked(getActiveSpace).mockResolvedValueOnce({ spaceId: space.id, name: 'Team', changedAt: 1, cleared: false });
    const session = deviceSession(userId, deviceConversationId);
    await runTurn(appDeps.turn, fakeSocket(), session, 'turn_dev', worker);

    expect(createBobAgent).toHaveBeenCalledTimes(1);
    const context = String(state.agentOpts[0]!.memoryContext);
    expect(context).toContain('[Active space]');
    expect(context).toContain('"Team"');
    expect(context).not.toContain('[BOB MEMORY');
    const scopes = state.journalLines
      .map((line) => JSON.parse(line) as { event: string; scope?: string })
      .filter((entry) => entry.event === 'v2.agent_tools')
      .map((entry) => entry.scope);
    expect(scopes).toEqual(['space']);
  });

  it('#409: memory off with the spaces store unavailable keeps timer + device tools and still replies', async () => {
    state.available = false;
    const { ensurePrivateSpace } = await import('../../src/spaces/store.ts');
    vi.mocked(ensurePrivateSpace).mockRejectedValueOnce(new Error('no spaces tables'));
    try {
      const session = deviceSession(userId, deviceConversationId);
      await runTurn(appDeps.turn, fakeSocket(), session, 'turn_dev', worker);
    } finally {
      vi.mocked(ensurePrivateSpace).mockClear();
    }
    expect(createBobAgent).toHaveBeenCalledTimes(1);
    const opts = state.agentOpts[0]!;
    expect(opts.memoryTools).toBeUndefined();
    expect(sortedKeys(capabilityAndLate(opts))).toEqual([...TIMELINE_TOOLS, ...TIMER_TOOLS, ...GAME_TOOLS, ...DEVICE_TOOLS].sort());
    expect(state.createdAgent.generate).toHaveBeenCalledTimes(1);
    expect(hasEvent('v2.agent_tools_degraded')).toBe(false);
  });

  it('omits only the productivity group when the spaces store is unavailable', async () => {
    const { ensurePrivateSpace } = await import('../../src/spaces/store.ts');
    vi.mocked(ensurePrivateSpace).mockRejectedValueOnce(new Error('no spaces tables'));
    try {
      const session = deviceSession(userId, deviceConversationId);
      await runTurn(appDeps.turn, fakeSocket(), session, 'turn_dev', worker);
    } finally {
      vi.mocked(ensurePrivateSpace).mockClear();
    }
    expect(createBobAgent).toHaveBeenCalledTimes(1);
    const opts = state.agentOpts[0]!;
    expect(sortedKeys(opts.memoryTools as Record<string, unknown>)).toEqual(MEMORY_TOOLS);
    expect(sortedKeys(capabilityAndLate(opts))).toEqual([...TIMELINE_TOOLS, ...TIMER_TOOLS, ...GAME_TOOLS, ...DEVICE_TOOLS].sort());
  });
});

describe('web surface (web-chat.ts)', () => {
  it('hands base + memory + productivity tools by name when memory is on', async () => {
    appDeps.memoryWorker = worker;
    const conversation = await createConversation(db, userId, 'web tools');
    const res = response();
    await webChat(appDeps)(
      { body: { id: conversation.id, message: userMessage('msg-web-1', 'what do I have to do today?') }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never,
      res as never,
    );

    expect(createBobAgent).toHaveBeenCalledTimes(1);
    const opts = state.agentOpts[0]!;
    // Each group by name -- a silently-empty group fails here.
    expect(sortedKeys(opts.memoryTools as Record<string, unknown>)).toEqual(MEMORY_TOOLS);
    expect(sortedKeys(capabilityAndLate(opts))).toEqual(WEB_CAPABILITY_TOOLS);
    // The registry the factory merges: base + memory + productivity.
    const merged = [
      ...BASE_TOOLS,
      ...sortedKeys(opts.memoryTools as Record<string, unknown>),
      ...sortedKeys(capabilityAndLate(opts)),
    ].sort();
    expect(merged).toEqual(ALL_WEB_TOOLS);
    // Memory-on web turn also includes timeline; no speech tools.
    expect(merged).toHaveLength(31);
    expect(merged).not.toContain('textToSpeech');
    expect(merged).not.toContain('speechToText');
  });

  it('journals the offered tool names once per turn', async () => {
    appDeps.memoryWorker = worker;
    const conversation = await createConversation(db, userId, 'web tools journal');
    const res = response();
    await webChat(appDeps)(
      { body: { id: conversation.id, message: userMessage('msg-web-2', 'what do I have to do today?') }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never,
      res as never,
    );

    const events = agentToolsEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.interface).toBe('web');
    expect(events[0]!.turn_id).toBe('msg-web-2');
    expect(events[0]!.tools.split(',').sort()).toEqual(ALL_WEB_TOOLS);
  });

  it('#409: memory off still builds ONE agent with base + capability tools (no memory tools), and journals them', async () => {
    state.available = false;
    const { startMemoryRetrieval } = await import('../../src/memory/retrieval.ts');
    vi.mocked(startMemoryRetrieval).mockClear();
    appDeps.memoryWorker = worker;
    const conversation = await createConversation(db, userId, 'web off tools');
    const res = response();
    await webChat(appDeps)(
      { body: { id: conversation.id, message: userMessage('msg-web-3', 'plain turn') }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never,
      res as never,
    );

    expect(createBobAgent).toHaveBeenCalledTimes(1);
    const opts = state.agentOpts[0]!;
    expect(opts.memoryTools).toBeUndefined();
    expect(opts.memoryContext).toBeUndefined();
    expect(sortedKeys(capabilityAndLate(opts))).toEqual(WEB_CAPABILITY_TOOLS);
    expect(startMemoryRetrieval).not.toHaveBeenCalled();
    expect(state.journalLines.some((line) => (JSON.parse(line) as { event: string }).event.startsWith('v2.memory_'))).toBe(false);
    const events = agentToolsEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.tools.split(',').sort()).toEqual([...BASE_TOOLS, ...WEB_CAPABILITY_TOOLS].sort());
  });

  it('#409: memory off with the spaces store unavailable keeps the timer tools', async () => {
    state.available = false;
    appDeps.memoryWorker = worker;
    const { ensurePrivateSpace } = await import('../../src/spaces/store.ts');
    const conversation = await createConversation(db, userId, 'web off no spaces');
    vi.mocked(ensurePrivateSpace).mockRejectedValueOnce(new Error('no spaces tables'));
    const res = response();
    try {
      await webChat(appDeps)(
        { body: { id: conversation.id, message: userMessage('msg-web-4', 'set a timer') }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never,
        res as never,
      );
    } finally {
      vi.mocked(ensurePrivateSpace).mockClear();
    }

    expect(createBobAgent).toHaveBeenCalledTimes(1);
    const opts = state.agentOpts[0]!;
    expect(opts.memoryTools).toBeUndefined();
    expect(sortedKeys(capabilityAndLate(opts))).toEqual([...TIMELINE_TOOLS, ...TIMER_TOOLS, ...GAME_TOOLS].sort());
    expect(state.createdAgent.stream).toHaveBeenCalledTimes(1);
  });

  it('memory off with an account zone builds ONE per-turn agent with base + capability tools in that zone', async () => {
    state.available = false;
    appDeps.memoryWorker = worker;
    const conversation = await createConversation(db, userId, 'web off zone');
    const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    // The guard has already verified the bearer; the route only decodes it.
    const bearer = `Bearer ${part({ alg: 'none' })}.${part({ sub: 'u', user_metadata: { time_zone: 'Asia/Kolkata' } })}.`;
    const res = response();
    await webChat(appDeps)(
      {
        body: { id: conversation.id, message: userMessage('msg-web-zone', 'what is due today') },
        headers: { authorization: bearer },
        on: vi.fn(),
        account: { userId, sessionId: 's', exp: 1 },
      } as never,
      res as never,
    );

    expect(createBobAgent).toHaveBeenCalledTimes(1);
    const opts = state.agentOpts[0]!;
    expect(opts.timeZone).toBe('Asia/Kolkata');
    expect(opts.memoryTools).toBeUndefined();
    expect(sortedKeys(capabilityAndLate(opts))).toEqual(WEB_CAPABILITY_TOOLS);
    const events = agentToolsEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.tools.split(',').sort()).toEqual([...BASE_TOOLS, ...WEB_CAPABILITY_TOOLS].sort());
  });

  it('#409: memory off with a connected device offers the web capability tools plus the device tools', async () => {
    state.available = false;
    appDeps.memoryWorker = worker;
    const { getDeviceSessions } = await import('../../src/voice/device-sessions.ts');
    const session = deviceSession(userId, deviceConversationId);
    getDeviceSessions().register(fakeSocket(), session, userId, null);
    const conversation = await createConversation(db, userId, 'web off device');
    const res = response();
    try {
      await webChat(appDeps)(
        { body: { id: conversation.id, message: userMessage('msg-web-device', 'turn it up') }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never,
        res as never,
      );
    } finally {
      getDeviceSessions().unregister(session);
    }

    expect(createBobAgent).toHaveBeenCalledTimes(1);
    const opts = state.agentOpts[0]!;
    expect(opts.memoryTools).toBeUndefined();
    expect(sortedKeys(capabilityAndLate(opts))).toEqual([...WEB_CAPABILITY_TOOLS, ...DEVICE_TOOLS].sort());
    const events = agentToolsEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.tools.split(',').sort()).toEqual([...BASE_TOOLS, ...WEB_CAPABILITY_TOOLS, ...DEVICE_TOOLS].sort());
  });

  it('a createBobAgent throw streams with zero tools and journals the degradation', async () => {
    const { bobAgent } = await import('@bob/ai');
    vi.mocked(bobAgent.stream).mockClear();
    vi.mocked(createBobAgent).mockImplementationOnce(() => {
      throw new TypeError('tool name clash');
    });
    appDeps.memoryWorker = worker;
    const conversation = await createConversation(db, userId, 'web degraded');
    const res = response();
    await webChat(appDeps)(
      { body: { id: conversation.id, message: userMessage('msg-web-degraded', 'hello') }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never,
      res as never,
    );

    expect(createBobAgent).toHaveBeenCalledTimes(2);
    expect(bobAgent.stream).not.toHaveBeenCalled();
    expect(state.createdAgent.stream).toHaveBeenCalledTimes(1);
    expect(state.agentOpts[0]?.mode).toBe('chat_degraded');
    const actual = await vi.importActual<typeof import('@bob/ai')>('@bob/ai');
    expect(actual.createBobAgent(state.agentOpts[0]).tools).toEqual({});
    expect(res.chunks.join('')).toContain('reply');
    const degraded = state.journalLines
      .map((line) => JSON.parse(line) as { event: string; interface?: string; turn_id?: string; error?: string })
      .filter((entry) => entry.event === 'v2.agent_tools_degraded');
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toMatchObject({ interface: 'web', turn_id: 'msg-web-degraded', error: 'TypeError' });
    const events = agentToolsEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.tools).toBe('');
  });
});
