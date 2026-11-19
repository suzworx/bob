/**
 * Games scope (epic #460, unit G3; tool-contracts.md scope table, safety.md
 * S3-S8) on BOTH turn surfaces. The agent factory is spied, as in
 * tool-wiring.test.ts, and the tool KEYS are asserted: an active game offers
 * exactly the engine controls, that game's tools, currentDateTime and
 * set_volume -- no memory, notes, search, inbox, reminder or productivity key.
 * Default suite: a per-file database, injected fakes, no model, no network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { WebSocket } from 'ws';

const state = vi.hoisted(() => ({
  agentOpts: [] as Array<Record<string, unknown>>,
  reply: 'reply',
  journalLines: [] as string[],
}));

vi.mock('../../src/memory/available.ts', () => ({ memoryAvailable: vi.fn(async () => true) }));
vi.mock('../../src/memory/retrieval.ts', () => ({
  startMemoryRetrieval: vi.fn(() => ({ result: Promise.resolve({ block: '[BOB MEMORY] lives on Oak Street', memories: [], dueSoon: [], degraded: false, latencyMs: 1, sourceFullText: 0, sourceSemantic: 0, sourceBoth: 0 }) })),
}));
vi.mock('../../src/memory/callbacks.ts', () => ({ createMemoryCallbacks: vi.fn(() => ({})) }));
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((() => ({
  AI_STUB_MODE: false,
  audioFormatSchema: z.enum(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac']),
  bobAgent: { generate: vi.fn(async () => ({ text: 'reply', toolCalls: [], usage: {} })) },
  isProviderError: () => false,
  providerErrorStatus: () => undefined,
  debugLog: vi.fn(),
  isFrameDebugEnabled: () => false,
}) ) as Factory),
    ((() => ({ createMemoryTools: vi.fn(() => ({ remember: {}, forget: {}, list_actions: {}, complete_action: {} })) }) ) as Factory),
    ((async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bob/ai')>();
  const stream = (): { stream: ReadableStream } => ({
    stream: new ReadableStream({
      start(controller) {
        for (const part of [{ type: 'start', messageId: 'a' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: state.reply, text: state.reply },
          { type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop' }]) controller.enqueue(part);
        controller.close();
      },
    }),
  });
  return {
    ...actual,
    createBobAgent: vi.fn((opts: unknown) => {
      state.agentOpts.push(opts as Record<string, unknown>);
      return { stream: vi.fn(async () => stream()), generate: vi.fn(async () => ({ text: state.reply, toolCalls: [], usage: {} })) };
    }),
  };
} ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});
vi.mock('../../src/spaces/active.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/spaces/active.ts')>();
  return { ...actual, getActiveSpace: vi.fn(async () => null) };
});
vi.mock('../../src/voice/audio/stt-tts.ts', () => ({
  assemblePcm16: (chunks: Buffer[]): Buffer => Buffer.concat(chunks),
  isEmptyTurn: vi.fn(() => false),
  isTooShortTurn: () => false,
  transcribePcm: vi.fn(async () => ({ text: 'is it an elephant', model: 'stt', seconds: 1 })),
  synthesizePcm: vi.fn(async () => ({ pcm: Buffer.alloc(3200), sourceRateHz: 44100 })),
  synthesizeMp3: vi.fn(async () => ({ mp3: Buffer.alloc(1024) })),
  downlinkFrames: vi.fn(() => [Buffer.alloc(340)]),
  downlinkMp3Frames: vi.fn(() => []),
}));
vi.mock('../../src/voice/cardputer-conversation.ts', () => ({
  loadCardputerHistory: vi.fn(async () => []),
  persistDeviceTurn: vi.fn(async () => ({ conversationId: 'c', created: false, title: 't', userMessageId: 'm', changedAt: 1 })),
}));

import { tool, type Tool } from 'ai';
import { webChat } from '../../src/conversations/chat-http.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { appendMessage, createConversation, getConversation } from '../../src/conversations/store.ts';
import { createGameSession, pauseGame, upsertGameSettings, addGameUsage, currentGame } from '../../src/voice/games-store.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { guardGameReply, newGameTurnState, resolveGameScope, GUARD_FALLBACK_SAY } from '../../src/voice/game-tools.ts';
import { isGameTurnInStore } from '../../src/memory/extract.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { BOB_AGENT_INSTRUCTIONS, registeredGames } from '@bob/ai';
import { ENGINE_TOOL_NAMES, gameErrOf, type GameDefinition, registerGame, unregisterGame, type GameMeta } from '@bob/ai/testing';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const toy: GameDefinition<{ n: number }> = {
  id: 'animal_riddles', bands: ['little', 'kid', 'grown'], minPlayers: 1, maxPlayers: 6,
  init: () => ({ n: 1 }),
  view: (s) => ({ game: 'animal_riddles', title: 'Toy', status: 'prompt', line1: `Pick ${s.n}`, scores: [] }),
  tools: (cb) => ({
    toy_score: tool({
      description: 'Score.', inputSchema: z.object({}).strict(),
      execute: async () => {
        try {
          const s = await cb.current();
          return { ok: s !== null, say: 'Nice one!' };
        } catch (error) { return gameErrOf(error); }
      },
    }),
  }),
};

/** The toy declares a cue and its next-prompt tool, as Simon does, so the S1 guard is tested generically. */
const TOY_META: GameMeta = { title: 'Toy', pitch: 'A toy game.', cues: ['Toy says'], advance: 'toy_score' };

