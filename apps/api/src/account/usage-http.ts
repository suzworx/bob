/**
 * GET /api/me/usage: the signed-in user's own usage as counts and times only.
 * The response is parsed through a strict schema before it is sent, and the one
 * journal line carries counts only. Days and hours are in the account time zone;
 * device facts are not here (Devices is their one home).
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { moduleJournal } from '../platform/logger.ts';
import { route, sendError } from '../platform/http/route.ts';
import { StoreError, type Db } from '../platform/db/db.ts';
import { readUsage } from './usage-store.ts';

const journal = moduleJournal('account');

interface UsageRouterDeps {
  getDb: () => Promise<Db>;
}

const UsageQuerySchema = z.object({ range: z.enum(['7d', '30d', '90d']).default('7d') }).strict();

const Count = z.number().int().nonnegative();
const SurfaceCountsSchema = z.object({ device: Count, web_voice: Count, web_text: Count }).strict();

export const UsageResponseSchema = z
  .object({
    range: z.enum(['7d', '30d', '90d']),
    from: z.string(),
    to: z.string(),
    generated_at: z.string(),
    active_days: Count,
    turns: z
      .object({
        total: Count,
        by_surface: SurfaceCountsSchema,
        by_day: z.array(SurfaceCountsSchema.extend({ day: z.string() }).strict()),
        by_weekday_hour: z.array(
          z.object({ dow: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23), count: Count }).strict(),
        ),
      })
      .strict(),
    conversations_created: Count,
    created: z.object({ tasks: Count, notes: Count, reminders: Count }).strict(),
    todos_done: Count,
    memories: z.object({ new_in_range: Count, total: Count }).strict().nullable(),
    game_minutes: Count.nullable(),
  })
  .strict();

function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreError) {
    sendError(response, 500, 'store_error');
    return;
  }
  throw error;
}

export function createUsageRouter({ getDb }: UsageRouterDeps): Router {
  const router = Router();

  router.get('/usage', route({ query: UsageQuerySchema, mapError }, async ({ query, userId }, _request, response) => {
    const usage = await readUsage(await getDb(), userId, query.range);
    const body = UsageResponseSchema.parse({
      range: usage.range,
      from: usage.from,
      to: usage.to,
      generated_at: usage.generatedAt,
      active_days: usage.activeDays,
      turns: {
        total: usage.total,
        by_surface: usage.bySurface,
        by_day: usage.byDay,
        by_weekday_hour: usage.byWeekdayHour,
      },
      conversations_created: usage.conversationsCreated,
      created: usage.created,
      todos_done: usage.todosDone,
      memories: usage.memories === null ? null : { new_in_range: usage.memories.newInRange, total: usage.memories.total },
      game_minutes: usage.gameMinutes,
    });
    journal('v2.usage_read', { range: usage.range, active_days: usage.activeDays, turns: usage.total });
    response.status(200).json(body);
  }));

  return router;
}
