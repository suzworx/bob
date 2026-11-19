/**
 * REST routes for reminders: list, preview, create, update, cancel and snooze.
 * RLS decides access from active membership, so a space or reminder the caller
 * cannot see answers exactly like a missing one (no oracle). A reminder and its
 * recipients are written in one transaction; every recipient must be an active
 * member (else 400, nothing written). A snooze touches only the caller's own
 * occurrence. Journal events carry ids and counts only, never titles.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { previewOccurrences, ruleError } from '../calendar/recurrence.ts';
import { moduleJournal } from '../platform/logger.ts';
import { route, sendError } from '../platform/http/route.ts';
import { StoreError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import {
  cancelReminder,
  createReminder,
  listReminders,
  ReminderRecipientError,
  snoozeOccurrence,
  updateReminder,
  type ReminderUpdate,
  type StoredReminder,
} from './store.ts';
import {
  CreateReminderRequestSchema,
  ReminderRuleSchema,
  SnoozeOccurrenceRequestSchema,
  UpdateReminderRequestSchema,
} from '../web-schemas.ts';

const journal = moduleJournal('reminders');

export { ReminderRuleSchema };

interface RemindersRouterDeps {
  getDb: () => Promise<Db>;
}

const UuidPath = z.string().uuid();

const ReminderSummarySchema = z.object({
  id: z.string(),
  space_id: z.string(),
  title: z.string(),
  due_at: z.number().nullable(),
  due_zone: z.string().nullable(),
  rrule: ReminderRuleSchema.nullable(),
  schedule_revision: z.number().int().positive(),
  status: z.enum(['active', 'paused', 'cancelled']),
});

export const ReminderResponseSchema = z.object({ reminder: ReminderSummarySchema });

export const RemindersResponseSchema = z.object({ reminders: z.array(ReminderSummarySchema) });

type ReminderSummary = z.infer<typeof ReminderSummarySchema>;

/**
 * How far from now a preview's `due` and `from` may lie. A reminder a person
 * sets is days or years away, never centuries: a hostile `from` far past the
 * due would otherwise make the expansion do needless work.
 */
const PREVIEW_BOUND_MS = 50 * 366 * 86_400_000;

const withinPreviewBound = (at: number): boolean => Math.abs(at - Date.now()) <= PREVIEW_BOUND_MS;

/** The preview query: `rrule` is the rule as JSON, absent for a one-off. */
const PreviewQuerySchema = z.object({
  due: z.coerce.number().int().positive().refine(withinPreviewBound),
  zone: CreateReminderRequestSchema.shape.due_zone,
  rrule: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw === '') return null;
      try {
        const rule = ReminderRuleSchema.safeParse(JSON.parse(raw));
        if (rule.success) return rule.data;
      } catch {
        // Not JSON: refused below.
      }
      ctx.addIssue({ code: 'custom', message: 'invalid rrule' });
      return z.NEVER;
    }),
  from: z.coerce.number().int().positive().refine(withinPreviewBound).optional(),
});

export const ReminderPreviewResponseSchema = z.object({
  occurrences: z.array(z.object({ at: z.number(), wall_time: z.string() })),
});

/** StoredReminder -> the wire ReminderSummarySchema. */
function toReminderSummary(reminder: StoredReminder): ReminderSummary {
  return {
    id: reminder.id,
    space_id: reminder.spaceId,
    title: reminder.title,
    due_at: reminder.dueAt,
    due_zone: reminder.dueZone,
    rrule: reminder.rrule,
    schedule_revision: reminder.scheduleRevision,
    status: reminder.status,
  };
}

/** Maps a store error to the contract shape; rethrows unknown errors so the
 *  express error handler sees a 500, never a silent 200. A StoreError here is a
 *  refused input (title, rule, target), so it is a 400. */
function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreNotFoundError) {
    sendError(response, 404, 'not_found', error.message);
    return;
  }
  if (error instanceof ReminderRecipientError) {
    sendError(response, 400, 'invalid_recipient', error.message);
    return;
  }
  if (error instanceof StoreError) {
    sendError(response, 400, 'invalid_request', error.message);
    return;
  }
  throw error;
}

