/**
 * #898 (correction c1): every `ToolLoopAgent` agents.ts builds applies
 * `withThinkingBudget` -- the shared `bobAgent` singleton (baked in at
 * import time) and every `createBobAgent`. Every test stubs
 * BOB_CHAT_MODEL and BOB_GATEWAY_ORDER explicitly, so the file is correct
 * under any ambient value of those (the root .env, a shell export) -- none of
 * it may leak in. BOB_CHAT_MODEL is read once into a frozen constant at
 * config.ts's first import, so it must be stubbed *before* the dynamic import
 * below; BOB_GATEWAY_ORDER is read live per call, so a per-test stub is
 * enough. Captures the ToolLoopAgent constructor settings directly; no
 * model call is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted((): { settings: Record<string, unknown>[] } => ({ settings: [] }));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  const MockedToolLoopAgent = new Proxy(actual.ToolLoopAgent, {
    construct(target, args, newTarget): object {
      captured.settings.push(args[0] as Record<string, unknown>);
      return Reflect.construct(target, args, newTarget) as object;
    },
  });
  return { ...actual, ToolLoopAgent: MockedToolLoopAgent };
});

// Both local modules are dynamically imported only after this stub runs: a
// static top-of-file import would load config.ts (and freeze BOB_CHAT_MODEL)
// before the stub takes effect.
vi.stubEnv('BOB_CHAT_MODEL', 'google/gemini-2.5-flash');
const { createBobAgent, promptCacheKeyFor } = await import('../src/agents.ts');
const { cacheProviderOptions } = await import('../src/prompt-cache.ts');
const { BOB_AGENT_INSTRUCTIONS } = await import('../src/prompts.ts');

const GOOGLE_NO_THINKING = { thinkingConfig: { thinkingBudget: 0 } };

function providerOptionsOf(index: number): Record<string, unknown> | undefined {
  return captured.settings[index]?.providerOptions as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.stubEnv('BOB_CHAT_MODEL', 'google/gemini-2.5-flash');
  vi.stubEnv('BOB_GATEWAY_ORDER', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('thinking budget (#898)', () => {
  it('the shared bobAgent singleton gets it, built at module load', () => {
    expect(providerOptionsOf(0)).toEqual({ google: GOOGLE_NO_THINKING });
  });

  it('a per-turn agent: merged with the existing cache options, not replacing them', () => {
    vi.stubEnv('BOB_GATEWAY_ORDER', 'vertex');
    const before = captured.settings.length;
    createBobAgent({ cacheKey: 'conv-1' });
    const expectedCacheOptions = cacheProviderOptions('conv-1', promptCacheKeyFor, 'google/gemini-2.5-flash');
    expect(expectedCacheOptions).toEqual({ gateway: { order: ['vertex'] } });
    expect(providerOptionsOf(before)).toEqual({ ...expectedCacheOptions, google: GOOGLE_NO_THINKING });
  });

  it('(c2) the instructions tell the model to answer advice directly, countering the refusals a 0 budget caused in eval', () => {
    expect(BOB_AGENT_INSTRUCTIONS).toContain(
      'Answer advice and opinion questions directly with a concrete suggestion; do not offer to set reminders or ask for more information first.',
    );
  });
});

const { withThinkingBudget } = await import('../src/prompt-cache.ts');

describe('withThinkingBudget by provider (#1331 phase 5)', () => {
  const cacheKeys = { anthropic: { cacheControl: { type: 'ephemeral' as const } }, gateway: { order: ['vertex'] } };

  it('anthropic: thinking disabled', () => {
    expect(withThinkingBudget(undefined, 'anthropic/claude-haiku-5.5')).toEqual({ anthropic: { thinking: { type: 'disabled' } } });
  });

  it('anthropic: keeps existing anthropic keys such as cacheControl, and other providers', () => {
    expect(withThinkingBudget(cacheKeys, 'anthropic/claude-haiku-5.5')).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' }, thinking: { type: 'disabled' } },
      gateway: { order: ['vertex'] },
    });
  });

  it('google flash: unchanged behaviour, budget 0', () => {
    expect(withThinkingBudget(undefined, 'google/gemini-2.5-flash')).toEqual({ google: GOOGLE_NO_THINKING });
  });

  it('google pro: base returned unchanged', () => {
    expect(withThinkingBudget(cacheKeys, 'google/gemini-2.5-pro')).toBe(cacheKeys);
  });

  it('openai: base returned unchanged', () => {
    expect(withThinkingBudget(cacheKeys, 'openai/gpt-5')).toBe(cacheKeys);
    expect(withThinkingBudget(undefined, 'openai/gpt-5')).toBeUndefined();
  });
});
