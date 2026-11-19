import { openobserveLogs } from '@openobserve/browser-logs';
import { openobserveRum, type RumEvent } from '@openobserve/browser-rum';
import type { RumConfig } from '@/lib/auth/supabase-client';
import { uiRoute } from './ui-routes';

/**
 * Browser Real User Monitoring. The ONLY file in ui-v2 that imports `@openobserve/*`
 * (guarded by apps/ai/tests/telemetry-vendor-neutral.test.ts). It runs only when
 * the server's public config carries `rum`, i.e. BOB_RUM_* is set; unset means off.
 *
 * Privacy: every text/input is masked, session replay is never started, the SDK adds
 * no trace headers (the app sends its own traceparent), and the only identity is the
 * account id. Nothing here may throw into the app.
 */
export type RumIds = { userId: string; sessionId: string; conversationId: string | null };
export type RumHandle = { setConversation: (conversationId: string | null) => void };

const OFF: RumHandle = { setConversation: () => {} };
let started = false;

/** Check event-time context as well as the current SPA location: queued events
 * and referrers can still belong to an invitation after navigation away. */
function outsideInvitation(event: unknown): boolean {
  try {
    const serialized = `${location.pathname} ${JSON.stringify(event)}`;
    const decoded = serialized.replace(/%[0-9a-f]{2}/gi, (value) => String.fromCharCode(Number.parseInt(value.slice(1), 16)));
    return !/\/(?:join-chat|invite|api\/(?:group-chats\/)?invitations)\//i.test(decoded);
  } catch { return false; }
}

/** Views cannot be discarded by the SDK. Its supported mutable fields are
 * scrubbed; free-text events are suppressed only in invitation contexts. */
function sanitizeEvent(event: RumEvent): boolean {
  if (event.type !== 'view' && !outsideInvitation(event)) return false;
  let route = 'other';
  try { route = uiRoute(new URL(event.view.url, location.origin).pathname); } catch { /* Invalid URLs stay bounded. */ }
  event.view.url = route;
  event.view.name = route;
  event.view.referrer = '';
  if (event.type === 'view' && event.view.performance?.lcp) event.view.performance.lcp.resource_url = '';
  return true;
}

function safely(action: () => void): void {
  try { action(); } catch { /* RUM must never break the app */ }
}

function setConversation(conversationId: string | null): void {
  safely(() => {
    if (conversationId) openobserveRum.setGlobalContextProperty('conversation_id', conversationId);
    else openobserveRum.removeGlobalContextProperty('conversation_id');
  });
}

/** Starts the SDKs once per page load; later calls only refresh the user and context. */
export function startRum(config: RumConfig | undefined, ids: RumIds): RumHandle {
  if (!config) return OFF;
  if (!started) {
    started = true;
    const connection = { clientToken: config.clientToken, site: config.site, organizationIdentifier: config.org, service: config.service, env: config.env, version: import.meta.env.BOB_WEB_RELEASE ?? config.version, insecureHTTP: false, apiVersion: 'v1' } as const;
    safely(() => openobserveRum.init({
      beforeSend: sanitizeEvent,
      applicationId: config.service,
      ...connection,
      trackResources: true,
      trackLongTasks: true,
      trackUserInteractions: true,
      defaultPrivacyLevel: 'mask',
      sessionSampleRate: 100,
      sessionReplaySampleRate: 0,
    }));
    safely(() => openobserveLogs.init({ ...connection, beforeSend: outsideInvitation, forwardErrorsToLogs: true, forwardConsoleLogs: ['error'], sessionSampleRate: 100 }));
  }
  safely(() => {
    openobserveRum.setUser({ id: ids.userId });
    openobserveRum.setGlobalContextProperty('session_id', ids.sessionId);
  });
  setConversation(ids.conversationId);
  return { setConversation };
}

/** Forgets the account when its session ends, so the next sign-in is not attributed to it. */
export function endRum(): void {
  if (started) safely(() => openobserveRum.clearUser());
}

export function resetRumForTests(): void {
  started = false;
}
