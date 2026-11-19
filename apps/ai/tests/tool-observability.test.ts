import { describe, expect, it, vi } from 'vitest';
import { tool, type ToolExecutionEndEvent } from 'ai';
import { z } from 'zod';
import { toolResultObserver } from '../src/tool-observability.ts';
import { recordObservationMetrics } from '../src/observation-metrics.ts';
import { traceSpan } from '../src/telemetry.ts';
vi.mock('../src/telemetry.ts', () => ({ traceSpan: vi.fn(async (_name, _attrs, fn) => fn()) }));
vi.mock('../src/observation-metrics.ts', () => ({ recordObservationMetrics: vi.fn() }));
describe('tool result diagnostics', () => {
  it('records handled failure without result content or arguments', async () => {
    const observe = toolResultObserver({ list_tasks: tool({ inputSchema: z.object({}) }) });
    await observe({ toolCall: { toolName: 'list_tasks', input: { secret: 'private' } }, toolOutput: { type: 'tool-result', output: { ok: false, reason: 'private' } }, toolExecutionMs: 12.4 } as unknown as ToolExecutionEndEvent);
    expect(traceSpan).toHaveBeenCalledWith('tool-result.list_tasks', {}, expect.any(Function));
    expect(recordObservationMetrics).toHaveBeenCalledWith([
      { name: 'tool.duration_ms', value: 12 }, { name: 'tool.failed', value: 1 },
      { name: 'tool.handled_failure', value: 1 }, { name: 'tool.cancelled', value: 0 },
    ]);
    expect(JSON.stringify(vi.mocked(traceSpan).mock.calls)).not.toContain('private');
  });
  it('classifies aborts separately and bounds unknown tool names', async () => {
    const observe = toolResultObserver({});
    await observe({ toolCall: { toolName: 'private/url' }, toolOutput: { type: 'tool-error', error: new DOMException('private', 'AbortError') }, toolExecutionMs: 5 } as unknown as ToolExecutionEndEvent);
    expect(traceSpan).toHaveBeenLastCalledWith('tool-result.other', {}, expect.any(Function));
    expect(recordObservationMetrics).toHaveBeenLastCalledWith(expect.arrayContaining([{ name: 'tool.failed', value: 0 }, { name: 'tool.cancelled', value: 1 }]));
  });
  it('does not throw if telemetry infrastructure fails', async () => {
    vi.mocked(traceSpan).mockRejectedValueOnce(new Error('private'));
    const observe = toolResultObserver({});
    await expect(observe({ toolCall: { toolName: 'x' }, toolOutput: { type: 'tool-result', output: {} }, toolExecutionMs: 1 } as unknown as ToolExecutionEndEvent)).resolves.toBeUndefined();
  });
});
