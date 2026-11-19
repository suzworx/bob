/**
 * GAMES-GUARD finding 4 (safety.md S3c): memory extraction skips a turn only
 * while its conversation's game is really in play. A game is over at
 * min(ended_at, last_turn_at + the pause window), so a game left paused (whose
 * ended_at stays null for a day) no longer hides the normal turns after it.
 * Default suite: a per-file database, no model, no network.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isGameTurnInStore } from '../../src/memory/extract.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { createGameSession, endGame, GAME_PAUSE_AFTER_MS, pauseGame } from '../../src/voice/games-store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});
afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

/** A conversation whose game's last turn was `ago` ms back, then one stored user turn. */
async function stored(ago: number, finish: 'open' | 'paused' | 'ended'): Promise<boolean> {
  const { userId } = await addAccount(pg);
  const { id: conversationId } = await createConversation(db, userId, 'Game night');
  const at = Date.now() - ago;
  const s = await createGameSession(db, userId, {
    conversationId, game: 'simon_says', players: [{ name: 'Maya', band: 'kid' }], state: {},
  }, at);
  if (finish === 'paused') await pauseGame(db, userId, s.id, s.version);
  if (finish === 'ended') await endGame(db, userId, s.id, s.version, 'stopped', at);
  const message = await appendMessage(db, userId, conversationId, { role: 'user', parts: [{ type: 'text', text: 'remind me to buy milk' }] });
  return isGameTurnInStore(db, userId, { messageId: message!.id, conversationId, surface: 'device' as const, userText: '', assistantText: '' });
}

describe('memory extraction around a game (finding 4)', () => {
  it('skips a turn while the game is in play', async () => {
    expect(await stored(60_000, 'open')).toBe(true);
  });

  it('remembers a turn after a paused game went quiet, though ended_at is still null', async () => {
    expect(await stored(GAME_PAUSE_AFTER_MS + 5 * 60_000, 'paused')).toBe(false);
  });

  it('remembers a turn after an idle game passed the pause window before the lifecycle marked it', async () => {
    expect(await stored(60 * 60_000, 'open')).toBe(false);
  });

  it('remembers a turn after a game that ended', async () => {
    expect(await stored(GAME_PAUSE_AFTER_MS, 'ended')).toBe(false);
  });
});
