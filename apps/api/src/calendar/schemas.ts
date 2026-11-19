import { z } from 'zod';
import { GoogleAgendaResponseSchema } from '../integrations/google-agenda-schemas.ts';

/** Where a calendar comes from; only native is produced today (origin is kept
 *  for forward-compatibility with Google/iCloud projections). */
const CalendarOriginSchema = z.enum(['native', 'google', 'icloud']);

/** One native calendar as returned by GET /api/spaces/:id/calendars. */
export const CalendarSummarySchema = z
  .object({
    id: z.string().uuid(),
    space_id: z.string().uuid(),
    name: z.string().min(1).max(60),
    zone: z.string().min(1).max(64),
    origin: CalendarOriginSchema,
    created_by: z.string().uuid(),
    created_at: z.number().int().positive(),
    updated_at: z.number().int().positive(),
  })
  .strict();
export type CalendarSummary = z.infer<typeof CalendarSummarySchema>;

/** POST /api/spaces/:id/calendars. Only native origins are creatable. */
export const CreateCalendarRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    zone: z.string().trim().min(1).max(64),
  })
  .strict();

/** GET /api/spaces/:id/calendars success body. */
export const CalendarsResponseSchema = z
  .object({ calendars: z.array(CalendarSummarySchema) })
  .strict();

/** The recurrence scope of an edit; never defaulted (resolved before execution). */
const RecurrenceScopeSchema = z.enum(['this', 'this_and_following', 'series']);

/** The RecurrenceRule shape from recurrence.ts (stored in rrule jsonb). */
export const RecurrenceRuleSchema = z
  .object({
    freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().min(1).optional(),
    byWeekday: z.array(z.number().int().min(0).max(6)).optional(),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    count: z.number().int().min(1).optional(),
  })
  .strict();
type RecurrenceRule = z.infer<typeof RecurrenceRuleSchema>;

const EventStatusSchema = z.enum(['confirmed', 'cancelled']);
const AttendeeResponseSchema = z.enum(['needs_action', 'accepted', 'declined', 'tentative']);
const AttendeeRoleSchema = z.enum(['required', 'optional']);

/** The calendar date of an all-day event; survives any viewer time zone. */
const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** One event master (the series definition) as returned by GET /api/events/:id.
 *  All-day events carry start_date/end_date (dates) and null instants; timed
 *  events carry epoch-ms instants and null dates. */
export const EventSummarySchema = z
  .object({
    id: z.string().uuid(),
    calendar_id: z.string().uuid(),
    space_id: z.string().uuid(),
    uid: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    organizer_user_id: z.string().uuid(),
    title: z.string().min(1).max(200),
    location: z.string().max(500).nullable(),
    body: z.string().max(8000).nullable(),
    all_day: z.boolean(),
    start_date: CalendarDateSchema.nullable(),
    end_date: CalendarDateSchema.nullable(),
    start_at: z.number().int().nullable(),
    end_at: z.number().int().nullable(),
    zone: z.string().min(1).max(64),
    rrule: RecurrenceRuleSchema.nullable(),
    status: EventStatusSchema,
    revision: z.number().int().positive(),
    created_at: z.number().int().positive(),
    updated_at: z.number().int().positive(),
  })
  .strict();
export type EventSummary = z.infer<typeof EventSummarySchema>;

/** One expanded occurrence in a window (GET /api/calendars/:id/events,
 *  GET /api/agenda). original_occurrence_start is the stable identity; a moved
 *  occurrence keeps it and sets moved: true. */
const OccurrenceSummarySchema = z
  .object({
    event_id: z.string().uuid(),
    uid: z.string().min(1),
    title: z.string().min(1).max(200),
    location: z.string().max(500).nullable(),
    body: z.string().max(8000).nullable(),
    all_day: z.boolean(),
    start_date: CalendarDateSchema.nullable(),
    end_date: CalendarDateSchema.nullable(),
    start_at: z.number().int().nullable(),
    end_at: z.number().int().nullable(),
    zone: z.string().min(1).max(64),
    original_occurrence_start: z.number().int().positive(),
    cancelled: z.boolean(),
    moved: z.boolean(),
    /** The caller's own RSVP, or null when the caller is not an attendee. */
    my_response: AttendeeResponseSchema.nullable(),
  })
  .strict();
export type OccurrenceSummary = z.infer<typeof OccurrenceSummarySchema>;

