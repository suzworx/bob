/**
 * Voice-reply eval suite (spec 009, US2): scores agent replies against the
 * voice rules the device depends on. All scorers are deterministic and live
 * in apps/ai/src/eval-scorers.ts, unit-tested inside the validation gate.
 */
import { runEvalSuite } from './eval-runner.ts';
import { endsAtSentence, isEnglish, lengthCap700, namesRealAbilities, noIdentityLeak, noMarkdown } from '../src/eval-scorers.ts';
import { assertEvalPreconditions, loadFixtures, voiceReplyCaseSchema } from './fixtures.ts';
import { buildToolEvalAgent } from './tool-agent.ts';

assertEvalPreconditions();

const data = loadFixtures('voice-reply', voiceReplyCaseSchema);

/**
 * #898 (correction c2): the full production device-turn agent (every
 * capability tool, memory on, voice reply style) -- not the bare
 * instructions-only singleton, which cannot name real abilities and does not
 * exercise what the device runs.
 */
const agent = buildToolEvalAgent({ mode: 'device' });

/** Capability questions (#898) where namesRealAbilities applies; other fixtures skip it (null-drop). */
const CAPABILITY_PROMPTS = new Set([
  'What can you do?',
  'How helpful are you? What all can you do?',
]);

await runEvalSuite({
  experimentName: 'voice-reply',
  data,
  task: async (input) => {
    const result = await agent.generate({ messages: [{ role: 'user', content: input }] });
    return {
      text: result.text,
      toolNames: result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
    };
  },
  scores: [
    ({ output }) => lengthCap700(output.text),
    ({ output }) => endsAtSentence(output.text),
    ({ output }) => noMarkdown(output.text),
    ({ output }) => isEnglish(output.text),
    ({ output }) => noIdentityLeak(output.text),
    ({ input, output }) => (CAPABILITY_PROMPTS.has(input) ? namesRealAbilities(output.text) : null),
  ],
});