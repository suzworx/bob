import { useEffect } from 'react';
import { useRefreshOnFocus } from '../../lib/use-refresh-on-focus';

/** Refetches the spaces when the reader comes back to the tab (throttled by
 *  useRefreshOnFocus), so another member's rename, archive or ownership
 *  change shows up without a reload. */
export function useSpacesRefreshOnFocus(refresh: () => Promise<void>): void {
  const tick = useRefreshOnFocus();
  useEffect(() => {
    if (tick > 0) void refresh();
  }, [tick, refresh]);
}
