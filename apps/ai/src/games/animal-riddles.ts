/**
 * Animal Riddles (tool-contracts.md section 2). A pure,
 * seeded reducer over the curated pack in content/animal-riddles.json, a view
 * for both screens, and three tools: riddle_guess, riddle_hint, riddle_skip.
 *
 * The server judges every guess: it normalises the text (lower case, articles
 * stripped, singular form, a light sound fold such as "ph" -> "f") and matches
 * the answer and aliases, with Levenshtein <= 1 for answers of 5+ letters. The
 * 3rd miss reveals the answer with no penalty. When a 'little' player is in the
 * game every line is gentle and never says "wrong" or "no" (safety.md S7).
 * Host notes ride in the tool output, never in the system prompt.
 */
import { z } from 'zod';
import { tool } from 'ai';
import type { Tool } from 'ai';
import {
  bandSchema, iconIdSchema,
  type Band, type GameCallbacks, type GameDefinition, type GameErr, type GameOk, type GameSnapshot, type GameView,
  type Player, type StartOptions,
} from './engine.ts';
import { gameErr, gameErrOf, gameResultSchema } from './engine-tools.ts';
import type { Rng } from './rng.ts';
import packJson from './content/animal-riddles.json' with { type: 'json' };

export const RIDDLES_PER_GAME = 6;
const MAX_HINTS = 2;
const MISSES_TO_REVEAL = 3;
/** Device text lines are 40 chars; a clue must wrap into two of them. */
export const LINE_CHARS = 40;
/** Closes every spoken riddle and clue, the engine's opening included. */
const WHO_AM_I = 'Who am I?';

const riddleSchema = z
  .object({
    id: z.string().regex(/^[a-z_]+$/),
    answer: z.string().min(1).max(30),
    aliases: z.array(z.string().min(1).max(30)),
    clues: z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]),
    sound: z.string().regex(/^[a-z_]+$/),
    band: bandSchema,
  })
  .strict();
type Riddle = z.infer<typeof riddleSchema>;

const poolSchema = z.object({ little: z.array(z.string()).min(6), kid: z.array(z.string()).min(6), grown: z.array(z.string()).min(6) }).strict();
export const riddlePackSchema = z
  .object({
    _readme: z.array(z.string()),
    pack: z.literal('animal_riddles'),
    version: z.number().int(),
    review: z.object({ status: z.string(), reviewer: z.string().nullable() }).strict(),
    copy: z.object({ praise: poolSchema, encourage: poolSchema, close: poolSchema }).strict(),
    riddles: z.array(riddleSchema).min(RIDDLES_PER_GAME),
  })
  .strict();
type RiddlePack = z.infer<typeof riddlePackSchema>;

export const RIDDLE_PACK: RiddlePack = riddlePackSchema.parse(packJson);
const RIDDLES_BY_ID: ReadonlyMap<string, Riddle> = new Map(RIDDLE_PACK.riddles.map((r) => [r.id, r]));

export function riddleById(id: string): Riddle {
  const riddle = RIDDLES_BY_ID.get(id);
  if (riddle === undefined) throw new Error(`unknown riddle ${id}`);
  return riddle;
}

// ---- Judging ---------------------------------------------------------------

const ARTICLES: ReadonlySet<string> = new Set(['a', 'an', 'the']);
const IRREGULAR: Readonly<Record<string, string>> = {
  mice: 'mouse', geese: 'goose', oxen: 'ox', wolves: 'wolf', calves: 'calf', octopi: 'octopus', hippopotami: 'hippopotamus',
};

