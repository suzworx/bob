/**
 * Agent tools for timers and alarms: `set_timer`, `set_alarm`,
 * `list_timers` and `cancel_timer`, built with the AI SDK `tool()` style over
 * injected callbacks, as productivity-tools.ts does. apps/ai owns no SQL and no
 * clock zone: apps/api binds the callbacks to ONE account and its time zone
 * (core/timer-tools.ts bindTimerTools), so no input names whose timers to touch.
 *
 * Outputs are short spoken-style sentences ("Timer set for 10 minutes.") the
 * voice reply can read as-is. Every tool catches its callback's rejection and
 * returns { ok: false, reason } rather than throwing.
 */
import { z } from 'zod';
import { tool } from 'ai';
import type { Tool } from 'ai';

/** A pending timer or alarm as the callbacks report it. localTime is the fire
 *  time on the account's wall clock, spoken form ("7:00 AM"). */
export const timerViewSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['timer', 'alarm']),
    label: z.string().nullable(),
    firesAtIso: z.string(),
    remainingMs: z.number().int().nonnegative(),
    localTime: z.string(),
  })
  .strict();
export type TimerView = z.infer<typeof timerViewSchema>;

/** set_timer input: a duration as ISO-8601 ("PT10M") or seconds, and an optional label. */
const setTimerInputSchema = z
  .object({
    duration: z.union([z.number().positive(), z.string().min(1)]),
    label: z.string().max(60).optional(),
  })
  .strict();
type SetTimerInput = z.infer<typeof setTimerInputSchema>;

/** set_alarm input: a wall time ("07:00", "7:30 pm") or an ISO date-time, and an optional label. */
const setAlarmInputSchema = z
  .object({
    time: z.string().min(1),
    label: z.string().max(60).optional(),
  })
  .strict();
type SetAlarmInput = z.infer<typeof setAlarmInputSchema>;

const listTimersInputSchema = z.object({}).strict();

/** cancel_timer input: a label, an id, or all; none cancels the only running one. */
const cancelTimerInputSchema = z
  .object({
    label: z.string().max(60).optional(),
    id: z.string().min(1).optional(),
    all: z.boolean().optional(),
  })
  .strict();
export type CancelTimerInput = z.infer<typeof cancelTimerInputSchema>;

const timerToolOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), message: z.string(), id: z.string().optional() }).strict(),
  z.object({ ok: z.literal(false), reason: z.string() }).strict(),
]);
export type TimerToolOutput = z.infer<typeof timerToolOutputSchema>;

/** The injected, account-bound operations. */
export interface TimerCallbacks {
  setTimer(input: { durationMs: number; label?: string }): Promise<TimerView>;
  setAlarm(input: { time: string; label?: string }): Promise<TimerView>;
  listTimers(): Promise<TimerView[]>;
  cancelTimers(input: CancelTimerInput): Promise<{ cancelled: TimerView[]; remaining: number }>;
}

const ISO_DURATION_RE = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

/** Milliseconds for seconds (number or numeric string) or an ISO-8601 duration; null if unreadable. */
export function parseTimerDuration(duration: number | string): number | null {
  if (typeof duration === 'number') return Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : null;
  const text = duration.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return parseTimerDuration(Number(text));
  const match = ISO_DURATION_RE.exec(text);
  if (!match || text.toUpperCase() === 'P' || text.toUpperCase().endsWith('T')) return null;
  const [d, h, m, s] = match.slice(1).map((part) => (part === undefined ? 0 : Number(part))) as [number, number, number, number];
  const ms = Math.round((((d * 24 + h) * 60 + m) * 60 + s) * 1000);
  return ms > 0 ? ms : null;
}

function unit(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Spoken duration: "10 minutes", "4 minutes 12 seconds", "1 hour 5 minutes". */
export function speakDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(unit(hours, 'hour'));
  if (minutes > 0) parts.push(unit(minutes, 'minute'));
  if (seconds > 0 && hours === 0) parts.push(unit(seconds, 'second'));
  return parts.length > 0 ? parts.join(' ') : '0 seconds';
}

