import { useCallback, useEffect, useState } from 'react';
import { useRefreshOnFocus } from '../../lib/use-refresh-on-focus';
import { fetchUsage, type UsageRange, type UsageResponse } from './usage-api';

type UsageState = 'loading' | 'ready' | 'empty' | 'failed';

type UsageResult = { state: UsageState; usage: UsageResponse | null; retry: () => void };
type Settled = { state: UsageState; usage: UsageResponse | null; range: UsageRange };

function hasNoActivity(usage: UsageResponse): boolean {
  const { created } = usage;
  const createdAnything = created.tasks + created.notes + created.reminders + (usage.memories?.new_in_range ?? 0) > 0;
  return usage.turns.total === 0 && usage.todos_done === 0 && !createdAnything;
}

// Refetches when the range changes, when the reader returns to the tab, and on
// retry. A failed refetch of the range already on screen keeps its numbers.
export function useUsage(range: UsageRange): UsageResult {
  const [settled, setSettled] = useState<Settled | null>(null);
  const [attempt, setAttempt] = useState(0);
  const refreshKey = useRefreshOnFocus();

  useEffect(() => {
    let cancelled = false;
    fetchUsage(range).then(
      (usage) => {
        if (cancelled) return;
        setSettled({ range, state: hasNoActivity(usage) ? 'empty' : 'ready', usage });
      },
      () => {
        if (cancelled) return;
        setSettled((prev) =>
          prev !== null && prev.range === range && prev.usage !== null
            ? prev
            : { range, state: 'failed', usage: null },
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [range, refreshKey, attempt]);

  const retry = useCallback((): void => {
    setSettled(null);
    setAttempt((value) => value + 1);
  }, []);

  if (settled !== null && settled.range === range) return { state: settled.state, usage: settled.usage, retry };
  return { state: 'loading', usage: null, retry };
}
