/**
 * Binds the game engine to one account and conversation and picks the tool
 * scope a turn offers:
 *   no game  -> start_game, list_games (beside every normal tool)
 *   paused   -> also resume_game, stop_game
 *   active   -> ONLY the engine controls, that game's tools, currentDateTime and
 *               set_volume: no memory, notes, search, inbox, reminders or
 *               productivity tool exists in the turn, by construction.
 * Refusals (games off, quiet hours, daily limit) are server checks the model
 * cannot talk around. Journal fields are enums and counts only.
 */
import { randomInt } from 'node:crypto';
import type { PrepareStepFunction, StopCondition, Tool, ToolSet } from 'ai';
import { type GameCallbacks, type GameId, type GameSnapshot, type Player, kidSafeText, createEngineTools, GameRefusedError, GameStaleError, guardOffScript, offScriptGameReply, type EngineCallbacks, type EngineRefusal, type OpenGame, allowedGames, getGame, registeredGames, resolveTimeZone } from '@bob/ai';
import type { Db } from '../platform/db/db.ts';
import {
  addGameUsage, commitGame, createGameSession, currentGame, endGame, GameConflictError, gameUsageToday,
  getGameSettings, pauseGame, resumeGame, type GameSession, type GameSettings,
} from './games-store.ts';

/** The other tools an ACTIVE game keeps. */
export const ACTIVE_GAME_KEEP: readonly string[] = ['currentDateTime', 'set_volume'];
const NO_GAME_TOOLS: readonly string[] = ['start_game', 'list_games'];
const PAUSED_GAME_TOOLS: readonly string[] = ['start_game', 'list_games', 'resume_game', 'stop_game'];
/** The engine controls a play turn's first model call may use beside the game's own moves. */
const PLAY_CONTROLS: readonly string[] = ['pause_game', 'stop_game', 'game_status'];

/** Gaps between game turns longer than this are not played time. */
const USAGE_GAP_MS = 2 * 60 * 1000;
/** play_again works only this soon after the end. */
export const PLAY_AGAIN_WINDOW_MS = 10 * 60 * 1000;

/** What one turn learned about games, read after the agent ran. */
export interface GameTurnState {
  /** A game was open at the start or one was started or ended during the turn. */
  gameTurn: boolean;
  /** Some player is 'little' or 'kid' (the kid-safe check applies). */
  kids: boolean;
  /** The last game tool's `say`, the kid-safe fallback. */
  lastSay: string | null;
  /** Every game tool `say` of this turn, in order (the off-script guard's allowance). */
  says: string[];
  /** The open (or just started) game's prompt cues; empty means no off-script check. */
  cues: readonly string[];
  /** Runs the active game's next-prompt tool and returns its say; null when none or it failed. */
  advance: (() => Promise<string | null>) | null;
  /** An active game's previewed lines, by tool name: what each tool returns if called now (null: spoken for the model). */
  preview: Readonly<Record<string, string | null>>;
  /** The say of a previewed tool that ran this turn; a one-step reply must carry it. */
  previewedSay: string | null;
  /** Runs one of the active game's tools with no input and returns its say; null when none or it failed. */
  run: ((name: string) => Promise<string | null>) | null;
}

export function newGameTurnState(): GameTurnState {
  return { gameTurn: false, kids: false, lastSay: null, says: [], cues: [], advance: null, preview: {}, previewedSay: null, run: null };
}

function hasKids(players: readonly Pick<Player, 'band'>[]): boolean {
  return players.some((player) => player.band !== 'grown');
}

/** Minutes since local midnight of `at` in `timeZone`. */
function localMinutes(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: resolveTimeZone(timeZone), hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return value('hour') * 60 + value('minute');
}

function clockMinutes(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number) as [number, number];
  return hours * 60 + minutes;
}

