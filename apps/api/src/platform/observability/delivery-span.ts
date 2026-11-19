/**
 * Delivery-path spans: the reminder fanout, the outbox tick, email outcomes
 * and notification enqueues each run their existing journal line inside one
 * trace span (surface `delivery`), as device milestones do. The fields
 * become string metadata, so callers pass counts, template ids and reason or
 * status codes only -- never an address, a title, notification text, an id
 * or a URL. A passthrough when no trace exporter is configured; rejects only when `run` does,
 * and a rejecting `run` marks the span ERROR.
 */
import { toSpanAttrs, traceSpan } from '@bob/ai';

export function traceDelivery<T>(
  spanName: string,
  fields: Record<string, string | number | undefined>,
  run: () => T | Promise<T>,
): Promise<T> {
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) metadata[key] = String(value);
  }
  return traceSpan(spanName, toSpanAttrs({ surface: 'delivery', metadata }), run);
}
