// #1041: the first provider 402 (spent AI Gateway budget) raises one
// text-free alarm per window and counts every 402; anything else is ignored.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@bob/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bob/ai')>()),
  recordObservationMetrics: vi.fn(),
}));

import { recordObservationMetrics } from '@bob/ai';
import { setJournalSink } from '../../src/platform/logger.ts';
import {
  BUDGET_ALARM_WINDOW_MS,
  isBudgetExhausted,
  noteBudgetExhausted,
  resetBudgetAlarm,
} from '../../src/platform/observability/budget-alarm.ts';

const ENVELOPE = new Set(['ts', 'level', 'event', 'message', 'source', 'module', 'user_id', 'conversation_id', 'conversation_source', 'session_id', 'trace_id', 'span_id']);
const lines: string[] = [];
const alarms = (): Array<Record<string, unknown>> =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.event === 'v2.ai_budget_exhausted');

beforeEach(() => {
  lines.length = 0;
  setJournalSink((line) => lines.push(line));
  resetBudgetAlarm();
});

afterEach(() => {
  setJournalSink(null);
  vi.clearAllMocks();
});

describe('budget alarm (#1041)', () => {
  it('a 402 is a spent budget; other statuses and none are not', () => {
    expect(isBudgetExhausted({ upstreamStatus: 402 })).toBe(true);
    for (const status of [400, 401, 403, 429, 500, undefined]) expect(isBudgetExhausted({ upstreamStatus: status })).toBe(false);
  });

  it('journals the first 402 once per window, with enum fields only', () => {
    const t0 = 1_000_000;
    expect(noteBudgetExhausted({ stage: 'stt', upstreamStatus: 402 }, 'device', t0)).toBe(true);
    expect(noteBudgetExhausted({ stage: 'agent', upstreamStatus: 402 }, 'web_text', t0 + 1_000)).toBe(true);
    expect(noteBudgetExhausted({ stage: 'agent', upstreamStatus: 402 }, 'device', t0 + BUDGET_ALARM_WINDOW_MS - 1)).toBe(true);
    expect(alarms()).toHaveLength(1);
    expect(alarms()[0]).toMatchObject({ surface: 'device', stage: 'stt' });
    // Nothing beyond the logger's envelope (journalEntry in apps/ai/src/journal.ts) and the two enums.
    const fields = Object.keys(alarms()[0] ?? {}).filter((key) => !ENVELOPE.has(key));
    expect(fields.sort()).toEqual(['stage', 'surface']);

    noteBudgetExhausted({ stage: 'tts', upstreamStatus: 402 }, 'web_voice', t0 + BUDGET_ALARM_WINDOW_MS);
    expect(alarms()).toHaveLength(2);
    expect(alarms()[1]).toMatchObject({ surface: 'web_voice', stage: 'tts' });
  });

  it('counts every 402 in ai.budget_exhausted, not just the alarmed one', () => {
    noteBudgetExhausted({ stage: 'stt', upstreamStatus: 402 }, 'device', 1);
    noteBudgetExhausted({ stage: 'stt', upstreamStatus: 402 }, 'device', 2);
    expect(recordObservationMetrics).toHaveBeenCalledTimes(2);
    expect(recordObservationMetrics).toHaveBeenCalledWith([{ name: 'ai.budget_exhausted', value: 1 }]);
  });

  it('ignores every other failure: no alarm, no count', () => {
    expect(noteBudgetExhausted({ stage: 'agent', upstreamStatus: 429 }, 'device')).toBe(false);
    expect(noteBudgetExhausted({ stage: 'agent' }, 'web_text')).toBe(false);
    expect(alarms()).toHaveLength(0);
    expect(recordObservationMetrics).not.toHaveBeenCalled();
  });
});
