/**
 * Engine controls for games: list_games, start_game,
 * pause_game, resume_game, stop_game, game_status and play_again, as
 * docs/games/tool-contracts.md section 1 specifies. Built with the AI SDK
 * `tool()` style over injected EngineCallbacks: apps/api binds them to one
 * account and one conversation (core/game-tools.ts), so no input names an
 * account, a session or an age. A rejected callback becomes a gameErrSchema
 * result and is never thrown. Host notes ride in the output, never the prompt.
 */
import { z } from 'zod';
import { tool } from 'ai';
import type { Tool } from 'ai';
import {
  bandForAge, bandSchema, categorySchema, gameErrSchema, gameIdSchema, gameOkSchema, playerAgeSchema, playerSchema,
  storyThemeSchema,
  type Band, type GameErr, type GameErrReason, type GameId, type GameOk, type GameResult, type GameSnapshot,
  type GameView, type Player,
} from './engine.ts';
import { mulberry32 } from './rng.ts';
import { allowedGames, getGame, lowerBand, type RegisteredGame } from './registry.ts';

const listGamesInputSchema = z.object({ band: bandSchema.optional() }).strict();
/** A player at start: `age` (when they said it) picks the band on the server and wins over any `band`. */
const startPlayerSchema = z
  .object({ name: playerSchema.shape.name, age: playerAgeSchema.optional(), band: bandSchema.optional() })
  .strict();
const startGameInputSchema = z
  .object({
    game: gameIdSchema,
    players: z.array(startPlayerSchema).max(6).optional(),
    teams: z.boolean().optional(),
    band: bandSchema.optional(),
    options: z.object({ category: categorySchema.optional(), theme: storyThemeSchema.optional() }).strict().optional(),
  })
  .strict();
type StartGameInput = z.infer<typeof startGameInputSchema>;
const emptyGameInputSchema = z.object({}).strict();
const gameStatusInputSchema = z.object({ repeat: z.boolean().optional() }).strict();
const playAgainInputSchema = z.object({ same_players: z.boolean() }).strict();

export const gameResultSchema = z.discriminatedUnion('ok', [gameOkSchema, gameErrSchema]);
const gameListOkSchema = z
  .object({
    ok: z.literal(true),
    say: z.string().max(600),
    games: z.array(z.object({ game: gameIdSchema, title: z.string().max(20), pitch: z.string().max(120) }).strict()),
  })
  .strict();
const gameListResultSchema = z.discriminatedUnion('ok', [gameListOkSchema, gameErrSchema]);
type GameListResult = z.infer<typeof gameListResultSchema>;

/** The conversation's open game as the engine controls see it. */
export interface OpenGame extends GameSnapshot<unknown> {
  status: 'active' | 'paused';
}

/** A write lost the optimistic-lock race; a game's commit rejects with it. */
export class GameStaleError extends Error {
  constructor() {
    super('stale');
    this.name = 'GameStaleError';
  }
}

/** A server check (safety.md S4-S6) refused a game action; a game tool rejects with it. */
export class GameRefusedError extends Error {
  constructor(readonly reason: EngineRefusal) {
    super(reason);
    this.name = 'GameRefusedError';
  }
}

export type EngineRefusal = Extract<GameErrReason, 'not_allowed' | 'time_limit' | 'quiet_hours'>;

/** Injected by apps/api, bound to one account and one conversation. */
export interface EngineCallbacks {
  current(): Promise<OpenGame | null>;
  /** The parental settings that filter games and bands (S4). */
  settings(): Promise<{ allowedGames: GameId[]; maxBand: Band }>;
  /** S4-S6 for start, resume and play again: games off, the daily limit, quiet hours. */
  refusal(): Promise<EngineRefusal | null>;
  create(input: { game: GameId; players: Player[]; seed: number; state: unknown }): Promise<OpenGame | 'conflict'>;
  pause(version: number): Promise<OpenGame | 'stale'>;
  resume(version: number): Promise<OpenGame | 'stale'>;
  end(version: number): Promise<'ok' | 'stale'>;
  /** The game that ended in this conversation moments ago, for play_again; null otherwise. */
  lastEnded(): Promise<{ game: GameId; players: Player[] } | null>;
  newSeed(): number;
}

