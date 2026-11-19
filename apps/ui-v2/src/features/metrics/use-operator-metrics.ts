import { useCallback, useEffect, useState } from 'react';
import { useRefreshOnFocus } from '../../lib/use-refresh-on-focus';
import { fetchOperatorMetrics, type MetricsDocuments, type MetricsRange } from './metrics-api';

export type MetricsLens = 'reliability' | 'ai' | 'devices' | 'features' | 'users';

type Docs = MetricsDocuments;
type LensData =
  | { lens: 'reliability'; usage: Docs['usage']; voice: Docs['voice']; platform: Docs['platform'] }
  | { lens: 'ai'; ai: Docs['ai'] }
  | { lens: 'devices'; devices: Docs['devices'] }
  | { lens: 'features'; features: Docs['features'] }
  | { lens: 'users'; users: Docs['users'] };

export type OperatorMetrics = { state: 'loading' } | { state: 'failed'; lens: MetricsLens } | ({ state: 'ready' } & LensData);

const LOADING: OperatorMetrics = { state: 'loading' };

// A lens is one or more independent documents, so they load together.
async function loadLens(lens: MetricsLens, range: MetricsRange): Promise<LensData> {
  switch (lens) {
    case 'reliability': {
      const [usage, voice, platform] = await Promise.all([
        fetchOperatorMetrics('usage', range),
        fetchOperatorMetrics('voice', range),
        fetchOperatorMetrics('platform', range),
      ]);
      return { lens, usage, voice, platform };
    }
    case 'ai':
      return { lens, ai: await fetchOperatorMetrics('ai', range) };
    case 'devices':
      return { lens, devices: await fetchOperatorMetrics('devices', range) };
    case 'features':
      return { lens, features: await fetchOperatorMetrics('features', range) };
    case 'users':
      return { lens, users: await fetchOperatorMetrics('users', range) };
  }
}

// Only the active lens is requested. A refetch (range change, tab focus) keeps
// the last answer on screen until the new one lands; an answer for a range or
// lens the reader has already left is dropped, and a lens change shows loading
// (also over another lens's answer or error). `retry` asks again after a
// failure and shows loading while it does.
export function useOperatorMetrics(lens: MetricsLens, range: MetricsRange): { metrics: OperatorMetrics; retry: () => void } {
  const [metrics, setMetrics] = useState<OperatorMetrics>(LOADING);
  const [attempt, setAttempt] = useState(0);
  const refreshKey = useRefreshOnFocus();
  const retry = useCallback((): void => {
    setMetrics(LOADING);
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let live = true;
    loadLens(lens, range).then(
      (data) => {
        if (live) setMetrics({ state: 'ready', ...data });
      },
      () => {
        if (live) setMetrics({ state: 'failed', lens });
      },
    );
    return () => {
      live = false;
    };
  }, [lens, range, refreshKey, attempt]);

  return { metrics: metrics.state !== 'loading' && metrics.lens !== lens ? LOADING : metrics, retry };
}
