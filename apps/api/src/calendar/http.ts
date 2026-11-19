/**
 * REST routes for native calendars, events, attendees and the agenda. A
 * missing recurrence `scope` on an edit is a 400 invalid_request, never a
 * silent default. Behaviour lives in the store; this module parses and maps
 * DTOs only. Journal events carry ids and counts only, never titles, bodies,
 * locations or attendees.
 *
 * Error mapping: a CalendarInvalidError (a caller mistake -- bad bounds,
 * inverted timing, a non-member attendee, or a this_and_following edit, which
 * is refused outright until a series-split design exists) answers 400
 * invalid_request; a CalendarForbiddenError (organizer-only, own-RSVP-only)
 * answers 403 forbidden; any other StoreError is a 500 store_error.
 */
import { Router, type Response } from 'express';
import { projectGoogleAgendaForRequest } from '../integrations/google-agenda-http.ts';
import { z } from 'zod';
import { moduleJournal } from '../platform/logger.ts';
import { route, sendError } from '../platform/http/route.ts';
import { eventPatchChangesDetails, notifyEventAttendeesAdded, notifyEventCancelled, notifyEventRsvp, notifyEventUpdated, readEvent } from '../notifications/notify.ts';
import { recipientEmail, sendTemplateEmail } from '../notifications/email-client.ts';
import { StoreConflictError, StoreError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { getSpace, listMembers } from '../spaces/store.ts';
import {
  addAttendee,
  CalendarForbiddenError,
  CalendarInvalidError,
  cancelEvent,
  createCalendar,
  createEvent,
  getEvent,
  listAgenda,
  listAttendees,
  listCalendars,
  listEvents,
  removeAttendee,
  setAttendeeResponse,
  updateEvent,
  type AgendaOccurrence,
  type EventPatch as StoredEventPatch,
  type StoredAttendee,
  type StoredCalendar,
  type StoredEvent,
  type UserOccurrence,
} from './store.ts';
import {
  AddAttendeeRequestSchema,
  AgendaQuerySchema,
  AgendaResponseSchema,
  AttendeesResponseSchema,
  AttendeeSchema,
  CalendarSummarySchema,
  CalendarsResponseSchema,
  CancelEventRequestSchema,
  CreateCalendarRequestSchema,
  CreateEventRequestSchema,
  EventsResponseSchema,
  EventsWindowQuerySchema,
  EventSummarySchema,
  RsvpRequestSchema,
  UpdateEventRequestSchema,
  type AgendaItem,
  type Attendee,
  type CalendarSummary,
  type EventPatch,
  type EventSummary,
  type OccurrenceSummary,
} from '../web-schemas.ts';

const journal = moduleJournal('calendar');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CalendarsRouterDeps {
  getDb: () => Promise<Db>;
  projectGoogleAgenda?: import('../integrations/google-agenda-service.ts').GoogleAgendaProjector;
}

/** Store outage and identity-leak mapping: unknown/hidden ids are 404; a stale
 *  revision is 409; any other StoreError is a 500. Non-StoreErrors rethrow to
 *  the default 500 handler. */
function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreNotFoundError) {
    sendError(response, 404, 'not_found', error.message);
    return;
  }
  if (error instanceof StoreConflictError) {
    sendError(response, 409, 'conflict');
    return;
  }
  if (error instanceof CalendarInvalidError) {
    sendError(response, 400, 'invalid_request');
    return;
  }
  if (error instanceof CalendarForbiddenError) {
    sendError(response, 403, 'forbidden');
    return;
  }
  if (error instanceof StoreError) {
    sendError(response, 500, 'store_error');
    return;
  }
  throw error;
}

// A loose uuid shape (any version), not zod's strict RFC uuid.
const UuidPath = z.string().regex(UUID_RE);
const SpaceParams = z.object({ spaceId: UuidPath });
const IdParams = z.object({ id: UuidPath });

function toCalendarSummary(calendar: StoredCalendar): CalendarSummary {
  return {
    id: calendar.id,
    space_id: calendar.spaceId,
    name: calendar.name,
    zone: calendar.zone,
    origin: calendar.origin,
    created_by: calendar.createdBy,
    created_at: calendar.createdAt,
    updated_at: calendar.updatedAt,
  };
}

function toEventSummary(event: StoredEvent): EventSummary {
  return {
    id: event.id,
    calendar_id: event.calendarId,
    space_id: event.spaceId,
    uid: event.uid,
    sequence: event.sequence,
    organizer_user_id: event.organizerUserId,
    title: event.title,
    location: event.location,
    body: event.body,
    all_day: event.allDay,
    start_date: event.startDate,
    end_date: event.endDate,
    start_at: event.startAt,
    end_at: event.endAt,
    zone: event.zone,
    rrule: event.rrule,
    status: event.status,
    revision: event.revision,
    created_at: event.createdAt,
    updated_at: event.updatedAt,
  };
}