const GAME_SAYS: Record<GameErrReason, string> = {
  no_game: "There's no game going right now. Want to start one?",
  wrong_game: "That's not the game we're playing right now.",
  not_allowed: "That game isn't switched on here. A grown-up can change it in the Bob app.",
  time_limit: "That's all the game time for today. Let's play again tomorrow!",
  quiet_hours: "It's quiet time now, so games are resting. Let's play another time!",
  bad_input: "Hmm, let's try that a different way.",
  not_your_turn: "Hold on, it's someone else's turn.",
  stale: 'Oops, let me try that again.',
  store_down: "Games aren't working right now. Let's try again in a bit.",
};

export function gameErr(reason: GameErrReason, say: string = GAME_SAYS[reason]): GameErr {
  return { ok: false, reason, say: say.slice(0, 200) };
}

/** A callback rejection as a typed result; never thrown to the model. */
export function gameErrOf(error: unknown): GameErr {
  if (error instanceof GameStaleError) return gameErr('stale');
  if (error instanceof GameRefusedError) return gameErr(error.reason);
  return gameErr('store_down');
}

/** "Maya 3, Leo 2", or "3 points" for one player. */
function speakScores(players: readonly Player[], scores: readonly number[]): string {
  if (players.length <= 1) return `${scores[0] ?? 0} point${scores[0] === 1 ? '' : 's'}`;
  return players.map((player, i) => `${player.name} ${scores[i] ?? 0}`).join(', ');
}

/** The game's own view, with the status the engine control sets. */
function engineView(entry: RegisteredGame, game: OpenGame, status?: GameView['status']): GameView {
  const view = entry.definition.view(game.state, game.players);
  return status === undefined ? view : { ...view, status };
}

function gameOk(say: string, view: GameView, extra: { expect_reply?: boolean; host_notes?: string } = {}): GameOk {
  return {
    ok: true, say: say.slice(0, 600), speak_verbatim: false, expect_reply: extra.expect_reply === true,
    ...(extra.host_notes === undefined ? {} : { host_notes: extra.host_notes.slice(0, 300) }), view,
  };
}

/** The open prompt as spoken: the view's lines, closed by the game's question while one is open. */
function prompt(view: GameView, ask?: string): string {
  const text = view.line2 === undefined ? view.line1 : `${view.line1} ${view.line2}`;
  return ask === undefined || view.status !== 'prompt' || text.endsWith(ask) ? text : `${text} ${ask}`;
}

/**
 * Named players with their bands clamped to the account's max band; one "You" when none.
 * A said age picks the band (bandForAge) and wins over any band the model sent; with
 * neither, a player gets the start's band or else the account's max band.
 */
function buildPlayers(named: ReadonlyArray<{ name: string; age?: number; band?: Band; team?: 'a' | 'b' }>, band: Band | undefined, maxBand: Band, teams: boolean): Player[] {
  const fallback = lowerBand(band ?? maxBand, maxBand);
  const bandOf = (player: { age?: number; band?: Band }): Band =>
    lowerBand(player.age === undefined ? player.band ?? fallback : bandForAge(player.age), maxBand);
  const players: Player[] = named.length > 0
    ? named.map((player) => ({ name: player.name.trim(), band: bandOf(player) }))
    : [{ name: 'You', band: fallback }];
  return teams ? players.map((player, i) => ({ ...player, team: i % 2 === 0 ? 'a' : 'b' })) : players;
}

type Run<I, O> = (input: I) => Promise<O>;
const guarded = <I, O>(run: Run<I, O | GameErr>): Run<I, O | GameErr> => async (input) => {
  try { return await run(input); } catch (error) { return gameErrOf(error); }
};

