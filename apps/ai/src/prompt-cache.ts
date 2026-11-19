/**
 * Model-aware prompt-cache options for the cache-v1 layout. The layout
 * already gives every provider a byte-stable prefix; what differs per provider
 * is how a cache hit is requested:
 *
 *  - openai/*    `promptCacheKey` (conversation digest), always sent when a key exists.
 *  - anthropic/* explicit `cacheControl` breakpoints on the instructions (which
 *                also covers the tools) and on the last history message.
 *                Off unless BOB_PROVIDER_CACHE=on.
 *  - google/*    implicit caching only: nothing to send, but it hits only on one
 *                backend, so BOB_GATEWAY_ORDER (e.g. "vertex") pins the order.
 *
 * Every function reads its env on each call so a test can flip it.
 */
import type { ToolLoopAgent } from 'ai';
import { BOB_CHAT_MODEL } from './config.ts';

/** The agent's own providerOptions type, so no undeclared @ai-sdk/provider import is needed. */
type AgentProviderOptions = NonNullable<NonNullable<ConstructorParameters<typeof ToolLoopAgent>[0]>['providerOptions']>;

export type ProviderFamily = 'openai' | 'anthropic' | 'google' | 'other';

export function providerFamily(modelId: string = BOB_CHAT_MODEL): ProviderFamily {
  const prefix = modelId.split('/')[0];
  return prefix === 'openai' || prefix === 'anthropic' || prefix === 'google' ? prefix : 'other';
}

/** BOB_PROVIDER_CACHE=on (default off) turns on the Anthropic breakpoints. */
function providerCacheEnabled(): boolean {
  return process.env.BOB_PROVIDER_CACHE === 'on';
}

const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };

/** The instructions, as a cache-marked system message for Anthropic when enabled, else unchanged. */
export function cacheableInstructions(
  instructions: string,
  modelId: string = BOB_CHAT_MODEL,
): string | { role: 'system'; content: string; providerOptions: typeof EPHEMERAL } {
  if (!providerCacheEnabled() || providerFamily(modelId) !== 'anthropic') return instructions;
  return { role: 'system', content: instructions, providerOptions: EPHEMERAL };
}

/**
 * `providerOptions` for the agent: the OpenAI cache key, and the Gateway
 * provider order when BOB_GATEWAY_ORDER is set. Undefined when there is nothing to send.
 */
export function cacheProviderOptions(
  cacheKey: string | undefined,
  digest: (key: string) => string,
  modelId: string = BOB_CHAT_MODEL,
): AgentProviderOptions | undefined {
  const options: AgentProviderOptions = {};
  if (cacheKey && providerFamily(modelId) === 'openai') options.openai = { promptCacheKey: digest(cacheKey) };
  const order = (process.env.BOB_GATEWAY_ORDER ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (order.length > 0) options.gateway = { order };
  return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * No reasoning tokens before the first token, for a Gemini model that spends them by default
 * (`thinkingConfig.thinkingBudget` is the Gemini-via-Gateway key), merged into `base` without dropping it.
 * An Anthropic model gets `anthropic.thinking = disabled`, keeping `base.anthropic` (cacheControl).
 * A Gemini `-pro` (thinking-only) model and any other provider get `base` unchanged.
 */
export function withThinkingBudget(
  base?: AgentProviderOptions,
  modelId: string = BOB_CHAT_MODEL,
): AgentProviderOptions | undefined {
  if (providerFamily(modelId) === 'anthropic') return { ...base, anthropic: { ...base?.anthropic, thinking: { type: 'disabled' } } };
  if (providerFamily(modelId) !== 'google' || modelId.includes('-pro')) return base;
  return { ...base, google: { thinkingConfig: { thinkingBudget: 0 } } };
}

/**
 * Marks the last history message (the one before the per-turn context message
 * and the final user message) as an Anthropic cache breakpoint. A no-op unless
 * enabled for an Anthropic model, or when there is no history to mark.
 */
export function markHistoryBreakpoint<T extends { role: string; providerOptions?: unknown }>(
  messages: T[],
  modelId: string = BOB_CHAT_MODEL,
): T[] {
  if (!providerCacheEnabled() || providerFamily(modelId) !== 'anthropic') return messages;
  const index = messages.length - 3;
  if (messages[index]?.role === undefined || messages[index]?.role === 'system') return messages;
  return messages.map((m, i) => (i === index ? { ...m, providerOptions: { ...(m.providerOptions as object | undefined), ...EPHEMERAL } } : m));
}
