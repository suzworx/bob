// core/game-tools.ts engine controls over the real G2 store (epic #460, unit G3):
// a per-file test database from this checkout's migrations, a toy game
// registered for the file, and the bound tools driven directly with a fake clock.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { type GameDefinition, gameErr, gameErrOf, registerGame, unregisterGame, mulberry32 } from '@bob/ai/testing';
import { guardOffScript, offScriptGameReply } from '@bob/ai';
import type { Db } from '../../src/platform/db/db.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { currentGame, gameUsageToday, getGameSession } from '../../src/voice/games-store.ts';
import {
  ACTIVE_GAME_KEEP, CLOSED_IN_GAME, closedOnceGameOpens, newGameTurnState,
  PLAY_AGAIN_WINDOW_MS, rememberEnded, rememberedEndedCount, resolveGameScope, takeEnded, type GameScope,
} from '../../src/voice/game-tools.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

type Toy = { n: number };
const toy: GameDefinition<Toy> = {
  id: 'animal_riddles', bands: ['little', 'kid', 'grown'], minPlayers: 1, maxPlayers: 6, ask: 'Which one?',
  init: (_opts, rng) => ({ n: rng.int(1, 1000) }),
  view: (s, players) => ({ game: 'animal_riddles', title: 'Toy', status: 'prompt', line1: `Pick ${s.n}`,
    scores: players.map((p) => ({ name: p.name, points: 0 })) }),
  tools: (cb) => ({
    toy_score: tool({
      description: 'Score a point.', inputSchema: z.object({ stale: z.boolean().optional() }).strict(),
      execute: async (input) => {
        try {
          const s = await cb.current();
          if (s === null) return gameErr('no_game');
          const next = await cb.commit({ version: input.stale === true ? s.version - 1 : s.version,
            state: { n: s.state.n + 1 }, turnIndex: 0, scores: s.scores.map((x) => x + 1) });
          return { ok: true, say: `Score ${next.scores[0]}`, speak_verbatim: false, expect_reply: true, view: toy.view(next.state, next.players) };
        } catch (error) { return gameErrOf(error); }
      },
    }),
  }),
};

const T0 = Date.parse('2030-01-01T12:00:00Z');
let pg: TestDb;
let db: Db;
let clock = T0;
let seeds: number[] = [];

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  registerGame(toy, { title: 'Toy', pitch: 'A toy game for tests.' });
});

afterAll(async () => {
  unregisterGame('animal_riddles');
  await closeTestDb(pg).catch(() => undefined);
});

type Out = Record<string, unknown> & { ok: boolean; say: string; reason?: string; view?: Record<string, unknown> };
async function call(tools: Record<string, Tool>, name: string, input: unknown = {}): Promise<Out> {
  const run = tools[name]?.execute as ((i: unknown, o: unknown) => Promise<Out>) | undefined;
  if (run === undefined) throw new Error(`tool ${name} not in scope`);
  return run(input, { toolCallId: 't1', messages: [] });
}

async function fresh(): Promise<{ userId: string; conversationId: string; scope: () => Promise<GameScope> }> {
  const { userId } = await addAccount(pg);
  const { id: conversationId } = await createConversation(db, userId, 'Game night');
  clock = T0;
  seeds = [7, 8, 9];
  const scope = (): Promise<GameScope> => resolveGameScope(db, userId,
    { conversationId, deviceId: null, timeZone: 'UTC', now: () => clock, seed: () => seeds.shift() ?? 1 });
  return { userId, conversationId, scope };
}