const ACTIVE_KEYS = [...ENGINE_TOOL_NAMES, 'toy_score', 'currentDateTime', 'set_volume'].sort();
const FORBIDDEN = ['remember', 'forget', 'create_note', 'read_note', 'search', 'read_inbox', 'create_reminder', 'list_tasks', 'set_timer'];
const worker = { enqueue: vi.fn(), scanUnprocessed: vi.fn(async () => 0), idle: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };

function offered(opts: Record<string, unknown>): string[] {
  const keys = (group: unknown): string[] => Object.keys((group ?? {}) as Record<string, unknown>);
  return [...new Set(['currentDateTime', ...keys(opts.capabilityTools), ...keys(opts.memoryTools), ...keys(opts.lateTools)])].sort();
}

function deviceSession(userId: string, conversationId: string): DeviceSession {
  const session = createSession({ kind: 'device', userId, deviceId: 'dev', name: 'cardputer' });
  Object.assign(session, { stage: 'responding', turnRef: 'turn_dev', activeConversationId: conversationId, formatId: 1, audioChunks: [Buffer.alloc(320)] });
  return session;
}

function fakeSocket(): WebSocket {
  return { readyState: 1, send: vi.fn() } as unknown as WebSocket;
}

/** Runs one web turn and returns what the reader was streamed. */
async function webTurn(userId: string, conversationId: string, id: string, text = 'is it a cat'): Promise<string> {
  const written: string[] = [];
  const res = { statusCode: 200, writableEnded: false, status() { return this; }, setHeader: vi.fn(),
    write: vi.fn((chunk: Buffer | string) => { written.push(String(chunk)); return true; }),
    end() { this.writableEnded = true; }, json: vi.fn(), on() { return this; } };
  await webChat(appDeps)({ body: { id: conversationId, message: { id, role: 'user', parts: [{ type: 'text', text }] } },
    on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never, res as never);
  return written.join('');
}

let pg: TestDb;
let db: Db;

async function account(game: 'none' | 'active' | 'paused', band: 'kid' | 'grown' = 'kid'): Promise<{ userId: string; conversationId: string }> {
  const { userId } = await addAccount(pg);
  const { id: conversationId } = await createConversation(db, userId, 'Game night');
  if (game !== 'none') {
    const s = await createGameSession(db, userId, { conversationId, game: 'animal_riddles', players: [{ name: 'Maya', band }], state: { n: 1 } });
    if (game === 'paused') await pauseGame(db, userId, s.id, s.version);
  }
  return { userId, conversationId };
}

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
  setJournalSink((line) => state.journalLines.push(line));
  registerGame(toy, TOY_META);
});
afterAll(async () => {
  unregisterGame('animal_riddles');
  setJournalSink(null);
  await closeTestDb(pg).catch(() => undefined);
});
afterEach(() => {
  state.agentOpts.length = 0;
  state.journalLines.length = 0;
  state.reply = 'reply';
  worker.enqueue.mockClear();
});