function toOccurrenceSummary(occurrence: UserOccurrence): OccurrenceSummary {
  return {
    event_id: occurrence.eventId,
    uid: occurrence.uid,
    title: occurrence.title,
    location: occurrence.location,
    body: occurrence.body,
    all_day: occurrence.allDay,
    start_date: occurrence.startDate,
    end_date: occurrence.endDate,
    start_at: occurrence.startAt,
    end_at: occurrence.endAt,
    zone: occurrence.zone,
    original_occurrence_start: occurrence.originalOccurrenceStart,
    cancelled: occurrence.cancelled,
    moved: occurrence.moved,
    my_response: occurrence.myResponse,
  };
}

function toAttendeeSummary(attendee: StoredAttendee): Attendee {
  return {
    event_id: attendee.eventId,
    user_id: attendee.userId,
    email: attendee.email,
    response: attendee.response,
    role: attendee.role,
  };
}

function toAgendaItem(item: AgendaOccurrence): AgendaItem {
  return {
    ...toOccurrenceSummary(item),
    calendar_id: item.calendarId,
    space_id: item.spaceId,
    origin: item.origin,
    can_edit: item.canEdit,
    can_delete: item.canDelete,
  };
}

/** Wire EventPatch (snake_case, nullish) -> store EventPatch (camelCase,
 *  undefined = unchanged, null = clear). */
function toStoredPatch(patch: EventPatch): StoredEventPatch {
  return {
    title: patch.title,
    location: patch.location === undefined ? undefined : (patch.location ?? null),
    body: patch.body === undefined ? undefined : (patch.body ?? null),
    allDay: patch.all_day,
    startDate: patch.start_date === undefined ? undefined : (patch.start_date ?? null),
    endDate: patch.end_date === undefined ? undefined : (patch.end_date ?? null),
    startAt: patch.start_at === undefined ? undefined : (patch.start_at ?? null),
    endAt: patch.end_at === undefined ? undefined : (patch.end_at ?? null),
    zone: patch.zone,
    rrule: patch.rrule === undefined ? undefined : (patch.rrule ?? null),
  };
}

/** The event's (or the cancelled occurrence's) start as a person reads it. */
function whenLabel(event: StoredEvent, occurrenceStart: number | undefined): string {
  if (event.allDay) return event.startDate ?? '';
  const at = occurrenceStart ?? event.startAt;
  if (at === null) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: event.zone, dateStyle: 'full', timeStyle: 'short',
  }).format(at);
}

/** Emails `event-cancelled` to every attendee but the actor, directly (the inbox
 *  item is notifyEventCancelled's). Best-effort: never throws; journals counts only. */
async function sendEventCancelled(db: Db, actorUserId: string, event: StoredEvent,
  occurrenceStart: number | undefined): Promise<void> {
  let sent = 0;
  let failed = 0;
  try {
    const attendees = await listAttendees(db, actorUserId, event.id);
    const recipients = [...new Set(attendees.map((a) => a.userId))]
      .filter((id): id is string => id !== null && id !== actorUserId);
    if (recipients.length === 0) return;
    const members = await listMembers(db, actorUserId, event.spaceId);
    const actor = members.find((member) => member.userId === actorUserId);
    const space = await getSpace(db, actorUserId, event.spaceId);
    const data = {
      actorName: actor?.displayName ?? 'Someone',
      eventTitle: event.title,
      whenLabel: whenLabel(event, occurrenceStart),
      spaceName: space.name,
    };
    for (const recipient of recipients) {
      try {
        const to = await recipientEmail(db, recipient);
        if (to === null) continue;
        await sendTemplateEmail({ template: 'event-cancelled', to, data });
        sent += 1;
      } catch {
        failed += 1;
      }
    }
  } catch {
    failed += 1;
  }
  journal('v2.event_cancelled_emailed', { event_id: event.id, sent, failed });
}

