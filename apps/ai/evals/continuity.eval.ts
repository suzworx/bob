/**
 * Multi-turn continuity eval suite (spec 009, US3): a question that needs a
 * fact from earlier turns. An LLM judge through the AI Gateway scores whether
 * the reply correctly used the earlier fact (spec 009, FR-006).
 */
import { runEvalSuite } from './eval-runner.ts';
import type { ModelMessage } from 'ai';
import { bobAgent } from '../src/agents.ts';
import { judge } from '../src/eval-judge.ts';
import { assertEvalPreconditions, continuityCaseSchema, loadFixtures } from './fixtures.ts';

assertEvalPreconditions();

const data = loadFixtures('continuity', continuityCaseSchema);

await runEvalSuite({
  experimentName: 'continuity',
  data,
  task: async (input) => {
const messages: Array<ModelMessage> = [
  ...input.turns.map((turn) =>
    turn.role === 'user'
      ? ({ role: 'user', content: turn.content } as const)
      : ({ role: 'assistant', content: turn.content } as const),
  ),
  { role: 'user' as const, content: input.question },
];
    const result = await bobAgent.generate({ messages });
    return {
      text: result.text,
      toolNames: result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
    };
  },
  scores: [
    ({ input, output, expected }) =>
      judge({
        criteria: 'the reply correctly uses the fact from earlier turns',
        input: `${input.turns.map((turn) => `${turn.role}: ${turn.content}`).join('\n')}\nuser: ${input.question}`,
        output: output.text,
        expected,
      }),
  ],
});