import { describe, expect, it, vi } from 'vitest';
import { traceSpeechCall } from '../src/speech-observability.ts';
import { recordObservationMetrics } from '../src/observation-metrics.ts';
import { traceSpan } from '../src/telemetry.ts';
vi.mock('../src/telemetry.ts', () => ({ traceSpan: vi.fn(async (_name, _attrs, fn) => fn()) }));
vi.mock('../src/observation-metrics.ts', () => ({ recordObservationMetrics: vi.fn() }));
describe('speech provider diagnostics', () => {
  it('preserves successful output and records whole call timing without content', async () => {
    const output = { text: 'private' };
    await expect(traceSpeechCall('tts', async () => output, 12)).resolves.toBe(output);
    expect(traceSpan).toHaveBeenCalledWith('speech-tts-provider', {}, expect.any(Function));
    expect(recordObservationMetrics).toHaveBeenCalledWith([{ name: 'speech.input_chars', value: 12 }]);
    expect(recordObservationMetrics).toHaveBeenLastCalledWith(expect.arrayContaining([{ name: 'speech.failed', value: 0 }, { name: 'speech.timeout', value: 0 }, { name: 'speech.cancelled', value: 0 }]));
    expect(JSON.stringify(vi.mocked(recordObservationMetrics).mock.calls)).not.toContain('private');
  });
  it.each([['TimeoutError', 1, 1, 0], ['AbortError', 0, 0, 1], ['Error', 1, 0, 0]])('classifies %s without changing rejection', async (name, failed, timeout, cancelled) => {
    const error = new Error('private'); error.name = String(name);
    await expect(traceSpeechCall('stt', async () => { throw error; })).rejects.toBe(error);
    expect(recordObservationMetrics).toHaveBeenLastCalledWith(expect.arrayContaining([
      { name: 'speech.failed', value: failed }, { name: 'speech.timeout', value: timeout }, { name: 'speech.cancelled', value: cancelled },
    ]));
  });
});
