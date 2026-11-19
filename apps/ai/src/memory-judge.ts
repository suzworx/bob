/**
 * The memory judge: decides whether a memory about to be
 * stored is a fact already held, a change to one, or a new fact. The store's
 * own duplicate check is lexical and cannot see that "User's wife's name is
 * Maya" and "User has a wife named Maya." are one fact. Embedding distance
 * cannot decide it either: measured on text-embedding-3-small, a correction
 * (a respelt first name, 0.09) sits closer than a true paraphrase (0.15), so a
 * threshold would swallow corrections. Embeddings only pick the candidates;
 * this model call decides, as Mem0 and Zep/Graphiti do.
 *
 * Pure: no DB, no journal. Under AI_STUB_MODE it answers "different" without
 * calling a model, so stub mode stores exactly what it stored before.
 */
import { generateText, Output, type LanguageModel } from 'ai';
import { agentTelemetry, traceSpan } from './telemetry.ts';
import { z } from 'zod';
import { AI_STUB_MODE } from './config.ts';
import { resolveExtractModel } from './memory-extractor.ts';

/** same: a candidate already states this fact; updates: a candidate holds the
 *  same attribute with a value this replaces; different: neither. */
type MemoryJudgeRelation = 'same' | 'updates' | 'different';

export interface MemoryJudgeVerdict {
  relation: MemoryJudgeRelation;
  /** The candidate the relation is about; null for "different". */
  id: string | null;
}

export interface MemoryJudgeInput {
  content: string;
  candidates: ReadonlyArray<{ id: string; content: string }>;
}

export type MemoryJudge = (input: MemoryJudgeInput) => Promise<MemoryJudgeVerdict>;

const verdictSchema = z.object({
  relation: z.enum(['same', 'updates', 'different']),
  id: z.string().nullable(),
});

export const MEMORY_JUDGE_SYSTEM_PROMPT =
  'You compare one new memory about a user with existing memories about the same user. ' +
  'Answer "same" when an existing memory already states the same fact: same subject, same ' +
  'attribute, same value, whatever the wording ("User has a wife named Maya." and ' +
  '"User\'s wife\'s name is Maya."). Answer "updates" when an existing memory is about the ' +
  'same subject and attribute but the new memory gives a different value, a correction or a ' +
  'change ("User lives in Toronto." then "User lives in Vancouver."; "Maya" then "Maia"), ' +
  'and also when the new memory restates an existing one with more detail ("User is vegetarian." ' +
  'then "User is an Indian vegetarian."): the fuller memory replaces it. When an existing memory ' +
  'already says everything the new one says, and more, answer "same". ' +
  'Answer "different" otherwise, including when the subject differs ("User lives in Berlin." ' +
  'and "User\'s brother lives in Berlin."), when it is about a different thing the user has ' +
  '("User has a dog named Rex." and "User has a cat named Rex." are two pets), or the new ' +
  'memory adds a separate fact. When unsure between "updates" and "different", answer ' +
  '"different": replacing a memory loses it. Opposites ' +
  'and different values are never "same" ("likes coffee" vs "dislikes coffee" is "updates"). ' +
  'Return the id of the existing memory for "same" or "updates", and null for "different".';

/** The user prompt for one decision. Exported for the prompt test. */
export function buildJudgePrompt({ content, candidates }: MemoryJudgeInput): string {
  return [
    `New memory: ${content}`,
    'Existing memories (id: content):',
    ...candidates.map((candidate) => `- ${candidate.id}: ${candidate.content}`),
    'Return JSON only: { "relation": "same" | "updates" | "different", "id": "<existing id>" | null }.',
  ].join('\n');
}

const DIFFERENT: MemoryJudgeVerdict = { relation: 'different', id: null };

/** Builds the judge. A verdict naming an id outside the candidates, or a
 *  "same"/"updates" without an id, is treated as "different": the judge can
 *  only ever point at a row it was shown. */
export function createMemoryJudge(model?: LanguageModel): MemoryJudge {
  return async function judge(input: MemoryJudgeInput): Promise<MemoryJudgeVerdict> {
    if (AI_STUB_MODE || input.candidates.length === 0) return DIFFERENT;
    const result = await traceSpan('bob-memory-judge', { observationType: 'chain' }, () => generateText({
      model: model ?? resolveExtractModel(),
      telemetry: { ...agentTelemetry, functionId: 'bob-memory-judge' },
      output: Output.object({ schema: verdictSchema }),
      system: MEMORY_JUDGE_SYSTEM_PROMPT,
      prompt: buildJudgePrompt(input),
    }));
    const verdict = result.output;
    if (verdict.relation === 'different') return DIFFERENT;
    const known = input.candidates.some((candidate) => candidate.id === verdict.id);
    return known ? { relation: verdict.relation, id: verdict.id } : DIFFERENT;
  };
}
