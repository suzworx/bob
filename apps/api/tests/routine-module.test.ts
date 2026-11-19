import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../src/app-deps.ts';
import { setJournalSink } from '../src/platform/logger.ts';
const mocks = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), send: vi.fn(), dispatch: vi.fn(), appDispatch: vi.fn(), appRun: vi.fn(), runner: vi.fn(), handle: vi.fn(), queue: vi.fn() }));
vi.mock('../src/bob-apps/refresh.ts', () => ({ dispatchBobAppRefreshes: mocks.appDispatch, tryHandleBobAppRun: mocks.appRun }));
vi.mock('../src/platform/jobs/routine-queue.ts', () => ({ createRoutineJobQueue: mocks.queue }));
vi.mock('../src/routines/dispatch.ts', () => ({ dispatchRoutines: mocks.dispatch }));
vi.mock('../src/workflows/workflow-routine-run.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), createRoutineRunner: mocks.runner }));
import { routineModule } from '../src/routine-module.ts';

describe('routine module lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); vi.stubEnv('BOB_DATABASE_URL', 'postgres://localhost/test'); mocks.dispatch.mockResolvedValue(0); mocks.appDispatch.mockResolvedValue(0); mocks.stop.mockResolvedValue(undefined); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  beforeEach(() => {
    mocks.queue.mockReturnValue({ start: mocks.start, stop: mocks.stop, send: mocks.send });
    mocks.runner.mockReturnValue(mocks.handle);
  });
  const deps = (): AppDeps => ({ getDb: vi.fn().mockResolvedValue({}), routineDigest: vi.fn() } as unknown as AppDeps);
  it('starts queue before dispatch and clears its timer on shutdown', async () => {
    const input = deps();
    const stop = await routineModule.start?.(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(input.routineJobs?.send).toBe(mocks.send);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    await stop?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(input.routineJobs).toBeUndefined();
  });
  it('does not overlap slow scans and drains the active scan before stopping queue', async () => {
    let finish: () => void = () => undefined;
    mocks.dispatch.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const stop = await routineModule.start?.(deps());
    await vi.advanceTimersByTimeAsync(90_000);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    const stopping = stop?.();
    expect(mocks.stop).not.toHaveBeenCalled();
    finish();
    await stopping;
    expect(mocks.stop).toHaveBeenCalledOnce();
  });
  it('runs app refresh without a digest provider', async () => {
    const input = deps();
    delete input.routineDigest;
    const stop = await routineModule.start?.(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.appDispatch).toHaveBeenCalledOnce();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    const handler = mocks.queue.mock.calls[0]?.[0]?.handle as (id: string, signal: AbortSignal) => Promise<void>;
    mocks.appRun.mockResolvedValueOnce(true);
    await handler('app-run', new AbortController().signal);
    expect(mocks.handle).not.toHaveBeenCalled();
    await stop?.();
  });
  it('routes app runs first and preserves the existing routine executor', async () => {
    const stop = await routineModule.start?.(deps());
    const handler = mocks.queue.mock.calls[0]?.[0]?.handle as (id: string, signal: AbortSignal) => Promise<void>;
    const signal = new AbortController().signal;
    mocks.appRun.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await handler('app-run', signal);
    await handler('gmail-run', signal);
    expect(mocks.handle).toHaveBeenCalledExactlyOnceWith('gmail-run', signal);
    await stop?.();
  });
  it('fails startup visibly after a queue connection failure so the host can restart', async () => {
    const lines: string[] = [];
    setJournalSink((line) => lines.push(line));
    mocks.start.mockRejectedValueOnce(Object.assign(new Error('private database connection details'), { code: '28P01' }));
    const input = deps();
    await expect(routineModule.start?.(input)).rejects.toThrow('routine_queue_start_failed');
    setJournalSink(null);
    const failure = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => entry.event === 'v2.routine_queue_error');
    expect(failure).toMatchObject({ code: 'queue_unavailable', reason: 'auth_failed' });
    expect(lines.join('\n')).not.toContain('private database connection details');
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(input.routineJobs).toBeUndefined();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    const stop = await routineModule.start?.(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    await stop?.();
  });
});
