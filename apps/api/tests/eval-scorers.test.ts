/**
 * Unit tests for the deterministic eval scorers (spec 009, D4) and the AI
 * Gateway judge (D5). Runs inside the existing Vitest gate; the judge tests
 * inject a mock language model so no gateway key or network is needed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { endsAtSentence, isEnglish, lengthCap700, noMarkdown, toolNameMatch, VOICE_REPLY_MAX_CHARS, judge, judgeOutputSchema } from '@bob/ai';
import { withinWordBudget, answersDirectly, falseAddRate, firstToolMatch, namesRealAbilities, noIdentityLeak, noToolFalseCall, overCall, reconciliationCorrect, toolArgsMatch, usesStructure } from '@bob/ai/testing';

function mockJudgeModel(score: number, rationale: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text: JSON.stringify({ score, rationale }) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('lengthCap700', () => {
  it('passes a reply that fits the voice cap exactly', () => {
    const output = 'x'.repeat(VOICE_REPLY_MAX_CHARS);
    expect(lengthCap700(output).score).toBe(1);
  });

  it('fails a reply one character over the cap', () => {
    const output = 'x'.repeat(VOICE_REPLY_MAX_CHARS + 1);
    expect(lengthCap700(output).score).toBe(0);
  });

  it('names the scorer', () => {
    expect(lengthCap700('short').name).toBe('lengthCap700');
  });
});

describe('endsAtSentence', () => {
  it('passes on a period, question mark, or exclamation', () => {
    expect(endsAtSentence('Yes.').score).toBe(1);
    expect(endsAtSentence('Really?').score).toBe(1);
    expect(endsAtSentence('Wow!').score).toBe(1);
  });

  it('ignores trailing whitespace', () => {
    expect(endsAtSentence('Yes.  ').score).toBe(1);
  });

  it('passes on a closing quote after a sentence ender', () => {
    expect(endsAtSentence('She said "yes."').score).toBe(1);
    expect(endsAtSentence('She said \u201cyes.\u2019').score).toBe(1);
  });

  it('fails when the reply ends mid-sentence or empty', () => {
    expect(endsAtSentence('Not finished').score).toBe(0);
    expect(endsAtSentence('Quoted "yes"').score).toBe(0);
    expect(endsAtSentence('').score).toBe(0);
  });
});

describe('answersDirectly (#750)', () => {
  it('passes a direct suggestion', () => {
    expect(answersDirectly('How about a grilled chicken salad with quinoa? It fits your diet.').score).toBe(1);
    expect(answersDirectly("Pack a chickpea wrap; if you're ordering, a chicken burrito bowl works.").score).toBe(1);
  });

  it('fails the replies from the 2026-09-30 session', () => {
    expect(answersDirectly("I can't tell you what to eat for lunch, as I don't have access to that kind of information.").score).toBe(0);
    expect(answersDirectly("I can't come up with specific meal suggestions. I can only remember your dietary preferences.").score).toBe(0);
    expect(answersDirectly('I cannot decide that for you.').score).toBe(0);
  });

  it('fails a reply that offers a reminder instead of answering', () => {
    expect(answersDirectly('Lunch is up to you, but I can help you set a reminder to pack it.').score).toBe(0);
  });
});

describe('noMarkdown', () => {
  it('passes plain voice-ready prose', () => {
    expect(noMarkdown('The forecast is sunny and warm.').score).toBe(1);
  });

  it('fails bold, code, headings, bullets, and links', () => {
    expect(noMarkdown('very **important**').score).toBe(0);
    expect(noMarkdown('very __important__').score).toBe(0);
    expect(noMarkdown('use `npm run eval`').score).toBe(0);
    expect(noMarkdown('# Heading').score).toBe(0);
    expect(noMarkdown('- item one').score).toBe(0);
    expect(noMarkdown('* item one').score).toBe(0);
    expect(noMarkdown('1. first step').score).toBe(0);
    expect(noMarkdown('see [docs](https://example.com)').score).toBe(0);
  });
});

describe('usesStructure (#898)', () => {
  it('passes a numbered list or bulleted list when structure is expected', () => {
    expect(usesStructure('1. First step\n2. Second step', true).score).toBe(1);
    expect(usesStructure('- First item\n- Second item', true).score).toBe(1);
    expect(usesStructure('* First item\n* Second item', true).score).toBe(1);
  });

  it('passes a fenced code block when structure is expected', () => {
    expect(usesStructure('Try this:\n```\nnpm test\n```', true).score).toBe(1);
  });

  it('fails a single bullet line or plain prose when structure is expected', () => {
    expect(usesStructure('- just one item', true).score).toBe(0);
    expect(usesStructure('This is a plain sentence with no structure.', true).score).toBe(0);
  });

  it('passes plain prose or a single bullet line when structure is not expected', () => {
    expect(usesStructure('This is a plain sentence with no structure.', false).score).toBe(1);
    expect(usesStructure('- just one item', false).score).toBe(1);
  });

  it('fails a list or a fenced code block when structure is not expected', () => {
    expect(usesStructure('1. First\n2. Second', false).score).toBe(0);
    expect(usesStructure('```\ncode\n```', false).score).toBe(0);
  });

  it('names the scorer', () => {
    expect(usesStructure('prose', false).name).toBe('usesStructure');
  });
});

describe('noIdentityLeak (#898)', () => {
  it('fails the regression reply that leaked the underlying model identity', () => {
    expect(noIdentityLeak('I am a large language model, trained by Google.').score).toBe(0);
  });

  it('fails other identity leaks', () => {
    expect(noIdentityLeak("I'm Gemini, an AI assistant made by Google.").score).toBe(0);
    expect(noIdentityLeak('As an LLM, I can help with many things.').score).toBe(0);
  });

  it('passes a reply that stays in character as Bob', () => {
    expect(noIdentityLeak("I'm Bob, your home voice assistant.").score).toBe(1);
  });

  it('names the scorer', () => {
    expect(noIdentityLeak('ok').name).toBe('noIdentityLeak');
  });
});

describe('namesRealAbilities (#898)', () => {
  it('passes a reply naming two or more real abilities', () => {
    expect(namesRealAbilities('I can set reminders and timers for you.').score).toBe(1);
    expect(namesRealAbilities('I can track tasks, keep notes, and play games with you.').score).toBe(1);
  });

  it('fails a reply naming fewer than two real abilities', () => {
    expect(namesRealAbilities('I can set a timer for you.').score).toBe(0);
    expect(namesRealAbilities("I'm here to help however I can.").score).toBe(0);
  });

  it('fails the regression reply: a generic LLM-abilities list even alongside real abilities', () => {
    const output = 'I have vast knowledge, can translate languages, write poems, and set reminders and timers.';
    expect(namesRealAbilities(output).score).toBe(0);
  });

  it('names the scorer', () => {
    expect(namesRealAbilities('reminders and timers').name).toBe('namesRealAbilities');
  });
});

describe('isEnglish', () => {
  it('passes an English sentence with common stopwords', () => {
    expect(isEnglish('The weather today is sunny and warm.').score).toBe(1);
  });

  it('fails a Spanish sample despite the shared ASCII alphabet', () => {
    expect(isEnglish('Hola, \u00bfc\u00f3mo est\u00e1s hoy? Me llamo Ana y vivo en Madrid.').score).toBe(0);
  });
});

describe('toolNameMatch', () => {
  it('scores the fraction of expected tools present', () => {
    expect(toolNameMatch(['a', 'b', 'c'], ['a', 'b', 'x']).score).toBeCloseTo(2 / 3);
    expect(toolNameMatch(['a'], ['z']).score).toBe(0);
    expect(toolNameMatch(['a', 'b'], ['a', 'b']).score).toBe(1);
  });

  it('passes when nothing is expected', () => {
    expect(toolNameMatch([], []).score).toBe(1);
    expect(toolNameMatch([], ['a']).score).toBe(1);
  });
});

describe('firstToolMatch', () => {
  it('scores 1 only when the first call is the first expected tool', () => {
    expect(firstToolMatch(['create_reminder'], ['create_reminder']).score).toBe(1);
    expect(firstToolMatch(['create_reminder'], ['create_task']).score).toBe(0);
    expect(firstToolMatch(['create_reminder'], ['currentDateTime', 'create_reminder']).score).toBe(0);
    expect(firstToolMatch(['create_reminder'], []).score).toBe(0);
  });

  it('scores a call where none is expected as 0', () => {
    expect(firstToolMatch([], []).score).toBe(1);
    expect(firstToolMatch([], ['search']).score).toBe(0);
  });
});

describe('noToolFalseCall', () => {
  it('scores a call where none is expected as 0', () => {
    expect(noToolFalseCall([], ['currentDateTime']).score).toBe(0);
    expect(noToolFalseCall([], []).score).toBe(1);
  });

  it('does not apply when a tool is expected', () => {
    expect(noToolFalseCall(['set_timer'], []).score).toBeNull();
    expect(noToolFalseCall(['set_timer'], ['set_timer']).score).toBeNull();
  });
});

describe('toolArgsMatch', () => {
  it('checks only the listed args, normalising case and numeric strings', () => {
    const calls = [{ toolName: 'set_mode', input: { mode: 'Wake', extra: 1 } }];
    expect(toolArgsMatch({ set_mode: { mode: 'wake' } }, calls).score).toBe(1);
    expect(toolArgsMatch({ set_mode: { mode: 'ptt' } }, calls).score).toBe(0);
    expect(toolArgsMatch({ set_timer: { duration: 300 } }, [{ toolName: 'set_timer', input: { duration: '300' } }]).score).toBe(1);
  });

  it('accepts any value listed in anyOf', () => {
    const want = { set_timer: { duration: { anyOf: [300, 'PT5M'] } } };
    expect(toolArgsMatch(want, [{ toolName: 'set_timer', input: { duration: 'PT5M' } }]).score).toBe(1);
    expect(toolArgsMatch(want, [{ toolName: 'set_timer', input: { duration: 60 } }]).score).toBe(0);
  });

  it('scores the fraction of listed keys and 0 for an uncalled tool', () => {
    const calls = [{ toolName: 'set_volume', input: { level: 3, mute: true } }];
    expect(toolArgsMatch({ set_volume: { level: 3, mute: false } }, calls).score).toBe(0.5);
    expect(toolArgsMatch({ set_mode: { mode: 'wake' } }, calls).score).toBe(0);
  });

  it('does not apply when no args are listed', () => {
    expect(toolArgsMatch(undefined, []).score).toBeNull();
    expect(toolArgsMatch({}, [{ toolName: 'search', input: {} }]).score).toBeNull();
  });
});

describe('overCall', () => {
  it('scores 0 for a duplicate create_* call in one turn', () => {
    expect(overCall(['create_task', 'create_task']).score).toBe(0);
    expect(overCall(['create_task', 'list_tasks', 'create_task']).score).toBe(0);
  });

  it('scores 1 for distinct creates, repeated reads, or no calls', () => {
    expect(overCall(['create_task', 'create_event']).score).toBe(1);
    expect(overCall(['list_tasks', 'list_tasks']).score).toBe(1);
    expect(overCall([]).score).toBe(1);
  });
});

describe('falseAddRate (#402)', () => {
  it('scores 1 for an add on a no-op fixture and 0 without one', () => {
    expect(falseAddRate([], [{ op: 'add' }]).score).toBe(1);
    expect(falseAddRate([], []).score).toBe(0);
    expect(falseAddRate([], [{ op: 'noop', id: 'mem_1' }]).score).toBe(0);
  });

  it('scores 0 on a fixture that expects a memory', () => {
    expect(falseAddRate([{ kind: 'fact', content_contains: 'x' }], [{ op: 'add' }]).score).toBe(0);
    expect(falseAddRate([], []).name).toBe('falseAddRate');
  });
});

describe('reconciliationCorrect (#402)', () => {
  it('scores 1 for the right op on the right id', () => {
    expect(reconciliationCorrect([{ op: 'update', id: 'm1' }], [{ op: 'update', id: 'm1' }]).score).toBe(1);
    expect(reconciliationCorrect([{ op: 'supersede', id: 'm1' }], [{ op: 'supersede', id: 'm1' }, { op: 'noop', id: 'm2' }]).score).toBe(1);
  });

  it('scores 0 for the right op on the wrong id', () => {
    expect(reconciliationCorrect([{ op: 'update', id: 'm1' }], [{ op: 'update', id: 'm2' }]).score).toBe(0);
  });

  it('scores 0 for the wrong op on the right id', () => {
    expect(reconciliationCorrect([{ op: 'update', id: 'm1' }], [{ op: 'supersede', id: 'm1' }]).score).toBe(0);
    expect(reconciliationCorrect([{ op: 'supersede', id: 'm1' }], [{ op: 'add' }]).score).toBe(0);
  });

  it('accepts an explicit noop or no op for an expected noop, but not a duplicate add', () => {
    expect(reconciliationCorrect([{ op: 'noop', id: 'm1' }], [{ op: 'noop', id: 'm1' }]).score).toBe(1);
    expect(reconciliationCorrect([{ op: 'noop', id: 'm1' }], []).score).toBe(1);
    expect(reconciliationCorrect([{ op: 'noop', id: 'm1' }], [{ op: 'add' }]).score).toBe(0);
    expect(reconciliationCorrect([{ op: 'noop', id: 'm1' }], [{ op: 'update', id: 'm1' }]).score).toBe(0);
  });

  it('matches an expected add alongside a reconciliation', () => {
    expect(reconciliationCorrect([{ op: 'noop', id: 'm1' }, { op: 'add' }], [{ op: 'add' }]).score).toBe(1);
    expect(reconciliationCorrect([{ op: 'noop', id: 'm1' }, { op: 'add' }], []).score).toBe(0);
  });
});

describe('judge', () => {
  it('maps the model structured output to a scorer result', async () => {
    const result = await judge(
      { criteria: 'answer is helpful', input: 'what is 2+2?', output: 'It is 4.' },
      { model: mockJudgeModel(0.8, 'correct and concise') },
    );
    expect(result).toEqual({
      name: 'answer is helpful',
      score: 0.8,
      metadata: { rationale: 'correct and concise' },
    });
  });

  it('throws when the gateway key is missing and no model override is given', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    await expect(judge({ criteria: 'c', input: 'i', output: 'o' })).rejects.toThrow(/AI_GATEWAY_API_KEY/);
  });

  it('validates the structured output schema strictly', () => {
    expect(judgeOutputSchema.safeParse({ score: 1.5, rationale: 'x' }).success).toBe(false);
    expect(judgeOutputSchema.safeParse({ score: 0.5, rationale: 'x'.repeat(401) }).success).toBe(false);
    expect(judgeOutputSchema.safeParse({ score: 0.5, rationale: 'ok' }).success).toBe(true);
  });
});
// Length is one signal only; the live helpfulness suite judges usefulness separately.
describe('withinWordBudget', () => {
  it('accepts a direct answer at the limit', () => {
    expect(withinWordBudget('The answer is 96.', 4).score).toBe(1);
  });
  it('rejects empty and verbose replies', () => {
    expect(withinWordBudget('   ', 4).score).toBe(0);
    expect(withinWordBudget('The answer is 96. Would you like more help?', 4).score).toBe(0);
  });
  it('counts whitespace-separated words across formatted lines', () => {
    expect(withinWordBudget('First step.\nSecond step.', 4).score).toBe(1);
  });
});
