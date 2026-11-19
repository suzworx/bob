/**
 * #502: streamAgent against a REAL ToolLoopAgent (ai SDK) driven by the SDK's
 * mock language model (tests/support/agent-harness.ts), so the shape of the
 * SDK's own stream() -- async, a promise of a StreamTextResult -- is what the
 * turn reads. No network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// The shared singleton is never run here (streamAgent is handed its agent); a
// harness agent that fails loudly stands in for it, not a hand-written double.

vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((async (importOriginal) => ({
  bobAgent: (await import('../support/agent-harness.ts')).createAgentHarness([[{ type: 'error', message: 'the singleton agent ran' }]]).agent,
  BOB_SYSTEM_TEST_MODE: false,
  AI_STUB_MODE: false,
  MAX_TTS_INPUT_CHARS: 700,
  BOB_STT_LANGUAGE: 'en',
  isProviderError: () => false,
  providerErrorStatus: () => undefined,
  debugLog: vi.fn(),
  isFrameDebugEnabled: () => false,
  synthesizeSpeech: vi.fn(),
  transcribeAudio: vi.fn(),
}) ) as Factory),
    ((async (importOriginal) => {
  const { bobAgent: mockAgent } = await importOriginal<typeof import('@bob/ai')>();
  return {
    createBobAgent: vi.fn(() => mockAgent),
    bobAgent: mockAgent,
    assistantAgent: mockAgent,
    chatModel: {},
    gateway: Object.assign(vi.fn(() => ({})), { embeddingModel: vi.fn(() => ({})) }),
    logAgentConfig: vi.fn(),
  };
} ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

import { streamAgent } from '../../src/voice/turn/agent.ts';
import { TurnCancelledError } from '../../src/voice/turn/abort.ts';
import { createAgentHarness, words, type ScriptStep } from '../support/agent-harness.ts';
import type { bobAgent } from '@bob/ai';

/** Step 1 says a line and calls `lookup`; step 2 answers. */
const STEPS: ScriptStep[] = [
  [...words('Let me check.'), { type: 'tool', name: 'lookup', result: { ok: true } }],
  words('It is sunny.'),
];

/** streamAgent's parameter is typed by the singleton's tool set; turn.ts:722
 *  converts createBobAgent's ToolLoopAgent the same way. The agent itself is
 *  the harness's real, uncast ToolLoopAgent, so its runtime shape is the SDK's. */
function turnAgent(steps: ScriptStep[]): typeof bobAgent {
  return createAgentHarness(steps).agent as unknown as typeof bobAgent;
}

const MESSAGES = [{ role: 'user' as const, content: 'what is the weather' }];

describe('streamAgent on a real ToolLoopAgent (#502)', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);

  afterEach(() => {
    expect(unhandled).toEqual([]);
    unhandled.length = 0;
  });

  it('awaits the async stream() and hands every step\'s text deltas to onText', async () => {
    const deltas: string[] = [];
    const result = await streamAgent(MESSAGES, turnAgent(STEPS), (delta) => deltas.push(delta));
    expect(result.text).toBe('Let me check. It is sunny.');
    expect(deltas.join('')).toBe('Let me check. It is sunny.');
    expect(result.steps).toHaveLength(2);
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls.map((call) => call.toolName)).toEqual(['lookup']);
  });

  it('rejects with the model\'s own error, not a TypeError about the stream shape', async () => {
    const broken: ScriptStep[] = [[...words('Hel'), { type: 'error', message: 'model stream broke' }]];
    const deltas: string[] = [];
    await expect(streamAgent(MESSAGES, turnAgent(broken), (delta) => deltas.push(delta)))
      .rejects.toThrow('model stream broke');
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('a turn already cancelled rejects with TurnCancelledError and leaves no unhandled rejection', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(streamAgent(MESSAGES, turnAgent(STEPS), () => undefined, abort.signal))
      .rejects.toBeInstanceOf(TurnCancelledError);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
