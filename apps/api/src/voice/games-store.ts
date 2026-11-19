/**
 * Games store. Every call runs under withUser, so RLS scopes it to the
 * account's own rows.
 *
 * bob.game_sessions holds at most one non-ended game per conversation (a
 * partial unique index). `version` is the optimistic lock: every write is
 * `where version = $n` and bumps it, and a lost race comes back as `stale`.
 * The lifecycle is lazy, applied on read, so no scheduler is needed: active ->
 * paused 10 min after the last turn, then ended ('timeout') 24 h after it.
 * Ending a game empties `players` and keeps the scores by position.
 *
 * Settings default when the account has no row; usage is seconds per local
 * day in the account time zone.
 */
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { bandSchema, gameIdSchema, playerSchema, type Band, type GameId, type Player, resolveTimeZone } from '@bob/ai';
import { StoreConflictError, StoreError, withUser, type Db } from '../platform/db/db.ts';
import { getAccountTimeZone } from '../devices/settings-store.ts';

export type GameStatus = 'active' | 'paused' | 'ended';
export type GameEndReason = 'finished' | 'stopped' | 'timeout' | 'time_limit' | 'quiet_hours';

export type GameSession = {
  id: string;
  userId: string;
  conversationId: string;
  deviceId: string | null;
  game: GameId;
  status: GameStatus;
  seed: number;
  players: Player[];
  turnIndex: number;
  scores: number[];
  /** Per game; the game's own Zod schema validates it. */
  state: unknown;
  version: number;
  startedAt: number;
  lastTurnAt: number;
  endedAt: number | null;
  endReason: GameEndReason | null;
};

/** A write lost the optimistic-lock race, or the game is no longer open. */
type GameStale = { ok: false; reason: 'stale' };
type GameWrite = { ok: true; session: GameSession } | GameStale;

/** Another non-ended game already runs in this conversation. */
export class GameConflictError extends StoreConflictError {
  constructor(readonly existingId: string | null) {
    super('a game is already running in this conversation');
    this.name = 'GameConflictError';
  }
}

export const GAME_PAUSE_AFTER_MS = 10 * 60 * 1000;
const GAME_END_AFTER_MS = 24 * 60 * 60 * 1000;
const GAME_MAX_PLAYERS = 6;

const COLUMNS = `id, user_id AS "userId", conversation_id AS "conversationId", device_id AS "deviceId",
  game, status, seed, players, turn_index AS "turnIndex", scores, state, version,
  floor(extract(epoch from started_at) * 1000)::bigint AS "startedAt",
  floor(extract(epoch from last_turn_at) * 1000)::bigint AS "lastTurnAt",
  floor(extract(epoch from ended_at) * 1000)::bigint AS "endedAt",
  end_reason AS "endReason"`;

type SessionRow = Record<keyof GameSession, unknown>;