export function createEngineTools(cb: EngineCallbacks): Record<string, Tool> {
  const open = async (): Promise<{ game: OpenGame; entry: RegisteredGame } | GameErr> => {
    const game = await cb.current();
    if (game === null) return gameErr('no_game');
    const entry = getGame(game.game);
    return entry === undefined ? gameErr('wrong_game') : { game, entry };
  };

  const begin = async (entry: RegisteredGame, players: Player[], opts: Pick<StartGameInput, 'teams' | 'options'>): Promise<GameResult> => {
    const def = entry.definition;
    if (players.length < def.minPlayers || players.length > def.maxPlayers) {
      return gameErr('bad_input', `${entry.title} is for ${def.minPlayers} to ${def.maxPlayers} players.`);
    }
    const band = players.reduce<Band>((low, player) => lowerBand(low, player.band), players[0]!.band);
    if (!def.bands.includes(band)) return gameErr('not_allowed', `${entry.title} is for older players. Want a different game?`);
    const seed = cb.newSeed();
    const state = def.init({ players, teams: opts.teams === true, band, ...(opts.options ? { options: opts.options } : {}) }, mulberry32(seed));
    const created = await cb.create({ game: def.id, players, seed, state });
    if (created === 'conflict') return gameErr('not_allowed', 'A game is already going. Want me to stop it first?');
    // The opening prompt is spoken, as resume_game does, so nobody needs the screen to play.
    const view = engineView(entry, created);
    return gameOk(`Let's play ${entry.title}! ${prompt(view, def.ask)}`, view, {
      expect_reply: true, host_notes: 'Welcome the players, then use the game tools for every move.',
    });
  };

  const start = guarded<StartGameInput, GameOk>(async (input) => {
    const refused = await cb.refusal();
    if (refused !== null) return gameErr(refused);
    const settings = await cb.settings();
    // A said age decides the band, so the model's band does not narrow the games then.
    const aged = (input.players ?? []).some((player) => player.age !== undefined);
    const entry = allowedGames(settings, aged ? undefined : input.band).find(({ definition }) => definition.id === input.game);
    if (entry === undefined) return gameErr('not_allowed');
    const running = await cb.current();
    if (running !== null) {
      return gameErr('not_allowed', `We're still playing ${getGame(running.game)?.title ?? 'a game'}. Want me to stop it first?`);
    }
    return begin(entry, buildPlayers(input.players ?? [], input.band, settings.maxBand, input.teams === true), input);
  });

  const pause = guarded<Record<string, never>, GameOk>(async () => {
    const found = await open();
    if (!('entry' in found)) return found;
    const { game, entry } = found;
    if (game.status === 'paused') return gameOk('The game is already paused.', engineView(entry, game, 'paused'));
    const paused = await cb.pause(game.version);
    if (paused === 'stale') return gameErr('stale');
    return gameOk('Game paused. Just ask when you want to carry on.', engineView(entry, paused, 'paused'));
  });

  const resume = guarded<Record<string, never>, GameOk>(async () => {
    const found = await open();
    if (!('entry' in found)) return found;
    const refused = await cb.refusal();
    if (refused !== null) return gameErr(refused);
    const game = found.game.status === 'active' ? found.game : await cb.resume(found.game.version);
    if (game === 'stale') return gameErr('stale');
    const view = engineView(found.entry, game);
    return gameOk(`We're back! ${prompt(view, found.entry.definition.ask)}`, view, { expect_reply: true, host_notes: 'Wait for their answer.' });
  });

  const stop = guarded<Record<string, never>, GameOk>(async () => {
    const found = await open();
    if (!('entry' in found)) return found;
    const { game, entry } = found;
    const view = engineView(entry, game, 'ended');
    if (await cb.end(game.version) === 'stale') return gameErr('stale');
    const say = game.players.length <= 1
      ? `Game over! You got ${speakScores(game.players, game.scores)}.`
      : `Game over! Final scores: ${speakScores(game.players, game.scores)}.`;
    return gameOk(say, view, { host_notes: 'You may offer play_again once.' });
  });

  const status = guarded<{ repeat?: boolean }, GameOk>(async (input) => {
    const found = await open();
    if (!('entry' in found)) return found;
    const { game, entry } = found;
    const view = engineView(entry, game, game.status === 'paused' ? 'paused' : undefined);
    const parts = [
      input.repeat === true ? prompt(view, entry.definition.ask) : '',
      view.turn === undefined ? '' : `It's ${view.turn}'s turn.`,
      `Scores: ${speakScores(game.players, game.scores)}.`,
    ];
    return gameOk(parts.filter((part) => part !== '').join(' '), view, { expect_reply: input.repeat === true });
  });

  const again = guarded<{ same_players: boolean }, GameOk>(async (input) => {
    if (await cb.current() !== null) return gameErr('not_allowed', "We're still playing. Want me to stop this game first?");
    const refused = await cb.refusal();
    if (refused !== null) return gameErr(refused);
    const last = await cb.lastEnded();
    if (last === null) return gameErr('no_game', "There's no game that just finished. Want to start a new one?");
    const settings = await cb.settings();
    const entry = allowedGames(settings).find(({ definition }) => definition.id === last.game);
    if (entry === undefined) return gameErr('not_allowed');
    const kept = input.same_players ? last.players : [];
    const teams = kept.some((player) => player.team !== undefined);
    return begin(entry, buildPlayers(kept, undefined, settings.maxBand, teams), { teams });
  });

  return {
    list_games: tool({
      description: 'List the playable games with a one-line pitch; band narrows it.',
      inputSchema: listGamesInputSchema,
      outputSchema: gameListResultSchema,
      execute: guarded<{ band?: Band }, GameListResult>(async (input) => {
        const games = allowedGames(await cb.settings(), input.band);
        const say = games.length === 0
          ? 'There are no games to play right now.'
          : `We can play ${games.map((entry) => entry.title).join(', ')}.`;
        return { ok: true, say, games: games.map(({ definition, title, pitch }) => ({ game: definition.id, title, pitch })) };
      }),
    }),
    start_game: tool({
      description: "Start a game; players are first names, plus age when they said it (never ask). Speak the returned say.",
      inputSchema: startGameInputSchema,
      outputSchema: gameResultSchema,
      execute: start,
    }),
    pause_game: tool({
      description: 'Pause the running game.',
      inputSchema: emptyGameInputSchema, outputSchema: gameResultSchema, execute: pause,
    }),
    resume_game: tool({
      description: 'Resume the paused game.',
      inputSchema: emptyGameInputSchema, outputSchema: gameResultSchema, execute: resume,
    }),
    stop_game: tool({
      description: 'End the game and read the scores.',
      inputSchema: emptyGameInputSchema, outputSchema: gameResultSchema, execute: stop,
    }),
    game_status: tool({
      description: "Turn and score; repeat re-reads the prompt.",
      inputSchema: gameStatusInputSchema, outputSchema: gameResultSchema, execute: status,
    }),
    play_again: tool({
      description: 'Replay the game that just ended; same_players keeps the names.',
      inputSchema: playAgainInputSchema, outputSchema: gameResultSchema, execute: again,
    }),
  };
}

