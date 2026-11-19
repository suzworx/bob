import { recordObservationMetrics, traceSpan, updateActiveSpanMetadata, withDetachedTelemetryContext, type SpanAttrs } from '@bob/ai';

/** Operation names are an API: fixed names keep dashboards stable and exclude payloads. */
const WORKFLOW_OPERATIONS = [
  'outbox-drain', 'outbox-claim', 'outbox-release', 'outbox-heartbeat', 'outbox-tick',
  'timer-sweep', 'timer-fire', 'timer-refresh', 'reminder-fanout',
  'memory-scan', 'memory-account', 'memory-extract', 'memory-extract-write',
  'notification-deliver', 'email-send', 'device-announcement',
  'account-event', 'device-control', 'device-announcement-queue', 'device-announcement-deliver',
  'device-active-conversation', 'device-active-space', 'device-revoke',
  'module-mount', 'module-start', 'module-stop', 'server-shutdown',
  'device-presence', 'device-timers-state', 'device-unpaired-expiry',
] as const;

type WorkflowOperation = (typeof WORKFLOW_OPERATIONS)[number];
export type WorkflowOutcome = 'ok' | 'failed' | 'rejected' | 'skipped' | 'cancelled';
export type SetWorkflowOutcome = (outcome: WorkflowOutcome) => void;

export function recordWorkflowMetrics(outcome: WorkflowOutcome, duration: number): void {
  recordObservationMetrics([
    { name: 'workflow.duration_ms', value: Math.max(0, Math.round(duration)) },
    { name: 'workflow.failed', value: Number(outcome === 'failed') },
    { name: 'workflow.rejected', value: Number(outcome === 'rejected') },
  ]);
}

export function completeWorkflow(name: WorkflowOperation, attrs: SpanAttrs, duration: number, outcome: WorkflowOutcome): Promise<void> {
  return traceSpan(name, { ...attrs, metadata: { ...attrs.metadata, workflow: name, outcome } },
    () => recordWorkflowMetrics(outcome, duration));
}

/** Preserve synchronous event/push semantics; observe completion with the real start time. */
export function traceSynchronousWorkflow<T>(name: WorkflowOperation, attrs: SpanAttrs,
  work: (setOutcome: SetWorkflowOutcome) => T): T {
  if (attrs.detached) return withDetachedTelemetryContext(() => traceSynchronousWorkflow(name, { ...attrs, detached: false }, work));
  const startTime = new Date();
  const started = performance.now();
  let outcome: WorkflowOutcome = 'ok';
  try { return work((value) => { outcome = value; }); }
  catch (error) { outcome = 'failed'; throw error; }
  finally {
    const duration = Math.max(0, Math.round(performance.now() - started));
    void completeWorkflow(name, { ...attrs, startTime }, duration, outcome);
  }
}

/** Wrap the actual operation, including caught failures reported through setOutcome. */
export function traceWorkflow<T>(
  name: WorkflowOperation,
  attrs: SpanAttrs,
  work: (setOutcome: SetWorkflowOutcome) => T | Promise<T>,
  clock: () => number = () => performance.now(),
): Promise<T> {
  return traceSpan(name, { ...attrs, metadata: { ...attrs.metadata, workflow: name } }, async () => {
    const started = clock();
    let outcome: WorkflowOutcome = 'ok';
    try {
      return await work((value) => { outcome = value; });
    } catch (error) {
      outcome = 'failed';
      throw error;
    } finally {
      updateActiveSpanMetadata({ outcome });
      recordWorkflowMetrics(outcome, clock() - started);
    }
  });
}
