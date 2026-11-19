/**
 * Memory gate: one evaluation-model call (typesafe-ai/jev by default) scores
 * whether a finished turn holds anything worth remembering, so the costlier
 * extractor runs only when it might. Off unless BOB_MEMORY_GATE is set:
 *   off    (default) the gate is never built and never called
 *   shadow the score is journaled, extraction still runs on every turn
 *   on     a score below MEMORY_GATE_THRESHOLD skips extraction
 * The turn text leaves the process for the gate model, so it stays opt-in.
 * Pure like the extractor: no DB and no journal; the worker decides and logs.
 */
import { experimental_evaluate as evaluate } from 'ai';
import { gateway } from './agents.ts';
import { traceEvaluation } from './telemetry.ts';

type MemoryGateMode = 'off' | 'shadow' | 'on';

/** Probability of "worth remembering" under which `on` skips extraction. Low
 *  on purpose: a wrong skip silently loses a memory, a wrong keep costs one
 *  extraction call. */
export const MEMORY_GATE_THRESHOLD = 0.2;

const MEMORY_GATE_MODEL = process.env.BOB_MEMORY_GATE_MODEL ?? 'typesafe-ai/jev';
const MEMORY_GATE_TIMEOUT_MS = 5_000;

export function memoryGateMode(): MemoryGateMode {
  const value = process.env.BOB_MEMORY_GATE;
  return value === 'shadow' || value === 'on' ? value : 'off';
}

interface MemoryGateInput {
  userText: string;
  assistantText: string;
  /** Account uuid for per-user trace attribution; never journaled. */
  userId?: string;
}

/** Resolves to the probability (0..1) that the turn is worth remembering. */
export type MemoryGate = (input: MemoryGateInput) => Promise<number>;

export function createMemoryGate(): MemoryGate {
  const model = gateway.evaluationModel(MEMORY_GATE_MODEL);
  return ({ userText, assistantText, userId }) => {
    const state = `User: ${userText}\nAssistant: ${assistantText}`;
    return traceEvaluation('bob-memory-gate', MEMORY_GATE_MODEL, state, async () => {
      const { answers } = await evaluate({
        model,
        state,
        questions: {
          memoryWorthy: {
            type: 'boolean',
            instructions:
              'Does the user reveal a lasting fact or preference about themselves, or accept an assistant offer ' +
              'that implies one? Greetings, thanks, small talk and one-off requests are no.',
          },
        },
        abortSignal: AbortSignal.timeout(MEMORY_GATE_TIMEOUT_MS),
      });
      return answers.memoryWorthy.probability;
      }, userId);
  };
}
