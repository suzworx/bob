import { AsyncLocalStorage } from 'node:async_hooks';
import { recordObservationMetrics, traceSpan, updateActiveSpanMetadata, type SpanAttrs } from '@bob/ai';
import type { ClientControlDto, V2ErrorCode } from './protocol.ts';

/** A new wire control must choose operation coverage or the heartbeat summary. */
export const CONTROL_COVERAGE = {
  hello: 'operation', pair_request: 'operation', turn_start: 'operation', turn_end: 'operation',
  cancel: 'operation', device_state: 'operation', device_log: 'operation', turn_timing: 'operation', announce_ack: 'operation',
  list_conversations: 'operation', select_conversation: 'operation', new_conversation: 'operation',
  list_spaces: 'operation', select_space: 'operation', check_update: 'operation', ota_progress: 'operation',
  pong: 'summary',
} as const satisfies Record<ClientControlDto['type'], 'operation' | 'summary'>;

const controlResult = new AsyncLocalStorage<{ rejected?: V2ErrorCode }>();

/** Called at the wire-error boundary; raw errors and DTOs never enter telemetry. */
export function rejectControl(code: V2ErrorCode): void {
  const result = controlResult.getStore();
  if (result !== undefined) result.rejected = code;
}

/** Separate dispatch exceptions from handled protocol/state rejections. */
export async function diagnoseControl(
  type: ClientControlDto['type'],
  work: () => void | Promise<void>,
  clock: () => number = () => performance.now(),
  attrs: SpanAttrs = {},
): Promise<void> {
  if (CONTROL_COVERAGE[type] === 'summary') return work();
  const result: { rejected?: V2ErrorCode } = {};
  await traceSpan(`ws.control.${type}`, { ...attrs, metadata: { ...attrs.metadata, ws_control: type } }, () => controlResult.run(result, async () => {
    const started = clock();
    let failed = true;
    try {
      await work();
      failed = false;
    } finally {
      updateActiveSpanMetadata({ outcome: failed ? 'failed' : result.rejected ? 'rejected' : 'ok',
        ...(result.rejected ? { error_code: result.rejected } : {}) });
      recordObservationMetrics([
        { name: 'ws.control.duration_ms', value: Math.max(0, Math.round(clock() - started)) },
        { name: 'ws.control.failed', value: Number(failed) },
        { name: 'ws.control.rejected', value: Number(result.rejected !== undefined) },
      ]);
    }
  }));
}
