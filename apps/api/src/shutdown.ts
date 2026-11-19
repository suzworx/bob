/**
 * Best-effort worker drain and telemetry flush on graceful shutdown (SIGTERM, or
 * Ctrl-C locally) so buffered spans survive a deploy/restart. Guarded by a
 * bounded timeout: a stalled worker or telemetry endpoint must never prevent exit
 * (FR-004). Injectable flush/exit for tests; the second signal is ignored.
 */
import { flushTelemetry } from '@bob/ai';
import { moduleJournal } from './platform/logger.ts';
import { traceWorkflow } from './platform/observability/workflow-diagnostics.ts';

const journal = moduleJournal('server');

export function installShutdownHandler(
  flush: () => Promise<void> = flushTelemetry,
  exit: (code: number) => void = (code) => process.exit(code),
  signals: ReadonlyArray<NodeJS.Signals> = ['SIGTERM', 'SIGINT'],
  worker?: { stop: () => Promise<void> },
): () => void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const force = setTimeout(() => exit(0), 15_000);
    force.unref();
    journal('v2.shutting_down', { signal });
    // T012: stop the background work (cancel timers, drain in-flight runs)
    // before telemetry flush. Fifteen seconds includes the queue's ten-second
    // drain and a bounded outbox handoff; the process still cannot hang forever.
    void (async () => {
      await traceWorkflow('server-shutdown', { detached: true, metadata: { action: signal } }, async (outcome) => {
        try { if (worker) await worker.stop(); }
        catch { outcome('failed'); }
      });
      await flush();
      exit(0);
    })().catch(() => exit(0));
  };
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = (): void => shutdown(signal);
    process.on(signal, handler);
    handlers.set(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
}