/** jsonb arrives parsed from postgres.js; tolerate a string too. */
function json(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function toSession(row: SessionRow): GameSession {
  return {
    id: String(row.id),
    userId: String(row.userId),
    conversationId: String(row.conversationId),
    deviceId: row.deviceId === null ? null : String(row.deviceId),
    game: gameIdSchema.parse(row.game),
    status: String(row.status) as GameStatus,
    seed: Number(row.seed),
    players: z.array(playerSchema).parse(json(row.players)),
    turnIndex: Number(row.turnIndex),
    scores: z.array(z.number()).parse(json(row.scores)),
    state: json(row.state),
    version: Number(row.version),
    startedAt: Number(row.startedAt),
    lastTurnAt: Number(row.lastTurnAt),
    endedAt: row.endedAt === null ? null : Number(row.endedAt),
    endReason: row.endReason === null ? null : (String(row.endReason) as GameEndReason),
  };
}

/** The ENDED fields: players emptied, scores kept by position. */
const END_SET = `status = 'ended', players = '[]'::jsonb, ended_at = to_timestamp($3 / 1000.0),
  end_reason = $4, version = version + 1`;

/** Applies the lazy lifecycle to one open row and returns it as it now is. */
async function applyLifecycle(tx: Db, userId: string, session: GameSession, now: number): Promise<GameSession> {
  if (session.status === 'ended') return session;
  const idle = now - session.lastTurnAt;
  let rows: SessionRow[] = [];
  if (idle >= GAME_END_AFTER_MS) {
    rows = await tx.query<SessionRow>(
      `UPDATE bob.game_sessions SET ${END_SET}
       WHERE user_id = $1 AND id = $2 AND status <> 'ended' RETURNING ${COLUMNS}`,
      [userId, session.id, now, 'timeout'],
    );
  } else if (session.status === 'active' && idle >= GAME_PAUSE_AFTER_MS) {
    rows = await tx.query<SessionRow>(
      `UPDATE bob.game_sessions SET status = 'paused', version = version + 1
       WHERE user_id = $1 AND id = $2 AND status = 'active' RETURNING ${COLUMNS}`,
      [userId, session.id],
    );
  }
  return rows[0] ? toSession(rows[0]) : session;
}

const createInputSchema = z.object({
  conversationId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  deviceId: z.string().uuid().nullable().optional(),
  game: gameIdSchema,
  players: z.array(playerSchema).max(GAME_MAX_PLAYERS),
  seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
  state: z.unknown(),
}).strict();

type CreateGameInput = z.input<typeof createInputSchema>;

/** The conversation's non-ended game with the lazy lifecycle applied, or null. */
async function openGame(tx: Db, userId: string, conversationId: string, now: number): Promise<GameSession | null> {
  const rows = await tx.query<SessionRow>(
    `SELECT ${COLUMNS} FROM bob.game_sessions
     WHERE user_id = $1 AND conversation_id = $2 AND status <> 'ended' FOR UPDATE`,
    [userId, conversationId],
  );
  if (!rows[0]) return null;
  const session = await applyLifecycle(tx, userId, toSession(rows[0]), now);
  return session.status === 'ended' ? null : session;
}

/** Starts a game; GameConflictError when the conversation already has one open. */
export async function createGameSession(
  db: Db, userId: string, input: CreateGameInput, now: number = Date.now(),
): Promise<GameSession> {
  const parsed = createInputSchema.safeParse(input);
  if (!parsed.success) throw new StoreError('invalid game session');
  const { conversationId, deviceId, game, players, state } = parsed.data;
  const seed = parsed.data.seed ?? randomInt(0, 2 ** 31 - 1);
  return withUser(db, userId, async (tx) => {
    const existing = await openGame(tx, userId, conversationId, now);
    if (existing) throw new GameConflictError(existing.id);
    const rows = await tx.query<SessionRow>(
      `INSERT INTO bob.game_sessions
         (user_id, conversation_id, device_id, game, seed, players, scores, state, started_at, last_turn_at)
       VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, $7::text::jsonb, $8::text::jsonb, to_timestamp($9 / 1000.0), to_timestamp($9 / 1000.0))
       RETURNING ${COLUMNS}`,
      [userId, conversationId, deviceId ?? null, game, seed, JSON.stringify(players),
        JSON.stringify(players.map(() => 0)), JSON.stringify(state ?? {}), now],
    ).catch((error: unknown) => {
      if ((error as { code?: unknown }).code === '23505') throw new GameConflictError(null);
      throw error;
    });
    if (!rows[0]) throw new StoreError('game insert returned no row');
    return toSession(rows[0]);
  });
}

/** The conversation's active or paused game after the lazy lifecycle, or null. */
export async function currentGame(
  db: Db, userId: string, conversationId: string, now: number = Date.now(),
): Promise<GameSession | null> {
  return withUser(db, userId, (tx) => openGame(tx, userId, conversationId, now));
}

/** One session by id, lifecycle applied (an ended one too); null when not the caller's. */
export async function getGameSession(
  db: Db, userId: string, id: string, now: number = Date.now(),
): Promise<GameSession | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<SessionRow>(
      `SELECT ${COLUMNS} FROM bob.game_sessions WHERE user_id = $1 AND id = $2`, [userId, id],
    );
    return rows[0] ? applyLifecycle(tx, userId, toSession(rows[0]), now) : null;
  });
}

type GameCommitInput = {
  version: number; state: unknown; turnIndex: number; scores: number[]; ended?: boolean;
};