/** Lower-case words with apostrophes dropped and articles removed. */
function guessWords(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().replace(/['’`]/gu, '')
    .split(/[^a-z]+/u).filter((word) => word !== '' && !ARTICLES.has(word));
}

/** The word plus every singular it could be the plural of. */
function singulars(word: string): string[] {
  const out = new Set([word]);
  const irregular = IRREGULAR[word];
  if (irregular !== undefined) out.add(irregular);
  if (word.endsWith('ies') && word.length > 4) out.add(`${word.slice(0, -3)}y`);
  if (word.endsWith('ves')) { out.add(`${word.slice(0, -3)}f`); out.add(`${word.slice(0, -3)}fe`); }
  if (word.endsWith('es')) out.add(word.slice(0, -2));
  if (word.endsWith('s') && !word.endsWith('ss')) out.add(word.slice(0, -1));
  return [...out];
}

/** Spaces dropped, a light sound fold, doubled letters squashed: "sea horse" = "seahorse", "elefant" = "elephant". */
function fold(text: string): string {
  return text.replace(/\s+/gu, '').replace(/ph/gu, 'f').replace(/ck/gu, 'k').replace(/(.)\1+/gu, '$1');
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** Each trailing run of the guess ("is it elephant" -> "elephant"), last word in every singular form. */
function candidates(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let start = 0; start < words.length; start++) {
    const head = words.slice(start, -1).join(' ');
    for (const last of singulars(words[words.length - 1]!)) out.push(head === '' ? last : `${head} ${last}`);
  }
  return out;
}

type Judgement = 'correct' | 'close' | 'wrong';

/** Judges a guess against a riddle's answer and aliases. */
export function judgeGuess(guess: string, riddle: Pick<Riddle, 'answer' | 'aliases'>): Judgement {
  const words = guessWords(guess);
  if (words.length === 0) return 'wrong';
  const guesses = candidates(words).map(fold);
  let close = false;
  for (const target of [riddle.answer, ...riddle.aliases]) {
    const want = fold(target.toLowerCase());
    for (const got of guesses) {
      if (got === want) return 'correct';
      const distance = levenshtein(got, want);
      if (want.length >= 5 && distance <= 1) return 'correct';
      if (want.length >= 6 && distance === 2) close = true;
    }
    // "bear" for "polar bear": one word of a longer answer is close.
    const parts = target.toLowerCase().split(' ');
    if (parts.length > 1 && guesses.some((got) => parts.some((part) => fold(part) === got))) close = true;
  }
  return close ? 'close' : 'wrong';
}

// ---- State and reducer -----------------------------------------------------

const riddlesStateSchema = z
  .object({
    tone: bandSchema,                                     // the youngest band in the game: sets the copy
    riddles: z.array(z.string()).min(1),                  // riddle ids in play order
    index: z.number().int().min(0),                       // the open riddle; riddles.length once done
    shown: z.number().int().min(1).max(3),                // clues shown for the open riddle
    hints: z.number().int().min(0).max(MAX_HINTS),        // of those, asked for with riddle_hint
    misses: z.number().int().min(0),
    stars: z.array(z.number().int().min(0)).min(1),       // per player, mirrored into scores
    rotate: z.number().int().min(0),                      // seeded offset into the copy pools
    said: z.object({ praise: z.number().int(), encourage: z.number().int(), close: z.number().int() }).strict(),
  })
  .strict();
export type RiddlesState = z.infer<typeof riddlesStateSchema>;

const BAND_ORDER: readonly Band[] = ['little', 'kid', 'grown'];

/** Six riddles, each from the band of the player whose turn it will be; no repeats. */
export function initRiddles(opts: StartOptions, rng: Rng): RiddlesState {
  const queues = new Map<Band, string[]>(BAND_ORDER.map((band) =>
    [band, rng.shuffle(RIDDLE_PACK.riddles.filter((r) => r.band === band).map((r) => r.id))]));
  const riddles: string[] = [];
  for (let i = 0; i < RIDDLES_PER_GAME; i++) {
    const band = opts.players[i % opts.players.length]!.band;
    const queue = queues.get(band)!;
    riddles.push(queue.shift()!);
  }
  return {
    tone: opts.band, riddles, index: 0, shown: 1, hints: 0, misses: 0,
    stars: opts.players.map(() => 0), rotate: rng.int(0, 5), said: { praise: 0, encourage: 0, close: 0 },
  };
}

export type RiddleAction = { type: 'guess'; guess: string } | { type: 'hint' } | { type: 'skip' };
type RiddleResult = 'correct' | 'close' | 'wrong' | 'revealed' | 'hint' | 'no_more_hints';

interface RiddleStep {
  state: RiddlesState;
  result: RiddleResult;
  /** The riddle the action was about. */
  riddle: Riddle;
  /** A clue newly shown by this step, if any. */
  clue?: string;
  points: number;
  /** Which player acted (the turn holder). */
  player: number;
  ended: boolean;
}

function isDone(s: RiddlesState): boolean {
  return s.index >= s.riddles.length;
}

function advance(s: RiddlesState): RiddlesState {
  return { ...s, index: s.index + 1, shown: 1, hints: 0, misses: 0 };
}

/** The pure reducer: the same state and action always give the same step. */
export function reduceRiddles(s: RiddlesState, action: RiddleAction): RiddleStep {
  const riddle = riddleById(s.riddles[s.index]!);
  const player = s.index % s.stars.length;
  const step = (state: RiddlesState, result: RiddleResult, extra: { clue?: string; points?: number } = {}): RiddleStep =>
    ({ state, result, riddle, points: extra.points ?? 0, player, ended: isDone(state), ...(extra.clue === undefined ? {} : { clue: extra.clue }) });
  if (action.type === 'skip') return step(advance(s), 'revealed');
  if (action.type === 'hint') {
    if (s.hints >= MAX_HINTS || s.shown >= 3) return step(s, 'no_more_hints');
    return step({ ...s, shown: s.shown + 1, hints: s.hints + 1 }, 'hint', { clue: riddle.clues[s.shown] });
  }
  const judged = judgeGuess(action.guess, riddle);
  if (judged === 'correct') {
    // A hint costs nothing for 'little'; older players earn 3 stars less one per hint.
    const points = riddle.band === 'little' ? 1 : Math.max(1, 3 - s.hints);
    const stars = s.stars.map((n, i) => (i === player ? n + points : n));
    return step(advance({ ...s, stars, said: { ...s.said, praise: s.said.praise + 1 } }), 'correct', { points });
  }
  const said = judged === 'close' ? { ...s.said, close: s.said.close + 1 } : { ...s.said, encourage: s.said.encourage + 1 };
  const missed = { ...s, misses: s.misses + 1, said };
  if (missed.misses >= MISSES_TO_REVEAL) return step(advance(missed), 'revealed');
  // Little and kid get a free clue after a miss; grown players just try again.
  if (s.tone !== 'grown' && s.shown < 3) return step({ ...missed, shown: s.shown + 1 }, judged, { clue: riddle.clues[s.shown] });
  return step(missed, judged);
}

// ---- Copy and view ---------------------------------------------------------

/** "an elephant", "a cat". */
function withArticle(answer: string): string {
  return `${/^[aeiou]/u.test(answer) ? 'an' : 'a'} ${answer}`;
}

/** Greedy word wrap into device lines; a clue must fit in two. */
export function wrapLines(text: string, width: number = LINE_CHARS): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/u)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && `${last} ${word}`.length <= width) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word.slice(0, width));
  }
  return lines;
}

