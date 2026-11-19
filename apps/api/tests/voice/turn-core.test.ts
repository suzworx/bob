/**
 * Shared turn-core rules: history trimming and failure classification.
 * The classification tests are the regression contract for the provider
 * detection that turn-core delegates to @bob/ai's isProviderError /
 * providerErrorStatus predicates.
 */
import { describe, expect, it } from 'vitest';
import { GatewayRateLimitError } from '@ai-sdk/gateway';
import {
  agentActionOutcome,
  classifyFailure,
  MAX_HISTORY_MESSAGES,
  trimHistory,
  type TurnStage,
} from '../../src/voice/turn-core.ts';

describe('trimHistory chunked window (#413, cache-v1: offset given)', () => {
  const range = (n: number, from = 0): number[] => Array.from({ length: n }, (_, index) => from + index);

  it.each([
    [0, 0, 0],
    [40, 0, 40],
    [41, 20, 21],
    [60, 20, 40],
    [61, 40, 21],
    [100, 60, 40],
  ])('n = %i: starts at message %i and keeps %i', (n, first, kept) => {
    const trimmed = trimHistory(range(n), MAX_HISTORY_MESSAGES, 0);
    expect(trimmed).toHaveLength(kept);
    if (kept > 0) expect(trimmed[0]).toBe(first);
    expect(trimmed.at(-1)).toBe(n === 0 ? undefined : n - 1);
  });

  it('keeps the same first message for 20 consecutive appends past the cap, never more than 40', () => {
    const firsts = new Set<number | undefined>();
    for (let n = 41; n <= 60; n += 1) {
      const trimmed = trimHistory(range(n), MAX_HISTORY_MESSAGES, 0);
      expect(trimmed.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
      expect(trimmed.length).toBeGreaterThanOrEqual(21);
      firsts.add(trimmed[0]);
    }
    expect([...firsts]).toEqual([20]);
  });

  it('anchors on the absolute position when only the newest rows were loaded', () => {
    // 77 messages in the conversation, the newest 59 loaded (positions 18-76).
    const trimmed = trimHistory(range(59, 18), MAX_HISTORY_MESSAGES, 18);
    expect(trimmed[0]).toBe(40);
    expect(trimmed).toHaveLength(37);
    expect(trimmed).toEqual(trimHistory(range(77), MAX_HISTORY_MESSAGES, 0));
  });

  it('never returns more than max, and a chunk wider than max shrinks to it', () => {
    expect(trimHistory(range(90), MAX_HISTORY_MESSAGES, 0)).toHaveLength(30);
    expect(trimHistory(range(5), 3, 0)).toEqual([3, 4]);
    expect(trimHistory(range(5), 0, 0)).toEqual([]);
  });
});

describe('trimHistory', () => {
  it('returns the newest N entries, oldest-first, for an array longer than max', () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({ role: 'user', content: `m${index}` }));
    const trimmed = trimHistory(messages, 3);
    expect(trimmed).toEqual([
      { role: 'user', content: 'm7' },
      { role: 'user', content: 'm8' },
      { role: 'user', content: 'm9' },
    ]);
  });

  it('returns the input contents unchanged when shorter than max', () => {
    const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    expect(trimHistory(messages, 5)).toEqual(messages);
  });

  it('does not mutate its input', () => {
    const messages = Array.from({ length: 50 }, (_, index) => ({ role: 'user', content: `m${index}` }));
    const originalLength = messages.length;
    const originalFirst = messages[0];
    trimHistory(messages, 3);
    expect(messages).toHaveLength(originalLength);
    expect(messages[0]).toBe(originalFirst);
    expect(messages[49]).toEqual({ role: 'user', content: 'm49' });
  });

  it('defaults to MAX_HISTORY_MESSAGES when max is omitted', () => {
    const messages = Array.from({ length: MAX_HISTORY_MESSAGES + 10 }, (_, index) => index);
    expect(trimHistory(messages)).toHaveLength(MAX_HISTORY_MESSAGES);
  });

  it('returns an empty array for a non-empty input when max is zero', () => {
    const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    expect(trimHistory(messages, 0)).toEqual([]);
  });

  it('returns an empty array when max is negative (no suffix leak)', () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({ role: 'user', content: `m${index}` }));
    expect(trimHistory(messages, -5)).toEqual([]);
  });

  it('does not mutate its input when max is zero', () => {
    const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    trimHistory(messages, 0);
    expect(messages).toEqual([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
  });

  it('is generic over the two message shapes this repo uses', () => {
    const chat = Array.from({ length: 5 }, (_, index) => ({ role: 'user', content: `c${index}` }));
    const ui = Array.from({ length: 5 }, (_, index) => ({ id: `id${index}`, role: 'user', parts: [{ type: 'text', text: `p${index}` }] }));
    expect(trimHistory(chat, 2)).toEqual([
      { role: 'user', content: 'c3' },
      { role: 'user', content: 'c4' },
    ]);
    expect(trimHistory(ui, 2)).toEqual([
      { id: 'id3', role: 'user', parts: [{ type: 'text', text: 'p3' }] },
      { id: 'id4', role: 'user', parts: [{ type: 'text', text: 'p4' }] },
    ]);
  });
});