describe('scope on the device surface (turn.ts)', () => {
  it('an active game offers exactly the engine controls, its tools, currentDateTime and set_volume', async () => {
    const a = await account('active');
    await runTurn(appDeps.turn, fakeSocket(), deviceSession(a.userId, a.conversationId), 'turn_dev', worker);
    const opts = state.agentOpts[0]!;
    expect(offered(opts)).toEqual(ACTIVE_KEYS);
    expect(opts.memoryTools).toBeUndefined();
    expect(opts.memoryContext).toBeUndefined();
    for (const key of FORBIDDEN) expect(offered(opts)).not.toContain(key);
  });

  it('outside a game only start_game and list_games are added; a paused game adds resume and stop', async () => {
    const none = await account('none');
    await runTurn(appDeps.turn, fakeSocket(), deviceSession(none.userId, none.conversationId), 'turn_dev', worker);
    const games = (keys: string[]): string[] => keys.filter((key) => (ENGINE_TOOL_NAMES as readonly string[]).includes(key));
    expect(games(offered(state.agentOpts[0]!))).toEqual(['list_games', 'start_game']);
    expect(offered(state.agentOpts[0]!)).toContain('remember');
    const paused = await account('paused');
    await runTurn(appDeps.turn, fakeSocket(), deviceSession(paused.userId, paused.conversationId), 'turn_dev', worker);
    expect(games(offered(state.agentOpts[1]!))).toEqual(['list_games', 'resume_game', 'start_game', 'stop_game']);
  });

  it('S8: an unsafe reply in a kids game is replaced before reply_text and TTS', async () => {
    const a = await account('active');
    state.reply = "Great guess! What's your address?";
    const socket = fakeSocket();
    await runTurn(appDeps.turn, socket, deviceSession(a.userId, a.conversationId), 'turn_dev', worker);
    const sent = JSON.stringify(vi.mocked(socket.send).mock.calls);
    expect(GUARD_FALLBACK_SAY).toContain('keep playing');
    expect(sent).toContain('keep playing');
    expect(sent).not.toContain('address');
    const guard = state.journalLines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((e) => e.event === 'v2.game_guard_replaced');
    expect(guard).toEqual([expect.objectContaining({ reason: 'personal_info', count: 1 })]);
  });
});

describe('no game available (correction c1)', () => {
  it('an empty registry adds no game key and leaves the tool set identical, in order, on both surfaces', async () => {
    const a = await account('none');
    const toolKeys = (opts: Record<string, unknown>): string[][] =>
      [opts.capabilityTools, opts.memoryTools, opts.lateTools].map((group) => Object.keys((group ?? {}) as Record<string, unknown>));
    appDeps.memoryWorker = worker;
    await runTurn(appDeps.turn, fakeSocket(), deviceSession(a.userId, a.conversationId), 'turn_dev', worker);
    await webTurn(a.userId, a.conversationId, 'msg-reg-1');
    // Every registered game goes (the toy and each built-in, G4-G8), and comes back after.
    const saved = registeredGames();
    for (const { definition } of saved) unregisterGame(definition.id);
    try {
      await runTurn(appDeps.turn, fakeSocket(), deviceSession(a.userId, a.conversationId), 'turn_dev', worker);
      await webTurn(a.userId, a.conversationId, 'msg-reg-2');
      const withoutGameKeys = (groups: string[][]): string[][] =>
        groups.map((keys) => keys.filter((key) => key !== 'start_game' && key !== 'list_games'));
      for (const [registered, empty] of [[0, 2], [1, 3]] as const) {
        const emptyKeys = toolKeys(state.agentOpts[empty]!);
        expect(emptyKeys.flat().filter((key) => (ENGINE_TOOL_NAMES as readonly string[]).includes(key))).toEqual([]);
        expect(emptyKeys).toEqual(withoutGameKeys(toolKeys(state.agentOpts[registered]!)));
      }
      expect(await resolveGameScope(db, a.userId, { conversationId: a.conversationId, deviceId: null, timeZone: 'UTC' }))
        .toMatchObject({ mode: 'none', tools: {}, turn: { gameTurn: false } });
    } finally {
      for (const { definition, title, pitch, cues, advance } of saved) {
        registerGame(definition, { title, pitch, cues, ...(advance === undefined ? {} : { advance }) });
      }
    }
  });
});

