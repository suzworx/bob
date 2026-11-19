import { GatewayError } from '@ai-sdk/gateway';

const TRANSPORT_OR_BUDGET_PATTERN = /fetch failed|timeout/i;

/**
 * True for failures that originate upstream of this codebase: provider errors
 * (identified by the Gateway error marker), transport failures, and the
 * timeout/abort cases that are budget failures rather than defects here.
 * apps/api uses this predicate so provider concepts stay inside apps/ai.
 */
export function isProviderError(error: unknown): boolean {
  if (GatewayError.isInstance(error)) return true;
  if (error instanceof Error) {
    if (TRANSPORT_OR_BUDGET_PATTERN.test(error.message)) return true;
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  }
  return false;
}

/**
 * The upstream HTTP status when the error is a Gateway error, undefined
 * otherwise. Read from the typed field rather than parsed from a message.
 */
export function providerErrorStatus(error: unknown): number | undefined {
  return GatewayError.isInstance(error) ? error.statusCode : undefined;
}