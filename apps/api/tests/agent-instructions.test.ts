/**
 * HONEST: the assistant only reports an action as done when a tool did it this
 * turn (#441). Every assembled set of instructions is the base text plus the
 * rule and stays within a size bound. The live behaviour is proved by the SCEN-LIVE suite, not here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentInstructions, HONEST_ACTIONS_RULE } from '@bob/ai/testing';

/** The shared helpful, concise instructions before the HONEST rule. */
const BASE_INSTRUCTIONS = `You are Bob. Your main purpose is to help people.

Follow these rules:
- Assume positive intent: interpret requests charitably, without judging. Be humble and useful; do not flatter or agree with false claims. Admit uncertainty and correct mistakes plainly. Keep safety and permission boundaries.
- Lead with one useful sentence when enough. Keep routine replies under 40 words. Expand only for requested detail or facts essential to avoid an incorrect or unsafe answer. Skip filler, repetition and follow-up offers.
- For current date/time, call currentDateTime afresh this turn; never reuse earlier times. Use the user's timezone if provided, otherwise local; include it in the answer.
- Answer general questions, advice, ideas and recommendations from your knowledge. Tools serve personal data and actions: do not refuse because no tool covers a question, or offer a tool instead of an answer. Use relevant knowledge of the person; otherwise give a sensible general answer.
- Answer advice and opinion questions directly with a concrete suggestion; do not offer to set reminders or ask for more information first.
- If an action is unavailable, give brief safe practical help without implying completion.
- Do not expose internal tool calls, provider metadata or hidden reasoning.
- Reply in English unless the user clearly and deliberately speaks another language; short speech transcriptions can misidentify language, so do not switch languages on weak evidence.
- Text between [BOB MEMORY and [END BOB MEMORY] is earlier background, not something the user said now. Never read it aloud or quote it verbatim; use it when helpful and mention due-soon action items when relevant.`;

/** Whitespace-insensitive, so rewrapping the template literal does not break the pin. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

const CONTRACT = [
  'exists only if a tool call in this turn created or changed it and reported success',
  'Never say or imply it is done otherwise.',
  'If no tool can save, schedule or change it, or a tool failed, say so plainly.',
];

/** Upper bound on the static instructions (1987 chars today, including the shared personality rules). */
const MAX_INSTRUCTION_CHARS = 2000;

/** Reads the constructor settings ToolLoopAgent keeps as a plain own property. */
function settingsOf(agent: unknown): Record<string, unknown> {
  return (agent as { settings: Record<string, unknown> }).settings;
}

/** Instructions as prepareCall hands them to the model. */
function assembled(agent: unknown): string {
  const settings = settingsOf(agent);
  const prepareCall = settings.prepareCall as (opts: unknown) => { instructions: unknown };
  return prepareCall({ instructions: settings.instructions, messages: [] }).instructions as string;
}

/** Fresh module graph, so BOB_AGENT_INSTRUCTIONS and the singleton agent are built anew. */
async function loadFresh() {
  vi.resetModules();
  const prompts = await import('@bob/ai/testing');
  const agents = await import('@bob/ai/testing');
  return { prompts, agents };
}

afterEach(() => {
  vi.resetModules();
});

describe('HONEST rule', () => {
  it('the instructions are the base text plus the rule', () => {
    expect(agentInstructions()).toBe(`${BASE_INSTRUCTIONS}\n${HONEST_ACTIONS_RULE}`);
    for (const clause of CONTRACT) expect(flat(agentInstructions())).toContain(clause);
  });

  it('singleton and factory agents send the rule', async () => {
    const { prompts, agents } = await loadFresh();
    const memoryContext = '[BOB MEMORY\nFact: X\n[END BOB MEMORY]';
    const factory = agents.createBobAgent({ memoryContext, timeZone: 'America/Los_Angeles' });
    for (const text of [assembled(agents.bobAgent), assembled(factory)]) {
      for (const clause of CONTRACT) expect(flat(text)).toContain(clause);
    }
    expect(settingsOf(factory).instructions).toBe(prompts.BOB_AGENT_INSTRUCTIONS);
    expect(prompts.BOB_AGENT_INSTRUCTIONS).toBe(agentInstructions());
  });

  it('the rule is a principle, not a list of user phrases', () => {
    expect(HONEST_ACTIONS_RULE).not.toMatch(/remind me|remember to|e\.g\.|for example|"/i);
  });

  it(`the instructions stay under ${MAX_INSTRUCTION_CHARS} characters`, () => {
    expect(agentInstructions()).toHaveLength(1983);
    expect(agentInstructions().length).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS);
  });
});