describe('scope on the web surface (web-chat.ts)', () => {
  it('an active game offers the same exact keys, and the turn is not sent to extraction', async () => {
    const a = await account('active');
    appDeps.memoryWorker = worker;
    const device = deviceSession(a.userId, a.conversationId);
    getDeviceSessions().register(fakeSocket(), device, a.userId, null);
    try { await webTurn(a.userId, a.conversationId, 'msg-game-1'); } finally { getDeviceSessions().unregister(device); }
    expect(offered(state.agentOpts[0]!)).toEqual(ACTIVE_KEYS);
    expect(worker.enqueue).not.toHaveBeenCalled();
  });

  it('outside a game only start_game and list_games are added', async () => {
    const a = await account('none');
    appDeps.memoryWorker = worker;
    await webTurn(a.userId, a.conversationId, 'msg-none-1');
    expect(offered(state.agentOpts[0]!).filter((key) => (ENGINE_TOOL_NAMES as readonly string[]).includes(key))).toEqual(['list_games', 'start_game']);
    expect(worker.enqueue).toHaveBeenCalledTimes(1);
  });
});

type Out = { ok: boolean; reason?: string; say: string };
async function call(tools: Record<string, Tool>, name: string, input: unknown = {}): Promise<Out> {
  return (tools[name]!.execute as (i: unknown, o: unknown) => Promise<Out>)(input, { toolCallId: 't', messages: [] });
}

describe('server checks (safety.md S4-S6)', () => {
  // 20:00 UTC, inside quiet hours 19:30-07:00.
  const EVENING = Date.parse('2030-01-01T20:00:00Z');
  const scope = (a: { userId: string; conversationId: string }, now = Date.now()) =>
    resolveGameScope(db, a.userId, { conversationId: a.conversationId, deviceId: null, timeZone: 'UTC', now: () => now });

  it('S4: games switched off, or no registered game allowed, offers no game tool at all', async () => {
    const a = await account('none');
    const allowed = await scope(a);
    expect(await call(allowed.tools, 'start_game', { game: 'family_quiz' })).toMatchObject({ ok: false, reason: 'not_allowed' });
    await upsertGameSettings(db, a.userId, { allowedGames: ['family_quiz'] });
    expect(await scope(a)).toMatchObject({ mode: 'none', tools: {} });
    await upsertGameSettings(db, a.userId, { enabled: false, allowedGames: ['animal_riddles'] });
    expect(await scope(a)).toMatchObject({ mode: 'none', tools: {} });
    // A settings change after the scope was built is re-checked by the server.
    expect(await call(allowed.tools, 'start_game', { game: 'animal_riddles' })).toMatchObject({ ok: false, reason: 'not_allowed' });
  });

  it('S4: a running game whose games were switched off ends at its next move', async () => {
    const running = await account('active');
    const active = await scope(running);
    await upsertGameSettings(db, running.userId, { enabled: false });
    expect(await call(active.tools, 'toy_score')).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(await currentGame(db, running.userId, running.conversationId)).toBeNull();
  });

  it('S5: at the daily limit new starts get time_limit', async () => {
    const a = await account('none');
    const now = Date.now();
    await addGameUsage(db, a.userId, 45 * 60, { now, timeZone: 'UTC' });
    expect(await call((await scope(a, now)).tools, 'start_game', { game: 'animal_riddles' })).toMatchObject({ ok: false, reason: 'time_limit' });
  });

  it('S6: quiet hours refuse start and resume, and end a running game at its next turn', async () => {
    const a = await account('none');
    await upsertGameSettings(db, a.userId, { quietHours: { start: '19:30', end: '07:00' } });
    expect(await call((await scope(a, EVENING)).tools, 'start_game', { game: 'animal_riddles' })).toMatchObject({ ok: false, reason: 'quiet_hours' });
    const paused = await account('paused');
    await upsertGameSettings(db, paused.userId, { quietHours: { start: '00:00', end: '23:59' } });
    expect(await call((await scope(paused, Date.now())).tools, 'resume_game')).toMatchObject({ ok: false, reason: 'quiet_hours' });
    const running = await account('active');
    await upsertGameSettings(db, running.userId, { quietHours: { start: '00:00', end: '23:59' } });
    const active = await scope(running);
    expect(active.mode).toBe('active');
    expect(await call(active.tools, 'toy_score')).toMatchObject({ ok: false, reason: 'quiet_hours' });
    expect(await currentGame(db, running.userId, running.conversationId)).toBeNull();
  });
});

