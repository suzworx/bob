import type { UiAction } from './ui-actions';
import type { UiEditEvent, UiEvent } from './ui-events';

/** One bounded summary per source text input or repeating callback and view. This counts callbacks,
 * never characters, keys, content, selections, DOM values or text length. */
export function createUiEditSummaries(record: (event: UiEditEvent) => void): {
  observe: (event: UiAction, view: Pick<UiEvent, 'page' | 'view_id' | 'route'>) => boolean;
  flush: () => void;
} {
  const pending = new Map<string, UiEditEvent>();
  function flush(): void {
    const summaries = [...pending.values()];
    pending.clear();
    for (const summary of summaries) record(summary);
  }
  return {
    flush,
    observe: (event, view) => {
      if (!event.editing && !event.activity) return false;
      if (event.stage !== 'complete') return true;
      const key = `${view.view_id}/${event.action}`;
      if (pending.size >= 32) flush();
      const previous = pending.get(key);
      if (previous && previous.invocations === 1_000_000) { pending.delete(key); record(previous); }
      const summary: UiEditEvent = pending.get(key) ?? {
        ...view, event: event.editing ? 'ui_edit' : 'ui_activity', action: event.action, action_id: event.action_id, trigger: event.trigger,
        duration_ms: 0, invocations: 0, failed_invocations: 0, aborted_invocations: 0,
      };
      summary.invocations++;
      summary.failed_invocations += Number(event.outcome === 'error');
      summary.aborted_invocations += Number(event.outcome === 'aborted');
      summary.duration_ms += Math.max(0, event.duration_ms);
      pending.set(key, summary);
      return true;
    },
  };
}
