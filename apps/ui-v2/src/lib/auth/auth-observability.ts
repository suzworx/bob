import { currentUiAction } from '@/lib/observability/ui-actions';
import { reportUiAuth, type UiAuthReport } from '@/lib/observability/ui-auth-events';

const operations: ReadonlyArray<UiAuthReport['operation']> = [
  'signInWithOtp', 'verifyOtp', 'signInWithPassword', 'resetPasswordForEmail',
  'updateUser', 'signOut', 'refreshSession',
];
const installed = new WeakSet<object>();
type Method = (this: unknown, ...args: unknown[]) => unknown;

function classify(error: unknown): UiAuthReport['outcome'] {
  try { return (error instanceof Error || error instanceof DOMException) && error.name === 'AbortError' ? 'aborted' : 'error'; }
  catch { return 'error'; }
}

function resultOutcome(result: unknown): UiAuthReport['outcome'] {
  try {
    const error: unknown = typeof result === 'object' && result !== null && 'error' in result ? result.error : null;
    return error ? classify(error) : 'ok';
  } catch { return 'error'; }
}

function completion(operation: UiAuthReport['operation']): (outcome: UiAuthReport['outcome']) => void {
  try {
    const started = performance.now();
    const actionId = currentUiAction()?.action_id;
    return (outcome): void => {
      try { reportUiAuth({ operation, outcome, duration_ms: performance.now() - started, ...(actionId ? { action_id: actionId } : {}) }); }
      catch { /* Reporting never changes auth behavior. */ }
    };
  } catch { return (): void => {}; }
}

function wrap(operation: UiAuthReport['operation'], original: Method): Method {
  return function (this: unknown, ...args: unknown[]): unknown {
    const complete = completion(operation);
    try {
      const result = original.apply(this, args);
      if (result instanceof Promise) void result.then((value: unknown) => complete(resultOutcome(value)), (error: unknown) => complete(classify(error)));
      else complete(resultOutcome(result));
      return result;
    } catch (error) { complete(classify(error)); throw error; }
  };
}

/** Inspect only the provider's error presence. Never capture credentials or provider responses. */
export function observeAuthOperations(auth: object): void {
  if (installed.has(auth)) return;
  installed.add(auth);
  for (const operation of operations) {
    try {
      const original: unknown = Reflect.get(auth, operation);
      if (typeof original === 'function') Reflect.set(auth, operation, wrap(operation, original as Method));
    } catch { /* An unavailable/read-only method leaves the original client usable. */ }
  }
}