/** After the cue, a separator (the packs' "Simon says, ...") and then a word. */
const CUE_SEPARATED = /^\s*[,:;–—-]\s*\p{L}/u;
/** After the cue, a word with no separator ("Simon says jump!"). */
const CUE_FOLLOWED = /^\s+\p{L}/u;
/** Before the cue, the start of the text or of a clause (punctuation, not a word). */
const CLAUSE_START = /(?:^|[^\p{L}\p{N}\s])\s*$/u;

/**
 * How often `text` uses `cue` in a command's shape: the cue (whole words, any
 * case and spacing) followed by an instruction. That is the cue, a separator
 * and a word anywhere, or at a clause start the cue and a word. A bare mention
 * of a game named like its cue ("We're playing Simon Says!", "let's play Simon
 * Says again") is no command. Only the declared cue and punctuation decide it,
 * never a list of phrases.
 */
function cueCount(text: string, cue: string): number {
  const escaped = cue.trim().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\s+/gu, '\\s+');
  let count = 0;
  for (const match of text.matchAll(new RegExp(`\\b${escaped}\\b`, 'giu'))) {
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    if (CUE_SEPARATED.test(after) || (CLAUSE_START.test(before) && CUE_FOLLOWED.test(after))) count += 1;
  }
  return count;
}

/**
 * S1 output guard: kids' content comes only from the reviewed packs, so in an
 * active game the reply may carry a game's prompt cue (its fixed frame, such as
 * Simon's "Simon says") no more often than this turn's tool outputs did. More
 * cues than the tools gave means the model composed game content itself.
 * It checks the model's output, never the player's words.
 */
export function offScriptGameReply(reply: string, says: readonly string[], cues: readonly string[]): boolean {
  return cues.some((cue) => cue.trim() !== '' && cueCount(reply, cue) > says.reduce((n, say) => n + cueCount(say, cue), 0));
}

/** The reply to speak: as given, or on an off-script reply the last tool `say` of the turn, else `fallback`. */
export function guardOffScript(reply: string, says: readonly string[], cues: readonly string[], fallback: string): string {
  if (!offScriptGameReply(reply, says, cues)) return reply;
  return says.length > 0 ? says[says.length - 1]! : fallback;
}

/** The engine control names, in scope order. */
export const ENGINE_TOOL_NAMES = ['list_games', 'start_game', 'pause_game', 'resume_game', 'stop_game', 'game_status', 'play_again'] as const;
