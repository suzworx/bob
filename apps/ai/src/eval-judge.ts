/**
 * LLM judge scorer (spec 009, D5): scores an agent output against a written
 * criterion using the AI Gateway chat model with structured output.
 *
 * Constitution V: a missing gateway key is a hard error -- the judge never
 * returns a fabricated score. The key is read at call time so tests can
 * stub it; config.ts loads the repo `.env` at import, so in production the
 * call-time value matches the configured gateway credential.
 */
import { generateText, Output, type LanguageModel } from 'ai';
import { z } from 'zod';
import { gateway } from './agents.ts';
import { BOB_CHAT_MODEL } from './config.ts';
import { agentTelemetry, traceSpan } from './telemetry.ts';

/** Structured output contract for every judge call: a 0..1 score plus rationale. */
export const judgeOutputSchema = z.object({
  score: z.number().min(0).max(1),
  rationale: z.string().max(400),
});

/** The context a judge scores: the criterion and the exchange it applies to. */
export interface JudgeInput {
  /** The criterion to score against, also used as the scorer name. */
  criteria: string;
  input: string;
  output: string;
  /** Optional expected output, included in the prompt when given. */
  expected?: string;
}

/** The judge's scorer result, matching the Braintrust scorer shape. */
export interface JudgeResult {
  name: string;
  score: number;
  metadata: { rationale: string };
}

export interface JudgeOptions {
  /** Override the model (tests inject a mock); the gateway model is used when unset. */
  model?: LanguageModel;
}

/** Judge model id: BOB_EVAL_JUDGE_MODEL overrides the configured chat model. */
function resolveJudgeModelId(): string {
  return process.env.BOB_EVAL_JUDGE_MODEL ?? BOB_CHAT_MODEL;
}

function buildJudgePrompt({ criteria, input, output, expected }: JudgeInput): string {
  const lines = [
    'You are an evaluator for a voice assistant. Score the assistant output against the criterion.',
    `Criterion: ${criteria}`,
    `User input: ${input}`,
    `Assistant output: ${output}`,
  ];
  if (expected !== undefined) {
    lines.push(`Expected output: ${expected}`);
  }
  lines.push(
    'Reply with JSON only: { "score": a number from 0 to 1, "rationale": a short explanation of at most 400 characters }.',
  );
  return lines.join('\n');
}

/**
 * Scores an agent output with the gateway judge model. Fails fast when the
 * gateway key is missing and no model override is given; never fabricates a
 * score. The returned `name` is the criterion, so each judge scorer is
 * identifiable in a Braintrust experiment.
 */
export async function judge(args: JudgeInput, options: JudgeOptions = {}): Promise<JudgeResult> {
  if (options.model === undefined && (process.env.AI_GATEWAY_API_KEY ?? '') === '') {
    throw new Error('eval judge requires AI_GATEWAY_API_KEY (set it or pass a model override)');
  }
  const model = options.model ?? gateway(resolveJudgeModelId());
  const result = await traceSpan('bob-eval-judge', { observationType: 'chain' }, () => generateText({
    model,
    telemetry: { ...agentTelemetry, functionId: 'bob-eval-judge' },
    output: Output.object({ schema: judgeOutputSchema }),
    prompt: buildJudgePrompt(args),
  }));
  return {
    name: args.criteria,
    score: result.output.score,
    metadata: { rationale: result.output.rationale },
  };
}
