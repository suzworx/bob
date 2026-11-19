/**
 * Games engine core: the pure types every game shares and
 * the shared tool output shapes, exactly as docs/games/tool-contracts.md
 * section 1 specifies. apps/ai owns no SQL: a game's tools run over injected
 * GameCallbacks that apps/api binds to one account, conversation and device.
 *
 * Reducers are pure and all randomness comes from the seeded Rng in rng.ts, so
 * the same seed plus the same actions always gives the same state.
 */
import { z } from 'zod';
import type { Tool } from 'ai';
import type { Rng } from './rng.ts';

export const gameIdSchema = z.enum(['animal_riddles', 'simon_says', 'family_quiz', 'twenty_questions', 'silly_stories']);
export type GameId = z.infer<typeof gameIdSchema>;

export const bandSchema = z.enum(['little', 'kid', 'grown']);
export type Band = z.infer<typeof bandSchema>;

/** An age a player says out loud at start. It only picks the band and is never
 *  stored or repeated (safety.md S3); the model never asks for it. */
export const playerAgeSchema = z.number().int().min(3).max(99);

/** The band for an age, as catalog.md's table has it: little 4-7 (3 counts as
 *  little too), kid 8-12, grown 13+. The server derives it; the model never does. */
export function bandForAge(age: number): Band {
  if (age <= 7) return 'little';
  return age <= 12 ? 'kid' : 'grown';
}

/** The bundled 48x48 device sprites (experience.md section 3). Extend this
 *  enum together with the firmware sprite table, never one without the other. */
export const iconIdSchema = z.enum([
  'animal_riddles', 'simon_says', 'family_quiz', 'twenty_questions', 'silly_stories',
  'trophy', 'pause', 'star', 'question', 'lightbulb',
  'elephant', 'lion', 'cat', 'dog', 'cow', 'duck', 'frog', 'monkey', 'owl', 'pig',
]);
type IconId = z.infer<typeof iconIdSchema>;

export const storyThemeSchema = z.enum(['space', 'animals', 'school', 'food', 'pirates']);
type StoryTheme = z.infer<typeof storyThemeSchema>;

export const categorySchema = z.enum(['animal', 'food', 'object', 'place', 'character']);
type Category = z.infer<typeof categorySchema>;

/** A player for one session only (safety.md S3): a first name or nickname of
 *  one or two words, a band and an optional team. No age, school or location. */
export const playerSchema = z
  .object({
    name: z.string().trim().min(1).max(20).regex(/^\S+( \S+)?$/),
    band: bandSchema,
    team: z.enum(['a', 'b']).optional(),
  })
  .strict();
export type Player = z.infer<typeof playerSchema>;

const startOptionsSchema = z
  .object({
    players: z.array(playerSchema).min(1).max(6),
    teams: z.boolean(),
    band: bandSchema,
    options: z
      .object({ category: categorySchema.optional(), theme: storyThemeSchema.optional() })
      .strict()
      .optional(),
  })
  .strict();
export type StartOptions = z.infer<typeof startOptionsSchema>;

export const gameViewSchema = z.object({
  game: gameIdSchema, title: z.string().max(20), status: z.enum(['intro','prompt','feedback','between','ended','paused']),
  line1: z.string().max(40), line2: z.string().max(40).optional(),        // big text on the device
  icon: iconIdSchema.optional(),                                           // enum of bundled 48x48 sprites
  turn: z.string().max(20).optional(),                                     // whose turn, by name
  scores: z.array(z.object({ name: z.string().max(20), points: z.number().int() })).max(6),
  progress: z.object({ n: z.number().int(), of: z.number().int() }).optional(),
  hints: z.object({ used: z.number().int(), of: z.number().int() }).optional(),
}).strict();
export const gameOkSchema = z.object({
  ok: z.literal(true),
  say: z.string().max(600),          // speak this, reworded freely; facts and results never change
  speak_verbatim: z.boolean(),       // true: content that must be read as written (story, riddle)
  expect_reply: z.boolean(),         // true: the device opens the mic after playback (D6)
  host_notes: z.string().max(300).optional(), // what to do next, e.g. "wait for their guess"
  view: gameViewSchema,
}).strict();
export const gameErrSchema = z.object({ ok: z.literal(false), say: z.string().max(200),
  reason: z.enum(['no_game','wrong_game','not_allowed','time_limit','quiet_hours','bad_input',
    'not_your_turn','stale','store_down']) }).strict();

export type GameView = z.infer<typeof gameViewSchema>;
type GameViewStatus = GameView['status'];
export type GameOk = z.infer<typeof gameOkSchema>;
export type GameErr = z.infer<typeof gameErrSchema>;
export type GameErrReason = GameErr['reason'];
export type GameResult = GameOk | GameErr;

/** The persisted session as a game's tools see it (one bob.game_sessions row). */
export interface GameSnapshot<S> {
  game: GameId;
  seed: number;
  players: Player[];
  turnIndex: number;
  scores: number[];
  state: S;
  version: number;
}

/** What a game hands back to be stored. The store writes it only where the
 *  row's version still equals `version`; a lost race rejects as `stale`. */
interface GameCommit<S> {
  version: number;
  state: S;
  turnIndex: number;
  scores: number[];
  ended?: boolean;
}

/** Injected by apps/api. A rejected promise becomes a gameErrSchema result in
 *  the tool and is never thrown to the model. */
export interface GameCallbacks<S> {
  current(): Promise<GameSnapshot<S> | null>;
  commit(next: GameCommit<S>): Promise<GameSnapshot<S>>;
  /** The recognised speaker from voice ID, set by the server; null when unknown. */
  speaker(): string | null;
}

export interface GameDefinition<S> {
  id: GameId; bands: Band[]; minPlayers: number; maxPlayers: number;
  /** The question that closes every spoken prompt ("Who am I?"), so the engine's
   *  opening, resume and repeat read like the game's own turns. */
  ask?: string;
  init(opts: StartOptions, rng: Rng): S;                     // pure
  view(s: S, players: Player[]): GameView;                   // pure, drives both screens
  tools(cb: GameCallbacks<S>): Record<string, Tool>;         // only while this game runs
  /** The say each named tool would return if called now with no input (pure, nothing stored).
   *  With it the model calls the tool and speaks that line in one step (voice-latency-rca root cause 2).
   *  null: the line hangs on the player's words or names an answer, so the model only calls the tool
   *  and the tool's say is spoken for it, still in one step. */
  preview?(snap: GameSnapshot<S>): Record<string, string | null>;
  /** The open prompt's host note (how to judge the answer), for a one-step turn: the history keeps only
   *  spoken text, so the note on the last tool result is gone by the next turn. */
  note?(snap: GameSnapshot<S>): string | null;
}