/** Whether `at` falls in the quiet window; a start after the end wraps midnight. */
function inQuietHours(quiet: GameSettings['quietHours'], timeZone: string, at: number): boolean {
  if (quiet === null) return false;
  const now = localMinutes(timeZone, at);
  const start = clockMinutes(quiet.start);
  const end = clockMinutes(quiet.end);
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** One server check: games off, quiet hours, then the daily limit (kids mode only). */
async function gameRefusal(
  db: Db, userId: string, settings: GameSettings, timeZone: string, now: number, game?: GameId,
): Promise<EngineRefusal | null> {
  if (!settings.enabled) return 'not_allowed';
  if (game !== undefined && !settings.allowedGames.includes(game)) return 'not_allowed';
  if (inQuietHours(settings.quietHours, timeZone, now)) return 'quiet_hours';
  if (!settings.kidsMode) return null;
  const used = await gameUsageToday(db, userId, { now, timeZone });
  return used >= settings.dailyLimitMinutes * 60 ? 'time_limit' : null;
}

/** The last finished game per conversation, in memory for play_again only; never stored. */
const recentlyEnded = new Map<string, { game: GameId; players: Player[]; at: number }>();

export function rememberEnded(userId: string, conversationId: string, game: GameId, players: Player[], at: number): void {
  // Nothing outlives play_again's window: stale entries (and their player names) go on every write.
  for (const [key, ended] of recentlyEnded) if (at - ended.at > PLAY_AGAIN_WINDOW_MS) recentlyEnded.delete(key);
  recentlyEnded.set(`${userId}:${conversationId}`, { game, players, at });
}

/** How many ended games are remembered (tests read it). */
export function rememberedEndedCount(): number {
  return recentlyEnded.size;
}

/** Takes (and forgets) the game that ended moments ago in this conversation. */
export function takeEnded(userId: string, conversationId: string, now: number): { game: GameId; players: Player[] } | null {
  const key = `${userId}:${conversationId}`;
  const ended = recentlyEnded.get(key);
  recentlyEnded.delete(key);
  if (ended === undefined || now - ended.at > PLAY_AGAIN_WINDOW_MS) return null;
  return { game: ended.game, players: ended.players };
}

/**
 * One game move per turn: a second call of the game's own tools in the same turn
 * (the model calling simon_caught and simon_next together) gets the first move's
 * result instead of moving again. A move that failed (bad names, not your turn)
 * leaves the next call free.
 */
function oneMovePerTurn(tools: Record<string, Tool>): Record<string, Tool> {
  let moved: Promise<unknown> | null = null;
  return Object.fromEntries(Object.entries(tools).map(([name, entry]) => {
    const execute = entry.execute as ((input: unknown, options: unknown) => Promise<unknown>) | undefined;
    if (execute === undefined) return [name, entry];
    const once = async (input: unknown, options: unknown): Promise<unknown> => {
      const prior = moved;
      if (prior !== null) {
        const out = await prior.catch(() => null);
        if ((out as { ok?: unknown } | null)?.ok === true) return out;
      }
      const run = execute(input, options);
      moved = run;
      return run;
    };
    return [name, { ...entry, execute: once } as Tool];
  }));
}

/** Wraps tools so every result's `say` lands in the turn state. */
function observeTools(tools: Record<string, Tool>, turn: GameTurnState): Record<string, Tool> {
  return Object.fromEntries(Object.entries(tools).map(([name, entry]) => {
    const execute = entry.execute;
    if (execute === undefined) return [name, entry];
    const observed = async (input: unknown, options: unknown): Promise<unknown> => {
      const output: unknown = await (execute as (i: unknown, o: unknown) => Promise<unknown>)(input, options);
      const say = (output as { say?: unknown } | null)?.say;
      if (typeof say === 'string') {
        turn.lastSay = say;
        turn.says.push(say);
        if (Object.hasOwn(turn.preview, name)) turn.previewedSay = say;
      }
      return output;
    };
    return [name, { ...entry, execute: observed } as Tool];
  }));
}

export const GUARD_FALLBACK_SAY = "Let's keep playing!";

/** Letters and digits only, lower case: "Simon says, hop!" reads " simon says hop ". */
function words(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
}

function carries(reply: string, line: string): boolean {
  return words(reply).includes(words(line));
}

/** The previewed tool whose line the reply speaks; the longest wins (a catch's line ends with the next command). */
function spokenPreview(reply: string, preview: Readonly<Record<string, string | null>>): string | null {
  const spoken = Object.entries(preview).flatMap(([name, say]): Array<[string, string]> => (say !== null && carries(reply, say) ? [[name, say]] : [])).sort(([, a], [, b]) => b.length - a.length);
  return spoken[0]?.[0] ?? null;
}

type GuardJournal = (event: string, fields: Record<string, string | number>) => void;

/** A one-step turn's reply: a previewed line spoken with no tool runs that tool; a reply missing the tool's say becomes it
 *  (journaled only when the model said other words: a silent call is the path for a tool with no line). */
async function oneStepReply(text: string, turn: GameTurnState, journal: GuardJournal): Promise<string> {
  const run = turn.run;
  const spoken = turn.says.length === 0 && run !== null ? spokenPreview(text, turn.preview) : null;
  if (run !== null && spoken !== null) {
    const ran = await run(spoken);
    journal('v2.game_guard_replaced', { reason: 'no_tool', advanced: ran === null ? 0 : 1, count: 1 });
  }
  if (turn.previewedSay === null || carries(text, turn.previewedSay)) return text;
  if (words(text).trim() !== '') journal('v2.game_guard_replaced', { reason: 'one_step', count: 1 });
  return turn.previewedSay;
}

/** An off-script reply becomes the turn's last say, or with none the next prompt from the game's own tool. */
async function offScriptReply(reply: string, turn: GameTurnState, journal: GuardJournal): Promise<string> {
  if (!offScriptGameReply(reply, turn.says, turn.cues)) return reply;
  const given = [...turn.says];
  const advanced = given.length === 0 && turn.advance !== null ? await turn.advance() : null;
  journal('v2.game_guard_replaced', { reason: 'off_script', advanced: advanced === null ? 0 : 1, count: 1 });
  return advanced ?? guardOffScript(reply, given, turn.cues, GUARD_FALLBACK_SAY);
}

/**
 * The final reply of a game turn, checked before TTS and the save. In a
 * one-step turn the model speaks a previewed line beside its tool call: a
 * reply missing the tool's actual say (no words, or another line) becomes that
 * say, and a previewed line spoken with no tool call runs that tool, so the
 * round moves on exactly once. An
 * off-script reply (a prompt cue no tool gave this turn) is replaced by the
 * turn's last tool `say`; with none, the server runs the game's next-prompt tool
 * itself so the round moves on. In a kids' game a reply failing kidSafeText is
 * replaced by the last tool's `say`. The journal gets the reason class only.
 */
export async function guardGameReply(
  text: string, turn: GameTurnState, journal: GuardJournal,
): Promise<string> {
  const reply = await offScriptReply(await oneStepReply(text, turn, journal), turn, journal);
  if (!turn.kids) return reply;
  const verdict = kidSafeText(reply);
  if (verdict.ok) return reply;
  journal('v2.game_guard_replaced', { reason: verdict.reason, count: 1 });
  const fallback = turn.lastSay !== null && kidSafeText(turn.lastSay).ok ? turn.lastSay : GUARD_FALLBACK_SAY;
  return fallback;
}

interface GameScopeOptions {
  conversationId: string;
  /** The device's uuid on a device turn; null on web. */
  deviceId: string | null;
  timeZone: string;
  now?: () => number;
  /** Seed source for new games (tests pin it). */
  seed?: () => number;
}

export interface GameScope {
  mode: 'none' | 'paused' | 'active';
  /** The game tools in scope: engine controls and, when active, that game's own tools. */
  tools: Record<string, Tool>;
  turn: GameTurnState;
  /**
   * An active game whose tools preview their lines: `context` (a system section
   * for the turn) gives the model each line so it calls the tool and speaks the
   * line in one message (a tool with no line is spoken for it), and `stopWhen`
   * ends the loop once that tool returned a say (one model call,
   * voice-latency-rca root cause 2); a call that failed its input check gets
   * no say, so the model keeps a step to recover and the turn is never silent.
   * `prepareStep` makes the first model call call a move or a control: a reply
   * in words alone would be the model judging a guess or giving a command itself.
   */
  oneStep?: { context: string; stopWhen: StopCondition<ToolSet>; prepareStep: PrepareStepFunction<ToolSet> };
}

function openGameOf(session: GameSession): OpenGame {
  const { game, seed, players, turnIndex, scores, state, version } = session;
  return { game, status: session.status === 'paused' ? 'paused' : 'active', seed, players, turnIndex, scores, state, version };
}

function pick(tools: Record<string, Tool>, names: readonly string[]): Record<string, Tool> {
  return Object.fromEntries(names.filter((name) => tools[name] !== undefined).map((name) => [name, tools[name]!]));
}

/** Of the normal tools, an active game keeps only ACTIVE_GAME_KEEP. */
export function keepForActiveGame(tools: Record<string, Tool>): Record<string, Tool> {
  return pick(tools, ACTIVE_GAME_KEEP);
}

/** A tool's answer once a game opened in this turn. */
export const CLOSED_IN_GAME = { refused: true, reason: 'game_active' } as const;

/** Tools offered before the model ran, that an active game would not offer,
 *  refuse once a game tool opens a game in the same turn. Keyed on
 *  `turn.gameTurn`, never on text. `open` names the tools an active game keeps. */
export function closedOnceGameOpens(
  tools: Record<string, Tool>, turn: GameTurnState | null, open: ReadonlySet<string> = new Set(),
): Record<string, Tool> {
  if (turn === null) return tools;
  let gatedAny = false;
  const gatedTools = Object.fromEntries(Object.entries(tools).map(([name, entry]) => {
    const execute = entry.execute;
    if (execute === undefined || open.has(name)) return [name, entry];
    gatedAny = true;
    const gated = async (input: unknown, options: unknown): Promise<unknown> => (
      turn.gameTurn ? CLOSED_IN_GAME : (execute as (i: unknown, o: unknown) => Promise<unknown>)(input, options)
    );
    return [name, { ...entry, execute: gated } as Tool];
  }));
  // Nothing to close: the caller's own object, unchanged.
  return gatedAny ? gatedTools : tools;
}

/** Adds the time since the last game turn, unless the gap was a break. */
async function recordUsage(db: Db, userId: string, lastTurnAt: number, now: number, timeZone: string): Promise<void> {
  const gap = now - lastTurnAt;
  if (gap <= 0 || gap > USAGE_GAP_MS) return;
  await addGameUsage(db, userId, gap / 1000, { now, timeZone }).catch(() => undefined);
}

/** A game this turn plays (active, started, resumed or ended here): the reply guards apply. */
function openedHere(turn: GameTurnState, session: Pick<GameSession, 'game' | 'players'>): void {
  turn.gameTurn = true;
  turn.kids = hasKids(session.players);
  turn.cues = getGame(session.game)?.cues ?? [];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bindEngine(db: Db, userId: string, opts: GameScopeOptions, turn: GameTurnState): EngineCallbacks {
  const now = opts.now ?? Date.now;
  let known: GameSession | null = null;
  return {
    current: async () => {
      known = await currentGame(db, userId, opts.conversationId, now());
      return known === null ? null : openGameOf(known);
    },
    settings: async () => {
      const settings = await getGameSettings(db, userId);
      return { allowedGames: settings.enabled ? settings.allowedGames : [], maxBand: settings.maxBand };
    },
    refusal: async () => gameRefusal(db, userId, await getGameSettings(db, userId), opts.timeZone, now()),
    create: async ({ game, players, seed, state }) => {
      try {
        const deviceId = opts.deviceId !== null && UUID.test(opts.deviceId) ? opts.deviceId : null;
        known = await createGameSession(db, userId, { conversationId: opts.conversationId, deviceId, game, players, seed, state }, now());
        openedHere(turn, known);
        return openGameOf(known);
      } catch (error) {
        if (error instanceof GameConflictError) return 'conflict';
        throw error;
      }
    },
    pause: async (version) => {
      const write = known === null ? null : await pauseGame(db, userId, known.id, version);
      return write?.ok === true ? openGameOf(write.session) : 'stale';
    },
    resume: async (version) => {
      const write = known === null ? null : await resumeGame(db, userId, known.id, version, now());
      if (write?.ok !== true) return 'stale';
      openedHere(turn, write.session);
      return openGameOf(write.session);
    },
    end: async (version) => {
      if (known === null) return 'stale';
      const at = now();
      const ending = known;
      const write = await endGame(db, userId, ending.id, version, 'stopped', at);
      if (!write.ok) return 'stale';
      if (ending.status === 'active') await recordUsage(db, userId, ending.lastTurnAt, at, opts.timeZone);
      rememberEnded(userId, opts.conversationId, ending.game, ending.players, at);
      openedHere(turn, ending);
      return 'ok';
    },
    lastEnded: async () => takeEnded(userId, opts.conversationId, now()),
    newSeed: opts.seed ?? ((): number => randomInt(0, 2 ** 31 - 1)),
  };
}

/** The running game's callbacks: every read re-checks the refusals and ends the game on one. */
function bindGame(db: Db, userId: string, opts: GameScopeOptions, session: GameSession): GameCallbacks<unknown> {
  const now = opts.now ?? Date.now;
  let known = session;
  const snapshot = (s: GameSession): GameSnapshot<unknown> => {
    const { game, seed, players, turnIndex, scores, state, version } = s;
    return { game, seed, players, turnIndex, scores, state, version };
  };
  return {
    current: async () => {
      const current = await currentGame(db, userId, opts.conversationId, now());
      if (current === null || current.id !== known.id || current.status !== 'active') return null;
      known = current;
      const refused = await gameRefusal(db, userId, await getGameSettings(db, userId), opts.timeZone, now(), current.game);
      if (refused !== null) {
        await endGame(db, userId, current.id, current.version, refused === 'not_allowed' ? 'stopped' : refused, now());
        throw new GameRefusedError(refused);
      }
      return snapshot(current);
    },
    commit: async (next) => {
      const at = now();
      const write = await commitGame(db, userId, known.id, next, at);
      if (!write.ok) throw new GameStaleError();
      await recordUsage(db, userId, known.lastTurnAt, at, opts.timeZone);
      if (next.ended === true) rememberEnded(userId, opts.conversationId, known.game, known.players, at);
      known = write.session;
      return snapshot(known);
    },
    speaker: () => null,
  };
}

/**
 * Reads the conversation's non-ended game FIRST and returns the game tools in
 * scope. The caller composes the rest: every normal tool unless the mode is
 * 'active', and then only keepForActiveGame() of them.
 */
export async function resolveGameScope(db: Db, userId: string, opts: GameScopeOptions): Promise<GameScope> {
  const turn = newGameTurnState();
  const session = await currentGame(db, userId, opts.conversationId, (opts.now ?? Date.now)());
  const engine = createEngineTools(bindEngine(db, userId, opts, turn));
  if (session === null) {
    // With nothing this account could play (no game registered, games
    // off, or none fits its bands) no game tool is offered, so the turn's
    // tool set stays exactly what it is without games.
    if (registeredGames().length === 0) return { mode: 'none', tools: {}, turn };
    const settings = await getGameSettings(db, userId);
    if (!settings.enabled || allowedGames(settings).length === 0) return { mode: 'none', tools: {}, turn };
    // play_again only right after the end: offered while the last game's players are still remembered.
    const ended = recentlyEnded.get(`${userId}:${opts.conversationId}`);
    const justEnded = ended !== undefined && (opts.now ?? Date.now)() - ended.at <= PLAY_AGAIN_WINDOW_MS;
    const names = justEnded ? [...NO_GAME_TOOLS, 'play_again'] : NO_GAME_TOOLS;
    return { mode: 'none', tools: observeTools(pick(engine, names), turn), turn };
  }
  // A paused game guards nothing until resume_game or stop_game runs in this
  // turn: the turns between are normal conversation, never filtered as play.
  if (session.status === 'paused') return { mode: 'paused', tools: observeTools(pick(engine, PAUSED_GAME_TOOLS), turn), turn };
  return activeScope(db, userId, opts, session, engine, turn);
}

/** An active game's scope: the engine controls, the game's tools and, when it previews them, the one-step context. */
function activeScope(
  db: Db, userId: string, opts: GameScopeOptions, session: GameSession, engine: Record<string, Tool>, turn: GameTurnState,
): GameScope {
  openedHere(turn, session);
  const entry = getGame(session.game);
  const own = entry === undefined ? {} : oneMovePerTurn(entry.definition.tools(bindGame(db, userId, opts, session)));
  const tools = observeTools({ ...engine, ...own }, turn);
  const run = runWith(tools);
  turn.run = run;
  const advance = entry?.advance;
  turn.advance = advance === undefined || tools[advance] === undefined ? null : () => run(advance);
  const { game, seed, players, turnIndex, scores, state, version } = session;
  const snap = { game, seed, players, turnIndex, scores, state, version };
  const preview = entry?.definition.preview?.(snap) ?? {};
  turn.preview = Object.fromEntries(Object.entries(preview).filter(([name]) => own[name] !== undefined));
  if (Object.keys(turn.preview).length === 0) return { mode: 'active', tools, turn };
  return {
    mode: 'active', tools, turn,
    oneStep: {
      context: oneStepContext(turn.preview, entry?.definition.note?.(snap) ?? null), stopWhen: () => turn.previewedSay !== null,
      prepareStep: firstCallsAMove([...Object.keys(own), ...PLAY_CONTROLS, ...ACTIVE_GAME_KEEP]),
    },
  };
}

/**
 * A play turn's first model call must call a tool, and only a move or a control
 * (never start_game or play_again): words alone would be the model judging a
 * guess or giving a command itself. Later steps are free.
 */
function firstCallsAMove(names: readonly string[]): PrepareStepFunction<ToolSet> {
  return ({ stepNumber }) => (stepNumber === 0 ? { toolChoice: 'required', activeTools: [...names] } : {});
}

/** The system section of a one-step game turn: the tools' lines, known before the call. */
function oneStepContext(preview: Readonly<Record<string, string | null>>, note: string | null): string {
  return [
    '[Game turn]',
    'You already know what the game tools return. Reply in ONE message: call the tool that fits what the player just said and, in that same message, speak its line exactly as written below. Do not wait for the tool result. Call exactly one game tool. A tool marked "spoken for you" has its line read out by the game: call it and add no words.',
    ...Object.entries(preview).map(([name, say]) => (say === null ? `- ${name}: spoken for you` : `- ${name} returns: ${say}`)),
    ...(note === null ? [] : [`Game note: ${note}`]),
  ].join('\n');
}

/** Runs one of a game's tools with no input (the guard's advance, or a previewed line spoken without its tool) and keeps its say when it succeeded. */
function runWith(tools: Record<string, Tool>): (name: string) => Promise<string | null> {
  return async (name) => {
    const execute = tools[name]?.execute as ((input: unknown, options: unknown) => Promise<unknown>) | undefined;
    if (execute === undefined) return null;
    try {
      const output = await execute({}, { toolCallId: 'game-guard-advance', messages: [] }) as { ok?: unknown; say?: unknown } | null;
      return output?.ok === true && typeof output.say === 'string' ? output.say : null;
    } catch {
      return null;
    }
  };
}
