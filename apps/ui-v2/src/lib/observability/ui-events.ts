import { routeFromPath } from '@/app/routes';
import { uiRoute } from './ui-routes';
import type { UiAction } from './ui-actions';
import endpoints from './ui-endpoint-catalog.json';

type Page = ReturnType<typeof routeFromPath>['kind'] | 'other' | 'signin';
type Common = { page: Page; view_id: string; duration_ms: number; route?: string };
export type UiMetricsCounters = {
  requests_ok: number; requests_error: number; requests_aborted: number;
  events_observed: number; events_accepted: number; events_dropped: number;
  batches_failed: number; timing_overflow: number; server_dropped: number;
};
export type UiMetricsWindow = Common & UiMetricsCounters & { event: 'ui_metrics_window' };
export type UiEditEvent = Common & {
  event: 'ui_edit' | 'ui_activity'; action: string; action_id: string; trigger: string; invocations: number;
  failed_invocations: number; aborted_invocations: number; duration_overflow?: boolean;
};
type Area = 'chat' | 'voice' | 'conversations' | 'spaces' | 'devices' | 'account' | 'memory' | 'productivity' | 'notifications' | 'other';
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'OTHER';
export type UiEvent = Common & (
  | { event: 'ui_navigation'; dom_content_loaded_ms?: number; load_ms?: number; ttfb_ms?: number }
  | { event: 'web_vital'; name: 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB'; value: number; rating: 'good' | 'needs-improvement' | 'poor' }
  | { event: 'ui_error'; kind: 'error' | 'rejection'; error_name: string; frame?: string }
  | ({ event: 'ui_action'; duration_overflow?: boolean } & UiAction)
  | UiEditEvent
  | { event: 'ui_interaction'; target: 'button' | 'link' | 'input' | 'select' | 'form' | 'other' }
  | { event: 'ui_render'; phase: 'mount' | 'update' | 'nested-update' }
  | { event: 'ui_request'; area: Area; method: Method; endpoint?: string; request_id?: string; action_id?: string; trace_id?: string; status: number; outcome: 'ok' | 'error' | 'aborted' }
);

export function currentView(anonymous = false): Pick<Common, 'page' | 'view_id' | 'route'> | null {
  try {
    const path = window.location.pathname;
    const routeKind = routeFromPath(path).kind;
    const kind = routeKind === 'groupChat' || routeKind === 'groupChatInvite' ? 'chat' : routeKind;
    if (anonymous && kind !== 'reset' && kind !== 'invite') return { page: 'signin', route: 'signin', view_id: crypto.randomUUID() };
    const page = kind === 'chat' && path !== '/' && !/^\/(c|groups|join-chat)\/[^/]+$/.test(path) ? 'other' : kind;
    return { page, route: uiRoute(path), view_id: crypto.randomUUID() };
  } catch {
    // Secure-context APIs can be unavailable on a device's LAN HTTP address.
    return null;
  }
}

export function duration(value: number): number {
  return Number.isFinite(value) ? Math.min(120000, Math.max(0, Math.round(value))) : 0;
}

export function clickTarget(target: EventTarget | null): Extract<UiEvent, { event: 'ui_interaction' }>['target'] {
  if (!(target instanceof Element)) return 'other';
  const element = target.closest('button,a,input,select,form,[role="button"],[role="link"]');
  const name = element?.tagName.toLowerCase();
  if (name === 'a' || element?.getAttribute('role') === 'link') return 'link';
  if (name === 'button' || element?.getAttribute('role') === 'button') return 'button';
  if (name === 'input' || name === 'select' || name === 'form') return name;
  return 'other';
}

const AREAS = new Set<string>(['chat', 'voice', 'conversations', 'spaces', 'devices', 'account', 'memory', 'productivity', 'notifications']);
const METHODS = new Set<string>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const AREA_ALIASES: Record<string, Area> = {
  'bob-apps': 'productivity',
  'group-chats': 'conversations', speech: 'voice', transcribe: 'voice', threads: 'conversations', invocations: 'conversations',
  tasks: 'productivity', notes: 'productivity', events: 'productivity', reminders: 'productivity', timers: 'productivity',
  calendars: 'productivity', agenda: 'productivity', 'action-items': 'productivity', memories: 'memory',
  'google-accounts': 'account', pair: 'devices', invitations: 'spaces', messages: 'conversations',
  'notification-preferences': 'notifications', me: 'account', active: 'conversations', search: 'conversations',
};

const endpointPatterns = endpoints.map(({ method, path }) => ({ method, path, pattern: new RegExp(`^${path.replace(/:[A-Za-z]+/g, '[^/]+')}$`) }))
  .sort((a, b) => (a.path.match(/:/g)?.length ?? 0) - (b.path.match(/:/g)?.length ?? 0));

export function requestCategory(input: RequestInfo | URL, init?: RequestInit): { area: Area; method: Method; endpoint: string } | null {
  try {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return null;
    const segment = url.pathname.split('/')[2] ?? '';
    if (segment === 'telemetry') return null;
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const alias = Object.hasOwn(AREA_ALIASES, segment) ? AREA_ALIASES[segment] : undefined;
    const endpoint = endpointPatterns.find((entry) => entry.method === method && entry.pattern.test(url.pathname))?.path ?? 'other';
    return { area: alias ?? (AREAS.has(segment) ? segment as Area : 'other'), method: METHODS.has(method) ? method as Method : 'OTHER', endpoint };
  } catch {
    return null;
  }
}
