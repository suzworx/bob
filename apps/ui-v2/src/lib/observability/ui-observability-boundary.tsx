import { Profiler, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useSession } from '@/lib/auth/use-session';
import { installUiObservability } from './ui-observability';

/** No rendered markup. Auth-only anonymous and authenticated queues never share ownership. */
export function UiObservabilityBoundary({ children }: { children: ReactNode }): ReactNode {
  const { status, session } = useSession();
  const bearer = useRef<string | null>(null);
  const observer = useRef<ReturnType<typeof installUiObservability> | null>(null);
  const userId = status === 'signed-in' ? session?.user.id : undefined;
  useLayoutEffect(() => { bearer.current = session?.access_token ?? null; }, [session?.access_token]);
  useLayoutEffect(() => {
    try {
      const installed = installUiObservability(() => bearer.current, { anonymous: !userId });
      observer.current = installed;
      return () => { if (!userId) installed.flush(); installed.dispose(); observer.current = null; };
    } catch {
      // Instrumentation must not prevent the authenticated app from mounting.
      observer.current = null;
      return;
    }
  }, [userId]);
  return <Profiler id="app" onRender={(_id, phase, actualDuration) => observer.current?.render(phase, actualDuration)}>{children}</Profiler>;
}
