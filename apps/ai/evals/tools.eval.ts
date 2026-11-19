/**
 * Tool-selection eval suite (spec 009 US3; #410, epic #394 X1): the per-turn
 * agent production builds for a memory-on device turn (buildToolEvalAgent)
 * should call the tool a request needs, and no tool when none is needed.
 *
 * Selection is scored on step 1 only (stub tool results shape later steps);
 * later steps feed overCall alone. Each scorer is also recorded per fixture
 * category as `<scorer>.<category>`, a null score outside that category, so
 * the local summary carries per-category means (the runner drops null
 * scores instead of coercing them to 0). Local reporting via eval-runner.ts
 * (task outputs carry tool names and inputs only, never reply text or
 * secrets).
 * `ownZoneDateTimeCall`
 * records whether currentDateTime was called on own-zone fixtures (02 open
 * question 6). Run 3x with `npm run eval:tools` (M10: ±2 points).
 */
import { runEvalSuite } from './eval-runner.ts';
import type { ModelMessage } from 'ai';
import {
  firstToolMatch,
  noToolFalseCall,
  overCall,
  toolArgsMatch,
  type OptionalScorerResult,
  type ToolCallLike,
} from '../src/eval-scorers.ts';
import { assertEvalPreconditions, loadFixtures, toolCaseSchema, type ToolCase } from './fixtures.ts';
import { buildToolEvalAgent } from './tool-agent.ts';

assertEvalPreconditions();

const CATEGORIES: ToolCase['category'][] = ['single', 'no_tool', 'confusable', 'follow_up', 'stt_noise'];

/** What the task records: tool names and inputs only, never reply text. */
interface ToolEvalOutput {
  firstStepCalls: ToolCallLike[];
  allToolNames: string[];
}

const agent = buildToolEvalAgent();
const data = loadFixtures('tools', toolCaseSchema).map((fixture) => ({
  input: fixture,
  expected: fixture.expected,
  metadata: { category: fixture.category },
}));

/** The prior turns followed by the request, as the model sees them. */
function messagesOf(fixture: ToolCase): ModelMessage[] {
  const prior: ModelMessage[] = (fixture.prior ?? []).map((turn) => turn.role === 'user'
    ? { role: 'user', content: turn.content }
    : { role: 'assistant', content: turn.content });
  return [...prior, { role: 'user', content: fixture.input }];
}

/**
 * 1 when every tool named in `expected` was called exactly as many times as
 * it appears there (across all steps), else 0; null when nothing is expected
 * (no_tool fixtures use noToolFalseCall instead). `expected` already lists
 * tools in call order, so a reminder-per-day fixture names create_reminder
 * twice: firstToolMatch alone (step 1 only) cannot see a right-first-tool,
 * wrong-count miss like one create_reminder where two were asked for (#898).
 */
function toolCallCount(expected: string[], allNames: string[]): OptionalScorerResult {
  if (expected.length === 0) return { name: 'toolCallCount', score: null };
  const wanted = new Map<string, number>();
  for (const name of expected) wanted.set(name, (wanted.get(name) ?? 0) + 1);
  const ok = [...wanted].every(([name, count]) => allNames.filter((n) => n === name).length === count);
  return { name: 'toolCallCount', score: ok ? 1 : 0 };
}

/** True when `expected` itself names the same create_* tool more than once (a per-day
 *  fixture): overCall's "no duplicate create_*" rule does not apply there (#898 c1). */
function expectsRepeatedCreate(expected: string[]): boolean {
  const counts = new Map<string, number>();
  for (const name of expected) {
    if (!name.startsWith('create_')) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.values()].some((count) => count > 1);
}

/** Scores one fixture with every scorer, before the per-category split. */
function scoreFixture(fixture: ToolCase, output: ToolEvalOutput): OptionalScorerResult[] {
  const firstNames = output.firstStepCalls.map((call) => call.toolName);
  const overCallResult = overCall(output.allToolNames);
  return [
    firstToolMatch(fixture.expected, firstNames),
    noToolFalseCall(fixture.expected, firstNames),
    toolArgsMatch(fixture.args, output.firstStepCalls),
    expectsRepeatedCreate(fixture.expected) ? { name: overCallResult.name, score: null } : overCallResult,
    toolCallCount(fixture.expected, output.allToolNames),
  ];
}

/** The overall score plus one `<name>.<category>` score per category (null elsewhere). */
function withCategories(results: OptionalScorerResult[], category: ToolCase['category']): OptionalScorerResult[] {
  return results.flatMap((result) => [
    result,
    ...CATEGORIES.map((c) => ({ name: `${result.name}.${c}`, score: c === category ? result.score : null })),
  ]);
}

await runEvalSuite({
  experimentName: 'tools',
  data,
  maxConcurrency: 8,
  task: async (fixture: ToolCase): Promise<ToolEvalOutput> => {
    const result = await agent.generate({ messages: messagesOf(fixture) });
    const firstStep = result.steps[0];
    return {
      firstStepCalls: (firstStep?.toolCalls ?? []).map((call) => ({ toolName: call.toolName, input: call.input })),
      allToolNames: result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
    };
  },
  scores: [
    ({ input, output }): OptionalScorerResult[] => withCategories(scoreFixture(input, output), input.category),
    ({ input, output }): OptionalScorerResult => ({
      name: 'ownZoneDateTimeCall',
      score: input.own_zone === true
        ? (output.firstStepCalls.some((call) => call.toolName === 'currentDateTime') ? 1 : 0)
        : null,
    }),
  ],
});