function pool(s: RiddlesState, kind: keyof RiddlesState['said']): string {
  const lines = RIDDLE_PACK.copy[kind][s.tone];
  return lines[(s.rotate + s.said[kind] - 1 + lines.length) % lines.length]!;
}

function clueNow(s: RiddlesState): string {
  return riddleById(s.riddles[s.index]!).clues[s.shown - 1] ?? '';
}

/** The open riddle as spoken, with the turn holder's name first in a group. */
function promptLine(s: RiddlesState, players: readonly Player[]): string {
  const who = players.length > 1 ? `${players[s.index % players.length]?.name ?? 'Next'}, your turn! ` : '';
  const first = riddleById(s.riddles[s.index]!).clues[0];
  return `${who}Riddle ${s.index + 1} of ${s.riddles.length}. ${first} Who am I?`;
}

function starWord(n: number): string {
  return `${n} star${n === 1 ? '' : 's'}`;
}

/** The end: one player hears their stars; a group hears only the leader (S7: nobody is called last). */
function endLine(s: RiddlesState, players: readonly Player[]): string {
  if (s.stars.length <= 1) return `That's all ${s.riddles.length} riddles, and you got ${starWord(s.stars[0] ?? 0)}! Play again?`;
  const top = Math.max(...s.stars);
  const leaders = s.stars.flatMap((n, i) => (n === top ? [players[i]?.name ?? 'Someone'] : []));
  const lead = leaders.length === 1 ? `${leaders[0]} has the most stars` : `It's a tie between ${leaders.join(' and ')}`;
  return `That's all ${s.riddles.length} riddles! ${lead}, with ${starWord(top)}. Play again?`;
}