/** "Pasta timer", "Timer", "Wake up alarm". */
export function speakTimerName(view: Pick<TimerView, 'kind' | 'label'>): string {
  if (view.label === null) return view.kind === 'alarm' ? 'Alarm' : 'Timer';
  const name = `${view.label} ${view.kind}`;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** One pending timer or alarm as a sentence. */
export function speakTimer(view: TimerView): string {
  return view.kind === 'alarm'
    ? `${speakTimerName(view)} at ${view.localTime}.`
    : `${speakTimerName(view)}: ${speakDuration(view.remainingMs)} left.`;
}

function failureOf(error: unknown): TimerToolOutput {
  return { ok: false, reason: error instanceof Error ? error.message : String(error) };
}

export function createTimerTools(cb: TimerCallbacks): Record<string, Tool> {
  return {
    set_timer: tool({
      description: 'Start a countdown timer ("10 minute pasta timer"). duration is ISO-8601 (PT10M) or seconds; label is a short name. Call it once per timer. For a clock time ("wake me at 7") use set_alarm instead.',
      inputSchema: setTimerInputSchema,
      outputSchema: timerToolOutputSchema,
      execute: async (input): Promise<TimerToolOutput> => {
        const durationMs = parseTimerDuration(input.duration);
        if (durationMs === null) return { ok: false, reason: 'unreadable duration' };
        try {
          const view = await cb.setTimer({ durationMs, ...(input.label === undefined ? {} : { label: input.label }) });
          const named = view.label === null ? 'Timer' : speakTimerName(view);
          return { ok: true, id: view.id, message: `${named} set for ${speakDuration(view.remainingMs)}.` };
        } catch (error) {
          return failureOf(error);
        }
      },
    }),
    set_alarm: tool({
      description: 'Set an alarm for a clock time ("wake me at 7"). time is a wall time ("07:00", "7:30 pm"; the next such time) or an ISO date-time. For a duration ("in 10 minutes") use set_timer instead.',
      inputSchema: setAlarmInputSchema,
      outputSchema: timerToolOutputSchema,
      execute: async (input): Promise<TimerToolOutput> => {
        try {
          const view = await cb.setAlarm({ time: input.time, ...(input.label === undefined ? {} : { label: input.label }) });
          return { ok: true, id: view.id, message: `${speakTimerName(view)} set for ${view.localTime}.` };
        } catch (error) {
          return failureOf(error);
        }
      },
    }),
    list_timers: tool({
      description: 'List running timers and alarms with the time left ("how long is left?").',
      inputSchema: listTimersInputSchema,
      outputSchema: timerToolOutputSchema,
      execute: async (): Promise<TimerToolOutput> => {
        try {
          const views = await cb.listTimers();
          if (views.length === 0) return { ok: true, message: 'No timers or alarms are set.' };
          return { ok: true, message: views.map(speakTimer).join(' ') };
        } catch (error) {
          return failureOf(error);
        }
      },
    }),
    cancel_timer: tool({
      description: 'Cancel timers or alarms by label ("the pasta timer" -> "pasta"), by id from list_timers, or all: true. No argument cancels the only running one. Never guess an id.',
      inputSchema: cancelTimerInputSchema,
      outputSchema: timerToolOutputSchema,
      execute: async (input): Promise<TimerToolOutput> => {
        try {
          const { cancelled, remaining } = await cb.cancelTimers(input);
          const [only] = cancelled;
          if (only === undefined) {
            if (input.all !== true && input.id === undefined && input.label === undefined && remaining > 1) {
              return { ok: true, message: `Which one? You have ${remaining} running.` };
            }
            return { ok: true, message: remaining === 0 ? 'No timers are running.' : "I couldn't find that timer." };
          }
          if (cancelled.length === 1) return { ok: true, message: `${speakTimerName(only)} cancelled.` };
          return { ok: true, message: `Cancelled ${cancelled.length} timers and alarms.` };
        } catch (error) {
          return failureOf(error);
        }
      },
    }),
  };
}
