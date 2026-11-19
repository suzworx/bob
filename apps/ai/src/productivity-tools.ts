/**
 * Agent capability tools for tasks and calendar (`list_tasks`, `create_task`, `complete_task`,
 * `update_task`, `list_agenda`, `create_event`) over injected callbacks.
 *
 * apps/ai owns no SQL, no credentials and no provider clients; apps/api builds
 * these callbacks bound to ONE CommandContext and passes them per invocation
 * (specs/014-family-collaboration/contracts/tools-and-events.md "The injection
 * rule"). A tool input schema therefore has no space_id, no actor_id, no
 * user_id, no audience and nothing else that names whose data to touch: the
 * model cannot name a space it was not handed, because there is nowhere in the
 * schema to say one. That is the structural half of the boundary; the
 * authorization re-check inside the callback is the enforcing half. Keep it
 * that way -- the next tool added here must stay narrow for the same reason.
 *
 * Every tool wraps its callback in try/catch and returns a structured
 * { ok: false, reason } instead of throwing, because a thrown error inside a
 * tool loop becomes an unhelpful model retry. On success each returns the real
 * resource id so the reply can link an actual item.
 */
import { z } from 'zod';
import { tool } from 'ai';
import type { ModelMessage, Tool } from 'ai';

/** A task summary returned by the callback. due stays null for a date-less task. */
const taskSummarySchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    status: z.enum(['open', 'completed']),
    due: z.string().nullable(),
  })
  .strict();
export type TaskSummary = z.infer<typeof taskSummarySchema>;

/** A created, completed or updated task. The api binders also name its space and title, which
 *  the tool output carries so a reply can link the item; stubs may leave them out. `assignee` is
 *  who the store now holds as assignee ("Maya (@maya)", null when cleared), present only when the
 *  call set one: a reply may claim an assignment only from it. */
const taskRefSchema = z
  .object({
    taskId: z.string().min(1),
    spaceId: z.string().min(1).optional(),
    title: z.string().optional(),
    assignee: z.string().nullable().optional(),
  })
  .strict();
type TaskRef = z.infer<typeof taskRefSchema>;

/** A calendar agenda item returned by the callback. */
const agendaItemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    startIso: z.string(),
    endIso: z.string(),
  })
  .strict();
export type AgendaItem = z.infer<typeof agendaItemSchema>;

/** A created event, with its space and title when the binder names them (see taskRefSchema). */
const eventRefSchema = z
  .object({ eventId: z.string().min(1), spaceId: z.string().min(1).optional(), title: z.string().optional() })
  .strict();
type EventRef = z.infer<typeof eventRefSchema>;

/**
 * Due for a task: a calendar date (no time) or an instant. A date-only due
 * must stay date-only through this layer -- never widen it into an instant.
 */
export const dueInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('date'), date: z.string() }).strict(),
  z.object({ kind: z.literal('instant'), at: z.string(), zone: z.string() }).strict(),
]);

/**
 * Behind BOB_LOCAL_TIME_DUES=on, a timed due or event time is local wall-clock time and the server
 * applies the account zone, so the model cannot write "9 a.m." as 09:00 UTC. Unset keeps the legacy schemas.
 */
export function localTimeDuesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BOB_LOCAL_TIME_DUES === 'on';
}

/** The shape a local wall-clock time must have; named in the tool error. */
export const LOCAL_WALL_TIME_SHAPE = 'YYYY-MM-DDTHH:mm';

const localWallTime = (what: string) =>
  z.string().describe(`${what}: local wall-clock time in the user's timezone, no offset (${LOCAL_WALL_TIME_SHAPE})`);

/** The flag-on due: an instant is local wall time, with no zone field. */
const localDueInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('date'), date: z.string() }).strict(),
  z.object({ kind: z.literal('instant'), at: localWallTime('When it is due') }).strict(),
]);
/** Either contract: an instant carries `zone` only under the legacy schema. */
type DueInput = z.infer<typeof dueInputSchema> | z.infer<typeof localDueInputSchema>;

