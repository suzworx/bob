import { useCallback, useEffect, useRef, useState } from 'react';
import { useRefreshOnFocus } from '@/lib/use-refresh-on-focus';
import { AppRequestError, getApp, listApps, type BobApp } from './bob-apps-api';
async function loadPages(count: number, spaceId: string | null): Promise<Awaited<ReturnType<typeof listApps>>> {
  const result = await listApps(undefined, spaceId);
  for (let page = 1; page < count && result.nextCursor; page++) { const next = await listApps(result.nextCursor, spaceId); result.apps.push(...next.apps); result.nextCursor = next.nextCursor; }
  return result;
}
function matchesAudience(app: BobApp | null, spaceId: string | null): boolean { return app === null || spaceId === null || app.spaceId === spaceId; }
async function readApps(id: string | null, count: number, spaceId: string | null): Promise<{ items: Awaited<ReturnType<typeof listApps>>; selected: BobApp | null }> {
  const [items, selected] = await Promise.all([loadPages(count, spaceId), id ? getApp(id) : Promise.resolve(null)]);
  if (!matchesAudience(selected, spaceId)) throw new AppRequestError(404);
  return { items, selected };
}
function unavailable(problem: unknown): boolean { return problem instanceof AppRequestError && [403, 404].includes(problem.status); }
function openFailure(problem: unknown): string {
  if (problem instanceof AppRequestError && problem.status === 404) return 'This app isn’t here. It may be private to someone else, or it may have been deleted.';
  return 'Couldn’t open your apps. Please try again.';
}
const isConflict = (problem: unknown): boolean => problem instanceof AppRequestError && problem.status === 409;
const saveErrorMessage = (problem: unknown): string => isConflict(problem)
  ? 'This app changed elsewhere. Your unsaved edits are still here. Reload the latest data, review your edits, then save again.'
  : 'Couldn’t save this change. Your edits are still here. Please try again.';
export function useBobApps(id: string | null, spaceId: string | null = null) {
  const [apps, setApps] = useState<Awaited<ReturnType<typeof listApps>>['apps'] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [app, setApp] = useState<BobApp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const activeId = useRef(id); activeId.current = id;
  const focus = useRefreshOnFocus();
  const generation = useRef(0);
  const pages = useRef(1);
  const mutating = useRef(false);
  const load = useCallback(async (): Promise<void> => {
    if (activeId.current !== id) return;
    const current = ++generation.current;
    try {
      const { items, selected } = await readApps(id, pages.current, spaceId);
      if (!alive.current || current !== generation.current) return;
      setApps(items.apps); setNextCursor(items.nextCursor); setApp(selected); setError(null);
    } catch (problem) {
      if (!alive.current || current !== generation.current) return;
      if (unavailable(problem)) { setApp(null); setApps([]); }
      setError(openFailure(problem));
    }
  }, [id, spaceId]);
  useEffect(() => {
    alive.current = true;
    setApp(null); setError(null); void load();
    const refresh = (): void => { if (document.visibilityState === 'visible' && !mutating.current) void load(); };
    const onAccess = (event: Event): void => {
      const changed = (event as CustomEvent<{ spaceId: string }>).detail;
      if (!spaceId || changed?.spaceId !== spaceId) return;
      ++generation.current; setApp(null); setApps([]); setError(null); void load();
    };
    window.addEventListener('bob:space-access', onAccess);
    const timer = window.setInterval(refresh, 15000);

    return () => { alive.current = false; ++generation.current; window.clearInterval(timer); window.removeEventListener('bob:space-access', onAccess); };
  }, [load, spaceId]);
  useEffect(() => { if (!mutating.current) void load(); }, [focus, load]);
  // quiet: the caller is a form or dialog on top of the page and tells the person itself.
  const perform = async (action: () => Promise<unknown>, { quiet = false } = {}): Promise<boolean> => {
    if (mutating.current) return false;
    mutating.current = true; setBusy(true); setError(null); ++generation.current;
    try { await action(); await load(); return true; }
    catch (problem) {
      // Whatever went wrong, the server may have moved on, or saved this and lost the reply.
      await load();
      if (alive.current && !quiet) setError(saveErrorMessage(problem));
      return false;
    } finally { mutating.current = false; if (alive.current) setBusy(false); }
  };
  const more = async (): Promise<void> => { if (!nextCursor) return; pages.current += 1; await load(); };
  return { apps, app, error, busy, load, perform, nextCursor, more };
}
