import { afterEach, expect, it, vi } from 'vitest';
import { recordObservationMetrics, traceSpan } from '@bob/ai';
import { startTimerScheduler } from '../../src/timers/scheduler.ts';
import { duePending, markTimerFired, type Timer } from '../../src/timers/store.ts';
import { createReminderFanout } from '../../src/workflows/workflow-reminder-fire.ts';
import { dueOccurrences } from '../../src/reminders/store.ts';
import type { Db } from '../../src/platform/db/db.ts';

vi.mock('@bob/ai', async (original) => ({
  ...(await original<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, fn: () => unknown) => fn()), recordObservationMetrics: vi.fn(),
}));
vi.mock('../../src/timers/store.ts', async (original) => ({
  ...(await original<typeof import('../../src/timers/store.ts')>()),
  duePending: vi.fn(async () => []), markTimerFired: vi.fn(), nextPendingFireAt: vi.fn(async () => null),
}));
vi.mock('../../src/reminders/store.ts', async (original) => ({
  ...(await original<typeof import('../../src/reminders/store.ts')>()), dueOccurrences: vi.fn(async () => []),
}));
afterEach(() => vi.clearAllMocks());

it.each(['timer', 'alarm'] as const)('detaches %s scheduling and observes swallowed delivery failure', async (kind) => {
  const timer = { id: 'private-id', userId: 'private-user', label: 'private-label', kind } as Timer;
  vi.mocked(duePending).mockResolvedValueOnce([timer]);
  vi.mocked(markTimerFired).mockResolvedValueOnce(timer);
  const refresh = vi.fn();
  const scheduler = startTimerScheduler({ db: {} as Db, setTimer: () => () => undefined,
    onFire: () => { throw new Error('private-error'); }, afterFire: refresh });
  await scheduler.reschedule();
  scheduler.stop();
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(traceSpan).toHaveBeenCalledWith('timer-sweep', expect.objectContaining({ detached: true }), expect.any(Function));
  expect(traceSpan).toHaveBeenCalledWith('timer-fire', expect.objectContaining({ metadata: expect.objectContaining({ action: kind }) }), expect.any(Function));
  expect(traceSpan).toHaveBeenCalledWith('timer-refresh', expect.any(Object), expect.any(Function));
  expect(recordObservationMetrics).toHaveBeenCalledWith(expect.arrayContaining([{ name: 'workflow.failed', value: 1 }]));
  // The owner is the correlation key (`userId`); no id may appear anywhere else.
  expect(JSON.stringify(vi.mocked(traceSpan).mock.calls, (key, value: unknown) => (key === 'userId' ? undefined : value))).not.toContain('private-');
});

it('traces reminder store outages and empty ticks as distinct failed/skipped outcomes', async () => {
  vi.mocked(dueOccurrences).mockRejectedValueOnce(new Error('private-db'));
  const fanout = createReminderFanout({ db: {} as Db, announce: vi.fn() });
  expect(await fanout.tick()).toBe(0);
  expect(await fanout.tick()).toBe(0);
  expect(traceSpan).toHaveBeenCalledTimes(2);
  expect(vi.mocked(traceSpan).mock.calls.every((call) => call[1].detached)).toBe(true);
  expect(recordObservationMetrics).toHaveBeenCalledWith(expect.arrayContaining([{ name: 'workflow.failed', value: 1 }]));
  expect(JSON.stringify(vi.mocked(traceSpan).mock.calls)).not.toContain('private-db');
});
