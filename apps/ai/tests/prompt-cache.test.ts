/** Model-aware prompt-cache options (#413 follow-up): per-provider levers, all off unless enabled. */
import { afterEach, describe, expect, it } from 'vitest';
import { cacheProviderOptions, cacheableInstructions, markHistoryBreakpoint, providerFamily, withThinkingBudget } from '../src/prompt-cache.ts';

const KEYS = ['BOB_PROVIDER_CACHE', 'BOB_GATEWAY_ORDER'] as const;
afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

const digest = (k: string): string => `d:${k}`;
const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' } } };

describe('providerFamily', () => {
  it('reads the gateway model prefix', () => {
    expect(['openai/gpt-4o', 'anthropic/claude-x', 'google/gemini-2.5-flash', 'xai/grok'].map((m) => providerFamily(m))).toEqual(['openai', 'anthropic', 'google', 'other']);
  });
});

describe('cacheableInstructions', () => {
  it('is the plain string unless enabled for an anthropic model', () => {
    expect(cacheableInstructions('sys', 'anthropic/claude-x')).toBe('sys');
    process.env.BOB_PROVIDER_CACHE = 'on';
    expect(cacheableInstructions('sys', 'google/gemini-2.5-flash')).toBe('sys');
    expect(cacheableInstructions('sys', 'openai/gpt-4o')).toBe('sys');
    expect(cacheableInstructions('sys', 'anthropic/claude-x')).toEqual({ role: 'system', content: 'sys', providerOptions: EPHEMERAL });
  });
});

describe('cacheProviderOptions', () => {
  it('sends the digested key only for openai models', () => {
    expect(cacheProviderOptions('conv', digest, 'openai/gpt-4o')).toEqual({ openai: { promptCacheKey: 'd:conv' } });
    expect(cacheProviderOptions('conv', digest, 'google/gemini-2.5-flash')).toBeUndefined();
    expect(cacheProviderOptions(undefined, digest, 'openai/gpt-4o')).toBeUndefined();
  });

  it('adds the gateway provider order for any model when BOB_GATEWAY_ORDER is set', () => {
    process.env.BOB_GATEWAY_ORDER = ' vertex , google ';
    expect(cacheProviderOptions(undefined, digest, 'google/gemini-2.5-flash')).toEqual({ gateway: { order: ['vertex', 'google'] } });
    expect(cacheProviderOptions('conv', digest, 'openai/gpt-4o')).toEqual({ openai: { promptCacheKey: 'd:conv' }, gateway: { order: ['vertex', 'google'] } });
  });
});

describe('withThinkingBudget', () => {
  it('adds the google thinking override for a non-pro google model, preserving any cache options', () => {
    expect(withThinkingBudget(undefined, 'google/gemini-2.5-flash')).toEqual({ google: { thinkingConfig: { thinkingBudget: 0 } } });
    expect(withThinkingBudget({ gateway: { order: ['vertex'] } }, 'google/gemini-2.5-flash')).toEqual({
      gateway: { order: ['vertex'] },
      google: { thinkingConfig: { thinkingBudget: 0 } },
    });
  });

  it('leaves base unchanged for a thinking-only (-pro) google model', () => {
    expect(withThinkingBudget(undefined, 'google/gemini-2.5-pro')).toBeUndefined();
    const base = { gateway: { order: ['vertex'] } };
    expect(withThinkingBudget(base, 'google/gemini-2.5-pro')).toBe(base);
  });

  it('leaves base unchanged for a non-google model', () => {
    expect(withThinkingBudget(undefined, 'openai/gpt-4o')).toBeUndefined();
    const base = { openai: { promptCacheKey: 'd:conv' } };
    expect(withThinkingBudget(base, 'openai/gpt-4o')).toBe(base);
  });
});

describe('markHistoryBreakpoint', () => {
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'Hi.' },
    { role: 'system', content: 'context' },
    { role: 'user', content: 'now' },
  ];

  it('marks only the last history message, only when enabled for anthropic', () => {
    expect(markHistoryBreakpoint(messages, 'anthropic/claude-x')).toBe(messages);
    process.env.BOB_PROVIDER_CACHE = 'on';
    expect(markHistoryBreakpoint(messages, 'google/gemini-2.5-flash')).toBe(messages);
    const marked = markHistoryBreakpoint(messages, 'anthropic/claude-x') as Array<{ providerOptions?: unknown }>;
    expect(marked.map((m) => m.providerOptions)).toEqual([undefined, EPHEMERAL, undefined, undefined]);
  });

  it('is a no-op with no history before the context message', () => {
    process.env.BOB_PROVIDER_CACHE = 'on';
    const bare = [{ role: 'system', content: 'context' }, { role: 'user', content: 'now' }];
    expect(markHistoryBreakpoint(bare, 'anthropic/claude-x')).toBe(bare);
  });
});