/** list_tasks input: optional status filter and row limit. */
export const listTasksInputSchema = z
  .object({
    status: z.enum(['open', 'completed']).optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type ListTasksInput = z.infer<typeof listTasksInputSchema>;

/** Who a task is for, as the person said or typed it; the server resolves it to one member. */
const assigneeInput = z
  .string()
  .min(1)
  .describe('The name or @handle of a space member, exactly as the person said it; the server finds the member');

/** create_task input: exactly one task, never bulk. */
export const createTaskInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    assigneeHandle: assigneeInput.optional(),
    due: dueInputSchema.optional(),
  })
  .strict();
/** Flag-on create_task input: the due is a local wall-clock time. */
export const localCreateTaskInputSchema = createTaskInputSchema.extend({ due: localDueInputSchema.optional() });
export type CreateTaskInput = z.infer<typeof createTaskInputSchema> | z.infer<typeof localCreateTaskInputSchema>;

/** complete_task input: the exact task id. */
export const completeTaskInputSchema = z
  .object({
    taskId: z.string().min(1),
  })
  .strict();
export type CompleteTaskInput = z.infer<typeof completeTaskInputSchema>;

/** update_task input: one task by id; only the fields to change. notes/due/assignee null clears them. */
export const updateTaskInputSchema = z
  .object({
    taskId: z.string().min(1),
    title: z.string().trim().min(1).max(200).optional(),
    notes: z.string().max(8000).nullable().optional(),
    assigneeHandle: assigneeInput.nullable().optional(),
    due: dueInputSchema.nullable().optional(),
  })
  .strict();
/** Flag-on update_task input: the due is a local wall-clock time. */
const localUpdateTaskInputSchema = updateTaskInputSchema.extend({
  due: localDueInputSchema.nullable().optional(),
});
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema> | z.infer<typeof localUpdateTaskInputSchema>;

/** list_agenda input: an inclusive ISO window. */
export const listAgendaInputSchema = z
  .object({
    fromIso: z.string(),
    toIso: z.string(),
  })
  .strict();
export type ListAgendaInput = z.infer<typeof listAgendaInputSchema>;

/** create_event input: a single event in one timezone. */
export const createEventInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    startIso: z.string(),
    endIso: z.string(),
    zone: z.string().min(1),
    allDay: z.boolean().optional(),
    attendeeHandles: z.array(z.string().min(1)).optional(),
  })
  .strict();
/** Flag-on create_event input: no model zone; start/end are local wall-clock times. */
export const localCreateEventInputSchema = createEventInputSchema.omit({ zone: true }).extend({
  startIso: localWallTime('Start (for an all-day event, its first date)'),
  endIso: localWallTime('End (for an all-day event, a date)'),
});
export type CreateEventInput = z.infer<typeof createEventInputSchema> | z.infer<typeof localCreateEventInputSchema>;

/** One bounded notification requested explicitly by the person. */
const notifyEmailInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(8000),
  })
  .strict();
export type NotifyEmailInput = z.infer<typeof notifyEmailInputSchema>;

/** The callback reports queueing, never final delivery. */
export type NotifyEmailCallbackResult = {
  noteId: string;
  delivery: 'queued' | 'muted';
};

/**
 * Tools whose results carry text written by someone other than the person
 * (their mail, calendar invites, and recaps built from mail). After one runs in
 * a turn, notify_email refuses: an injected instruction must not be able to
 * send itself to the person from Bob's trusted address.
 */
const OUTSIDE_CONTENT_TOOLS: ReadonlySet<string> = new Set([
  'google_gmail_search', 'google_gmail_read_thread', 'google_gmail_read_draft',
  'google_calendar_list_events', 'get_saved_insights', 'get_routine_timeline', 'list_timeline',
]);