export function createCalendarsRouter({ getDb, projectGoogleAgenda }: CalendarsRouterDeps): Router {
  const router = Router();

  router.get('/spaces/:spaceId/calendars', route({ params: SpaceParams, mapError },
    async ({ params, userId }, _request, response) => {
      const calendars = await listCalendars(await getDb(), userId, params.spaceId);
      journal('v2.calendars_listed', { space_id: params.spaceId, count: calendars.length });
      response.status(200).json(CalendarsResponseSchema.parse({ calendars: calendars.map(toCalendarSummary) }));
    }));

  router.post('/spaces/:spaceId/calendars', route({ body: CreateCalendarRequestSchema, params: SpaceParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const calendar = await createCalendar(await getDb(), userId, params.spaceId, body);
      journal('v2.calendar_created', { calendar_id: calendar.id, space_id: params.spaceId });
      response.status(201).json(CalendarSummarySchema.parse(toCalendarSummary(calendar)));
    }));

  router.get('/calendars/:id/events', route({ query: EventsWindowQuerySchema, params: IdParams, mapError },
    async ({ query, params, userId }, _request, response) => {
      const events = await listEvents(await getDb(), userId, params.id, query);
      journal('v2.events_listed', { calendar_id: params.id, count: events.length });
      response.status(200).json(EventsResponseSchema.parse({ events: events.map(toOccurrenceSummary) }));
    }));

  router.post('/calendars/:id/events', route({ body: CreateEventRequestSchema, params: IdParams, mapError },
    async ({ body: input, params, userId }, _request, response) => {
      const db = await getDb();
      const event = await createEvent(db, userId, params.id, {
        title: input.title,
        location: input.location ?? null,
        body: input.body ?? null,
        allDay: input.all_day,
        startDate: input.start_date ?? null,
        endDate: input.end_date ?? null,
        startAt: input.start_at ?? null,
        endAt: input.end_at ?? null,
        zone: input.zone,
        rrule: input.rrule ?? null,
        attendees: input.attendees?.map((attendee) => ({ userId: attendee.user_id, role: attendee.role })),
      });
      journal('v2.event_created', { event_id: event.id, calendar_id: params.id });
      await notifyEventAttendeesAdded(db, userId, event, input.attendees?.map((a) => a.user_id) ?? []);
      response.status(201).json(EventSummarySchema.parse(toEventSummary(event)));
    }));

  router.get('/events/:id', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    const event = await getEvent(await getDb(), userId, params.id);
    response.status(200).json(EventSummarySchema.parse(toEventSummary(event)));
  }));

  router.patch('/events/:id', route({ body: UpdateEventRequestSchema, params: IdParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const db = await getDb();
      const id = params.id;
      const patch = toStoredPatch(body.patch);
      const before = await readEvent(db, userId, id);
      const event = await updateEvent(db, userId, id, body.scope, {
        revision: body.revision,
        occurrenceStart: body.occurrence_start,
        patch,
      });
      journal('v2.event_updated', { event_id: id, scope: body.scope });
      if (eventPatchChangesDetails(before, patch)) await notifyEventUpdated(db, userId, event);
      response.status(200).json(EventSummarySchema.parse(toEventSummary(event)));
    }));

  router.delete('/events/:id', route({ body: CancelEventRequestSchema, params: IdParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const db = await getDb();
      const event = await cancelEvent(db, userId, params.id, body.scope, {
        occurrenceStart: body.occurrence_start,
      });
      journal('v2.event_cancelled', { event_id: params.id, scope: body.scope });
      await sendEventCancelled(db, userId, event, body.occurrence_start);
      await notifyEventCancelled(db, userId, event, body.occurrence_start);
      response.status(200).json(EventSummarySchema.parse(toEventSummary(event)));
    }));

  router.get('/events/:id/attendees', route({ params: IdParams, mapError },
    async ({ params, userId }, _request, response) => {
      const attendees = await listAttendees(await getDb(), userId, params.id);
      response.status(200).json(AttendeesResponseSchema.parse({ attendees: attendees.map(toAttendeeSummary) }));
    }));

  router.post('/events/:id/attendees', route({ body: AddAttendeeRequestSchema, params: IdParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const db = await getDb();
      const attendee = await addAttendee(db, userId, params.id, { userId: body.user_id, role: body.role });
      journal('v2.attendee_added', { event_id: params.id });
      const event = await readEvent(db, userId, params.id);
      if (event !== undefined) await notifyEventAttendeesAdded(db, userId, event, [attendee.userId]);
      response.status(201).json(AttendeeSchema.parse(toAttendeeSummary(attendee)));
    }));

  // `user_id` is checked after the account, like the path id, so it is read
  // here rather than as a route() query schema (which runs before the account).
  router.delete('/events/:id/attendees', route({ params: IdParams, mapError },
    async ({ params, userId }, request, response) => {
      const target = typeof request.query.user_id === 'string' ? request.query.user_id : '';
      if (!UUID_RE.test(target)) {
        sendError(response, 400, 'invalid_request');
        return;
      }
      await removeAttendee(await getDb(), userId, params.id, target);
      journal('v2.attendee_removed', { event_id: params.id });
      response.status(204).end();
    }));

  router.put('/events/:id/rsvp', route({ body: RsvpRequestSchema, params: IdParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const db = await getDb();
      const attendee = await setAttendeeResponse(db, userId, params.id, body.response);
      journal('v2.rsvp_set', { event_id: params.id, response: body.response });
      await notifyEventRsvp(db, userId, params.id, body.response);
      response.status(200).json(AttendeeSchema.parse(toAttendeeSummary(attendee)));
    }));

  router.get('/agenda', route({ query: AgendaQuerySchema, mapError }, async ({ query, userId }, request, response) => {
    response.set('Cache-Control', 'no-store');
    const { space_id: spaceId, ...window } = query;
    const items = await listAgenda(await getDb(), userId, { ...window, spaceId });
    // Google rows are the person's own, never a space's: a scoped agenda has none.
    const remote = projectGoogleAgenda && spaceId === undefined ? await projectGoogleAgendaForRequest(projectGoogleAgenda, userId, { from: query.from, to: query.to }, request, response) : {};
    journal('v2.agenda_listed', { count: items.length });
    response
      .status(200)
      .json(AgendaResponseSchema.parse({ items: items.map((item) => toAgendaItem(item)), ...remote }));
  }));

  return router;
}
