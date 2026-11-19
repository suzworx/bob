// test:db suite (epic #460, unit G2): games rows are isolated between accounts
// under real roles. Runs on the LOCAL Supabase stack through a database built
// from THIS checkout's migrations (support/test-db.ts), connected as
// bob_server (nobypassrls), so FORCE RLS decides every read and write. Skips
// cleanly when the local stack's Postgres port does not answer.
import { createConnection } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/platform/db/db.ts';

const DB_PORT = Number(process.env.BOB_TEST_DB_PORT ?? 54322);

function stackAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (up: boolean): void => { socket.destroy(); resolve(up); };
    socket.setTimeout(1500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const stackUp = await stackAnswers(DB_PORT);

describe.skipIf(!stackUp)('games RLS isolation on the local stack', () => {
  type Support = typeof import('../support/test-db.ts');
  type Store = typeof import('../../src/voice/games-store.ts');
  let support: Support;
  let store: Store;
  let pg: Awaited<ReturnType<Support['createTestDb']>>;
  let db: Db;
  let a: string;
  let b: string;
  let conversationA: string;
  let sessionA: string;

  beforeAll(async () => {
    support = await import('../support/test-db.ts');
    store = await import('../../src/voice/games-store.ts');
    const { createConversation } = await import('../../src/conversations/store.ts');
    pg = await support.createTestDb();
    db = support.asDb(pg);
    a = (await support.addAccount(pg)).userId;
    b = (await support.addAccount(pg)).userId;
    conversationA = (await createConversation(db, a, 'A plays')).id;
    const session = await store.createGameSession(db, a,
      { conversationId: conversationA, game: 'simon_says', players: [{ name: 'Maya', band: 'kid' }], state: {} });
    sessionA = session.id;
    await store.upsertGameSettings(db, a, { dailyLimitMinutes: 15 });
    await store.addGameUsage(db, a, 600, { timeZone: 'UTC' });
  }, 60_000);

  afterAll(async () => {
    if (pg) await support.closeTestDb(pg).catch(() => undefined);
  });

  it("B reads none of A's sessions, settings or usage", async () => {
    expect(await store.currentGame(db, b, conversationA)).toBeNull();
    expect(await store.getGameSession(db, b, sessionA)).toBeNull();
    expect(await store.getGameSettings(db, b)).toEqual(store.DEFAULT_GAME_SETTINGS);
    expect(await store.gameUsageToday(db, b, { timeZone: 'UTC' })).toBe(0);
    for (const table of ['game_sessions', 'user_state', 'game_usage']) {
      const rows = await support.withUserRaw(pg, b, (tx) =>
        tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM bob.${table}`));
      expect(rows.rows[0]?.n).toBe(0);
    }
  });

  it("B cannot end, pause or commit A's game", async () => {
    expect(await store.endGame(db, b, sessionA, 1, 'stopped')).toEqual({ ok: false, reason: 'stale' });
    expect(await store.pauseGame(db, b, sessionA, 1)).toEqual({ ok: false, reason: 'stale' });
    expect(await store.commitGame(db, b, sessionA, { version: 1, state: {}, turnIndex: 0, scores: [9] }))
      .toEqual({ ok: false, reason: 'stale' });
    expect(await store.getGameSession(db, a, sessionA)).toMatchObject({ status: 'active', version: 1, scores: [0] });
  });

  it("B cannot start a game in A's conversation or write rows as A", async () => {
    await expect(store.createGameSession(db, b,
      { conversationId: conversationA, game: 'family_quiz', players: [], state: {} }))
      .rejects.toThrow(/row-level security/);
    await expect(support.withUserRaw(pg, b, (tx) =>
      tx.query(`INSERT INTO bob.game_usage (user_id, day, seconds) VALUES ($1, current_date, 1)`, [a])))
      .rejects.toThrow(/row-level security/);
    await expect(support.withUserRaw(pg, b, (tx) =>
      tx.query(`INSERT INTO bob.user_state (user_id) VALUES ($1)`, [a])))
      .rejects.toThrow(/row-level security/);
    expect(await store.gameUsageToday(db, a, { timeZone: 'UTC' })).toBe(600);
  });
});
