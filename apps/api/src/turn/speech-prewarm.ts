/**
 * Speech ahead: the clauses a device turn synthesizes before it speaks them (prewarmed game lines, TTS_AHEAD slots).
 * Trigger: turn/game-turn.ts (an ACTIVE game's preview lines) and voice/turn/playback.ts createSentencePlayback.
 * Steps: 1. prewarmSpeech starts the first clause of each previewed line while the model runs. 2. a sentence playback
 *   takes its turn's prewarmed clause by exact text, once, else makes a fresh call. 3. up to TTS_AHEAD sentences
 *   synthesize at once.
 * Outcome: a reply that speaks a previewed line finds its audio ready; nothing is sent or persisted here, and a
 *   prewarm that fails or is aborted is simply not used.
 * Journal: none (turn/tts-journal.ts journals prewarm_hits and prewarm_lines).
 */
import { ttsVoiceFor } from '@bob/ai';
import { wholeMp3, type TtsMp3Result } from '../voice/speech-port.ts';
import { createReplySplitter } from '../voice/audio/stt-tts.ts';
import { speakable } from '../voice/audio/speakable.ts';
import { MP3_16K_MONO_FORMAT, type SessionDto } from '../voice/protocol.ts';
import { abortable } from '../voice/turn/abort.ts';
import type { TurnDeps } from '../voice/turn/deps.ts';

/** Most previewed lines one turn synthesizes ahead. */
const PREWARM_MAX_LINES = 3;

/** Per session, the turn's prewarmed clauses by exact text (speculate.ts keeps the same one-entry shape). */
const prewarms = new WeakMap<SessionDto, { turnRef: string; ready: Map<string, Promise<TtsMp3Result | null>> }>();

/**
 * Starts the first clause of each previewed game line now, while the model
 * runs, so a reply that speaks one of them (a silent tool call, or the one-step
 * guard's line) finds its audio ready. MP3 clause path only: PCM keeps its
 * whole-reply call. Nothing is sent or persisted here, and a prewarm that
 * fails or is aborted is simply not used.
 */
export function prewarmSpeech(
  deps: TurnDeps, session: SessionDto, turnRef: string, lines: ReadonlyArray<string | null>, signal?: AbortSignal,
): void {
  if (session.formatId !== MP3_16K_MONO_FORMAT || signal?.aborted === true) return;
  const voice = ttsVoiceFor(session.assistantName);
  for (const line of lines) {
    if (line === null) continue;
    const splitter = createReplySplitter();
    const [first = ''] = [...splitter.push(line), ...splitter.flush()];
    const text = speakable(first);
    if (text === '') continue;
    // The turn's entry is made only once a line is started, so a turn with nothing to prewarm journals no counts.
    const held = prewarms.get(session);
    const entry = held?.turnRef === turnRef ? held : { turnRef, ready: new Map<string, Promise<TtsMp3Result | null>>() };
    if (entry.ready.size >= PREWARM_MAX_LINES || entry.ready.has(text)) continue;
    prewarms.set(session, entry);
    const pending = abortable(deps.ttsMp3(text, voice), signal);
    // A prewarm that fails, is aborted or finds no audio leaves the map, so the turn's next run prewarms again.
    const forget = (): void => { if (entry.ready.get(text) === pending) entry.ready.delete(text); };
    pending.then((speech) => { if (speech === null) forget(); }, forget);
    entry.ready.set(text, pending);
  }
}

/** The prewarm counts for a turn's tts completed journal: none unless the turn had a prewarm entry (counts only). */
export function prewarmFields(lines: number | undefined, hits: number): Record<string, number> {
  return lines === undefined ? {} : { prewarm_hits: hits, prewarm_lines: lines };
}

/** One sentence playback's view of its turn's prewarmed clauses: how many it started, how many this reply used. */
export interface TurnPrewarm { lines: number | undefined; hits: number; speechFor(text: string): Promise<TtsMp3Result | null> }

export function turnPrewarm(
  deps: TurnDeps, session: SessionDto, turnRef: string, voice: ReturnType<typeof ttsVoiceFor>, signal: AbortSignal | undefined, halted: () => boolean,
): TurnPrewarm {
  const held = prewarms.get(session);
  const prewarm = held?.turnRef === turnRef ? held : undefined;
  const state: TurnPrewarm = {
    lines: prewarm?.ready.size,
    hits: 0,
    // This turn's prewarmed call for `text`, used once. A prewarm that failed or
    // was aborted is not used: the sentence gets a fresh call, as without one.
    speechFor: (text) => {
      const early = prewarm?.ready.get(text);
      if (prewarm === undefined || early === undefined) return abortable(deps.ttsMp3(text, voice), signal);
      prewarm.ready.delete(text);
      // A prewarm counts as a hit only once its whole clip (tail included) is in hand; a failed one gets one fresh call.
      // Both waits follow this turn's signal, so a cancel never waits on the prewarm's tail.
      return abortable(early.catch(() => null), signal)
        .then((speech) => (speech === null ? null : abortable(wholeMp3(speech), signal).then((mp3) => {
          state.hits += 1;
          // Its timing is the earlier call's, made while the model thought: not this clause's wait.
          return { mp3 };
        }, () => null)))
        .then((warm) => warm ?? (halted() ? null : abortable(deps.ttsMp3(text, voice), signal)));
    },
  };
  return state;
}

/** Up to `count` sentences synthesize at once, so sentence N+1 is ready by the time sentence N finishes playing instead
 *  of starting cold; playback order still follows enqueue order. */
export function ttsSlots(count: number): { acquire(): Promise<void>; release(): void } {
  let free = count;
  const waiters: Array<() => void> = [];
  return {
    acquire: () => {
      if (free > 0) {
        free -= 1;
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    release: () => {
      const next = waiters.shift();
      if (next) next();
      else free += 1;
    },
  };
}
