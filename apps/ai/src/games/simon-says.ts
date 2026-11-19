/**
 * Simon Says (tool-contracts.md section 2). A pure, seeded
 * reducer over the curated pack in content/simon-says.json, a view for both
 * screens, and two tools: simon_next and simon_caught.
 *
 * The engine picks every command and whether it is a trick (no "Simon says"):
 * about 30% tricks, and for 'little' never two tricks in a row (after a Simon
 * command the trick chance is raised so the long-run rate stays ~30%). Players
 * are on their honour: simon_caught marks them out, and a confession with no
 * names counts for the whole room. The round ends after 12 commands or when one
 * player is left (none, solo). In quiet hours only `calm` commands are used.
 * Host notes ride in the tool output, never in the system prompt.
 */
import { z } from 'zod';
import { tool } from 'ai';
import type { Tool } from 'ai';
import {
  bandSchema,
  type Band, type GameCallbacks, type GameDefinition, type GameErr, type GameOk, type GameSnapshot, type GameView,
  type Player, type StartOptions,
} from './engine.ts';
import { gameErr, gameErrOf, gameResultSchema } from './engine-tools.ts';
import { rngAt, type Rng } from './rng.ts';
import packJson from './content/simon-says.json' with { type: 'json' };

export const COMMANDS_PER_ROUND = 12;
const TRICK_RATE = 0.3;
/** 'little' never gets a trick after a trick, so after a Simon command the chance is p with p / (1 + p) = 30%. */
const LITTLE_TRICK_AFTER_SIMON = TRICK_RATE / (1 - TRICK_RATE);
/** A command is one device line. */
const LINE_CHARS = 40;

const commandSchema = z
  .object({ text: z.string().min(1).max(LINE_CHARS), band: bandSchema, calm: z.boolean() })
  .strict();
type SimonCommand = z.infer<typeof commandSchema>;

const poolSchema = z.object({ little: z.array(z.string()).min(3), kid: z.array(z.string()).min(3), grown: z.array(z.string()).min(3) }).strict();
export const simonPackSchema = z
  .object({
    _readme: z.array(z.string()),
    pack: z.literal('simon_says'),
    version: z.number().int(),
    review: z.object({ status: z.string(), reviewer: z.string().nullable() }).strict(),
    copy: z.object({ gotcha: poolSchema, cheer: poolSchema, faster: poolSchema }).strict(),
    commands: z.array(commandSchema).min(COMMANDS_PER_ROUND),
  })
  .strict();
type SimonPack = z.infer<typeof simonPackSchema>;

export const SIMON_PACK: SimonPack = simonPackSchema.parse(packJson);

/** A stable id from the text ("Touch your nose!" -> "touch_your_nose"), for the lint. */
export function commandId(command: Pick<SimonCommand, 'text'>): string {
  return command.text.toLowerCase().replace(/[^a-z]+/gu, '_').replace(/^_+|_+$/gu, '');
}

// ---- State and reducer -----------------------------------------------------

const simonStateSchema = z
  .object({
    tone: bandSchema,                                            // the youngest band in the game: sets the pool and copy
    salt: z.number().int().min(0),                               // seeds each pick with rngAt(salt, count)
    count: z.number().int().min(0).max(COMMANDS_PER_ROUND),      // commands given; the last is the open one
    used: z.array(z.number().int().min(0)),                      // pack indices, in order
    simon: z.boolean(),                                          // the open command had "Simon says"
    tricks: z.number().int().min(0),
    out: z.array(z.number().int().min(1).nullable()).min(1),     // per player: the command they were caught on
    ended: z.boolean(),
    said: z.object({ gotcha: z.number().int().min(0) }).strict(),
  })
  .strict();
export type SimonState = z.infer<typeof simonStateSchema>;

const BAND_ORDER: readonly Band[] = ['little', 'kid', 'grown'];

/** Pack indices a game of `tone` may use: its band and younger, only calm ones in quiet hours. */
export function eligible(tone: Band, quiet: boolean): number[] {
  const max = BAND_ORDER.indexOf(tone);
  return SIMON_PACK.commands.flatMap((c, i) => (BAND_ORDER.indexOf(c.band) <= max && (!quiet || c.calm) ? [i] : []));
}

