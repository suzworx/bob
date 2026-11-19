import catalog from './ui-action-catalog.json';

export type UiAction = {
  action: string;
  action_id: string;
  trigger: string;
  stage: 'start' | 'complete';
  outcome?: 'returned' | 'resolved' | 'error' | 'aborted';
  duration_ms: number;
  editing?: boolean;
  activity?: boolean;
};
type Callback = (this: unknown, ...args: unknown[]) => unknown;
const allowed = new Map(catalog.map(({ id, trigger }) => [id, trigger]));
const editActions = new Set(catalog.filter(({ category }) => category === 'edit').map(({ id }) => id));
const activityActions = new Set(catalog.filter(({ category }) => category === 'activity').map(({ id }) => id));
const wrappers = new WeakMap<object, Map<string, Callback>>();
const listeners = new Set<(event: UiAction) => void>();
let active: Pick<UiAction, 'action' | 'action_id' | 'editing'> | null = null;

export function currentUiAction(): typeof active { return active; }

export function isAnonymousUiAction(action: string): boolean {
  return allowed.has(action) && /^(account\.(sign-in|reset-page)|spaces\.invite-page)\./.test(action);
}

export function subscribeUiActions(listener: (event: UiAction) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function emit(event: UiAction, recipients: Array<(event: UiAction) => void>): void {
  for (const listener of recipients) {
    if (!listeners.has(listener)) continue;
    try { listener(event); } catch { /* Collection cannot change application behavior. */ }
  }
}

function actionId(): string | null {
  try { return active?.action_id ?? crypto.randomUUID(); } catch { return null; }
}

function failure(error: unknown): 'error' | 'aborted' {
  return error instanceof DOMException && error.name === 'AbortError' ? 'aborted' : 'error';
}

function execute(action: string, trigger: string, callback: Callback, receiver: unknown, args: unknown[]): unknown {
  if (listeners.size === 0) return callback.apply(receiver, args);
  if (active?.editing && !editActions.has(action)) return callback.apply(receiver, args);
  const id = actionId();
  if (!id) return callback.apply(receiver, args);
  const parent = active;
  const recipients = [...listeners];
  const started = performance.now();
  const context = { action, action_id: id, trigger, ...(editActions.has(action) ? { editing: true } : {}), ...(activityActions.has(action) ? { activity: true } : {}) };
  const complete = (outcome: UiAction['outcome']): void => emit({ ...context, stage: 'complete', outcome, duration_ms: performance.now() - started }, recipients);
  active = context;
  emit({ ...context, stage: 'start', duration_ms: 0 }, recipients);
  try {
    const result = callback.apply(receiver, args);
    if (result instanceof Promise) void result.then(() => complete('resolved'), (error: unknown) => complete(failure(error)));
    else complete('returned');
    return result;
  } catch (error) {
    complete(failure(error));
    throw error;
  } finally {
    active = parent;
  }
}

/** Build-time wrappers keep the original receiver, result, rejection and stable callback identity.
 * Nested forwarding callbacks share a workflow UUID. Only synchronous causality is inferred. */
export function observeUiAction<T>(action: string, callback: T): T {
  const trigger = allowed.get(action);
  if (typeof callback !== 'function' || !trigger) return callback;
  let byAction = wrappers.get(callback);
  if (!byAction) { byAction = new Map(); wrappers.set(callback, byAction); }
  const existing = byAction.get(action);
  if (existing) return existing as T;
  const original = callback as Callback;
  const wrapped: Callback = function (this: unknown, ...args: unknown[]): unknown {
    return execute(action, trigger, original, this, args);
  };
  byAction.set(action, wrapped);
  return wrapped as T;
}

/** Preserve an action across auth refresh awaits, but never send correlation to another origin. */
export function withUiActionHeaders(input: RequestInfo | URL, init: RequestInit, id = active?.action_id): RequestInit {
  if (!id) return init;
  try {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || url.pathname === '/api/telemetry') return init;
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('X-Bob-Ui-Action-Id', id);
    return { ...init, headers };
  } catch { return init; }
}
