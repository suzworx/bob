// store/games.ts tests (epic #460, unit G2). Same PG test support as
// store-timers.test.ts: a per-file database from this checkout's migrations,
// connected as bob_server, with every store call under withUser.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreError, withUser, type Db } from '../../src/platform/db/db.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { eraseAccount } from '../../src/account/erasure-service.ts';
import {
  addGameUsage, commitGame, createGameSession, currentGame, DEFAULT_GAME_SETTINGS, endGame, GameConflictError,
  gameUsageToday, getGameSession, getGameSettings, pauseGame, resumeGame, upsertGameSettings,
} from '../../src/voice/games-store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;

const T0 = Date.parse('2030-01-01T12:00:00Z');
const MIN = 60_000;
const players = [{ name: 'Maya', band: 'kid' as const }, { name: 'Leo', band: 'little' as const }];

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

async function newGame(): Promise<{ userId: string; conversationId: string; id: string; version: number }> {
  const { userId } = await addAccount(pg);
  const conversation = await createConversation(db, userId, 'Game night');
  const session = await createGameSession(db, userId,
    { conversationId: conversation.id, game: 'animal_riddles', players, seed: 42, state: { riddle: 0 } }, T0);
  return { userId, conversationId: conversation.id, id: session.id, version: session.version };
}

async function countRows(userId: string, table: string): Promise<number> {
  const rows = await withUser(db, userId, (tx) =>
    tx.query<{ n: unknown }>(`SELECT count(*)::int AS n FROM bob.${table} WHERE user_id = $1`, [userId]));
  return Number(rows[0]?.n ?? 0);
}

describe('games store', () => {
  it('allows one non-ended game per conversation, and a new one once it ends', async () => {
    const g = await newGame();
    const again = { conversationId: g.conversationId, game: 'family_quiz' as const, players: [], state: {} };
    const conflict = await createGameSession(db, g.userId, again, T0 + MIN).catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(GameConflictError);
    expect((conflict as GameConflictError).existingId).toBe(g.id);
    expect((await endGame(db, g.userId, g.id, g.version, 'stopped', T0 + MIN)).ok).toBe(true);
    const next = await createGameSession(db, g.userId, again, T0 + 2 * MIN);
    expect(next).toMatchObject({ game: 'family_quiz', status: 'active', version: 1 });
  });

  it('commits at the current version and returns stale on a lost race', async () => {
    const g = await newGame();
    const turn = { version: g.version, state: { riddle: 1 }, turnIndex: 1, scores: [1, 0] };
    const first = await commitGame(db, g.userId, g.id, turn, T0 + MIN);
    expect(first).toMatchObject({ ok: true, session: { version: 2, turnIndex: 1, scores: [1, 0], state: { riddle: 1 } } });
    expect(await commitGame(db, g.userId, g.id, turn, T0 + MIN)).toEqual({ ok: false, reason: 'stale' });
    expect(await pauseGame(db, g.userId, g.id, 1)).toEqual({ ok: false, reason: 'stale' });
  });

  it('pauses lazily after 10 min without a turn and ends 24 h after the last turn', async () => {
    const g = await newGame();
    expect((await currentGame(db, g.userId, g.conversationId, T0 + 9 * MIN))?.status).toBe('active');
    const paused = await currentGame(db, g.userId, g.conversationId, T0 + 10 * MIN);
    expect(paused).toMatchObject({ status: 'paused', version: 2, endReason: null });
    expect(await commitGame(db, g.userId, g.id, { version: 2, state: {}, turnIndex: 0, scores: [0, 0] }))
      .toEqual({ ok: false, reason: 'stale' });
    expect(await currentGame(db, g.userId, g.conversationId, T0 + 24 * 60 * MIN)).toBeNull();
    const ended = await getGameSession(db, g.userId, g.id, T0 + 24 * 60 * MIN);
    expect(ended).toMatchObject({ status: 'ended', endReason: 'timeout', players: [], scores: [0, 0] });
  });

  it('resumes a paused game and ends with players emptied and scores kept by position (S3)', async () => {
    const g = await newGame();
    const paused = await pauseGame(db, g.userId, g.id, g.version);
    expect(paused).toMatchObject({ ok: true, session: { status: 'paused' } });
    const resumed = await resumeGame(db, g.userId, g.id, 2, T0 + 60 * MIN);
    expect(resumed).toMatchObject({ ok: true, session: { status: 'active', lastTurnAt: T0 + 60 * MIN } });
    const done = await commitGame(db, g.userId, g.id,
      { version: 3, state: { riddle: 5 }, turnIndex: 0, scores: [3, 2], ended: true }, T0 + 61 * MIN);
    expect(done).toMatchObject({ ok: true, session: { status: 'ended', endReason: 'finished', players: [], scores: [3, 2] } });
    expect(await endGame(db, g.userId, g.id, 4, 'stopped')).toEqual({ ok: false, reason: 'stale' });
  });

  it('refuses invalid sessions', async () => {
    const g = await newGame();
    const bad = { conversationId: g.conversationId, game: 'chess', players: [], state: {} };
    await expect(createGameSession(db, g.userId, bad as never)).rejects.toBeInstanceOf(StoreError);
  });

  it('returns default settings, then merges and saves a patch', async () => {
    const { userId } = await addAccount(pg);
    expect(await getGameSettings(db, userId)).toEqual(DEFAULT_GAME_SETTINGS);
    const saved = await upsertGameSettings(db, userId,
      { allowedGames: ['simon_says'], quietHours: { start: '19:30', end: '07:00' } });
    expect(saved).toMatchObject({ dailyLimitMinutes: 45, allowedGames: ['simon_says'], quietHours: { start: '19:30' } });
    expect(await upsertGameSettings(db, userId, { dailyLimitMinutes: 20 })).toMatchObject({ allowedGames: ['simon_says'] });
    expect((await getGameSettings(db, userId)).dailyLimitMinutes).toBe(20);
    await expect(upsertGameSettings(db, userId, { dailyLimitMinutes: 0 })).rejects.toBeInstanceOf(StoreError);
  });

  it('sums usage per local day in the account time zone', async () => {
    const { userId } = await addAccount(pg);
    const la = { timeZone: 'America/Los_Angeles' };
    const lateEvening = Date.parse('2030-01-02T07:30:00Z'); // 23:30 on Jan 1 in LA
    await addGameUsage(db, userId, 300, { ...la, now: Date.parse('2030-01-01T20:00:00Z') });
    expect(await addGameUsage(db, userId, 120, { ...la, now: lateEvening })).toBe(420);
    await addGameUsage(db, userId, 60, { ...la, now: Date.parse('2030-01-02T08:30:00Z') }); // 00:30 Jan 2
    expect(await gameUsageToday(db, userId, { ...la, now: lateEvening })).toBe(420);
    expect(await gameUsageToday(db, userId, { now: lateEvening })).toBe(60); // no zone set: UTC Jan 2
    await expect(addGameUsage(db, userId, -1)).rejects.toBeInstanceOf(StoreError);
  });

  it('account erasure deletes sessions, settings and usage', async () => {
    const g = await newGame();
    await upsertGameSettings(db, g.userId, { kidsMode: false });
    await addGameUsage(db, g.userId, 90, { now: T0 });
    await eraseAccount({ db, userId: g.userId, now: T0 });
    for (const table of ['game_sessions', 'user_state', 'game_usage']) {
      expect(await countRows(g.userId, table)).toBe(0);
    }
  });
});
