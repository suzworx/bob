/**
 * Running timers and alarms for the timers API (apps/api/src/timers/http.ts,
 * issue #457). Each row's deadline is measured on THIS clock (received time +
 * remaining_ms), so a skewed device clock never shifts the countdown. A local
 * 1 s tick only moves the countdown text; the list itself comes from the
 * server: on mount, when `refreshKey` changes, and when a timer reaches zero
 * (retried every ZERO_RETRY_MS while the scheduler has not fired it yet, and
 * given up after ZERO_RETRY_LIMIT_MS so a stalled scheduler never polls forever).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '../../lib/auth/use-session';

export type TimerSummary = {
  id: string;
  kind: 'timer' | 'alarm';
  label: string | null;
  fire_at: number;
  remaining_ms: number;
  zone: string;
};

/** A timer with its deadline on the local clock. */
export type RunningTimer = TimerSummary & { endsAt: number };

type UseTimersResult = {
  timers: RunningTimer[];
  /** The local clock at the last tick; countdowns are `endsAt - now`. */
  now: number;
  cancel: (id: string) => Promise<boolean>;
  refresh: () => Promise<void>;
};

const TICK_MS = 1000;
const ZERO_RETRY_MS = 2000;
const ZERO_RETRY_LIMIT_MS = 30_000;

/** "4:59", "1:02:03": whole seconds left, rounded up so 0:00 means done. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

export function useTimers(refreshKey = 0): UseTimersResult {
  const [timers, setTimers] = useState<RunningTimer[]>([]);
  const [now, setNow] = useState<number>(() => Date.now());
  const requestRef = useRef(0);
  const lastZeroFetchRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current;
    try {
      const response = await fetchWithAuth('/api/timers');
      if (!response.ok) return;
      const body = (await response.json()) as { timers: TimerSummary[] };
      if (request !== requestRef.current) return;
      const received = Date.now();
      // A row seen before keeps its earlier deadline, so a timer the server
      // keeps answering at 0 ms ages past ZERO_RETRY_LIMIT_MS and stops the retries.
      setTimers((prev) =>
        body.timers.map((timer) => {
          const endsAt = received + timer.remaining_ms;
          const seen = prev.find((p) => p.id === timer.id);
          return { ...timer, endsAt: seen ? Math.min(seen.endsAt, endsAt) : endsAt };
        }),
      );
      setNow(received);
    } catch {
      // Keep what is on screen; the next focus or zero refetches.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const running = timers.length > 0;
  useEffect(() => {
    if (!running) return undefined;
    const handle = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(handle);
  }, [running]);

  useEffect(() => {
    const due = timers.some((timer) => timer.endsAt <= now && now - timer.endsAt < ZERO_RETRY_LIMIT_MS);
    if (!due || now - lastZeroFetchRef.current < ZERO_RETRY_MS) return;
    lastZeroFetchRef.current = now;
    void load();
  }, [timers, now, load]);

  const cancel = useCallback(async (id: string): Promise<boolean> => {
    try {
      const response = await fetchWithAuth(`/api/timers/${id}`, { method: 'DELETE' });
      // 404: it already fired or was cancelled elsewhere; either way it is gone.
      if (!response.ok && response.status !== 404) return false;
      requestRef.current += 1;
      setTimers((prev) => prev.filter((timer) => timer.id !== id));
      return true;
    } catch {
      return false;
    }
  }, []);

  return { timers, now, cancel, refresh: load };
}
