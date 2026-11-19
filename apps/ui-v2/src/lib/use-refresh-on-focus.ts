import { useEffect, useState } from 'react';

// Returning to the tab usually fires visibilitychange and window focus back to
// back; the throttle also collapses those into a single refetch.
const THROTTLE_MS = 5_000;

/**
 * A counter that ticks when the reader comes back to the page: the document
 * turns visible again, or the window regains focus. It ticks at most once per
 * five seconds. Pass it to a hook's `refreshKey`, or watch it in an effect, to
 * refetch what was changed elsewhere while the tab was in the background.
 */
export function useRefreshOnFocus(): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let lastTickAt = Number.NEGATIVE_INFINITY;

    const bump = (): void => {
      const now = Date.now();
      if (now - lastTickAt < THROTTLE_MS) return;
      lastTickAt = now;
      setTick((count) => count + 1);
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') bump();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', bump);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', bump);
    };
  }, []);

  return tick;
}

/**
 * True only until the first load has finished. The v1 hooks raise `loading`
 * on every refetch, which would swap the content for a loading message and
 * throw away the reader's scroll position and open forms; gate the "Loading…"
 * state on this instead so a refetch replaces the data in place.
 */
export function useInitialLoading(loading: boolean): boolean {
  const [settled, setSettled] = useState(false);
  if (!loading && !settled) setSettled(true);
  return loading && !settled;
}
