/**
 * REST routes for the durable inbox and per-type controls. RLS decides what
 * exists: a notification for a space the caller is no longer an active member
 * of is not returned, and an inaccessible id answers exactly like a missing one
 * (no oracle). The inbox table stores ids, types and revisions only; each
 * listed item's `about` (who, what, where, when) is read at request time from
 * the resource itself under the caller's own authorization (describe.ts), so
 * a resource they lost access to describes as null. Journal events carry ids
 * and counts only.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { moduleJournal } from '../platform/logger.ts';
import { route, sendError } from '../platform/http/route.ts';
import { StoreError, type Db } from '../platform/db/db.ts';
import {
  getPreferences,
  listNotifications,
  markRead,
  NOTIFICATION_TYPES,
  unreadCount,
  upsertPreference,
  type StoredNotification,
  type StoredPreference,
} from './store.ts';
import { describeNotifications, NOTIFICATION_ACTIONS, type NotificationAbout } from './describe.ts';

const journal = moduleJournal('notifications');

interface NotificationsRouterDeps {
  getDb: () => Promise<Db>;
}

const NotificationTypeSchema = z.enum(NOTIFICATION_TYPES);

const NotificationsQuerySchema = z
  .object({
    after: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    unread: z.enum(['true', 'false']).optional(),
  })
  .strict();

/** Who did it, to what, where and when, read under the caller's RLS at
 *  request time. Never a message body or snippet. */
const NotificationAboutSchema = z
  .object({
    actor_name: z.string().nullable(),
    title: z.string().nullable(),
    space_name: z.string().nullable(),
    at: z.number().int().nullable(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    action: z.enum(NOTIFICATION_ACTIONS).nullable(),
  })
  .strict();

/** A durable inbox item as the client reads it: ids, type, the resource
 *  pointer, when it was created (epoch ms) and `about` (null when the
 *  resource is gone or hidden from the caller). */
const NotificationSummarySchema = z
  .object({
    id: z.string().uuid(),
    space_id: z.string().uuid().nullable(),
    type: NotificationTypeSchema,
    resource_type: z.string().min(1).max(32),
    resource_id: z.string().uuid(),
    revision: z.number().int().positive(),
    cursor: z.number().int().positive(),
    read_at: z.number().int().nonnegative().nullable(),
    created_at: z.number().int().nonnegative(),
    about: NotificationAboutSchema.nullable(),
  })
  .strict();

export const NotificationsResponseSchema = z
  .object({
    notifications: z.array(NotificationSummarySchema),
    next_cursor: z.number().int().positive().nullable(),
    unread_count: z.number().int().nonnegative(),
  })
  .strict();

/** Exactly one of ids or up_to_cursor -- a body with both (or neither) is a
 *  400 invalid_request, never a silent partial write. */
const MarkReadRequestSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).optional(),
    up_to_cursor: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasIds = value.ids !== undefined;
    const hasCursor = value.up_to_cursor !== undefined;
    if (hasIds === hasCursor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'provide exactly one of ids or up_to_cursor',
      });
    }
  });

export const MarkReadResponseSchema = z.object({ moved: z.number().int().nonnegative() }).strict();

/** A durable preference row as the client reads it (type null = all types). */
export const PreferenceSchema = z
  .object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    space_id: z.string().uuid().nullable(),
    thread_id: z.string().uuid().nullable(),
    type: NotificationTypeSchema.nullable(),
    muted: z.boolean(),
    quiet_hours_start: z.string().nullable(),
    quiet_hours_end: z.string().nullable(),
    quiet_zone: z.string().nullable(),
  })
  .strict();

export const PreferencesResponseSchema = z.object({ preferences: z.array(PreferenceSchema) }).strict();

const QuietTimeSchema = z.string().regex(/^\d{2}:\d{2}:\d{2}$/);

const PutPreferencesRequestSchema = z
  .object({
    space_id: z.string().uuid().nullable().optional(),
    thread_id: z.string().uuid().nullable().optional(),
    type: NotificationTypeSchema.nullable().optional(),
    muted: z.boolean().optional(),
    quiet_hours_start: QuietTimeSchema.nullable().optional(),
    quiet_hours_end: QuietTimeSchema.nullable().optional(),
    quiet_zone: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .strict()
  // Quiet hours are all-or-nothing (store + DB CHECK agree): a body setting
  // one or two of start/end/zone is a 400 invalid_request, never a silent
  // partial write.
  .superRefine((value, context) => {
    const setCount = [value.quiet_hours_start, value.quiet_hours_end, value.quiet_zone].filter(
      (part) => part !== undefined && part !== null,
    ).length;
    if (setCount !== 0 && setCount !== 3) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'quiet hours must be all-or-nothing: start, end and zone together',
      });
    }
  });