/** What the tool says for one reducer step (every 'little' path is gentle). */
export function sayStep(step: RiddleStep, players: readonly Player[]): string {
  const s = step.state;
  const it = withArticle(step.riddle.answer);
  const next = step.ended ? endLine(s, players) : '';
  const again = s.tone === 'grown' ? 'Try again.' : 'Have another go!';
  const clue = step.clue === undefined ? again : `Here's a clue: ${step.clue} Who am I?`;
  const soft = s.tone === 'little';
  const parts: Record<RiddleResult, string> = {
    correct: `${pool(s, 'praise')} It's ${it}!`,
    close: `${pool(s, 'close')} ${clue}`,
    wrong: `${pool(s, 'encourage')} ${clue}`,
    revealed: soft ? `It was ${it}! What a tricky one.` : s.tone === 'kid' ? `It was ${it}! Tricky one.` : `It was ${it}.`,
    hint: `Here's another clue: ${step.clue ?? ''} Who am I?`,
    no_more_hints: soft ? "That's all my clues! Have a guess, or I can tell you." : "That's all the clues. Have a guess, or I can tell you.",
  };
  const opened = step.result === 'correct' || step.result === 'revealed';
  return [parts[step.result], opened && !step.ended ? promptLine(s, players) : next].filter((p) => p !== '').join(' ');
}

function viewRiddles(s: RiddlesState, players: Player[]): GameView {
  const scores = players.slice(0, 6).map((p, i) => ({ name: p.name, points: s.stars[i] ?? 0 }));
  const base = { game: 'animal_riddles' as const, title: 'Animal Riddles', scores };
  if (isDone(s)) {
    const total = s.stars.reduce((a, b) => a + b, 0);
    return { ...base, status: 'ended', icon: 'trophy', line1: 'All done!', line2: starWord(total), progress: { n: s.riddles.length, of: s.riddles.length } };
  }
  const [line1 = '', line2] = wrapLines(clueNow(s));
  const turn = players.length > 1 ? players[s.index % players.length]?.name : undefined;
  return {
    ...base, status: 'prompt', icon: 'question', line1, ...(line2 === undefined ? {} : { line2 }),
    ...(turn === undefined ? {} : { turn }),
    progress: { n: s.index + 1, of: s.riddles.length }, hints: { used: s.shown - 1, of: MAX_HINTS },
  };
}

// ---- Tools -----------------------------------------------------------------

const riddleGuessInputSchema = z
  .object({ guess: z.string().trim().min(1).max(40), player: z.string().max(20).optional() })
  .strict();
const riddleEmptyInputSchema = z.object({}).strict();

const RIDDLE_HOST_NOTES = {
  open: 'Read the riddle as written, then wait. Send their exact words to riddle_guess; the server judges. Use riddle_hint when they ask for help or are stuck, riddle_skip when they want the answer.',
  ended: 'The game has ended. Offer play_again once; if they say no, say a warm goodbye.',
} as const;

type Loaded = { snap: GameSnapshot<RiddlesState>; state: RiddlesState };

