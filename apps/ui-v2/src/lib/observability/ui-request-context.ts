import { routeFromPath } from '../../app/routes';
import { prefixedId } from '../ids';
import { currentUiAction, withUiActionHeaders } from './ui-actions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SESSION_KEY = 'bob.client-session';
let tabSession: string | undefined;

/** One random id per browser tab (sessionStorage; a new tab is a new session), read once then kept. Telemetry only, never auth. */
export function clientSessionId(): string {
  if (tabSession !== undefined) return tabSession;
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored && UUID.test(stored)) {
      tabSession = stored;
    } else {
      tabSession = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, tabSession);
    }
  } catch {
    tabSession ??= crypto.randomUUID();
  }
  return tabSession;
}

/** The conversation the URL shows (`/c/:id`, a space thread), as a prefixed id; null on every other page. */
export function openConversationId(pathname: string = location.pathname): string | null {
  const route = routeFromPath(pathname);
  const id = route.kind === 'chat' ? route.conversationId : route.kind === 'spaces' ? route.threadId : null;
  return id === null ? null : prefixedId('conversation', id);
}

function randomHex(bytes: number): string {
  // An all-zero id is invalid in W3C trace context; a 2^-64 draw is retried rather than sent.
  for (;;) {
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (/[1-9a-f]/.test(hex)) return hex;
  }
}

/** A fresh sampled W3C trace context for one API request: the server continues the trace and the browser event names it. */
function newTraceparent(): { traceparent: string; trace_id: string } {
  const trace_id = randomHex(16);
  return { traceparent: `00-${trace_id}-${randomHex(8)}-01`, trace_id };
}

export function uiRequestContext(input: RequestInfo | URL, init?: RequestInit): {
  init: RequestInit | undefined;
  metadata: { action_id?: string; request_id?: string; trace_id?: string };
} {
  try {
    const original = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const supplied = original.get('X-Bob-Ui-Action-Id');
    const action_id = supplied && UUID.test(supplied) ? supplied : currentUiAction()?.action_id;
    const request_id = crypto.randomUUID();
    const next = withUiActionHeaders(input, init ?? { headers: original }, action_id);
    const headers = new Headers(next.headers ?? original);
    headers.set('X-Bob-Ui-Request-Id', request_id);
    headers.set('X-Bob-Client-Session', clientSessionId());
    const conversation = openConversationId();
    if (conversation) headers.set('X-Bob-Conversation', conversation);
    const { traceparent, trace_id } = newTraceparent();
    headers.set('traceparent', traceparent);
    return { init: { ...next, headers }, metadata: { request_id, trace_id, ...(action_id ? { action_id } : {}) } };
  } catch { return { init, metadata: {} }; }
}

export function uiResponseContext(response: Response): { trace_id?: string } {
  const id = response.headers.get('X-Bob-Trace-Id');
  return id && /^[0-9a-f]{32}$/.test(id) ? { trace_id: id } : {};
}
