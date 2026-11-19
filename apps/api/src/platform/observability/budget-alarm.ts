/**
 * #1041: once the AI Gateway key's budget is spent, every AI, STT and TTS call
 * answers HTTP 402 until the owner raises it, and on 2026-10-14 nothing said
 * so. Each provider failure a turn sees passes through here: a 402 is counted
 * (`ai.budget_exhausted`) and alarmed as `v2.ai_budget_exhausted`, at most once
 * per window so an outage is one alert, not one per turn. Enum fields only:
 * never a message, key, prompt or id.
 */
import { recordObservationMetrics } from '@bob/ai';
import { moduleJournal } from '../logger.ts';

const journal = moduleJournal('platform');

/** The status the AI Gateway answers once the key's budget is spent. */
const BUDGET_EXHAUSTED_STATUS = 402;

/** One journal alarm per window; the counter still counts every 402. */
export const BUDGET_ALARM_WINDOW_MS = 10 * 60_000;

type Surface = 'device' | 'web_text' | 'web_voice';

/** The web's answer to a spent budget: web chat and web voice send this as
 *  their 503 error body (and chat as its SSE error text, the code), and the
 *  web app shows its plain out-of-credit notice for it. */
export const OUT_OF_CREDIT_ERROR = { code: 'out_of_credit', message: 'The AI service is out of credit.' } as const;

let lastAlarmAt: number | undefined;

/** True when a classified provider failure is a spent budget (402). Pure: no count, no alarm. */
export function isBudgetExhausted(failure: { upstreamStatus?: number }): boolean {
  return failure.upstreamStatus === BUDGET_EXHAUSTED_STATUS;
}

/** isBudgetExhausted, plus the count (every time) and the alarm (once per window). */
export function noteBudgetExhausted(
  failure: { stage: string; upstreamStatus?: number },
  surface: Surface,
  now: number = Date.now(),
): boolean {
  if (!isBudgetExhausted(failure)) return false;
  recordObservationMetrics([{ name: 'ai.budget_exhausted', value: 1 }]);
  if (lastAlarmAt === undefined || now - lastAlarmAt >= BUDGET_ALARM_WINDOW_MS) {
    lastAlarmAt = now;
    journal('v2.ai_budget_exhausted', { surface, stage: failure.stage });
  }
  return true;
}

/** Forgets the last alarm, so the next 402 alarms again (tests). */
export function resetBudgetAlarm(): void {
  lastAlarmAt = undefined;
}