async function load(cb: GameCallbacks<RiddlesState>): Promise<Loaded | GameErr> {
  const snap = await cb.current();
  if (snap === null) return gameErr('no_game');
  if (snap.game !== 'animal_riddles') return gameErr('wrong_game');
  const parsed = riddlesStateSchema.safeParse(snap.state);
  if (!parsed.success) return gameErr('store_down');
  if (isDone(parsed.data)) return gameErr('no_game');
  return { snap, state: parsed.data };
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** In a group, a named answer from a player other than the turn holder. An unknown name counts as the holder. */
function outOfTurn(players: readonly Player[], s: RiddlesState, named: string | undefined): GameErr | null {
  if (named === undefined || players.length <= 1) return null;
  const holder = players[s.index % players.length];
  if (holder === undefined || sameName(holder.name, named) || !players.some((p) => sameName(p.name, named))) return null;
  return gameErr('not_your_turn', `That's ${holder.name}'s turn! ${named.trim()}, yours is coming.`);
}

function sprite(riddle: Riddle): GameView['icon'] {
  const parsed = iconIdSchema.safeParse(riddle.id);
  return parsed.success ? parsed.data : undefined;
}

async function play(cb: GameCallbacks<RiddlesState>, action: RiddleAction, named?: string): Promise<GameOk | GameErr> {
  try {
    const loaded = await load(cb);
    if (!('snap' in loaded)) return loaded;
    const { snap, state } = loaded;
    const blocked = outOfTurn(snap.players, state, cb.speaker() ?? named);
    if (blocked !== null) return blocked;
    const step = reduceRiddles(state, action);
    if (step.state !== state) {
      await cb.commit({
        version: snap.version, state: step.state, scores: step.state.stars,
        turnIndex: step.ended ? 0 : step.state.index % step.state.stars.length, ...(step.ended ? { ended: true } : {}),
      });
    }
    const view = viewRiddles(step.state, snap.players);
    const icon = step.result === 'correct' || step.result === 'revealed' ? sprite(step.riddle) : undefined;
    const miss = !step.ended && (step.result === 'close' || step.result === 'wrong');
    return {
      ok: true, say: sayStep(step, snap.players).slice(0, 600),
      speak_verbatim: !step.ended && step.result !== 'no_more_hints', expect_reply: true,
      host_notes: step.ended ? RIDDLE_HOST_NOTES.ended : RIDDLE_HOST_NOTES.open,
      view: { ...view, ...(miss ? { status: 'feedback' as const } : {}), ...(icon === undefined ? {} : { icon }) },
    };
  } catch (error) {
    return gameErrOf(error);
  }
}

function riddleTools(cb: GameCallbacks<RiddlesState>): Record<string, Tool> {
  return {
    riddle_guess: tool({
      description: 'Judge a guess at the current riddle; pass their words. Speak the say.',
      inputSchema: riddleGuessInputSchema, outputSchema: gameResultSchema,
      execute: async (input) => play(cb, { type: 'guess', guess: input.guess }, input.player),
    }),
    riddle_hint: tool({
      description: 'Next clue for the current riddle.',
      inputSchema: riddleEmptyInputSchema, outputSchema: gameResultSchema,
      execute: async () => play(cb, { type: 'hint' }),
    }),
    riddle_skip: tool({
      description: 'Reveal the answer and go to the next riddle.',
      inputSchema: riddleEmptyInputSchema, outputSchema: gameResultSchema,
      execute: async () => play(cb, { type: 'skip' }),
    }),
  };
}

/**
 * What riddle_hint would say now (same reducer and copy, nothing stored). A guess's
 * line hangs on the server's judgement and a skip's names the answer, so both are
 * null: the model only calls them, and the answer never reaches it before the reveal.
 */
function previewRiddles(snap: GameSnapshot<RiddlesState>): Record<string, string | null> {
  const parsed = riddlesStateSchema.safeParse(snap.state);
  if (!parsed.success || isDone(parsed.data)) return {};
  const hint = sayStep(reduceRiddles(parsed.data, { type: 'hint' }), snap.players).slice(0, 600);
  return { riddle_guess: null, riddle_hint: hint, riddle_skip: null };
}

export const animalRiddles: GameDefinition<RiddlesState> = {
  id: 'animal_riddles', bands: ['little', 'kid', 'grown'], minPlayers: 1, maxPlayers: 6, ask: WHO_AM_I,
  init: initRiddles, view: viewRiddles, tools: riddleTools, preview: previewRiddles,
};

export const ANIMAL_RIDDLES_META = { title: 'Animal Riddles', pitch: 'I describe an animal with clues, and you guess who I am!' } as const;
