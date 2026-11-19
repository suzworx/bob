import { sendUiBatch } from './ui-collection';

export type UiAuthReport = {
  operation: 'signInWithOtp' | 'verifyOtp' | 'signInWithPassword' | 'resetPasswordForEmail' | 'updateUser' | 'signOut' | 'refreshSession';
  outcome: 'ok' | 'error' | 'aborted';
  duration_ms: number;
  action_id?: string;
};
type AuthEvent = UiAuthReport & { event: 'ui_auth'; view_id: string; duration_overflow?: boolean };
let queue: AuthEvent[] = [];
let timer: number | undefined;
let viewId: string | undefined;
let windowStart = 0;
let count = 0;
let dropped = 0;
let failed = 0;
let observingPageHide = false;
let inFlight = false;

async function flush(): Promise<void> {
  window.clearTimeout(timer);
  timer = undefined;
  if (queue.length === 0 || inFlight) return;
  const events = queue;
  queue = [];
  const losses = dropped;
  const failures = failed;
  const first = events[0];
  if (!first) return;
  inFlight = true;
  try {
    const response = await sendUiBatch(fetch, [{ ...first, events_dropped: losses, batches_failed: failures }, ...events.slice(1)], null, true);
    if (!response.ok) { failed = Math.min(1_000_000, failed + 1); dropped = Math.min(1_000_000, dropped + events.length); return; }
    dropped -= losses;
    failed -= failures;
    dropped = Math.min(1_000_000, dropped + response.dropped);
  } catch { failed = Math.min(1_000_000, failed + 1); dropped = Math.min(1_000_000, dropped + events.length); }
  finally { inFlight = false; if (queue.length > 0) timer ??= window.setTimeout(() => { void flush(); }, 1000); }
}

/** Independent anonymous outcome lane survives the auth observer's ownership change.
 * This reports no page: completion may occur after navigation or sign-in. */
export function reportUiAuth(report: UiAuthReport): void {
  try {
    const now = performance.now();
    if (now - windowStart >= 60_000) { windowStart = now; count = 0; }
    if (count >= 100 || queue.length >= 10) { dropped = Math.min(1_000_000, dropped + 1); return; }
    viewId ??= crypto.randomUUID();
    count++;
    const overflow = !Number.isFinite(report.duration_ms) || report.duration_ms > 604_800_000;
    queue.push({ event: 'ui_auth', view_id: viewId, operation: report.operation, outcome: report.outcome,
      duration_ms: overflow ? 0 : Math.max(0, Math.round(report.duration_ms)),
      ...(report.action_id ? { action_id: report.action_id } : {}), ...(overflow ? { duration_overflow: true } : {}),
    });
    if (!observingPageHide) { observingPageHide = true; window.addEventListener('pagehide', () => { void flush(); }); }
    if (queue.length === 10) void flush();
    else timer ??= window.setTimeout(() => { void flush(); }, 1000);
  } catch { /* No credentials, provider objects or exceptions can escape through telemetry. */ }
}
