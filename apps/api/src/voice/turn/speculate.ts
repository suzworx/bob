/**
 * The speculative reply. At the server's end of turn the model starts on the stable STT
 * hypothesis, while the device still waits out its silence. A matching final transcript commits the run
 * (its buffered text streams out at once); a different one, more speech, or a cancel aborts it. Until the
 * commit nothing reaches the socket and nothing is persisted: text is buffered, tools wait on a gate.
 * Journal fields are enums and ms only, never the hypothesis, transcript or reply.
 */
import { MP3_16K_MONO_FORMAT, type SessionDto } from '../protocol.ts';
import { sincePrevTurnMs } from '../turn-core.ts';
import { TurnCancelledError } from './abort.ts';
import type { TurnDeps } from './deps.ts';
import { normaliseTranscript } from './end-of-turn.ts';
import { generateReply, peekEarlyPrep, SpeculationIneligibleError, type EarlyPrep, type GeneratedReply } from './generate.ts';
import type { EndOfTurnEvent } from './stream-stt.ts';

/** Runs one turn may start: a second end after the user kept talking, never a third. */
const SPECULATION_MAX_RUNS = 2;

type SpeculationReason = 'kept_talking' | 'aborted' | 'superseded' | 'mismatch' | 'no_transcript' | 'error' | 'limit' | 'not_eligible' | 'no_end_of_turn';

interface SpeculationOutcome {
  speculation: 'used' | 'discarded' | 'none';
  speculation_reason?: SpeculationReason;
  saved_ms?: number;
}

/** The turn's speculation as runTurn sees it. */
export interface Speculation {
  /**
   * Commits the live run when `finalText` is the hypothesis it started on (same words, any case or punctuation) and
   * `signal` is not aborted: its buffered text goes to `onText` at once, its tools wait for `prepare`, and it resolves
   * the run's reply once `prepare` settles too. Otherwise it discards the run (aborted, else mismatch) and resolves
   * undefined. A committed run can still end not eligible (the early context resolved after turn_end): that error comes
   * before the model runs, so no text went out, and it also resolves undefined for the caller's own reply to take over.
   */
  tryCommit(
    finalText: string, onText: ((delta: string) => void) | undefined, signal: AbortSignal | undefined, prepare: Promise<void>,
  ): Promise<GeneratedReply | undefined>;
  /** Aborts the live run; a no-op after commit or with no live run. */
  discard(reason: SpeculationReason): void;
  outcome(): SpeculationOutcome;
}

/** What takeSpeculation hands out: the seam, plus the raw run the speculation tests drive directly. */
interface TakenSpeculation extends Speculation {
  /** A run is held, not yet committed or discarded. */
  readonly live: boolean;
  /** Forwards the buffered text to `onText` at once, releases the tools once `after` settles, and returns the run's reply. */
  commit(onText?: (delta: string) => void, signal?: AbortSignal, after?: Promise<void>): Promise<GeneratedReply>;
}

interface Run {
  key: string;
  controller: AbortController;
  gate: { promise: Promise<void>; resolve: () => void; reject: (reason: unknown) => void };
  buffered: string[];
  forward: ((delta: string) => void) | null;
  startedAt: number;
  settledAt?: number;
  commitAt?: number;
  reply: Promise<GeneratedReply>;
}

interface Entry { turnRef: string; runs: number; live: Run | null; used: Run | null; reason?: SpeculationReason; taken: boolean }

/** One entry per session: the turn in flight. */
const entries = new WeakMap<SessionDto, Entry>();

function discardLive(entry: Entry, reason: SpeculationReason): void {
  const run = entry.live;
  if (run === null) return;
  entry.live = null;
  entry.reason = reason;
  run.controller.abort();
  run.gate.reject(new Error('speculation_discarded'));
  run.buffered = [];
}

function startRun(deps: TurnDeps, session: SessionDto, entry: Entry, early: EarlyPrep, turnRef: string, hypothesis: string, key: string): Run {
  const controller = new AbortController();
  const gate = {} as Run['gate'];
  gate.promise = new Promise<void>((resolve, reject) => { gate.resolve = resolve; gate.reject = reject; });
  gate.promise.catch(() => undefined);
  const onText = (delta: string): void => { if (run.forward !== null) run.forward(delta); else if (!controller.signal.aborted) run.buffered.push(delta); };
  // The condition runTurn streams on: a PCM device's real run is batch, so its speculative one is too.
  const streams = session.formatId === MP3_16K_MONO_FORMAT;
  /** Ends this run as not eligible, so it is not a started run: a live one leaves the turn; one runTurn committed meanwhile
   *  rejects, and runTurn falls back to its own reply. A run discarded already has nothing left to undo. */
  const ineligible = (): never => {
    if (entry.live === run) entry.live = null;
    else if (entry.used === run) entry.used = null;
    else throw new SpeculationIneligibleError();
    entry.runs -= 1;
    entry.reason = 'not_eligible';
    throw new SpeculationIneligibleError();
  };
  const reply = early.context.then(async ({ memory, contextMs }) => {
    if (memory === null) return ineligible();
    if (controller.signal.aborted) throw new TurnCancelledError();
    return generateReply(deps, session, hypothesis, turnRef, memory, controller.signal, contextMs, streams ? onText : undefined, undefined, early, { speculative: true, toolGate: gate.promise });
  });
  const run: Run = { key, controller, gate, buffered: [], forward: null, startedAt: Date.now(), reply };
  // Marked handled now: the reply is awaited only on commit, and an abort or a failure must not be an unhandled rejection.
  reply.then(() => { run.settledAt = Date.now(); }, (error: unknown) => {
    run.settledAt = Date.now();
    if (error instanceof TurnCancelledError) return;
    // Only this run's own failure: a superseded or discarded run's late rejection must not end the newer one.
    if (error instanceof SpeculationIneligibleError) {
      // generateReply's own ineligible ends (no usable history): a started run, wherever it stands.
      if (entry.live === run) entry.live = null;
      else if (entry.used === run) entry.used = null;
      else return;
      entry.reason = 'not_eligible';
      return;
    }
    if (entry.live === run) discardLive(entry, 'error');
  });
  return run;
}

