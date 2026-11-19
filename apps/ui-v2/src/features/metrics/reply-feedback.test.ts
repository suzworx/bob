import { beforeEach, describe, expect, it, vi } from 'vitest';
import { messageTraceId, sendReplyFeedback } from './reply-feedback';

const sendTelemetryEvents = vi.hoisted(() => vi.fn(async (_events: unknown[]): Promise<void> => {}));
vi.mock('@/features/voice/mode/metrics', () => ({ sendTelemetryEvents }));

const TRACE_ID = '1234567890abcdef1234567890abcdef';

beforeEach(() => {
  sendTelemetryEvents.mockReset();
  sendTelemetryEvents.mockResolvedValue(undefined);
});

describe('sendReplyFeedback', () => {
  it('sends one reply_feedback event for a valid trace id', async () => {
    await sendReplyFeedback(TRACE_ID, false);
    expect(sendTelemetryEvents).toHaveBeenCalledExactlyOnceWith([{ event: 'reply_feedback', trace_id: TRACE_ID, positive: false }]);
  });

  it.each(['', 'trace-1', 'ABCDEF1234567890ABCDEF1234567890', `${TRACE_ID}0`])('sends nothing for invalid trace id %j', async (traceId) => {
    await sendReplyFeedback(traceId, true);
    expect(sendTelemetryEvents).not.toHaveBeenCalled();
  });

  it('does not throw when the transport fails', async () => {
    sendTelemetryEvents.mockRejectedValue(new Error('network down'));
    await expect(sendReplyFeedback(TRACE_ID, true)).resolves.toBeUndefined();
  });
});

describe('messageTraceId', () => {
  it('returns only a 32-hex trace id from message metadata', () => {
    expect(messageTraceId({ metadata: { traceId: TRACE_ID } })).toBe(TRACE_ID);
    expect(messageTraceId({ metadata: { traceId: 'nope' } })).toBeUndefined();
    expect(messageTraceId({ metadata: {} })).toBeUndefined();
    expect(messageTraceId({})).toBeUndefined();
  });
});
