import { clickTarget, currentView, requestCategory, type UiEvent, type UiMetricsWindow } from './ui-events';
import { createUiMetrics } from './ui-metrics';
import { subscribeUiActions } from './ui-actions';
import { clientSessionId, openConversationId, uiRequestContext, uiResponseContext } from './ui-request-context';
import { getRumConfig } from '@/lib/auth/supabase-client';
import { endRum, startRum, type RumHandle } from './rum';

/** The account id (`sub`) of a bearer token, for monitoring attribution only; never verified or sent anywhere else. */
function tokenUserId(token: () => string | null): string | null {
  try {
    const payload = JSON.parse(atob((token()?.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: unknown };
    return typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
  } catch { return null; }
}
import { createUiEditSummaries } from './ui-edit-events';
import { installWebMonitoring } from './ui-web-monitoring';
import { anonymousUiEvent, boundedUiEvent, createUiDetailBudget, sendUiBatch, uiRequestFailure } from './ui-collection';

/** Authenticated, metadata-only browser facts. Fetch timings end at headers;
 * response bodies (including SSE) are never consumed, cloned or inspected. */
export function installUiObservability(token: () => string | null, options: { anonymous?: boolean } = {}): {
  dispose: () => void;
  flush: () => void;
  render: (phase: 'mount' | 'update' | 'nested-update', actualDuration: number) => void;
} {
  const anonymous = options.anonymous === true;
  const initialView = currentView(anonymous);
  if (!initialView) return { dispose: () => {}, render: () => {}, flush: () => {} };
  const originalFetch = window.fetch;
  let active = true;
  let view = initialView;
  let queue: UiEvent[] = [];
  let flushStart = performance.now();
  let flushCount = 0;
  const metrics = createUiMetrics();
  const capacity = anonymous ? 9 : 19;
  const detailBudget = createUiDetailBudget(capacity);
  const edits = createUiEditSummaries(record);
  function record(event: UiEvent): void {
    if (!active) return;
    if (anonymous && !anonymousUiEvent(event)) return;
    const accepted = detailBudget(event, queue.length);
    metrics.observe(event, accepted);
    if (!accepted) return;
    queue.push(boundedUiEvent(event));
    if (queue.length === capacity) flush();
  }
  async function send(events: Array<UiEvent | UiMetricsWindow>): Promise<void> {
    if (!active || events.length === 0) return;
    try {
      // No auth-helper recursion, refresh, retry, persisted queue or cross-account replay.
      const result = await sendUiBatch(originalFetch, events, anonymous ? null : token(), anonymous);
      if (!active) return;
      if (!result.ok) metrics.failed();
      metrics.serverDropped(result.dropped);
    } catch {
      // Observability failure must never interrupt rendering, navigation or requests.
      if (active) metrics.failed();
    }
  }
  function flush(): void {
    edits.flush();
    if (performance.now() - flushStart >= 60000) { flushStart = performance.now(); flushCount = 0; }
    if (flushCount >= 20) return;
    const events: Array<UiEvent | UiMetricsWindow> = queue;
    queue = [];
    const summary = metrics.take(view);
    if (summary) events.push(summary);
    if (events.length === 0) return;
    flushCount++;
    void send(events);
  }
  function navigate(): void {
    const nextView = currentView(anonymous);
    if (!nextView) { dispose(); return; }
    view = nextView;
    rum.setConversation(openConversationId());
    record({ ...view, event: 'ui_navigation', duration_ms: 0 });
  }
  function click(event: MouseEvent): void {
    record({ ...view, event: 'ui_interaction', target: clickTarget(event.target), duration_ms: 0 });
  }
  function visibility(): void { if (document.visibilityState === 'hidden') flush(); }
  const wrappedFetch: typeof fetch = async function (this: unknown, input, init) {
    const category = requestCategory(input, init);
    const context = category ? uiRequestContext(input, init) : { init, metadata: {} };
    const startingView = view;
    const start = performance.now();
    try {
      const response = await originalFetch.call(this, input, context.init);
      if (category) record({ ...startingView, ...category, ...uiResponseContext(response), ...context.metadata, event: 'ui_request', duration_ms: performance.now() - start, status: response.status, outcome: response.ok ? 'ok' : 'error' });
      return response;
    } catch (error) {
      if (category) record({ ...startingView, ...category, ...context.metadata, event: 'ui_request', duration_ms: performance.now() - start, status: 0, outcome: uiRequestFailure(error) });
      throw error;
    }
  };
  const actionViews = new Map<string, typeof view>();
  const stopActions = subscribeUiActions((received) => {
    const { editing, activity, ...event } = received;
    const key = `${event.action_id}/${event.action}`;
    if (event.stage === 'start' && actionViews.size < 256) actionViews.set(key, view);
    const startingView = actionViews.get(key) ?? view;
    if (event.stage === 'complete') actionViews.delete(key);
    if (edits.observe({ ...event, editing, activity }, startingView)) return;
    record({ ...startingView, event: 'ui_action', ...event });
    if (event.stage === 'start' && event.action.includes('sign-out')) flush();
  });
  const userId = anonymous ? null : tokenUserId(token);
  const rum: RumHandle = userId ? startRum(getRumConfig(), { userId, sessionId: clientSessionId(), conversationId: openConversationId() }) : { setConversation: () => {} };
  const stopWebMonitoring = anonymous ? () => {} : installWebMonitoring(record, () => view);
  window.fetch = wrappedFetch;
  window.addEventListener('bob:routechange', navigate);
  window.addEventListener('popstate', navigate);
  document.addEventListener('click', click, true);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', flush);
  const timer = window.setInterval(flush, 5000);
  function dispose(): void {
    active = false;
    if (userId) endRum();
    stopActions();
    stopWebMonitoring();
    actionViews.clear();
    queue = [];
    window.clearInterval(timer);
    if (window.fetch === wrappedFetch) window.fetch = originalFetch;
    window.removeEventListener('bob:routechange', navigate);
    window.removeEventListener('popstate', navigate);
    document.removeEventListener('click', click, true);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', flush);
  }
  record({ ...view, event: 'ui_navigation', duration_ms: 0 });
  return {
    render: (phase, actualDuration) => record({ ...view, event: 'ui_render', phase, duration_ms: actualDuration }),
    dispose,
    flush,
  };
}
