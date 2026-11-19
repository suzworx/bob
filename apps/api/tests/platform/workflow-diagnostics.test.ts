import { afterEach, expect, it, vi } from 'vitest';
import { recordObservationMetrics, traceSpan, withDetachedTelemetryContext } from '@bob/ai';
import { traceSynchronousWorkflow, traceWorkflow } from '../../src/platform/observability/workflow-diagnostics.ts';

vi.mock('@bob/ai', async (original) => ({
  ...(await original<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, fn: () => unknown) => fn()),
  recordObservationMetrics: vi.fn(),
  withDetachedTelemetryContext: vi.fn((work: () => unknown) => work()),
}));
afterEach(() => vi.clearAllMocks());

it('measures the work and explicitly detaches background executions', async () => {
  let now = 0;
  const result = await traceWorkflow('timer-sweep', { detached: true }, () => { now = 37; return 3; }, () => now);
  expect(result).toBe(3);
  expect(traceSpan).toHaveBeenCalledWith('timer-sweep', expect.objectContaining({ detached: true }), expect.any(Function));
  expect(recordObservationMetrics).toHaveBeenCalledWith([
    { name: 'workflow.duration_ms', value: 37 }, { name: 'workflow.failed', value: 0 }, { name: 'workflow.rejected', value: 0 },
  ]);
});

it('clears context before synchronous background work while preserving immediate result', () => {
  const work = vi.fn(() => 7);
  expect(traceSynchronousWorkflow('device-presence', { detached: true }, work)).toBe(7);
  expect(withDetachedTelemetryContext).toHaveBeenCalledTimes(1);
  expect(work).toHaveBeenCalledTimes(1);
  expect(vi.mocked(withDetachedTelemetryContext).mock.invocationCallOrder[0]).toBeLessThan(work.mock.invocationCallOrder[0] ?? 0);
});

it('records swallowed failure outcomes and preserves thrown errors', async () => {
  await traceWorkflow('timer-fire', {}, (outcome) => outcome('failed'));
  expect(recordObservationMetrics).toHaveBeenLastCalledWith(expect.arrayContaining([{ name: 'workflow.failed', value: 1 }]));
  const error = new Error('private error');
  await expect(traceWorkflow('timer-fire', {}, () => { throw error; })).rejects.toBe(error);
  expect(JSON.stringify(vi.mocked(traceSpan).mock.calls)).not.toContain('private error');
});