/** Gives the next command: a fresh one when any is left, a trick by the balanced chance. */
function issue(s: SimonState, quiet: boolean): SimonState {
  const rng = rngAt(s.salt, s.count);
  const pool = eligible(s.tone, quiet);
  const fresh = pool.filter((i) => !s.used.includes(i));
  const pick = rng.pick(fresh.length > 0 ? fresh : pool);
  const afterTrick = s.count > 0 && !s.simon;
  const chance = s.tone !== 'little' ? TRICK_RATE : afterTrick ? 0 : LITTLE_TRICK_AFTER_SIMON;
  const trick = rng.next() < chance;
  return { ...s, count: s.count + 1, used: [...s.used, pick], simon: !trick, tricks: s.tricks + (trick ? 1 : 0) };
}

/** A new round with the first command already given (start_game speaks it). */
export function initSimon(opts: StartOptions, rng: Rng, quiet: boolean = false): SimonState {
  const base: SimonState = {
    tone: opts.band, salt: rng.int(0, 2 ** 31 - 1), count: 0, used: [], simon: true, tricks: 0,
    out: opts.players.map(() => null), ended: false, said: { gotcha: 0 },
  };
  return issue(base, quiet);
}

export type SimonAction = { type: 'next' } | { type: 'caught'; players: number[] | 'all' };
type SimonResult = 'command' | 'caught' | 'ended';

export interface SimonStep {
  state: SimonState;
  result: SimonResult;
  /** Players newly marked out by this step. */
  caught: number[];
  ended: boolean;
}

function stillIn(s: SimonState): number[] {
  return s.out.flatMap((at, i) => (at === null ? [i] : []));
}

/** Commands survived: the round so far for those still in, the ones before their catch for the rest. */
export function simonScores(s: SimonState): number[] {
  return s.out.map((at) => (at === null ? s.count : at - 1));
}

/** The pure reducer: the same state, action and quiet flag always give the same step. */
export function reduceSimon(s: SimonState, action: SimonAction, quiet: boolean = false): SimonStep {
  if (action.type === 'next') {
    if (s.count >= COMMANDS_PER_ROUND) return { state: { ...s, ended: true }, result: 'ended', caught: [], ended: true };
    return { state: issue(s, quiet), result: 'command', caught: [], ended: false };
  }
  const caught = action.players === 'all' ? stillIn(s) : [...new Set(action.players)].filter((i) => s.out[i] === null);
  const marked = { ...s, out: s.out.map((at, i) => (caught.includes(i) ? s.count : at)), said: { gotcha: s.said.gotcha + 1 } };
  const left = stillIn(marked).length;
  const over = s.count >= COMMANDS_PER_ROUND || (s.out.length > 1 ? left <= 1 : left === 0);
  if (over) return { state: { ...marked, ended: true }, result: 'caught', caught, ended: true };
  return { state: issue(marked, quiet), result: 'caught', caught, ended: false };
}

// ---- Copy and view ---------------------------------------------------------

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function openCommand(s: SimonState): SimonCommand {
  return SIMON_PACK.commands[s.used[s.used.length - 1] ?? 0]!;
}

/** The open command as spoken: "Simon says, touch your nose!" or the bare trick "Touch your nose!". */
export function commandLine(s: SimonState): string {
  const text = openCommand(s).text;
  return s.simon ? `Simon says, ${lowerFirst(text)}` : text;
}

function pool(s: SimonState, kind: keyof SimonPack['copy'], n: number): string {
  const lines = SIMON_PACK.copy[kind][s.tone];
  return lines[(s.salt + n) % lines.length]!;
}

