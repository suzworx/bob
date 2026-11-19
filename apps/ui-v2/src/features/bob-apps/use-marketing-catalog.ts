import { useEffect, useRef, useState } from 'react';
import { marketingCatalog } from './marketing-api';

export function useMarketingCatalog(userId: string | null, spaceId: string | null = null) {
  const owner = `${userId}:${spaceId}`;
  const generation = useRef(0);
  const [loaded, setLoaded] = useState<{ owner: string; data: Awaited<ReturnType<typeof marketingCatalog>> } | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const accessChanged = (event: Event): void => {
      if (!spaceId || (event as CustomEvent<{ spaceId: string }>).detail?.spaceId !== spaceId) return;
      ++generation.current; setLoaded(null); setRevision((value) => value + 1);
    };
    window.addEventListener('bob:space-access', accessChanged);
    return () => window.removeEventListener('bob:space-access', accessChanged);
  }, [spaceId]);
  useEffect(() => {
    if (!userId) return;
    const current = ++generation.current;
    const controller = new AbortController();
    setError(false);
    void marketingCatalog(controller.signal, spaceId).then((result) => { if (!controller.signal.aborted && current === generation.current) setLoaded({ owner, data: result }); })
      .catch(() => { if (!controller.signal.aborted && current === generation.current) setError(true); });
    return () => controller.abort();
  }, [userId, spaceId, owner, revision]);
  return { data: loaded?.owner === owner ? loaded.data : null, error, reload: () => setRevision((value) => value + 1) };
}