/** Writes a turn to an active game at `version`; `stale` when the row moved on. */
export async function commitGame(
  db: Db, userId: string, id: string, next: GameCommitInput, now: number = Date.now(),
): Promise<GameWrite> {
  const ended = next.ended === true;
  // An active row's end_reason is null, so the open branch rewrites it as null
  // and every placeholder keeps a type.
  const set = ended ? `${END_SET},` : 'version = version + 1, end_reason = $4::text,';
  return write(db, userId,
    `UPDATE bob.game_sessions SET ${set} state = $6::text::jsonb, turn_index = $7, scores = $8::text::jsonb,
       last_turn_at = to_timestamp($3 / 1000.0)
     WHERE user_id = $1 AND id = $2 AND version = $5 AND status = 'active' RETURNING ${COLUMNS}`,
    [userId, id, now, ended ? 'finished' : null, next.version, JSON.stringify(next.state ?? {}), next.turnIndex,
      JSON.stringify(next.scores)]);
}

/** active -> paused at `version` (pause_game). */
export async function pauseGame(db: Db, userId: string, id: string, version: number): Promise<GameWrite> {
  return write(db, userId,
    `UPDATE bob.game_sessions SET status = 'paused', version = version + 1
     WHERE user_id = $1 AND id = $2 AND version = $3 AND status = 'active' RETURNING ${COLUMNS}`,
    [userId, id, version]);
}

/** paused -> active at `version`; the resume counts as a turn for the 10 min pause. */
export async function resumeGame(
  db: Db, userId: string, id: string, version: number, now: number = Date.now(),
): Promise<GameWrite> {
  return write(db, userId,
    `UPDATE bob.game_sessions SET status = 'active', version = version + 1,
       last_turn_at = to_timestamp($4 / 1000.0)
     WHERE user_id = $1 AND id = $2 AND version = $3 AND status = 'paused' RETURNING ${COLUMNS}`,
    [userId, id, version, now]);
}

/** Ends an open game at `version`: players emptied, scores kept by position. */
export async function endGame(
  db: Db, userId: string, id: string, version: number, reason: GameEndReason, now: number = Date.now(),
): Promise<GameWrite> {
  return write(db, userId,
    `UPDATE bob.game_sessions SET ${END_SET}
     WHERE user_id = $1 AND id = $2 AND version = $5 AND status <> 'ended' RETURNING ${COLUMNS}`,
    [userId, id, now, reason, version]);
}

async function write(db: Db, userId: string, sql: string, params: unknown[]): Promise<GameWrite> {
  if (!z.string().uuid().safeParse(params[1]).success) return { ok: false, reason: 'stale' };
  const rows = await withUser(db, userId, (tx) => tx.query<SessionRow>(sql, params));
  return rows[0] ? { ok: true, session: toSession(rows[0]) } : { ok: false, reason: 'stale' };
}

const clockSchema = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);

/** Parental settings. Only the web settings route writes them, never a tool. */
export const gameSettingsSchema = z.object({
  enabled: z.boolean(),
  kidsMode: z.boolean(),
  maxBand: bandSchema,
  allowedGames: z.array(gameIdSchema),
  dailyLimitMinutes: z.number().int().min(1).max(600),
  quietHours: z.object({ start: clockSchema, end: clockSchema }).strict().nullable(),
}).strict();

export type GameSettings = z.infer<typeof gameSettingsSchema>;
const gameSettingsPatchSchema = gameSettingsSchema.partial();
type GameSettingsPatch = z.infer<typeof gameSettingsPatchSchema>;

export const DEFAULT_GAME_SETTINGS: GameSettings = {
  enabled: true,
  kidsMode: true,
  maxBand: 'kid' satisfies Band,
  allowedGames: [...gameIdSchema.options],
  dailyLimitMinutes: 45,
  quietHours: null,
};

type SettingsRow = {
  enabled: unknown; kidsMode: unknown; maxBand: unknown; allowedGames: unknown;
  dailyLimitMinutes: unknown; quietStart: unknown; quietEnd: unknown;
};

const SETTINGS_COLUMNS = `games_enabled AS enabled, games_kids_mode AS "kidsMode", games_max_band AS "maxBand",
  games_allowed_games AS "allowedGames", games_daily_limit_minutes AS "dailyLimitMinutes",
  games_quiet_start AS "quietStart", games_quiet_end AS "quietEnd"`;