function names(list: readonly string[]): string {
  return list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** The end: champions only, never who went out first (S7). */
function endLine(s: SimonState, players: readonly Player[]): string {
  const champs = stillIn(s).map((i) => players[i]?.name ?? 'Someone');
  if (s.out.length <= 1) {
    return champs.length === 1
      ? `You made it through all ${s.count} commands. You're a Simon champion! Play again?`
      : `That's the end of the round. You lasted ${simonScores(s)[0] ?? 0} commands! Play again?`;
  }
  if (champs.length === 0) return 'Simon tricked everybody this time! Great listening, everyone. Play again?';
  return champs.length === 1 ? `Our Simon champion is... ${champs[0]}! Play again?` : `Our Simon champions are ${names(champs)}! Play again?`;
}

/** What the tool says for one reducer step (`before` is the state the action was about). */
export function saySimon(before: SimonState, step: SimonStep, players: readonly Player[]): string {
  const s = step.state;
  const next = step.ended ? endLine(s, players) : commandLine(s);
  if (step.result === 'command') return s.count === 7 ? `${pool(s, 'faster', 0)} ${next}` : next;
  if (step.result === 'ended') return `${pool(s, 'cheer', 0)} That's all ${s.count} commands! ${next}`;
  const oops = before.simon
    ? (s.tone === 'little' ? "Oops, Simon did say that one! That's OK." : 'Simon did say that one!')
    : pool(s, 'gotcha', s.said.gotcha);
  const who = players.length > 1 && step.caught.length > 0 && step.caught.length < stillIn(before).length
    ? `${names(step.caught.map((i) => players[i]?.name ?? 'Someone'))}, you're out this round. You can help me watch!`
    : '';
  return [oops, who, step.ended ? '' : 'Next one!', next].filter((p) => p !== '').join(' ');
}

function viewSimon(s: SimonState, players: Player[]): GameView {
  const points = simonScores(s);
  const scores = players.slice(0, 6).map((p, i) => ({ name: p.name, points: points[i] ?? 0 }));
  const base = { game: 'simon_says' as const, title: 'Simon Says', scores, progress: { n: s.count, of: COMMANDS_PER_ROUND } };
  if (s.ended) {
    const champs = stillIn(s).map((i) => players[i]?.name ?? '');
    const line2 = champs.length === 0 || players.length <= 1 ? undefined : `Champion: ${champs.join(', ')}`.slice(0, LINE_CHARS);
    return { ...base, status: 'ended', icon: 'trophy', line1: 'Round over!', ...(line2 === undefined ? {} : { line2 }) };
  }
  const text = openCommand(s).text;
  return { ...base, status: 'prompt', icon: 'simon_says', ...(s.simon ? { line1: 'Simon says,', line2: lowerFirst(text) } : { line1: text }) };
}

// ---- Tools -----------------------------------------------------------------

const simonNextInputSchema = z.object({}).strict();
const simonCaughtInputSchema = z
  .object({ players: z.array(z.string().trim().min(1).max(20)).max(6).optional() })
  .strict();

const SIMON_HOST_NOTES = {
  open: 'Speak the say exactly, then wait. When they answer, your next action is a tool call, not your own words: simon_next for the next command, or simon_caught only if a player says they moved. You never create Simon commands; they exist only in simon_next.',
  caught: 'The next command is already in say: speak it exactly and wait. Do not call simon_next for it. You never create Simon commands; they exist only in the tools.',
  trick: 'This command is a trick (no "Simon says"). When they answer, call simon_next if nobody says they moved, even when nobody moved at all; call simon_caught only with players who say they moved. You never create Simon commands; they exist only in simon_next.',
  ended: 'The round has ended. Offer play_again once; if they say no, say a warm goodbye.',
} as const;

/** The host note for a step: after a trick the model must still go to a tool for the next command (S1). */
export function simonHostNotes(step: Pick<SimonStep, 'ended' | 'result' | 'state'>): string {
  if (step.ended) return SIMON_HOST_NOTES.ended;
  if (step.state.simon) return step.result === 'caught' ? SIMON_HOST_NOTES.caught : SIMON_HOST_NOTES.open;
  return step.result === 'caught' ? `The next command is already in say. ${SIMON_HOST_NOTES.trick}` : SIMON_HOST_NOTES.trick;
}

/** Where the account's quiet hours come from; apps/api may bind it. Unbound means not quiet. */
interface SimonEnv {
  quiet?: () => boolean;
}

type Loaded = { snap: GameSnapshot<SimonState>; state: SimonState };

async function load(cb: GameCallbacks<SimonState>): Promise<Loaded | GameErr> {
  const snap = await cb.current();
  if (snap === null) return gameErr('no_game');
  if (snap.game !== 'simon_says') return gameErr('wrong_game');
  const parsed = simonStateSchema.safeParse(snap.state);
  if (!parsed.success) return gameErr('store_down');
  if (parsed.data.ended) return gameErr('no_game');
  return { snap, state: parsed.data };
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Named players to indices. No name (and no recognised speaker) is the whole room; so is any name when solo. */
function whoCaught(players: readonly Player[], named: readonly string[]): number[] | 'all' | GameErr {
  if (named.length === 0 || players.length <= 1) return 'all';
  const found = players.flatMap((p, i) => (named.some((n) => sameName(p.name, n)) ? [i] : []));
  if (found.length > 0) return found;
  return gameErr('bad_input', `Who got caught? Say their name, like ${players[0]?.name ?? 'Maya'}, or "we all moved".`);
}

type Request = { type: 'next' } | { type: 'caught'; named: string[] };

async function play(cb: GameCallbacks<SimonState>, env: SimonEnv, request: Request): Promise<GameOk | GameErr> {
  try {
    const loaded = await load(cb);
    if (!('snap' in loaded)) return loaded;
    const { snap, state } = loaded;
    let resolved: SimonAction = { type: 'next' };
    if (request.type === 'caught') {
      // A recognised speaker wins over the model's names.
      const speaker = cb.speaker();
      const who = whoCaught(snap.players, speaker === null ? request.named : [speaker]);
      if (who !== 'all' && !Array.isArray(who)) return who;
      resolved = { type: 'caught', players: who };
    }
    const step = reduceSimon(state, resolved, env.quiet?.() === true);
    await cb.commit({ version: snap.version, state: step.state, scores: simonScores(step.state), turnIndex: 0, ...(step.ended ? { ended: true } : {}) });
    return {
      ok: true, say: saySimon(state, step, snap.players).slice(0, 600),
      speak_verbatim: !step.ended, expect_reply: true,
      host_notes: simonHostNotes(step),
      view: viewSimon(step.state, snap.players),
    };
  } catch (error) {
    return gameErrOf(error);
  }
}

/**
 * What simon_next, and solo simon_caught, would say now: the same reducer and copy
 * as the tools, nothing stored. With several players a catch names who moved, so
 * simon_caught has no line (null): the model passes the names and its say is spoken.
 */
function previewSimon(snap: GameSnapshot<SimonState>, quiet: boolean = false): Record<string, string | null> {
  const parsed = simonStateSchema.safeParse(snap.state);
  if (!parsed.success || parsed.data.ended) return {};
  const s = parsed.data;
  const line = (action: SimonAction): string => saySimon(s, reduceSimon(s, action, quiet), snap.players).slice(0, 600);
  return { simon_next: line({ type: 'next' }), simon_caught: snap.players.length > 1 ? null : line({ type: 'caught', players: 'all' }) };
}

/** The open command's host note: after a trick it says how to judge "we didn't move". */
function noteSimon(snap: GameSnapshot<SimonState>): string | null {
  const parsed = simonStateSchema.safeParse(snap.state);
  if (!parsed.success || parsed.data.ended) return null;
  return simonHostNotes({ ended: false, result: 'command', state: parsed.data });
}

export function simonTools(cb: GameCallbacks<SimonState>, env: SimonEnv = {}): Record<string, Tool> {
  return {
    simon_next: tool({
      description: 'The next Simon Says command, also right after a trick; every command comes from here, never make one up. Speak the say exactly.',
      inputSchema: simonNextInputSchema, outputSchema: gameResultSchema,
      execute: async () => play(cb, env, { type: 'next' }),
    }),
    simon_caught: tool({
      description: 'Mark caught players out (names, or none for the whole room).',
      inputSchema: simonCaughtInputSchema, outputSchema: gameResultSchema,
      execute: async (input) => play(cb, env, { type: 'caught', named: input.players ?? [] }),
    }),
  };
}

export const simonSays: GameDefinition<SimonState> = {
  id: 'simon_says', bands: ['little', 'kid', 'grown'], minPlayers: 1, maxPlayers: 6,
  init: (opts, rng) => initSimon(opts, rng), view: viewSimon, tools: (cb) => simonTools(cb),
  preview: (snap) => previewSimon(snap), note: noteSimon,
};

/**
 * Simon's prompt frame for the S1 output guard (engine-tools offScriptGameReply):
 * only simon_next and simon_caught may give a command in its shape ("Simon says,
 * touch your nose"); naming the game ("We're playing Simon Says!") is no command.
 */
export const SIMON_CUES: readonly string[] = ['Simon says'];

export const SIMON_SAYS_META = {
  title: 'Simon Says', pitch: 'Do what Simon says, but only when I say "Simon says"!', cues: SIMON_CUES, advance: 'simon_next',
} as const;
