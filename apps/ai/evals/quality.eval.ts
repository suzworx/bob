/**
 * Answer-quality eval suite (spec 009, US3): overall factual agreement with a
 * reference answer, judged by a model through the AI Gateway, plus the
 * deterministic noMarkdown rule so quality is measured on speakable replies.
 */
import { runEvalSuite } from './eval-runner.ts';
import { bobAgent } from '../src/agents.ts';
import { judge } from '../src/eval-judge.ts';
import { noMarkdown } from '../src/eval-scorers.ts';
import { assertEvalPreconditions, loadFixtures, qualityCaseSchema } from './fixtures.ts';

assertEvalPreconditions();

const data = loadFixtures('quality', qualityCaseSchema);

await runEvalSuite({
  experimentName: 'quality',
  data,
  task: async (input) => {
    const result = await bobAgent.generate({ messages: [{ role: 'user', content: input }] });
    return {
      text: result.text,
      toolNames: result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
    };
  },
  scores: [
    ({ input, output, expected }) =>
      judge({
        criteria: 'factual agreement with the reference answer',
        input,
        output: output.text,
        expected,
      }),
    ({ output }) => noMarkdown(output.text),
  ],
});