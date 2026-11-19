/**
 * Real tracing with an in-memory OTLP destination, for tests that assert on the spans a flow exports.
 *
 * Import this module BEFORE anything that loads `@bob/ai` (it points tracing at an endpoint, and the
 * endpoint must exist before `@bob/ai` initialises), then mock the exporter with it:
 *
 *   import { otlpSpans } from '../support/memory-otlp.ts';
 *   vi.mock('@opentelemetry/exporter-trace-otlp-proto', async () => ({
 *     OTLPTraceExporter: (await import('../support/memory-otlp.ts')).MemoryOtlpTraceExporter,
 *   }));
 *
 * Call `initTelemetry()` and `flushTelemetry()` from `@bob/ai` as usual; `otlpSpans.getFinishedSpans()`
 * holds what was exported and `otlpSpans.reset()` clears it between tests.
 */
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otlp.example.test';
process.env.OTEL_METRICS_EXPORTER = 'none';

export const otlpSpans = new InMemorySpanExporter();

/** Stands in for the OTLP exporter class: every instance is the one shared in-memory exporter. */
export class MemoryOtlpTraceExporter {
  constructor() {
    return otlpSpans;
  }
}

/** The attributes of the first exported span named `name`. */
export function exportedAttributes(name: string): Record<string, unknown> {
  const found = otlpSpans.getFinishedSpans().find((span) => span.name === name);
  if (found === undefined) throw new Error(`no exported span named ${name}`);
  return found.attributes;
}
