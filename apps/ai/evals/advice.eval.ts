/**
 * Advice eval suite (#750): ordinary advice questions ("What should I eat for
 * lunch today?") must get a direct answer, not a refusal or an offer to set a
 * reminder. Runs the per-turn agent with the full memory-on tool set
 * (tool-agent.ts) and, per case, the memory block and earlier turns. Needs
 * AI_GATEWAY_API_KEY: `npm run eval:advice`.
 */
import { runEvalSuite } from './eval-runner.ts';
import { answersDirectly, noMarkdown } from '../src/eval-scorers.ts';
import { adviceCaseSchema, assertEvalPreconditions, loadFixtures } from './fixtures.ts';
import { buildToolEvalAgent } from './tool-agent.ts';

assertEvalPreconditions();

const data = loadFixtures('advice', adviceCaseSchema).map((row) => ({ input: row, expected: undefined }));

await runEvalSuite({
  experimentName: 'advice',
  data,
  task: async (row) => {
    const agent = buildToolEvalAgent({ ...(row.memory ? { memoryContext: row.memory } : {}), timeZone: 'America/Los_Angeles' });
    const result = await agent.generate({ messages: [...row.history, { role: 'user', content: row.input }] });
    return {
      text: result.text,
      toolNames: result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
    };
  },
  scores: [
    ({ output }) => answersDirectly(output.text),
    ({ output }) => noMarkdown(output.text),
  ],
});
