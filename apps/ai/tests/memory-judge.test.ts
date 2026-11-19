/**
 * The memory judge (follow-up to #758): decides same / updates / different for
 * a new memory against its nearest current memories. These pin the contract
 * around the model call; the real model's accuracy is checked live
 * (apps/api/tests/live/memory.live.test.ts).
 */
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { MEMORY_JUDGE_SYSTEM_PROMPT, buildJudgePrompt, createMemoryJudge } from '../src/memory-judge.ts';

/** A model that answers every call with this verdict, recording the prompts. */
function answering(verdict: { relation: string; id: string | null }): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text: JSON.stringify(verdict) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

const candidates = [
  { id: 'mem_wife', content: 'User has a wife named Maya.' },
  { id: 'mem_job', content: 'User works as a nurse.' },
];

describe('createMemoryJudge', () => {
  it('returns a "same" verdict naming the shown candidate', async () => {
    const judge = createMemoryJudge(answering({ relation: 'same', id: 'mem_wife' }));
    await expect(judge({ content: "User's wife's name is Maya", candidates })).resolves.toEqual({ relation: 'same', id: 'mem_wife' });
  });

  it('returns an "updates" verdict naming the shown candidate', async () => {
    const judge = createMemoryJudge(answering({ relation: 'updates', id: 'mem_wife' }));
    await expect(judge({ content: "User's wife's name is Maia", candidates })).resolves.toEqual({ relation: 'updates', id: 'mem_wife' });
  });

  it.each([
    ['an id it was never shown', { relation: 'same', id: 'mem_other' }],
    ['a "same" without an id', { relation: 'same', id: null }],
    ['an "updates" without an id', { relation: 'updates', id: null }],
    ['"different" with a stray id', { relation: 'different', id: 'mem_wife' }],
  ])('treats %s as "different"', async (_label, verdict) => {
    const judge = createMemoryJudge(answering(verdict));
    await expect(judge({ content: 'x', candidates })).resolves.toEqual({ relation: 'different', id: null });
  });

  it('makes no model call without candidates', async () => {
    const model = answering({ relation: 'same', id: 'mem_wife' });
    const judge = createMemoryJudge(model);
    await expect(judge({ content: 'x', candidates: [] })).resolves.toEqual({ relation: 'different', id: null });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('shows the model the new memory and every candidate by id', async () => {
    const model = answering({ relation: 'different', id: null });
    await createMemoryJudge(model)({ content: "User's wife's name is Maya", candidates });
    const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain("User's wife's name is Maya");
    expect(prompt).toContain('mem_wife: User has a wife named Maya.');
    expect(prompt).toContain('mem_job: User works as a nurse.');
  });
});

describe('judge prompt', () => {
  it('separates a correction and a different subject from a duplicate', () => {
    expect(MEMORY_JUDGE_SYSTEM_PROMPT).toContain('"updates"');
    expect(MEMORY_JUDGE_SYSTEM_PROMPT).toContain("User's brother lives in Berlin.");
    expect(buildJudgePrompt({ content: 'c', candidates: [{ id: 'a', content: 'b' }] })).toContain('- a: b');
  });
});
