import { useCallback, useEffect, useState } from 'react';
import { probeOperatorAccess } from './metrics-api';

export type OperatorAccess = 'checking' | 'yes' | 'no' | 'failed';

// One answer per session, shared by every caller (the menu and the page). A
// failed probe is not an answer: it is forgotten, so the next caller (or Retry)
// asks again instead of hiding the page until a reload.
let known: 'yes' | 'no' | null = null;
let pending: Promise<OperatorAccess> | null = null;

function probeOnce(): Promise<OperatorAccess> {
  pending ??= probeOperatorAccess().then(
    (allowed): OperatorAccess => {
      known = allowed ? 'yes' : 'no';
      return known;
    },
    (): OperatorAccess => {
      pending = null;
      return 'failed';
    },
  );
  return pending;
}

export function resetOperatorAccess(): void {
  known = null;
  pending = null;
}

export function useOperatorAccessState(): { access: OperatorAccess; retry: () => void } {
  const [access, setAccess] = useState<OperatorAccess>(known ?? 'checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void probeOnce().then((answer) => {
      if (live) setAccess(answer);
    });
    return () => {
      live = false;
    };
  }, [attempt]);

  const retry = useCallback((): void => {
    setAccess('checking');
    setAttempt((n) => n + 1);
  }, []);

  return { access, retry };
}

export function useOperatorAccess(): OperatorAccess {
  return useOperatorAccessState().access;
}
