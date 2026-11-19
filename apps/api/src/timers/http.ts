/**
 * REST routes for timers and alarms: the Calendar page shows the
 * caller's running timers and alarms with a live countdown and lets them cancel
 * one. Account-wide like the timer tools: every handler acts as
 * req.account.userId and the store runs under withUser, so another account's
 * timer answers exactly like a missing one (no oracle). Cancel goes through the
 * store's cancelTimers path and re-arms the scheduler. Journal events carry ids
 * and counts only, never labels.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { moduleJournal } from '../platform/logger.ts';
import { route, sendError } from '../platform/http/route.ts';
import { StoreError, type Db } from '../platform/db/db.ts';
import { cancelTimers, listPendingTimers, timerNotificationState, type Timer } from './store.ts';
import { TimerNotificationStateQuerySchema, TimerNotificationStateResponseSchema } from './schemas.ts';
import { accountTimeZone } from '../account/auth.ts';

const journal = moduleJournal('timers');

interface TimersRouterDeps {
  getDb: () => Promise<Db>;
  /** Re-arms the timer scheduler after a cancel and pushes the caller's
   *  devices (server.ts: timersChanged); called with the caller's userId. */
  onChange?: (userId: string) => void | Promise<void>;
  now?: () => number;
}

const UuidPath = z.string().uuid();

const TimerSummarySchema = z.object({
  id: z.string(),
  kind: z.enum(['timer', 'alarm']),
  label: z.string().nullable(),
  fire_at: z.number(),
  remaining_ms: z.number().int().min(0),
  zone: z.string(),
});

export const TimersResponseSchema = z.object({ timers: z.array(TimerSummarySchema) });

export const TimerCancelResponseSchema = z.object({
  cancelled: TimerSummarySchema,
  remaining: z.number().int().min(0),
});

type TimerSummary = z.infer<typeof TimerSummarySchema>;

/** Timer -> the wire TimerSummarySchema; `zone` is the account zone the ring
 *  time of an alarm is shown in. */
function toTimerSummary(timer: Timer, now: number, zone: string): TimerSummary {
  return {
    id: timer.id,
    kind: timer.kind,
    label: timer.label,
    fire_at: timer.firesAt,
    remaining_ms: Math.max(0, timer.firesAt - now),
    zone,
  };
}

function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreError) {
    sendError(response, 409, 'conflict', error.message);
    return;
  }
  throw error;
}

const IdParams = z.object({ id: UuidPath });

export function createTimersRouter({ getDb, onChange, now = Date.now }: TimersRouterDeps): Router {
  const router = Router();

  router.get('/timers', route({}, async ({ userId }, request, response) => {
    const started = Date.now();
    const db = await getDb();
    const at = now();
    const zone = accountTimeZone(request);
    const pending = await listPendingTimers(db, userId, at);
    journal('v2.timers_listed', { count: pending.length, duration_ms: Date.now() - started });
    response
      .status(200)
      .json(TimersResponseSchema.parse({ timers: pending.map((timer) => toTimerSummary(timer, at, zone)) }));
  }));

  router.get('/timers/notification-state', route({ query: TimerNotificationStateQuerySchema }, async ({ userId, query }, request, response) => {
    const db = await getDb();
    const zone = accountTimeZone(request);
    const timers = await timerNotificationState(db, userId, query.ids);
    const at = now();
    response.status(200).json(TimerNotificationStateResponseSchema.parse({
      timers: timers.map((timer) => ({ ...toTimerSummary(timer, at, zone), status: timer.status })),
    }));
  }));

  router.delete('/timers/:id', route({ params: IdParams, mapError }, async ({ params, userId }, request, response) => {
    const started = Date.now();
    const db = await getDb();
    const at = now();
    const result = await cancelTimers(db, userId, { id: params.id });
    const cancelled = result.cancelled[0];
    if (!cancelled) {
      sendError(response, 404, 'not_found');
      return;
    }
    try {
      await onChange?.(userId);
    } catch {
      // The row is cancelled; the scheduler re-arms on its next run anyway.
    }
    journal('v2.timer_cancelled', {
      timer_id: cancelled.id,
      remaining: result.remaining,
      duration_ms: Date.now() - started,
    });
    response.status(200).json(TimerCancelResponseSchema.parse({
      cancelled: toTimerSummary(cancelled, at, accountTimeZone(request)),
      remaining: result.remaining,
    }));
  }));

  return router;
}
