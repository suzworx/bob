/**
 * Graceful-shutdown telemetry flush (specs/009, FR-004): SIGTERM/SIGINT flush
 * buffered Braintrust spans before exit, the flush is never awaited past a
 * hard timeout, a second signal is ignored, and the event lands in the
 * journal. flush/exit are injected so no signal handler or exit path touches
 * the real process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installShutdownHandler } from '../../src/shutdown.ts';
import { setJournalSink } from '../../src/platform/logger.ts';

describe('installShutdownHandler', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setJournalSink(null);
  });

  it('flushes telemetry and exits on SIGTERM, journaling v2.shutting_down', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const sink = vi.fn();
    setJournalSink(sink);
    const unsubscribe = installShutdownHandler(flush, exit, ['SIGTERM']);

    process.emit('SIGTERM' as NodeJS.Signals);
    await new Promise((resolve) => setImmediate(resolve));

    expect(flush).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    const entry = JSON.parse(sink.mock.calls[0]![0] as string) as { event: string; signal: string };
    expect(entry.event).toBe('v2.shutting_down');
    expect(entry.signal).toBe('SIGTERM');
    unsubscribe();
  });

  it('ignores a second signal while shutting down', async () => {
    let resolveFlush!: () => void;
    const flush = vi.fn().mockReturnValue(new Promise<void>((resolve) => { resolveFlush = resolve; }));
    const exit = vi.fn();
    const unsubscribe = installShutdownHandler(flush, exit, ['SIGTERM']);

    process.emit('SIGTERM' as NodeJS.Signals);
    process.emit('SIGTERM' as NodeJS.Signals);
    resolveFlush();
    await new Promise((resolve) => setImmediate(resolve));

    expect(flush).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('forces exit after the timeout even when the flush never settles', async () => {
    vi.useFakeTimers();
    const flush = vi.fn().mockReturnValue(new Promise<void>(() => undefined));
    const exit = vi.fn();
    const unsubscribe = installShutdownHandler(flush, exit, ['SIGTERM']);

    process.emit('SIGTERM' as NodeJS.Signals);
    vi.advanceTimersByTime(14_999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(0);
    unsubscribe();
    vi.useRealTimers();
  });

  it('unsubscribes cleanly so a later signal is untouched', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const unsubscribe = installShutdownHandler(flush, exit, ['SIGTERM']);
    unsubscribe();

    process.emit('SIGTERM' as NodeJS.Signals);
    await new Promise((resolve) => setImmediate(resolve));

    expect(flush).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('lets a ten-second queue drain finish before flushing and exiting', async () => {
    vi.useFakeTimers();
    const flush = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const stop = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 10_000)));
    const unsubscribe = installShutdownHandler(flush, exit, ['SIGTERM'], { stop });
    process.emit('SIGTERM' as NodeJS.Signals);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(exit).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stop).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    unsubscribe();
  });
});