function sendReminder(response: Response, status: number, reminder: StoredReminder): void {
  response.status(status).json(ReminderResponseSchema.parse({ reminder: toReminderSummary(reminder) }));
}

const SpaceParams = z.object({ spaceId: UuidPath });
const IdParams = z.object({ id: UuidPath });

export function createRemindersRouter({ getDb }: RemindersRouterDeps): Router {
  const router = Router();

  router.get('/spaces/:spaceId/reminders', route({ params: SpaceParams, mapError },
    async ({ params, userId }, _request, response) => {
      const started = Date.now();
      const reminders = await listReminders(await getDb(), userId, params.spaceId);
      journal('v2.reminders_listed', {
        space_id: params.spaceId,
        count: reminders.length,
        duration_ms: Date.now() - started,
      });
      response
        .status(200)
        .json(RemindersResponseSchema.parse({ reminders: reminders.map(toReminderSummary) }));
    }));

  // The next three rings; no DB.
  router.get('/reminders/preview', route({ query: PreviewQuerySchema }, async ({ query }, _request, response) => {
    const { due, zone, rrule, from } = query;
    if (rrule !== null && ruleError(rrule) !== null) {
      sendError(response, 400, 'invalid_request', ruleError(rrule) ?? undefined);
      return;
    }
    const occurrences = previewOccurrences({ rule: rrule, dueAt: due, zone, from });
    response.status(200).json(ReminderPreviewResponseSchema.parse({
      occurrences: occurrences.map((o) => ({ at: o.at, wall_time: o.wallTime })),
    }));
  }));

  router.post('/spaces/:spaceId/reminders', route({ body: CreateReminderRequestSchema, params: SpaceParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const spaceId = params.spaceId;
      try {
        const reminder = await createReminder(await getDb(), userId, spaceId, {
          title: body.title,
          due: { kind: 'instant', at: body.due_at, zone: body.due_zone },
          rrule: body.rrule ?? null,
          taskId: body.task_id ?? null,
          recipients: body.recipient_user_ids,
        });
        journal('v2.reminder_created', {
          reminder_id: reminder.id,
          space_id: spaceId,
          recipients: new Set(body.recipient_user_ids).size,
          recurring: reminder.rrule !== null,
        });
        sendReminder(response, 201, reminder);
      } catch (error) {
        if (error instanceof ReminderRecipientError) {
          journal('v2.reminder_create_refused', { space_id: spaceId, reason: 'recipient_not_member' });
        }
        throw error;
      }
    }));

  // A timing or rule change bumps schedule_revision.
  router.patch('/reminders/:id', route({ body: UpdateReminderRequestSchema, params: IdParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const update: ReminderUpdate = {};
      if (body.title !== undefined) update.title = body.title;
      if (body.due_at !== undefined && body.due_zone !== undefined) {
        update.due = { kind: 'instant', at: body.due_at, zone: body.due_zone };
      }
      if (body.rrule !== undefined) update.rrule = body.rrule;
      const reminder = await updateReminder(await getDb(), userId, params.id, update);
      journal('v2.reminder_updated', { reminder_id: reminder.id, schedule_revision: reminder.scheduleRevision });
      sendReminder(response, 200, reminder);
    }));

  router.post('/reminders/:id/cancel', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    const reminder = await cancelReminder(await getDb(), userId, params.id);
    journal('v2.reminder_cancelled', { reminder_id: reminder.id });
    sendReminder(response, 200, reminder);
  }));

  // Snoozes the caller's own occurrence only.
  router.post('/reminders/:id/occurrences/snooze', route({ body: SnoozeOccurrenceRequestSchema, params: IdParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const { occurrence_id: occurrenceId, until } = body;
      if (until <= Date.now()) {
        sendError(response, 400, 'invalid_request');
        return;
      }
      await snoozeOccurrence(await getDb(), userId, occurrenceId, until, params.id);
      journal('v2.reminder_occurrence_snoozed', { reminder_id: params.id, occurrence_id: occurrenceId });
      response.status(204).end();
    }));

  return router;
}