/** True when an earlier step of this turn called an outside-content tool. */
function readOutsideContent(messages: readonly ModelMessage[] | undefined): boolean {
  return (messages ?? []).some((message) =>
    (message.role === 'assistant' || message.role === 'tool')
    && Array.isArray(message.content)
    && message.content.some((part) =>
      (part.type === 'tool-call' || part.type === 'tool-result') && OUTSIDE_CONTENT_TOOLS.has(part.toolName)));
}

/** Structured failure shared by every tool: the model can retry or report it. */
const failureSchema = z.object({ ok: z.literal(false), reason: z.string() }).strict();
type Failure = z.infer<typeof failureSchema>;

const listTasksOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), items: z.array(taskSummarySchema) }).strict(),
  failureSchema,
]);
type ListTasksOutput = z.infer<typeof listTasksOutputSchema>;

const createTaskOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), ...taskRefSchema.shape }).strict(),
  failureSchema,
]);
type CreateTaskOutput = z.infer<typeof createTaskOutputSchema>;

const completeTaskOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), ...taskRefSchema.shape }).strict(),
  failureSchema,
]);
type CompleteTaskOutput = z.infer<typeof completeTaskOutputSchema>;

const updateTaskOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), ...taskRefSchema.shape }).strict(),
  failureSchema,
]);
type UpdateTaskOutput = z.infer<typeof updateTaskOutputSchema>;

const listAgendaOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), items: z.array(agendaItemSchema) }).strict(),
  failureSchema,
]);
type ListAgendaOutput = z.infer<typeof listAgendaOutputSchema>;

const createEventOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), ...eventRefSchema.shape }).strict(),
  failureSchema,
]);
type CreateEventOutput = z.infer<typeof createEventOutputSchema>;

const notifyEmailOutputSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    noteId: z.string().min(1),
    delivery: z.enum(['queued', 'muted']),
  }).strict(),
  failureSchema,
]);
type NotifyEmailOutput = z.infer<typeof notifyEmailOutputSchema>;

/**
 * The callback bag implemented by apps/api, bound to one CommandContext, per
 * invocation. apps/ai only ever calls these; it never imports the DB.
 */
export interface ProductivityCallbacks {
  listTasks(input: ListTasksInput): Promise<TaskSummary[]>;
  createTask(input: CreateTaskInput): Promise<TaskRef>;
  completeTask(input: CompleteTaskInput): Promise<TaskRef>;
  updateTask(input: UpdateTaskInput): Promise<TaskRef>;
  listAgenda(input: ListAgendaInput): Promise<AgendaItem[]>;
  createEvent(input: CreateEventInput): Promise<EventRef>;
  /** Optional: only private/personal callback contexts may provide this. */
  notifyEmail?(input: NotifyEmailInput): Promise<NotifyEmailCallbackResult>;
}

/** The space, title and (for a task) assignee a binder named for an item, and nothing else it returned. */
function linkOf(ref: { spaceId?: string; title?: string; assignee?: string | null }): {
  spaceId?: string;
  title?: string;
  assignee?: string | null;
} {
  return {
    ...(ref.spaceId !== undefined && { spaceId: ref.spaceId }),
    ...(ref.title !== undefined && { title: ref.title }),
    ...(ref.assignee !== undefined && { assignee: ref.assignee }),
  };
}

/** Maps a rejected callback to the structured failure instead of throwing. */
function failureOf(error: unknown): Failure {
  return { ok: false, reason: error instanceof Error ? error.message : String(error) };
}

/**
 * Builds the productivity capability tools over the callback bag. Each wraps its
 * callback so a rejection becomes { ok: false, reason } rather than throwing.
 * Tool descriptions are the model's only instructions: they say what the tool
 * does and when not to use it.
 */
