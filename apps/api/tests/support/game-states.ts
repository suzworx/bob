/**
 * Seeds one conversation into a named game state through the real store and
 * the real resolveGameScope tools (TG-GAME-MODES, test-strategy.md §3). A new
 * state is one new entry in SEEDS; game-modes.test.ts adds its row.
 */
import type { Tool } from 'ai';
import { createConversation } from '../../src/conversations/store.ts';
import { createGameSession, GAME_PAUSE_AFTER_MS, pauseGame } from '../../src/voice/games-store.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { PLAY_AGAIN_WINDOW_MS, rememberEnded, rememberedEndedCount, resolveGameScope, takeEnded } from '../../src/voice/game-tools.ts';
import { addAccount, type TestDb } from './test-db.ts';

export type GameStateName =
  | 'none' | 'active' | 'paused' | 'paused_idle' | 'resumed' | 'stopped' | 'ended' | 'ended_stale';

/** A seeded account and conversation, and the tool the model calls in the turn (if any). */
export interface SeededState {
  userId: string;
  conversationId: string;
  action: 'resume_game' | 'stop_game' | null;
}

/** The game the seeds play: the caller registers it (a toy in the scope tests). */
export const SEED_GAME = 'animal_riddles';
const MINUTE = 60_000;
const SWEEP = 'game-states-sweep';

type Seed = { at: (now: number) => number; then: 'none' | 'pause' | 'stop'; action: SeededState['action'] } | null;

/** How each state is built: when its game last moved, what then happened to it, and the turn's action. */
const SEEDS: Record<GameStateName, Seed> = {
  none: null,
  active: { at: (now) => now - MINUTE, then: 'none', action: null },
  paused: { at: (now) => now - MINUTE, then: 'pause', action: null },
  // Left active past the pause window: the store's lazy lifecycle pauses it.
  paused_idle: { at: (now) => now - GAME_PAUSE_AFTER_MS - 5 * MINUTE, then: 'none', action: null },
  resumed: { at: (now) => now - MINUTE, then: 'pause', action: 'resume_game' },
  stopped: { at: (now) => now - MINUTE, then: 'none', action: 'stop_game' },
  // Stopped 5 min back: past S3c's 2 min margin, inside play_again's window.
  ended: { at: (now) => now - 5 * MINUTE, then: 'stop', action: null },
  ended_stale: { at: (now) => now - PLAY_AGAIN_WINDOW_MS - MINUTE, then: 'stop', action: null },
};

export const GAME_STATE_NAMES = Object.keys(SEEDS) as GameStateName[];

async function runTool(tools: Record<string, Tool>, name: string): Promise<{ ok: boolean }> {
  const execute = tools[name]?.execute as ((input: unknown, options: unknown) => Promise<{ ok: boolean }>) | undefined;
  if (execute === undefined) throw new Error(`seed: ${name} is not offered`);
  return execute({}, { toolCallId: 'seed', messages: [] });
}

/**
 * Empties recentlyEnded through its public API, then leaves exactly one entry
 * from a day ago: a stale ended game that the next write must drop.
 */
export function resetRecentlyEnded(now: number): void {
  rememberEnded(SWEEP, SWEEP, 'animal_riddles', [], now + 24 * 60 * MINUTE);
  takeEnded(SWEEP, SWEEP, now + 24 * 60 * MINUTE);
  rememberEnded(SWEEP, 'yesterday', 'animal_riddles', [], now - 24 * 60 * MINUTE);
  if (rememberedEndedCount() !== 1) throw new Error(`seed: recentlyEnded holds ${rememberedEndedCount()}, not 1`);
}

/** A fresh account whose one conversation is in `state` at `now`. */
export async function seedGameState(pg: TestDb, db: Db, state: GameStateName, now: number): Promise<SeededState> {
  const { userId } = await addAccount(pg);
  const { id: conversationId } = await createConversation(db, userId, 'Game night');
  const seed = SEEDS[state];
  if (seed === null) return { userId, conversationId, action: null };
  const at = seed.at(now);
  const session = await createGameSession(db, userId, {
    conversationId, game: SEED_GAME, players: [{ name: 'Maya', band: 'kid' }], state: { n: 1 },
  }, at);
  if (seed.then === 'pause') await pauseGame(db, userId, session.id, session.version);
  if (seed.then === 'stop') {
    const scope = await resolveGameScope(db, userId, { conversationId, deviceId: null, timeZone: 'UTC', now: () => at });
    const stopped = await runTool(scope.tools, 'stop_game');
    if (!stopped.ok) throw new Error(`seed: stop_game refused for ${state}`);
  }
  return { userId, conversationId, action: seed.action };
}
