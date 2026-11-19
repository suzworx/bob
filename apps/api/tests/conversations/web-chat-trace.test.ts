/**
 * traceWebTurn stamps the web turn id into the turn's trace so it joins
 * back to the journal's `v2.turn_stage_*` lines (LF-OBS-1).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@bob/ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@bob/ai')>();
  return {
    ...original,
    traceSpan: vi.fn((_name: string, _attrs: unknown, fn: () => unknown) => fn()),
  };
});

import { traceSpan } from '@bob/ai';
import { traceWebTurn } from '../../src/conversations/chat-stream.ts';

describe('traceWebTurn', () => {
  it('passes conversation, user, and turn id to the trace', async () => {
    const result = await traceWebTurn('conv-1', 'user-1', 'turn-9', () => 'reply');
    expect(result).toBe('reply');
    expect(vi.mocked(traceSpan)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(traceSpan).mock.calls[0]?.[1]).toEqual({
      conversationId: 'conv-1',
      conversationSource: 'explicit',
      userId: 'user-1',
      turnId: 'turn-9',
      workflowNamespace: expect.any(String),
      tags: ['web'],
      metadata: { interface: 'web', turn_id: 'turn-9' },
    });
  });
});
