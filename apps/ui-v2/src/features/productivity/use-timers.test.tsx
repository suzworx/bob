import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatCountdown, useTimers, type TimerSummary } from './use-timers';

vi.mock('../../lib/auth/use-session', () => ({
  fetchWithAuth: async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

function timer(overrides: Partial<TimerSummary> = {}): TimerSummary {
  return { id: 't1', kind: 'timer', label: 'pasta', fire_at: 0, remaining_ms: 5000, zone: 'UTC', ...overrides };
}

function json(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? undefined : { 'Content-Type': 'application/json' },
  });
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('formatCountdown', () => {
  it('rounds up to whole seconds and adds hours only when needed', () => {
    expect(formatCountdown(299_001)).toBe('5:00');
    expect(formatCountdown(59_000)).toBe('0:59');
    expect(formatCountdown(3_723_000)).toBe('1:02:03');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});

describe('useTimers', () => {
  it('loads the running timers and ticks the countdown once a second', async () => {
    fetchMock.mockResolvedValue(json(200, { timers: [timer()] }));
    const { result } = renderHook(() => useTimers());
    await flush();
    expect(fetchMock).toHaveBeenCalledWith('/api/timers', undefined);
    const [first] = result.current.timers;
    expect(first?.endsAt! - result.current.now).toBe(5000);
    await flush(1000);
    expect(first?.endsAt! - result.current.now).toBe(4000);
  });

  it('refetches when a timer reaches zero, and not before', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { timers: [timer({ remaining_ms: 3000 })] }))
      .mockResolvedValue(json(200, { timers: [] }));
    const { result } = renderHook(() => useTimers());
    await flush();
    await flush(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flush(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.timers).toEqual([]);
  });

  it('stops polling a timer the server never fires', async () => {
    fetchMock.mockImplementation(async () => json(200, { timers: [timer({ remaining_ms: 0 })] }));
    renderHook(() => useTimers());
    await flush();
    await flush(10_000);
    const early = fetchMock.mock.calls.length;
    // Retries at the bounded cadence, never once a tick...
    expect(early).toBeGreaterThan(1);
    expect(early).toBeLessThanOrEqual(1 + 10_000 / 2000);
    // ...and gives up once the timer is ZERO_RETRY_LIMIT_MS overdue.
    await flush(30_000);
    const settled = fetchMock.mock.calls.length;
    await flush(30_000);
    expect(fetchMock.mock.calls.length).toBe(settled);
  });

  it('refetches when the refresh key changes', async () => {
    fetchMock.mockResolvedValue(json(200, { timers: [] }));
    const { rerender } = renderHook(({ key }) => useTimers(key), { initialProps: { key: 0 } });
    await flush();
    rerender({ key: 1 });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancel deletes the timer and removes it from the list', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { timers: [timer(), timer({ id: 't2', kind: 'alarm', label: null })] }))
      .mockResolvedValueOnce(json(200, { cancelled: timer(), remaining: 1 }));
    const { result } = renderHook(() => useTimers());
    await flush();
    let ok = false;
    await act(async () => {
      ok = await result.current.cancel('t1');
    });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/timers/t1', { method: 'DELETE' });
    expect(result.current.timers.map((t) => t.id)).toEqual(['t2']);
  });

  it('a failed cancel keeps the timer', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { timers: [timer()] }))
      .mockResolvedValueOnce(json(500, null));
    const { result } = renderHook(() => useTimers());
    await flush();
    let ok = true;
    await act(async () => {
      ok = await result.current.cancel('t1');
    });
    expect(ok).toBe(false);
    expect(result.current.timers.map((t) => t.id)).toEqual(['t1']);
  });
});