/** The turn deps' onEndOfTurn: the server's end of turn starts or keeps a run, more speech or a cancel aborts it. */
export function onSpeculationEvent(deps: TurnDeps, session: SessionDto, turnRef: string, event: EndOfTurnEvent, hypothesis: string): void {
  let entry = entries.get(session);
  if (entry !== undefined && entry.turnRef !== turnRef) {
    discardLive(entry, 'aborted');
    entry = undefined;
  }
  if (entry?.taken === true) return;
  if (event !== 'end') {
    if (entry !== undefined) discardLive(entry, event === 'resume' ? 'kept_talking' : 'aborted');
    return;
  }
  if (entry === undefined) {
    entry = { turnRef, runs: 0, live: null, used: null, taken: false };
    entries.set(session, entry);
  }
  const key = normaliseTranscript(hypothesis);
  if (entry.live?.key === key) return;
  discardLive(entry, 'superseded');
  if (entry.runs >= SPECULATION_MAX_RUNS) { entry.reason = 'limit'; return; }
  const early = peekEarlyPrep(session, turnRef);
  if (early === undefined || !session.activeConversationId || key === '') { entry.reason = 'not_eligible'; return; }
  entry.runs += 1;
  entry.live = startRun(deps, session, entry, early, turnRef, hypothesis, key);
}

/** The turn's speculation, taken once at the start of runTurn (before anything aborts the STT stream, whose 'drop' would end it). */
export function takeSpeculation(session: SessionDto, turnRef: string): TakenSpeculation {
  const found = entries.get(session);
  // An entry left by another turn ends with it.
  if (found !== undefined && found.turnRef !== turnRef) {
    discardLive(found, 'aborted');
    entries.delete(session);
  }
  const entry: Entry = found?.turnRef === turnRef ? found : { turnRef, runs: 0, live: null, used: null, reason: 'no_end_of_turn', taken: true };
  entry.taken = true;
  const commit: TakenSpeculation['commit'] = (onText, signal, after) => {
    const run = entry.live;
    if (run === null) throw new Error('no live speculation to commit');
    entry.live = null;
    entry.used = run;
    run.commitAt = Date.now();
    // The run skipped this record (it stamps "now" as the conversation's last turn); the committed turn makes it.
    sincePrevTurnMs(session.activeConversationId);
    run.forward = onText ?? ((): void => undefined);
    if (signal?.aborted === true) run.controller.abort();
    else signal?.addEventListener('abort', () => { run.controller.abort(); }, { once: true });
    for (const delta of run.buffered.splice(0)) run.forward(delta);
    if (after === undefined) run.gate.resolve(); else after.then(run.gate.resolve, run.gate.resolve);
    return run.reply.then((reply) => {
      if (reply.keptHistory !== undefined) session.messages = reply.keptHistory;
      return reply;
    });
  };
  return {
    get live() { return entry.live !== null; },
    commit,
    tryCommit(finalText, onText, signal, prepare) {
      const aborted = signal?.aborted === true;
      if (entry.live === null || entry.live.key !== normaliseTranscript(finalText) || aborted) {
        discardLive(entry, aborted ? 'aborted' : 'mismatch');
        return Promise.resolve(undefined);
      }
      return commit(onText, signal, prepare).then(async (kept) => { await prepare; return kept; })
        .catch((error: unknown) => { if (error instanceof SpeculationIneligibleError) return undefined; throw error; });
    },
    discard: (reason) => { discardLive(entry, reason); },
    outcome() {
      const run = entry.used;
      if (run?.commitAt !== undefined) return { speculation: 'used', saved_ms: Math.min(run.commitAt, run.settledAt ?? run.commitAt) - run.startedAt };
      if (entry.runs > 0) return { speculation: 'discarded', speculation_reason: entry.reason ?? 'aborted' };
      return { speculation: 'none', speculation_reason: entry.reason ?? 'no_end_of_turn' };
    },
  };
}