export function createProductivityTools(
  cb: ProductivityCallbacks,
  { localTimeDues = localTimeDuesEnabled() }: { localTimeDues?: boolean } = {},
): Record<string, Tool> {
  // The flag picks the whole timed-input contract; unset is the legacy one.
  const createTaskSchema: z.ZodType<CreateTaskInput> = localTimeDues ? localCreateTaskInputSchema : createTaskInputSchema;
  const updateTaskSchema: z.ZodType<UpdateTaskInput> = localTimeDues ? localUpdateTaskInputSchema : updateTaskInputSchema;
  const createEventSchema: z.ZodType<CreateEventInput> = localTimeDues
    ? localCreateEventInputSchema
    : createEventInputSchema;
  return {
    list_tasks: tool({
      description: 'List tasks, optionally open or completed ("what do I have to do", to read a task, or to find a named task\'s id for complete_task). Not for past events or calendar slots. "My day"/"today"/"tomorrow"/"this week" resolve from the current date without asking. Asked to plan or organise a day or week: call this and list_agenda, then propose a time for each open task in the free gaps around the events (e.g. "buy the gift at 4, after the dentist") instead of only listing what is scheduled, asking what to plan, or offering to schedule; ask at most one follow-up after giving it.',
      inputSchema: listTasksInputSchema,
      outputSchema: listTasksOutputSchema,
      execute: async (input): Promise<ListTasksOutput> => {
        try {
          const items = await cb.listTasks(input);
          return { ok: true, items };
        } catch (error) {
          return failureOf(error);
        }
      },
    }),
    create_task: tool({
      description: 'Create exactly one task with a title, optional assignee and due. Call it once per task; never call it repeatedly to "make sure" -- that creates duplicates. A due given as a date stays a date. To assign an existing task, use update_task.',
      inputSchema: createTaskSchema,
      outputSchema: createTaskOutputSchema,
      execute: async (input): Promise<CreateTaskOutput> => {
        try {
          const ref = await cb.createTask(input);
          return { ok: true, taskId: ref.taskId, ...linkOf(ref) };
        } catch (error) {
          return failureOf(error);
        }
      },
    }),
    complete_task: tool({
      description: 'Mark one task (a to-do item made with create_task) completed by id, only when the person actually finished it; not one they only mentioned. Named by title: get the id from list_tasks first; never ask the person for an id or guess one. Something finished by name and not called an action item is a task: use this, not complete_action, even if an action item has the same name.',
      inputSchema: completeTaskInputSchema,
      outputSchema: completeTaskOutputSchema,
      execute: async (input): Promise<CompleteTaskOutput> => {
        try {
          const ref = await cb.completeTask(input);
          return { ok: true, taskId: ref.taskId, ...linkOf(ref) };
        } catch (error) {
          return failureOf(error);
        }
      },
    }),
    update_task: tool({
      description: 'Change one task by id: title, notes, due or assignee (null clears them). Call it whenever asked to assign or reassign, even if you think it is done; name an assignee only from the assignee a result returns. Get the id from list_tasks; never guess one. Use complete_task to finish a task, not this.',
      inputSchema: updateTaskSchema,
      outputSchema: updateTaskOutputSchema,
      execute: async (input): Promise<UpdateTaskOutput> => {
        if (input.title === undefined && input.notes === undefined && input.due === undefined && input.assigneeHandle === undefined) {
          return { ok: false, reason: 'nothing to change' };
        }
        try {
          const ref = await cb.updateTask(input);
          return { ok: true, taskId: ref.taskId, ...linkOf(ref) };
        } catch (error) {
          return failureOf(error);
        }
      },
    }),
    list_agenda: tool({
      description: 'List calendar events in an inclusive [fromIso, toIso] window ("what is on my calendar"). Not for task or note content. "My day"/"today"/"tomorrow"/"this week" resolve from the current date without asking. Asked to plan or organise a day or week: call this and list_tasks, then propose a time for each open task in the free gaps around the events (e.g. "buy the gift at 4, after the dentist") instead of only listing what is scheduled, asking what to plan, or offering to schedule; ask at most one follow-up after giving it.',
      inputSchema: listAgendaInputSchema,
      outputSchema: listAgendaOutputSchema,
      execute: async (input): Promise<ListAgendaOutput> => {
        try {
          const items = await cb.listAgenda(input);
          return { ok: true, items };
        } catch (error) {
          return failureOf(error);
        }
      },
    }),
    create_event: tool({
      description: localTimeDues
        ? "Create one calendar event (title, local start and end; optional all-day and attendees). Use only when the person gave the time; otherwise ask for the missing details first. Also use it to block days or times the person is away, busy or unavailable, even phrased \"remember that...\"; make it all-day across every day of the span when whole days are named."
        : 'Create one calendar event (title, start, end, timezone; optional all-day and attendees). Use only when the person gave the time; otherwise ask for the missing details first. Also use it to block days or times the person is away, busy or unavailable, even phrased \"remember that...\"; make it all-day across every day of the span when whole days are named.',
      inputSchema: createEventSchema,
      outputSchema: createEventOutputSchema,
      execute: async (input): Promise<CreateEventOutput> => {
        try {
          const ref = await cb.createEvent(input);
          return { ok: true, eventId: ref.eventId, ...linkOf(ref) };
        } catch (error) {
          return failureOf(error);
        }
      },
    }),
    ...(cb.notifyEmail === undefined
      ? {}
      : {
          notify_email: tool({
            description: 'Create one notification only when explicitly asked to notify by email. Queued means it was queued, not delivered; muted means it was not sent. Never claim it was sent.',
            inputSchema: notifyEmailInputSchema,
            outputSchema: notifyEmailOutputSchema,
            execute: async (input, options): Promise<NotifyEmailOutput> => {
              if (readOutsideContent(options?.messages)) {
                return { ok: false, reason: 'email notification is unavailable after reading mail, calendar or recap content in this turn' };
              }
              try {
                const result = await cb.notifyEmail?.(input);
                if (!result) return { ok: false, reason: 'email notification is unavailable' };
                return { ok: true, noteId: result.noteId, delivery: result.delivery };
              } catch (error) {
                return failureOf(error);
              }
            },
          }),
        }),
  };
}