describe('S8 guard and S3 extraction', () => {
  it('replaces an unsafe kids reply with the last say, and leaves grown-only games alone', async () => {
    const turn = { ...newGameTurnState(), kids: true, lastSay: 'Nice one! Next riddle.' };
    const journal = vi.fn();
    expect(await guardGameReply('Visit www.example.com for more!', turn, journal)).toBe('Nice one! Next riddle.');
    expect(journal).toHaveBeenCalledWith('v2.game_guard_replaced', { reason: 'url', count: 1 });
    expect(await guardGameReply('Well done, that was an elephant!', turn, journal)).toBe('Well done, that was an elephant!');
    expect(await guardGameReply('Visit www.example.com', { ...turn, kids: false }, journal)).toBe('Visit www.example.com');
  });

  it('a grown-only game still gets the S3 scope but no guard', async () => {
    const a = await account('active', 'grown');
    const s = await resolveGameScope(db, a.userId, { conversationId: a.conversationId, deviceId: null, timeZone: 'UTC' });
    expect(s).toMatchObject({ mode: 'active', turn: { kids: false, gameTurn: true } });
  });

  it('extraction skips a turn stored while the conversation has a game', async () => {
    const a = await account('active');
    const inGame = await appendMessage(db, a.userId, a.conversationId, { role: 'user', parts: [{ type: 'text', text: 'my address is 12 Oak Street' }] });
    const b = await account('none');
    const plain = await appendMessage(db, b.userId, b.conversationId, { role: 'user', parts: [{ type: 'text', text: 'I like chai' }] });
    const turn = (messageId: string, conversationId: string) => ({ messageId, conversationId, surface: 'device' as const, userText: '', assistantText: '' });
    expect(await isGameTurnInStore(db, a.userId, turn(inGame!.id, a.conversationId))).toBe(true);
    expect(await isGameTurnInStore(db, b.userId, turn(plain!.id, b.conversationId))).toBe(false);
  });

  it('BOB_AGENT_INSTRUCTIONS is untouched: no game text in it and no per-turn instructions', async () => {
    for (const name of [...ENGINE_TOOL_NAMES, 'toy_score', 'game']) expect(BOB_AGENT_INSTRUCTIONS).not.toContain(name);
    const a = await account('active');
    await runTurn(appDeps.turn, fakeSocket(), deviceSession(a.userId, a.conversationId), 'turn_dev', worker);
    expect(state.agentOpts[0]).not.toHaveProperty('instructions');
  });
});