/** The from/to instant window shared by events and agenda expansion. */
export const EventsWindowQuerySchema = z
  .object({
    from: z.coerce.number().int().nonnegative(),
    to: z.coerce.number().int().nonnegative(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict()
  .refine((value) => value.to > value.from, { message: 'to must be after from' });

/** GET /api/agenda query: the window, plus an optional space to scope it to
 *  (a space's Agenda tab). A scoped agenda carries no Google rows: those
 *  belong to the person, not to a space. */
export const AgendaQuerySchema = z
  .object({
    from: z.coerce.number().int().nonnegative(),
    to: z.coerce.number().int().nonnegative(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    space_id: z.string().uuid().optional(),
  })
  .strict()
  .refine((value) => value.to > value.from, { message: 'to must be after from' });

/** GET /api/calendars/:id/events success body. */
export const EventsResponseSchema = z
  .object({ events: z.array(OccurrenceSummarySchema) })
  .strict();

/** POST /api/calendars/:id/events. all_day selects dates OR instants. */
export const CreateEventRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    location: z.string().trim().max(500).nullish(),
    body: z.string().max(8000).nullish(),
    all_day: z.boolean().default(false),
    start_date: CalendarDateSchema.nullish(),
    end_date: CalendarDateSchema.nullish(),
    start_at: z.number().int().positive().nullish(),
    end_at: z.number().int().positive().nullish(),
    zone: z.string().trim().min(1).max(64),
    rrule: RecurrenceRuleSchema.nullish(),
    attendees: z
      .array(
        z
          .object({ user_id: z.string().uuid(), role: AttendeeRoleSchema.default('required') })
          .strict(),
      )
      .max(200)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasDates = value.start_date !== undefined || value.end_date !== undefined;
    const hasInstants = value.start_at !== undefined || value.end_at !== undefined;
    if (value.all_day && hasInstants) {
      ctx.addIssue({ code: 'custom', path: ['start_at'], message: 'all-day events take dates, not instants' });
    }
    if (!value.all_day && hasDates) {
      ctx.addIssue({ code: 'custom', path: ['start_date'], message: 'timed events take instants, not dates' });
    }
  });

/** The editable fields of an event, as a partial for PATCH. */
const EventPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    location: z.string().max(500).nullish(),
    body: z.string().max(8000).nullish(),
    all_day: z.boolean().optional(),
    start_date: CalendarDateSchema.nullish(),
    end_date: CalendarDateSchema.nullish(),
    start_at: z.number().int().positive().nullish(),
    end_at: z.number().int().positive().nullish(),
    zone: z.string().trim().min(1).max(64).optional(),
    rrule: RecurrenceRuleSchema.nullish(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasDates = value.start_date !== undefined || value.end_date !== undefined;
    const hasInstants = value.start_at !== undefined || value.end_at !== undefined;
    const allDay = value.all_day;
    if (allDay === true && hasInstants) {
      ctx.addIssue({ code: 'custom', path: ['start_at'], message: 'all-day events take dates, not instants' });
    }
    if (allDay === false && hasDates) {
      ctx.addIssue({ code: 'custom', path: ['start_date'], message: 'timed events take instants, not dates' });
    }
  });
export type EventPatch = z.infer<typeof EventPatchSchema>;

/** PATCH /api/events/:id. scope and revision are required; occurrence_start is
 *  required when scope is not 'series'. A missing scope is a 400, never a
 *  silent default. */
export const UpdateEventRequestSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    scope: RecurrenceScopeSchema,
    occurrence_start: z.number().int().positive().optional(),
    patch: EventPatchSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope !== 'series' && value.occurrence_start === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['occurrence_start'],
        message: 'occurrence_start is required when scope is not series',
      });
    }
  });

/** DELETE /api/events/:id. Takes an explicit scope like PATCH. */
export const CancelEventRequestSchema = z
  .object({
    scope: RecurrenceScopeSchema,
    occurrence_start: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope !== 'series' && value.occurrence_start === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['occurrence_start'],
        message: 'occurrence_start is required when scope is not series',
      });
    }
  });

/** One attendee of an event. */
export const AttendeeSchema = z
  .object({
    event_id: z.string().uuid(),
    user_id: z.string().uuid().nullable(),
    email: z.string().email().nullable(),
    response: AttendeeResponseSchema,
    role: AttendeeRoleSchema,
  })
  .strict();
export type Attendee = z.infer<typeof AttendeeSchema>;

/** POST /api/events/:id/attendees (organizer only; target must be a member). */
export const AddAttendeeRequestSchema = z
  .object({
    user_id: z.string().uuid(),
    role: AttendeeRoleSchema.default('required'),
  })
  .strict();

/** GET /api/events/:id/attendees success body. */
export const AttendeesResponseSchema = z
  .object({ attendees: z.array(AttendeeSchema) })
  .strict();

/** PUT /api/events/:id/rsvp. The actor sets only their OWN response. */
export const RsvpRequestSchema = z
  .object({ response: AttendeeResponseSchema })
  .strict();

/** GET /api/agenda success body: occurrences across the caller's calendars,
 *  each labelled with its calendar and origin. */
const AgendaItemSchema = OccurrenceSummarySchema.extend({
  calendar_id: z.string().uuid(),
  /** The space the calendar belongs to, so a reader can label the row. */
  space_id: z.string().uuid(),
  origin: CalendarOriginSchema,
  can_edit: z.boolean(),
  /** can_edit, plus a group owner/admin for any native event. */
  can_delete: z.boolean(),
}).strict();
export type AgendaItem = z.infer<typeof AgendaItemSchema>;

export const AgendaResponseSchema = z
  .object({ items: z.array(AgendaItemSchema), ...GoogleAgendaResponseSchema.partial().shape, remote_unavailable: z.literal(true).optional() })
  .strict();