/** One active member of the turn's space: what a fellow member may see, never an email or user id. */
const spaceMemberSchema = z
  .object({
    name: z.string().nullable(),
    handle: z.string().min(1),
    role: z.enum(['owner', 'admin', 'member']),
    isYou: z.boolean(),
  })
  .strict();
export type SpaceMemberLine = z.infer<typeof spaceMemberSchema>;

/** list_space_members takes no input: the space is the one the binder was handed. */
const listSpaceMembersInputSchema = z.object({}).strict();

const listSpaceMembersOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), members: z.array(spaceMemberSchema) }).strict(),
  failureSchema,
]);
type ListSpaceMembersOutput = z.infer<typeof listSpaceMembersOutputSchema>;

/** The callback apps/api binds to one space and one caller (who must be an active member). */
export interface SpaceMemberCallbacks {
  listSpaceMembers(): Promise<SpaceMemberLine[]>;
}

/**
 * `list_space_members`, offered only on a turn bound to a shared space (the
 * caller decides; a personal turn never builds it). Each line is copied field
 * by field, so nothing the binder returns beyond name, handle, role and isYou
 * (an email, a user id) can reach the model.
 */
export function createSpaceMemberTools(cb: SpaceMemberCallbacks): Record<string, Tool> {
  return {
    list_space_members: tool({
      description: 'List this space\'s active members: name, @handle, role, whether it is you. Use it for who is in the space and to resolve a named person to a member @handle before assigning; never guess a handle.',
      inputSchema: listSpaceMembersInputSchema,
      outputSchema: listSpaceMembersOutputSchema,
      execute: async (): Promise<ListSpaceMembersOutput> => {
        try {
          const members = (await cb.listSpaceMembers()).map(({ name, handle, role, isYou }) => ({ name, handle, role, isYou }));
          return { ok: true, members };
        } catch (error) {
          return failureOf(error);
        }
      },
    }),
  };
}
