import { recordObservationMetrics } from './observation-metrics.ts';
import { traceSpan } from './telemetry.ts';

/** Full provider-call duration, never TTFB: the speech SDK buffers its result. */
export function traceSpeechCall<T>(kind: 'stt' | 'tts', run: () => Promise<T>, inputChars?: number): Promise<T> {
  return traceSpan(`speech-${kind}-provider`, {}, async () => {
    const start = performance.now();
    let failed = 0;
    let timeout = 0;
    let cancelled = 0;
    if (inputChars !== undefined) recordObservationMetrics([{ name: 'speech.input_chars', value: inputChars }]);
    try { return await run(); }
    catch (error) {
      timeout = Number(error instanceof Error && error.name === 'TimeoutError');
      cancelled = Number(error instanceof Error && error.name === 'AbortError');
      failed = Number(!cancelled);
      throw error;
    } finally {
      recordObservationMetrics([
        { name: 'speech.duration_ms', value: Math.round(performance.now() - start), attributes: { stage: kind } },
        { name: 'speech.failed', value: failed },
        { name: 'speech.timeout', value: timeout },
        { name: 'speech.cancelled', value: cancelled },
      ]);
    }
  });
}
