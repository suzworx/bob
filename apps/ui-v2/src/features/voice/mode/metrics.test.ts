/**
 * Conversation-mode metrics batching (013 R8, FR-031..FR-034): with injected
 * transport, clock, and hidden hook under fake timers -- interval flush, size
 * flush, flush on hide, drop-on-overflow, and a transport error that never
 * throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetrics, type MetricsOptions, type TelemetryEvent } from './metrics';

const timing = (n: number): TelemetryEvent => ({ event: 'turn_timing', eos_to_first_audio_ms: n });

interface Harness {
  send: ReturnType<typeof vi.fn>;
  onHidden: ReturnType<typeof vi.fn>;
  nowValue: { value: number };
  hidden: () => void;
  metrics: ReturnType<typeof createMetrics>;
}

function makeHarness(overrides: Partial<MetricsOptions> = {}): Harness {
  const send = vi.fn(overrides.send ?? (async () => undefined));
  const nowValue = { value: 0 };
  let hiddenCb: (() => void) | undefined;
  const onHidden = vi.fn((cb: () => void): (() => void) => {
    hiddenCb = cb;
    return () => undefined;
  });
  const metrics = createMetrics({
    send,
    now: () => nowValue.value,
    flushMs: overrides.flushMs ?? 10000,
    maxBatch: overrides.maxBatch ?? 20,
    onHidden,
  });
  return {
    send,
    onHidden,
    nowValue,
    hidden: (): void => {
      if (!hiddenCb) throw new Error('hidden callback was not registered');
      hiddenCb();
    },
    metrics,
  };
}

describe('createMetrics (013 R8)', () => {
  it('disposes its interval and hidden subscription and flushes pending metrics', async () => {
    const off = vi.fn();
    const send = vi.fn(async () => {});
    const metrics = createMetrics({ send, onHidden: () => off });
    metrics.record(timing(100));
    metrics.dispose();
    expect(off).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(send).toHaveBeenCalledWith([timing(100)]);
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes the batch when the interval elapses', () => {
    const h = makeHarness();
    h.metrics.record(timing(1000));
    expect(h.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10000);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith([{ event: 'turn_timing', eos_to_first_audio_ms: 1000 }]);
  });

  it('flushes eagerly once the batch reaches maxBatch', () => {
    const h = makeHarness();
    const events = Array.from({ length: 20 }, (_, i) => timing(i));
    for (const event of events) h.metrics.record(event);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(events);
  });

  it('flushes when the hidden hook fires (pagehide / visibilitychange)', () => {
    const h = makeHarness();
    h.metrics.record(timing(2000));
    expect(h.onHidden).toHaveBeenCalledTimes(1);
    h.hidden();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith([{ event: 'turn_timing', eos_to_first_audio_ms: 2000 }]);
  });

  it('drops the oldest events rather than queueing without bound', async () => {
    const h = makeHarness({ maxBatch: 200 });
    for (let i = 0; i < 105; i += 1) h.metrics.record(timing(i));
    expect(h.send).not.toHaveBeenCalled();
    await h.metrics.flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    const sent = h.send.mock.calls[0]![0] as TelemetryEvent[];
    expect(sent).toHaveLength(100);
    expect(sent[0]).toEqual(timing(5));
    expect(sent[99]).toEqual(timing(104));
  });

  it('carries a trace id on timing and a reply_feedback event in the same batch', async () => {
    const h = makeHarness();
    const trace_id = 'a'.repeat(32);
    h.metrics.record({ event: 'turn_timing', eos_to_first_audio_ms: 750, trace_id });
    h.metrics.record({ event: 'reply_feedback', trace_id, positive: true });
    await h.metrics.flush();
    expect(h.send).toHaveBeenCalledExactlyOnceWith([
      { event: 'turn_timing', eos_to_first_audio_ms: 750, trace_id },
      { event: 'reply_feedback', trace_id, positive: true },
    ]);
  });

  it('never throws when the transport rejects', async () => {
    const h = makeHarness({
      send: vi.fn(async () => {
        throw new Error('network down');
      }),
    });
    h.metrics.record(timing(1));
    await expect(h.metrics.flush()).resolves.toBeUndefined();
  });
});