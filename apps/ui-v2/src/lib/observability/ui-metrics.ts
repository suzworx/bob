import { duration, type UiEvent, type UiMetricsCounters, type UiMetricsWindow } from './ui-events';

function emptyCounters(): UiMetricsCounters {
  return { requests_ok: 0, requests_error: 0, requests_aborted: 0, events_observed: 0, events_accepted: 0, events_dropped: 0, batches_failed: 0, timing_overflow: 0, server_dropped: 0 };
}

/** Fixed-size counters measure every eligible event, before detail sampling. */
export function createUiMetrics(): {
  observe: (event: UiEvent, accepted: boolean) => void;
  failed: () => void;
  serverDropped: (count: number) => void;
  take: (view: Pick<UiEvent, 'page' | 'view_id'>) => UiMetricsWindow | null;
} {
  let counters = emptyCounters();
  let page: UiEvent['page'] | null = null;
  let started = performance.now();
  function increment(key: keyof UiMetricsCounters): void { counters[key] = Math.min(1_000_000, counters[key] + 1); }
  return {
    observe: (event, accepted) => {
      page = page === null || page === event.page ? event.page : 'other';
      increment('events_observed');
      increment(accepted ? 'events_accepted' : 'events_dropped');
      if (event.duration_ms > (['ui_action', 'ui_edit', 'ui_activity'].includes(event.event) ? 604_800_000 : 120000)) increment('timing_overflow');
      if (event.event === 'ui_request') increment(`requests_${event.outcome}`);
    },
    failed: () => increment('batches_failed'),
    serverDropped: (count) => { counters.server_dropped = Math.min(1_000_000, counters.server_dropped + count); },
    take: (view) => {
      if (!Object.values(counters).some((value) => value > 0)) return null;
      const result: UiMetricsWindow = { ...view, page: page ?? view.page, event: 'ui_metrics_window', duration_ms: duration(performance.now() - started), ...counters };
      counters = emptyCounters();
      page = null;
      started = performance.now();
      return result;
    },
  };
}