describe('S1 off-script guard (any game with a cue)', () => {
  const journal = vi.fn();
  const turn = (over: Partial<ReturnType<typeof newGameTurnState>>): ReturnType<typeof newGameTurnState> =>
    ({ ...newGameTurnState(), gameTurn: true, cues: ['Toy says'], ...over });

  it('keeps a reply that repeats only the tool cues; replaces an extra cue with the last say, never advancing then', async () => {
    const advance = vi.fn(async () => 'Toy says, spin!');
    const given = turn({ says: ['Toy says, hop!'], lastSay: 'Toy says, hop!', advance });
    expect(await guardGameReply('Ready? Toy says, hop!', given, journal)).toBe('Ready? Toy says, hop!');
    expect(await guardGameReply('Toy says, hop! And toy says, clap!', given, journal)).toBe('Toy says, hop!');
    expect(advance).not.toHaveBeenCalled();
    expect(await guardGameReply('Toy says, clap!', turn({ says: [] }), journal)).toBe(GUARD_FALLBACK_SAY);
    expect(await guardGameReply('Toy says, clap!', turn({ cues: [] }), journal)).toBe('Toy says, clap!');
  });

  it('with no tool behind an invented prompt, the server runs the next-prompt tool and speaks its say', async () => {
    const advance = vi.fn(async () => 'Toy says, spin!');
    journal.mockClear();
    expect(await guardGameReply('Great! Toy says, clap!', turn({ advance }), journal)).toBe('Toy says, spin!');
    expect(advance).toHaveBeenCalledTimes(1);
    expect(journal).toHaveBeenCalledWith('v2.game_guard_replaced', { reason: 'off_script', advanced: 1, count: 1 });
    expect(await guardGameReply('Toy says, clap!', turn({ advance: async () => null }), journal)).toBe(GUARD_FALLBACK_SAY);
  });

  it("device: an invented prompt never reaches reply_text or TTS; the game tool's say does", async () => {
    const a = await account('active');
    state.reply = 'Great! Toy says, touch the moon!';
    const socket = fakeSocket();
    await runTurn(appDeps.turn, socket, deviceSession(a.userId, a.conversationId), 'turn_dev', worker);
    const sent = JSON.stringify(vi.mocked(socket.send).mock.calls);
    expect(sent).not.toContain('touch the moon');
    expect(sent).toContain('Nice one!');
    const guard = state.journalLines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((e) => e.event === 'v2.game_guard_replaced');
    expect(guard).toEqual([expect.objectContaining({ reason: 'off_script', advanced: 1 })]);
  });

  it("web: the saved reply is the game tool's say, not the invented prompt", async () => {
    const a = await account('active');
    state.reply = 'Toy says, touch the moon!';
    const streamed = await webTurn(a.userId, a.conversationId, 'msg-s1-1');
    // Finding 2: the reader is streamed the checked text only, never the invented prompt.
    expect(streamed).not.toContain('touch the moon');
    expect(streamed).toContain('Nice one!');
    const saved = JSON.stringify(await getConversation(db, a.userId, a.conversationId));
    expect(saved).not.toContain('touch the moon');
    expect(saved).toContain('Nice one!');
  });

  it('outside a game the cue is just words', async () => {
    const a = await account('none');
    state.reply = 'Toy says hello!';
    expect(await webTurn(a.userId, a.conversationId, 'msg-s1-2')).toContain('Toy says hello!');
    expect(JSON.stringify(await getConversation(db, a.userId, a.conversationId))).toContain('Toy says hello!');
  });
});

// GAMES-GUARD finding 1: a paused game guards nothing until it is resumed or
// stopped in the turn, so a parent's normal turn is never filtered as play.
describe('a paused game is not a game turn', () => {
  const reply = 'Sure, I will remind you to buy milk. Recipe at www.example.com';

  it('the scope checks nothing while paused, and the kids guard returns once resume_game runs', async () => {
    const a = await account('paused');
    const paused = await resolveGameScope(db, a.userId, { conversationId: a.conversationId, deviceId: null, timeZone: 'UTC' });
    expect(paused).toMatchObject({ mode: 'paused', turn: { gameTurn: false, kids: false, cues: [] } });
    expect(await guardGameReply(reply, paused.turn, vi.fn())).toBe(reply);
    expect(await call(paused.tools, 'resume_game')).toMatchObject({ ok: true });
    expect(paused.turn).toMatchObject({ gameTurn: true, kids: true, cues: ['Toy says'] });
    expect(await guardGameReply(reply, paused.turn, vi.fn())).not.toBe(reply);
  });

  it('device and web: the reply is spoken, streamed and saved as written, and web sends it to extraction', async () => {
    const a = await account('paused');
    state.reply = reply;
    const socket = fakeSocket();
    await runTurn(appDeps.turn, socket, deviceSession(a.userId, a.conversationId), 'turn_dev', worker);
    expect(JSON.stringify(vi.mocked(socket.send).mock.calls)).toContain('buy milk');
    appDeps.memoryWorker = worker;
    worker.enqueue.mockClear();
    expect(await webTurn(a.userId, a.conversationId, 'msg-paused-1', 'remind me to buy milk')).toContain('www.example.com');
    expect(JSON.stringify(await getConversation(db, a.userId, a.conversationId))).toContain('www.example.com');
    expect(worker.enqueue).toHaveBeenCalledTimes(1);
    expect(state.journalLines.filter((line) => line.includes('v2.game_guard_replaced'))).toEqual([]);
  });
});
