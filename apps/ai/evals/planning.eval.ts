/**
 * Planning eval suite (#898): "Plan my week using my tasks and events" must
 * get a plan, not a question. Owner, production web chat 2026-10-07:
 * list_tasks and list_agenda were called, then the reply asked "What would
 * you like to plan?" instead of proposing one. Needs AI_GATEWAY_API_KEY; no
 * npm script (package.json is outside this unit's owns):
 * `npx tsx apps/ai/evals/planning.eval.ts`.
 *
 * Each fixture runs twice, once per replyStyle ('text', then 'voice'), through
 * the full memory-on device-turn agent (buildToolEvalAgent, tool-agent.ts),
 * seeded (PLAN-SEED) with the fixture's own tasks/agenda picture so a real
 * list_tasks/list_agenda call returns real data instead of today's empty stub
 * result -- the earlier trick of carrying that picture as fake prior turns in
 * `history` left the model's own (correct) tool call contradicting the
 * conversation, which is the bug #898 reports. `fixture.seed` resolves to
 * real ISO dates in the current week at load time (resolvePlanningSeed,
 * fixtures.ts), since the eval agent has no fixed clock: "today" is whenever
 * the suite runs.
 */
import { runEvalSuite } from './eval-runner.ts';
import { noMarkdown, type OptionalScorerResult, type ScorerResult } from '../src/eval-scorers.ts';
import { assertEvalPreconditions, loadFixtures, planningCaseSchema, resolvePlanningSeed, type PlanningCase } from './fixtures.ts';
import { buildToolEvalAgent } from './tool-agent.ts';

assertEvalPreconditions();

const REPLY_STYLES = ['text', 'voice'] as const;
type PlanningReplyStyle = (typeof REPLY_STYLES)[number];

/** One fixture run with one reply style. */
interface PlanningRow {
  fixture: PlanningCase;
  replyStyle: PlanningReplyStyle;
}

const fixtures = loadFixtures('planning', planningCaseSchema);
const data = fixtures.flatMap((fixture) =>
  REPLY_STYLES.map((replyStyle) => ({
    input: { fixture, replyStyle } as PlanningRow,
    expected: undefined,
    metadata: { replyStyle },
  })),
);

/** Weekday names and clock times ("10am", "2:30pm", "14:00") a plan can point to. */
const WEEKDAY_RE = /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi;
const TIME_RE = /\b\d{1,2}:\d{2}\s?(?:am|pm)?\b|\b\d{1,2}\s?(?:am|pm)\b/gi;

function dayOrTimeMentions(text: string): number {
  return (text.match(WEEKDAY_RE) ?? []).length + (text.match(TIME_RE) ?? []).length;
}

function endsWithQuestion(text: string): boolean {
  return text.trimEnd().endsWith('?');
}

/** 1 when list_agenda or list_tasks was called this turn, else 0. */
function calledPlanningTools(toolNames: string[]): ScorerResult {
  const called = toolNames.includes('list_agenda') || toolNames.includes('list_tasks');
  return { name: 'calledPlanningTools', score: called ? 1 : 0 };
}

/**
 * #898/PLAN-GUIDE2: null when the seed is empty -- there is nothing to build
 * a concrete plan from, so the fixture should not be scored on giving one.
 * On a non-empty seed, 1 when the reply names at least 2 weekdays/times and
 * does not end with only a question, else 0.
 */
function givesConcretePlan(text: string, seedNonEmpty: boolean): OptionalScorerResult {
  if (!seedNonEmpty) return { name: 'givesConcretePlan', score: null };
  const detailed = dayOrTimeMentions(text) >= 2;
  return { name: 'givesConcretePlan', score: detailed && !endsWithQuestion(text) ? 1 : 0 };
}

/** now is fixed once per suite run, so every fixture/replyStyle pair sees the same "today". */
const now = new Date();

await runEvalSuite({
  experimentName: 'planning',
  data,
  task: async ({ fixture, replyStyle }: PlanningRow) => {
    const agent = buildToolEvalAgent({
      ...(fixture.memory ? { memoryContext: fixture.memory } : {}),
      timeZone: 'America/Los_Angeles',
      mode: replyStyle === 'voice' ? 'device' : 'chat',
      seed: resolvePlanningSeed(fixture.seed, now),
    });
    const result = await agent.generate({
      messages: [{ role: 'user', content: fixture.input }],
    });
    const toolNames = result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName));
    console.log(`[planning] "${fixture.input}" (${replyStyle}) tools=${toolNames.join(',') || 'none'} :: ${result.text.slice(0, 160)}`);
    return { text: result.text, toolNames };
  },
  scores: [
    ({ output }) => calledPlanningTools(output.toolNames),
    ({ input, output }) =>
      givesConcretePlan(output.text, input.fixture.seed.tasks.length > 0 || input.fixture.seed.agenda.length > 0),
    ({ input, output }) => (input.replyStyle === 'voice' ? noMarkdown(output.text) : null),
  ],
});