describe('game engine tools', () => {
  it('starts a game, and a second start is refused while one is open', async () => {
    const f = await fresh();
    const started = await call((await f.scope()).tools, 'start_game', { game: 'animal_riddles', players: [{ name: 'Maya', band: 'little' }] });
    expect(started).toMatchObject({ ok: true, expect_reply: true, view: { game: 'animal_riddles' } });
    // The opening prompt from view() is spoken and closed by the game's ask, like every later turn.
    expect(started.say).toBe(`Let's play Toy! Pick ${toy.init({} as never, mulberry32(7)).n} Which one?`);
    const row = await currentGame(db, f.userId, f.conversationId, clock);
    expect(row).toMatchObject({ seed: 7, status: 'active', players: [{ name: 'Maya', band: 'little' }], state: toy.init({} as never, mulberry32(7)) });
    const again = await call((await f.scope()).tools, 'start_game', { game: 'animal_riddles' });
    expect(again).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(again.say).toMatch(/stop it first/);
  });

  it('a said age picks the band on the server, wins over the model band, and is never stored', async () => {
    const f = await fresh();
    const started = await call((await f.scope()).tools, 'start_game', {
      game: 'animal_riddles', band: 'kid',
      players: [{ name: 'Maya', age: 6, band: 'kid' }, { name: 'Tom', age: 3 }, { name: 'Leo', age: 10 }, { name: 'Dad', age: 40 }, { name: 'Kit' }],
    });
    expect(started).toMatchObject({ ok: true });
    const row = await currentGame(db, f.userId, f.conversationId, clock);
    // 6 and 3 are little, 10 is kid, 40 is grown clamped to the default max band (kid); no age means the start's band.
    expect(row!.players).toEqual([
      { name: 'Maya', band: 'little' }, { name: 'Tom', band: 'little' }, { name: 'Leo', band: 'kid' },
      { name: 'Dad', band: 'kid' }, { name: 'Kit', band: 'kid' },
    ]);
    const tools = (await f.scope()).tools;
    await call(tools, 'stop_game');
    for (const age of [2, 100, 6.5]) {
      const bad = tools.start_game!.inputSchema as unknown as { safeParse(v: unknown): { success: boolean } };
      expect(bad.safeParse({ game: 'animal_riddles', players: [{ name: 'Maya', age }] }).success, `age ${age}`).toBe(false);
    }
  });

  it('pauses, resumes with the prompt replayed, and stops with the scores; players are emptied', async () => {
    const f = await fresh();
    await call((await f.scope()).tools, 'start_game', { game: 'animal_riddles' });
    const id = (await currentGame(db, f.userId, f.conversationId, clock))!.id;
    expect(await call((await f.scope()).tools, 'pause_game')).toMatchObject({ ok: true, view: { status: 'paused' } });
    const paused = await f.scope();
    expect(paused.mode).toBe('paused');
    const resumed = await call(paused.tools, 'resume_game');
    expect(resumed).toMatchObject({ ok: true, expect_reply: true });
    expect(resumed.say).toMatch(/^We're back! Pick \d+ Which one\?$/);
    const stopped = await call((await f.scope()).tools, 'stop_game');
    expect(stopped).toMatchObject({ ok: true, view: { status: 'ended' } });
    expect(stopped.say).toMatch(/Game over! You got 0 points/);
    expect(await getGameSession(db, f.userId, id, clock)).toMatchObject({ status: 'ended', players: [], endReason: 'stopped' });
    expect((await f.scope()).mode).toBe('none');
  });

  it('play_again starts the ended game again with a new seed and the same players', async () => {
    const f = await fresh();
    await call((await f.scope()).tools, 'start_game', { game: 'animal_riddles', players: [{ name: 'Maya' }, { name: 'Leo', band: 'little' }] });
    await call((await f.scope()).tools, 'stop_game');
    const again = await call((await f.scope()).tools, 'play_again', { same_players: true });
    expect(again).toMatchObject({ ok: true });
    const row = await currentGame(db, f.userId, f.conversationId, clock);
    expect(row).toMatchObject({ seed: 8, players: [{ name: 'Maya', band: 'kid' }, { name: 'Leo', band: 'little' }] });
    // Replay is the seed: the stored state is exactly init() under that seed.
    expect(row!.state).toEqual(toy.init({} as never, mulberry32(8)));
    await call((await f.scope()).tools, 'stop_game');
    await call((await f.scope()).tools, 'play_again', { same_players: false });
    expect(await call((await f.scope()).tools, 'play_again', { same_players: true })).toMatchObject({ ok: false, reason: 'not_allowed' });
  });

  it('records usage per game turn, skipping gaps over 2 minutes, and reports a lost race as stale', async () => {
    const f = await fresh();
    await call((await f.scope()).tools, 'start_game', { game: 'animal_riddles' });
    clock = T0 + 60_000;
    expect(await call((await f.scope()).tools, 'toy_score')).toMatchObject({ ok: true, say: 'Score 1' });
    clock = T0 + 6 * 60_000;
    expect(await call((await f.scope()).tools, 'toy_score')).toMatchObject({ ok: true, say: 'Score 2' });
    expect(await gameUsageToday(db, f.userId, { now: clock, timeZone: 'UTC' })).toBe(60);
    expect(await call((await f.scope()).tools, 'toy_score', { stale: true })).toMatchObject({ ok: false, reason: 'stale' });
  });
});

// S1 output guard, generic over any game's prompt cue (a toy cue here, not Simon's).
describe('off-script game reply guard', () => {
  const cues = ['Captain orders'];
  it('keeps a reply that only repeats the cues the tools gave this turn', () => {
    const says = ['Captain orders: wave!'];
    expect(offScriptGameReply('Ready? Captain orders: wave!', says, cues)).toBe(false);
    expect(guardOffScript('Great job! Captain  ORDERS: wave!', says, cues, 'Fallback')).toBe('Great job! Captain  ORDERS: wave!');
    expect(offScriptGameReply('Nice listening, everyone!', [], cues)).toBe(false);
  });

  it('replaces a reply with a cue no tool gave: the last say, else the fallback', () => {
    expect(offScriptGameReply('Captain orders: hop!', [], cues)).toBe(true);
    expect(guardOffScript('Captain orders: hop!', [], cues, 'Fallback')).toBe('Fallback');
    const says = ['Gotcha!', 'Captain orders: wave!'];
    expect(guardOffScript('Captain orders: wave! And captain orders: spin!', says, cues, 'Fallback')).toBe('Captain orders: wave!');
  });

  it('matches whole words only and ignores empty cues', () => {
    expect(offScriptGameReply("The captain's orders were fun", [], cues)).toBe(false);
    expect(offScriptGameReply('Anything at all', [], ['', '  '])).toBe(false);
  });
});

// GAMES-GUARD finding 5: play_again's memory never outlives its window, so player names do not pile up.
describe('recently ended games', () => {
  it('a write sweeps every entry older than the play_again window', () => {
    const t = Date.parse('2030-01-01T10:00:00Z');
    const players = [{ name: 'Maya', band: 'kid' as const }];
    const before = rememberedEndedCount();
    for (let i = 0; i < 50; i++) rememberEnded('sweep-user', `c${i}`, 'animal_riddles', players, t);
    expect(rememberedEndedCount()).toBe(before + 50);
    rememberEnded('sweep-user', 'fresh', 'animal_riddles', players, t + PLAY_AGAIN_WINDOW_MS + 1);
    expect(rememberedEndedCount()).toBeLessThanOrEqual(before + 1);
    expect(takeEnded('sweep-user', 'c0', t + PLAY_AGAIN_WINDOW_MS + 1)).toBeNull();
    expect(takeEnded('sweep-user', 'fresh', t + PLAY_AGAIN_WINDOW_MS + 2)).toMatchObject({ game: 'animal_riddles', players });
  });
});

describe('tools closed once a game opens mid-turn (defect 8)', () => {
  const calls: string[] = [];
  const make = (name: string): Tool => tool({
    description: name, inputSchema: z.object({}).strict(),
    execute: async () => { calls.push(name); return { ok: true }; },
  });
  const run = (tools: Record<string, Tool>, name: string): Promise<unknown> =>
    (tools[name]!.execute as (i: unknown, o: unknown) => Promise<unknown>)({}, { toolCallId: 't', messages: [] });
  const open = new Set(['resume_game', ...ACTIVE_GAME_KEEP]);

  it('runs a closed tool until the game opens, then refuses it without running it', async () => {
    calls.length = 0;
    const turn = newGameTurnState();
    const tools = closedOnceGameOpens({ remember: make('remember') }, turn, open);
    expect(await run(tools, 'remember')).toEqual({ ok: true });
    turn.gameTurn = true;
    expect(await run(tools, 'remember')).toEqual(CLOSED_IN_GAME);
    expect(calls).toEqual(['remember']);
  });

  it('leaves the tools an active game keeps untouched', async () => {
    calls.length = 0;
    const kept = { resume_game: make('resume_game'), set_volume: make('set_volume') };
    const tools = closedOnceGameOpens({ ...kept, remember: make('remember') }, { ...newGameTurnState(), gameTurn: true }, open);
    expect(tools.resume_game).toBe(kept.resume_game);
    expect(tools.set_volume).toBe(kept.set_volume);
    expect(await run(tools, 'set_volume')).toEqual({ ok: true });
    expect(calls).toEqual(['set_volume']);
  });

  it('returns the same object the caller passed when nothing is gated', () => {
    const kept = { set_volume: make('set_volume'), plain: { description: 'no execute', inputSchema: z.object({}) } as Tool };
    expect(closedOnceGameOpens(kept, newGameTurnState(), open)).toBe(kept);
    const any = { remember: make('remember') };
    expect(closedOnceGameOpens(any, null, open)).toBe(any);
  });
});
