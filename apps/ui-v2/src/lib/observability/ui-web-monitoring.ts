import { currentView, duration, type UiEvent } from './ui-events';

type View = NonNullable<ReturnType<typeof currentView>>;
type Sink = (event: UiEvent) => void;
type Vital = Extract<UiEvent, { event: 'web_vital' }>;
type Failure = Extract<UiEvent, { event: 'ui_error' }>;

const NAME = /^[A-Za-z]{1,40}$/;
const FRAME_LINE = /((?:https?|file):\/\/[^\s()]+?):(\d{1,6}):(\d{1,6})\)?$/;
const BASENAME = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_ERRORS_PER_MINUTE = 10;
const MAX_DEDUPE_KEYS = 100;

/** Web Vitals start once per page load; each install (a sign-in or sign-out re-installs) only swaps who receives them. */
let vitalSink: ((vital: Pick<Vital, 'name' | 'value' | 'rating'>) => void) | null = null;
let vitalsStarted = false;
let firstLoadReported = false;

function startVitals(): void {
  if (vitalsStarted) return;
  vitalsStarted = true;
  // Loaded after hydration so the library never sits in the entry chunk.
  void import('web-vitals').then(({ onLCP, onINP, onCLS, onFCP, onTTFB }) => {
    const report = (metric: { name: string; value: number; rating: string }): void => {
      if (!Number.isFinite(metric.value)) return;
      // CLS is unitless; x1000 keeps it an integer like every other bounded sample.
      const value = Math.min(120000, Math.max(0, Math.round(metric.name === 'CLS' ? metric.value * 1000 : metric.value)));
      vitalSink?.({ name: metric.name as Vital['name'], value, rating: metric.rating as Vital['rating'] });
    };
    for (const observe of [onLCP, onINP, onCLS, onFCP, onTTFB]) observe(report);
  }).catch(() => { /* Monitoring never interrupts the product. */ });
}

/** `file:line:col` for the top stack frame only when it lies in this app's own origin; the file is reduced to its basename. */
function ownFrame(error: unknown): string | undefined {
  try {
    const stack = typeof error === 'object' && error !== null ? (error as { stack?: unknown }).stack : undefined;
    if (typeof stack !== 'string') return undefined;
    const top = stack.split('\n').map((line) => FRAME_LINE.exec(line.trim())).find((match) => match !== null) ?? null;
    if (!top) return undefined;
    const url = new URL(top[1] as string);
    const file = url.pathname.split('/').pop() ?? '';
    return url.origin === location.origin && BASENAME.test(file) ? `${file}:${top[2]}:${top[3]}` : undefined;
  } catch { return undefined; }
}

function errorName(error: unknown): string {
  const name = typeof error === 'object' && error !== null ? (error as { constructor?: { name?: unknown } }).constructor?.name : undefined;
  return typeof name === 'string' && NAME.test(name) ? name : 'Error';
}

/** Names the error class and where it was thrown, never its message or stack text; max 10 a minute, identical name+frame once. */
function createErrorReporter(report: (failure: Pick<Failure, 'kind' | 'error_name' | 'frame'>) => void): (kind: Failure['kind'], error: unknown) => void {
  const seen = new Set<string>();
  let windowStart = 0;
  let sent = 0;
  return (kind, error) => {
    const error_name = errorName(error);
    const frame = ownFrame(error);
    const key = `${kind}|${error_name}|${frame ?? ''}`;
    const now = performance.now();
    if (seen.has(key) || seen.size >= MAX_DEDUPE_KEYS) return;
    if (now - windowStart >= 60_000) { windowStart = now; sent = 0; }
    if (sent >= MAX_ERRORS_PER_MINUTE) return;
    sent++;
    seen.add(key);
    report({ kind, error_name, ...(frame ? { frame } : {}) });
  };
}

function reportFirstLoad(record: Sink, view: () => View): void {
  if (firstLoadReported || typeof performance.getEntriesByType !== 'function') return;
  firstLoadReported = true;
  const emit = (): void => {
    const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (!entry) return;
    record({
      ...view(), event: 'ui_navigation', duration_ms: 0,
      dom_content_loaded_ms: duration(entry.domContentLoadedEventEnd), load_ms: duration(entry.loadEventEnd), ttfb_ms: duration(entry.responseStart),
    });
  };
  if (document.readyState === 'complete') window.setTimeout(emit, 0);
  else window.addEventListener('load', () => window.setTimeout(emit, 0), { once: true });
}

/** Authenticated lane only: vitals, JavaScript errors (class and own-bundle frame) and first-load navigation timing. Returns the cleanup. */
export function installWebMonitoring(record: Sink, view: () => View): () => void {
  const fail = createErrorReporter((failure) => record({ ...view(), ...failure, event: 'ui_error', duration_ms: 0 }));
  const onError = (event: Event): void => fail('error', (event as ErrorEvent).error);
  const onRejection = (event: Event): void => fail('rejection', (event as PromiseRejectionEvent).reason);
  vitalSink = (vital) => record({ ...view(), ...vital, event: 'web_vital', duration_ms: 0 });
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  startVitals();
  reportFirstLoad(record, view);
  return () => {
    vitalSink = null;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