function toSettings(row: SettingsRow): GameSettings {
  return gameSettingsSchema.parse({
    enabled: row.enabled === true,
    kidsMode: row.kidsMode === true,
    maxBand: row.maxBand,
    allowedGames: row.allowedGames,
    dailyLimitMinutes: Number(row.dailyLimitMinutes),
    quietHours: row.quietStart === null ? null : { start: row.quietStart, end: row.quietEnd },
  });
}

/** The account's settings, or the defaults when it never saved any. */
export async function getGameSettings(db: Db, userId: string): Promise<GameSettings> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<SettingsRow>(
      `SELECT ${SETTINGS_COLUMNS} FROM bob.user_state WHERE user_id = $1 AND games_updated_at IS NOT NULL`, [userId],
    );
    return rows[0] ? toSettings(rows[0]) : { ...DEFAULT_GAME_SETTINGS, allowedGames: [...DEFAULT_GAME_SETTINGS.allowedGames] };
  });
}

/** Merges `patch` over the current settings (or the defaults) and saves the row. */
export async function upsertGameSettings(db: Db, userId: string, patch: GameSettingsPatch): Promise<GameSettings> {
  const parsed = gameSettingsPatchSchema.strict().safeParse(patch);
  if (!parsed.success) throw new StoreError('invalid game settings');
  const next: GameSettings = { ...(await getGameSettings(db, userId)), ...parsed.data };
  next.allowedGames = [...new Set(next.allowedGames)];
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<SettingsRow>(
      `INSERT INTO bob.user_state AS s (user_id, games_enabled, games_kids_mode, games_max_band,
         games_allowed_games, games_daily_limit_minutes, games_quiet_start, games_quiet_end, games_updated_at)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, now())
       ON CONFLICT (user_id) DO UPDATE SET games_enabled = excluded.games_enabled,
         games_kids_mode = excluded.games_kids_mode, games_max_band = excluded.games_max_band,
         games_allowed_games = excluded.games_allowed_games,
         games_daily_limit_minutes = excluded.games_daily_limit_minutes,
         games_quiet_start = excluded.games_quiet_start, games_quiet_end = excluded.games_quiet_end,
         games_updated_at = now()
       RETURNING ${SETTINGS_COLUMNS}`,
      [userId, next.enabled, next.kidsMode, next.maxBand, next.allowedGames, next.dailyLimitMinutes,
        next.quietHours?.start ?? null, next.quietHours?.end ?? null],
    );
    if (!rows[0]) throw new StoreError('game settings upsert returned no row');
    return toSettings(rows[0]);
  });
}

/** The calendar date ("YYYY-MM-DD") of instant `at` in `timeZone`. */
function localDay(timeZone: string, at: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveTimeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(at));
}

/** The account's zone as turn.ts resolves it: user_metadata.time_zone, else UTC. */
async function accountZone(db: Db, userId: string, timeZone: string | undefined): Promise<string> {
  if (timeZone !== undefined) return resolveTimeZone(timeZone);
  return resolveTimeZone(await getAccountTimeZone(db, userId).catch(() => null));
}

type UsageOptions = { now?: number; timeZone?: string };

/** Adds played seconds to the account's local day; returns that day's total. */
export async function addGameUsage(
  db: Db, userId: string, seconds: number, options: UsageOptions = {},
): Promise<number> {
  const add = Math.round(seconds);
  if (!Number.isFinite(add) || add < 0 || add > 24 * 60 * 60) throw new StoreError('invalid game usage seconds');
  const day = localDay(await accountZone(db, userId, options.timeZone), options.now ?? Date.now());
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<{ seconds: unknown }>(
      `INSERT INTO bob.game_usage AS u (user_id, day, seconds) VALUES ($1, $2::date, $3)
       ON CONFLICT (user_id, day) DO UPDATE SET seconds = u.seconds + excluded.seconds
       RETURNING seconds`,
      [userId, day, add],
    );
    return Number(rows[0]?.seconds ?? 0);
  });
}

/** Seconds played on the account's current local day (0 when none). */
export async function gameUsageToday(db: Db, userId: string, options: UsageOptions = {}): Promise<number> {
  const day = localDay(await accountZone(db, userId, options.timeZone), options.now ?? Date.now());
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<{ seconds: unknown }>(
      `SELECT seconds FROM bob.game_usage WHERE user_id = $1 AND day = $2::date`, [userId, day],
    );
    return Number(rows[0]?.seconds ?? 0);
  });
}
