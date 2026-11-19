import { isAnonymousUiAction } from './ui-actions';
import { duration, type UiEvent } from './ui-events';
import { clientSessionId, openConversationId } from './ui-request-context';

export function anonymousUiEvent(event: UiEvent): boolean {
  if (event.event === 'ui_navigation') return true;
  return (event.event === 'ui_action' || event.event === 'ui_edit' || event.event === 'ui_activity') && isAnonymousUiAction(event.action);
}

export function boundedUiEvent(event: UiEvent): UiEvent {
  if (event.event !== 'ui_action' && event.event !== 'ui_edit' && event.event !== 'ui_activity') return { ...event, duration_ms: duration(event.duration_ms) };
  const overflow = !Number.isFinite(event.duration_ms) || event.duration_ms > 604_800_000;
  return { ...event, duration_ms: overflow ? 0 : Math.max(0, Math.round(event.duration_ms)), ...(overflow ? { duration_overflow: true } : {}) };
}

export function createUiDetailBudget(capacity: number): (event: UiEvent, queued: number) => boolean {
  let started = performance.now();
  let count = 0;
  let renders = 0;
  let edits = 0;
  return (event, queued) => {
    if (performance.now() - started >= 60_000) { started = performance.now(); count = 0; renders = 0; edits = 0; }
    if (queued >= capacity) return false;
    if (event.event === 'ui_edit' || event.event === 'ui_activity') { if (edits >= 20) return false; edits++; return true; }
    if (count >= 100) return false;
    if (event.event === 'ui_render' && renders >= 20) return false;
    renders += Number(event.event === 'ui_render');
    count++;
    return true;
  };
}

export async function sendUiBatch(fetcher: typeof fetch, events: readonly unknown[], bearer: string | null, anonymous: boolean): Promise<{ ok: boolean; dropped: number }> {
  if (!anonymous && !bearer) return { ok: false, dropped: 0 };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearer && !anonymous) {
    // The ids every API request carries, so the server joins these events to the tab and the open conversation.
    headers.Authorization = `Bearer ${bearer}`;
    headers['X-Bob-Client-Session'] = clientSessionId();
    const conversation = openConversationId();
    if (conversation) headers['X-Bob-Conversation'] = conversation;
  }
  const response = await fetcher.call(window, anonymous ? '/api/telemetry/anonymous' : '/api/telemetry', {
    method: 'POST', headers, body: JSON.stringify({ events }), keepalive: true,
  });
  const dropped = Number(response.headers.get('X-Bob-Telemetry-Dropped'));
  return { ok: response.ok, dropped: Number.isInteger(dropped) && dropped > 0 && dropped <= events.length ? dropped : 0 };
}

export function uiRequestFailure(error: unknown): 'aborted' | 'error' {
  return error instanceof DOMException && error.name === 'AbortError' ? 'aborted' : 'error';
}
