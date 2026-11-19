import type { ToolSet } from 'ai';
import { recordObservationMetrics } from './observation-metrics.ts';
import { traceSpan } from './telemetry.ts';

/** SDK completion hooks run after the SDK TOOL span has closed. This companion
 * records semantic outcomes; native tool latency comes from explicit scores. */
interface ToolResultEvent {
  toolCall: { toolName: string };
  toolOutput: { type: string; error?: unknown; output?: unknown };
  toolExecutionMs: number;
}
export function toolResultObserver(tools: ToolSet): (event: ToolResultEvent) => Promise<void> {
  const names = new Set(Object.keys(tools).filter((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name)));
  return async ({ toolCall, toolOutput, toolExecutionMs }): Promise<void> => {
    try {
      const name = names.has(toolCall.toolName) ? toolCall.toolName : 'other';
      const cancelled = toolOutput.type === 'tool-error' && toolOutput.error instanceof Error && toolOutput.error.name === 'AbortError';
      const output = toolOutput.type === 'tool-result' ? toolOutput.output : undefined;
      const handled = typeof output === 'object' && output !== null && 'ok' in output && output.ok === false;
      await traceSpan(`tool-result.${name}`, {}, () => {
        recordObservationMetrics([
          { name: 'tool.duration_ms', value: Math.round(toolExecutionMs) },
          { name: 'tool.failed', value: Number(!cancelled && (handled || toolOutput.type === 'tool-error')) },
          { name: 'tool.handled_failure', value: Number(handled) },
          { name: 'tool.cancelled', value: Number(cancelled) },
        ]);
      });
    } catch { /* Diagnostic callbacks must not fail or alter tool execution. */ }
  };
}
