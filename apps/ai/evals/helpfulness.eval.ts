/** Synthetic cross-surface personality eval. Budget headroom must be checked before running. */
import { runEvalSuite } from './eval-runner.ts';
import { judge } from '../src/eval-judge.ts';
import { noMarkdown, withinWordBudget } from '../src/eval-scorers.ts';
import { assertEvalPreconditions, helpfulnessCaseSchema, loadFixtures } from './fixtures.ts';
import { buildToolEvalAgent } from './tool-agent.ts';
import type { ReplyStyle } from '../src/prompts.ts';
import type { TurnMode } from '../src/agents.ts';

assertEvalPreconditions();

const fixtures = loadFixtures('helpfulness', helpfulnessCaseSchema);
const styles: ReplyStyle[] = ['text', 'group', 'voice'];
/** The turn row that renders each reply style. */
const STYLE_MODE = { text: 'chat', group: 'group', voice: 'device' } as const satisfies Record<ReplyStyle, TurnMode>;

// Four repetitions per style; each flag/layout cell runs in its own process.
for (const replyStyle of styles) {
  const data = Array.from({ length: 4 }, () => fixtures).flat().map((row) => ({ input: row }));
  await runEvalSuite({
    experimentName: `helpfulness-${replyStyle}`,
    data,
    task: async (row) => {
      const agent = buildToolEvalAgent({ mode: STYLE_MODE[replyStyle] });
      const result = await agent.generate({ messages: [{ role: 'user', content: row.input }] });
      return { text: result.text };
    },
    scores: [
      async ({ input, output }) => judge({
        criteria: 'Helpful, humble, charitable and accurate; no filler or routine follow-up offers. Meet the reference requirements without sacrificing needed detail.',
        input: input.input,
        output: output.text,
        expected: input.expected,
      }),
      ({ input, output }) => input.maxWords === undefined ? null : withinWordBudget(output.text, input.maxWords),
      ({ output }) => replyStyle === 'voice' ? noMarkdown(output.text) : null,
    ],
  });
}
