import { useCallback, useEffect, useState } from 'react';
import { useSession } from '@/lib/auth/use-session';
import { probeAdminAccess } from './admin-api';

type Access = 'checking' | 'yes' | 'no' | 'failed';
const DENIED_EVENT = 'bob:admin-access-denied';
export function invalidateAdminAccess(): void {
  window.dispatchEvent(new Event(DENIED_EVENT));
}

/** No cross-session permission cache; each mount, focus and retry rechecks the server. */
export function useAdminAccess(): Access {
  return useAdminAccessState().access;
}

export function useAdminAccessState(): { access: Access; retry: () => void } {
  const { session, status } = useSession();
  const identity = status === 'signed-in' ? (session?.user.id ?? '') : '';
  const [result, setResult] = useState<{ identity: string; access: Access }>({
    identity: '',
    access: 'checking',
  });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback((): void => setAttempt((value) => value + 1), []);
  useEffect(() => {
    let live = true;
    let generation = 0;
    const deny = (): void => {
      generation += 1;
      setResult({ identity, access: 'no' });
    };
    const probe = (): void => {
      if (!identity) {
        deny();
        return;
      }
      const current = ++generation;
      void probeAdminAccess()
        .then((allowed) => {
          if (live && current === generation)
            setResult({ identity, access: allowed ? 'yes' : 'no' });
        })
        .catch(() => {
          if (live && current === generation) setResult({ identity, access: 'failed' });
        });
    };
    probe();
    window.addEventListener('focus', probe);
    window.addEventListener(DENIED_EVENT, deny);
    return () => {
      live = false;
      generation += 1;
      window.removeEventListener('focus', probe);
      window.removeEventListener(DENIED_EVENT, deny);
    };
  }, [identity, attempt]);
  return { access: result.identity === identity ? result.access : 'checking', retry };
}