describe('classifyFailure', () => {
  it('classifies a Gateway error as upstream and lifts its typed statusCode', () => {
    const result = classifyFailure('agent', new GatewayRateLimitError({ statusCode: 429 }));
    expect(result.kind).toBe('upstream_error');
    expect(result.upstreamStatus).toBe(429);
  });

  it('flags a TimeoutError as timed-out and upstream', () => {
    const error = new Error('Request timed out');
    error.name = 'TimeoutError';
    const result = classifyFailure('agent', error);
    expect(result.kind).toBe('upstream_error');
    expect(result.timedOut).toBe(true);
  });

  it('flags an AbortError as timed-out and upstream', () => {
    const result = classifyFailure('agent', new DOMException('The operation was aborted', 'AbortError'));
    expect(result.kind).toBe('upstream_error');
    expect(result.timedOut).toBe(true);
  });

  it('flags the turn.ts signature (fetch failed) as upstream', () => {
    expect(classifyFailure('agent', new Error('fetch failed')).kind).toBe('upstream_error');
  });

  it('classifies a validation/invalid NAME as invalid_input', () => {
    const error = new Error('bad shape');
    error.name = 'ValidationError';
    expect(classifyFailure('input', error).kind).toBe('invalid_input');
  });

  it('classifies an invalid-signature name as invalid_input', () => {
    const error = new Error('nope');
    error.name = 'InvalidRequestError';
    expect(classifyFailure('input', error).kind).toBe('invalid_input');
  });

  it('lets a validation name win over a provider signal', () => {
    const error = new Error('fetch failed (429)');
    error.name = 'ValidationError';
    const result = classifyFailure('agent', error);
    expect(result.kind).toBe('invalid_input');
  });

  it('classifies a plain unremarkable Error as internal', () => {
    expect(classifyFailure('stt', new Error('boom')).kind).toBe('internal');
  });

  it('does not crash on a non-Error throw and reports a sensible errorName', () => {
    const result = classifyFailure('stt', 'thrown string value');
    expect(result.kind).toBe('internal');
    expect(typeof result.errorName).toBe('string');
    expect(result.errorName.length).toBeGreaterThan(0);
  });

  it('never returns the error message text', () => {
    const sentinel = 'SECRET_PROVIDER_RESPONSE_BODY_9f3a';
    const error = new Error(`upstream failed (500): ${sentinel}`);
    error.name = 'AI_APICallError';
    const result = classifyFailure('agent', error);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result.errorName).toBe('AI_APICallError');
  });

  it('passes the stage argument through unchanged for all four TurnStage values', () => {
    const stages: TurnStage[] = ['input', 'stt', 'agent', 'tts'];
    for (const stage of stages) {
      expect(classifyFailure(stage, new Error('x')).stage).toBe(stage);
    }
  });
});

describe('agentActionOutcome (#999)', () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });

  it('a run without tool calls has no action', () => {
    expect(agentActionOutcome({ toolCalls: [] })).toEqual({ tool_calls: 0, tool_failures: 0, action_outcome: 'none' });
    expect(agentActionOutcome({ steps: [{ toolCalls: [] }] })).toEqual({ tool_calls: 0, tool_failures: 0, action_outcome: 'none' });
  });

  it('a successful tool result is an ok action', () => {
    const fields = agentActionOutcome({
      steps: [{ toolCalls: [{ toolName: 'set_alarm' }], toolResults: [{ output: { ok: true } }] }, { toolCalls: [] }],
    });
    expect(fields).toEqual({ tool_calls: 1, tool_failures: 0, action_outcome: 'ok' });
  });

  it('a handled { ok: false } result and a tool-error both count as failures, and carry no text', () => {
    const fields = agentActionOutcome({
      steps: [{
        toolCalls: [{ toolName: 'set_alarm' }, { toolName: 'add_note' }, { toolName: 'currentDateTime' }],
        toolResults: [{ output: { ok: false, error: 'private words' } }, { output: 'plain text' }],
        content: [{ type: 'text' }, { type: 'tool-error', error: new Error('private words') }],
      }],
    });
    expect(fields).toEqual({ tool_calls: 3, tool_failures: 2, action_outcome: 'failed' });
    expect(JSON.stringify(fields)).not.toContain('private');
  });

  it('an aborted tool is a cancellation, not a failure', () => {
    const fields = agentActionOutcome({
      steps: [{ toolCalls: [{ toolName: 'set_alarm' }], content: [{ type: 'tool-error', error: abort }] }],
    });
    expect(fields).toEqual({ tool_calls: 1, tool_failures: 0, action_outcome: 'ok' });
  });
});