/** A StoreError escaping the router (invalid rows, impossible upserts) is a
 *  500 store_error; anything else is rethrown so the net webErrorHandler
 *  answers one generic 500. All client-caused refusals are decided by Zod
 *  before the store runs. */
function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreError) {
    sendError(response, 500, 'store_error');
    return;
  }
  throw error;
}

function toAbout(about: NotificationAbout | null): z.infer<typeof NotificationAboutSchema> | null {
  if (about === null) return null;
  return {
    actor_name: about.actorName,
    title: about.title,
    space_name: about.spaceName,
    at: about.at,
    date: about.date,
    action: about.action,
  };
}

function toNotificationSummary(notification: StoredNotification,
  about: NotificationAbout | null): z.infer<typeof NotificationSummarySchema> {
  return {
    id: notification.id,
    space_id: notification.spaceId,
    type: notification.type,
    resource_type: notification.resourceType,
    resource_id: notification.resourceId,
    revision: notification.revision,
    cursor: notification.cursor,
    read_at: notification.readAt,
    created_at: notification.createdAt,
    about: toAbout(about),
  };
}

function toPreference(preference: StoredPreference): z.infer<typeof PreferenceSchema> {
  return {
    id: preference.id,
    user_id: preference.userId,
    space_id: preference.spaceId,
    thread_id: preference.threadId,
    type: preference.type,
    muted: preference.muted,
    quiet_hours_start: preference.quietHoursStart,
    quiet_hours_end: preference.quietHoursEnd,
    quiet_zone: preference.quietZone,
  };
}

export function createNotificationsRouter({ getDb }: NotificationsRouterDeps): Router {
  const router = Router();

  router.get('/notifications', route({ query: NotificationsQuerySchema, mapError },
    async ({ query, userId }, _request, response) => {
      const db = await getDb();
      const limit = query.limit ?? 25;
      const notifications = await listNotifications(db, userId, {
        afterCursor: query.after,
        limit,
        unreadOnly: query.unread === 'true',
      });
      const totalUnread = await unreadCount(db, userId);
      const last = notifications.at(-1);
      const nextCursor = notifications.length === limit && last !== undefined ? last.cursor : null;
      const described = await describeNotifications(db, userId, notifications);
      journal('v2.notifications_listed', {
        count: notifications.length, unread_count: totalUnread, describe_failed: described.failed,
      });
      response.status(200).json(
        NotificationsResponseSchema.parse({
          notifications: notifications.map((n, i) => toNotificationSummary(n, described.about[i] ?? null)),
          next_cursor: nextCursor,
          unread_count: totalUnread,
        }),
      );
    }));

  router.put('/notifications/read', route({ body: MarkReadRequestSchema, mapError },
    async ({ body, userId }, _request, response) => {
      const moved = await markRead(await getDb(), userId, {
        ids: body.ids,
        upToCursor: body.up_to_cursor,
      });
      journal('v2.notifications_marked_read', { moved });
      response.status(200).json(MarkReadResponseSchema.parse({ moved }));
    }));

  router.get('/notification-preferences', route({ mapError }, async ({ userId }, _request, response) => {
    const preferences = await getPreferences(await getDb(), userId);
    journal('v2.notification_preferences_listed', { count: preferences.length });
    response.status(200).json(
      PreferencesResponseSchema.parse({ preferences: preferences.map(toPreference) }),
    );
  }));

  router.put('/notification-preferences', route({ body: PutPreferencesRequestSchema, mapError },
    async ({ body, userId }, _request, response) => {
      const preference = await upsertPreference(await getDb(), userId, {
        spaceId: body.space_id,
        threadId: body.thread_id,
        type: body.type,
        muted: body.muted,
        quietHoursStart: body.quiet_hours_start,
        quietHoursEnd: body.quiet_hours_end,
        quietZone: body.quiet_zone,
      });
      journal('v2.notification_preference_upserted', { preference_id: preference.id });
      response.status(200).json(PreferenceSchema.parse(toPreference(preference)));
    }));

  return router;
}
