import type { AgendaItem, CompleteTaskInput, CreateEventInput, CreateTaskInput, ListAgendaInput, ListTasksInput, ProductivityCallbacks, TaskSummary, UpdateTaskInput } from '@bob/ai';
import { type Db } from '../platform/db/db.ts';
import { completeTask as storeCompleteTask, createTask as storeCreateTask, getTask as storeGetTask, listTasks as storeListTasks, updateTask as storeUpdateTask, type TaskDue } from './store.ts';
import { createCalendar as storeCreateCalendar, createEvent as storeCreateEvent, listAgenda as storeListAgenda, listCalendars as storeListCalendars } from '../calendar/store.ts';
import { createNote as storeCreateNote } from '../notes/store.ts';
import { notifyBobMessage } from '../notifications/notify.ts';
import { getSpace } from '../spaces/store.ts';
import { resolveToolAssignee } from './assignee.ts';
import { agendaTimeText, defaultCalendarZone, dueInstant, eventTiming, taskDueText, type LocalTimeScope } from '../conversations/invocations-service.ts';

type PrivateCallbackOptions = {
  calendarName?: string;
  allowNotifyEmail?: boolean;
};

/** The space's first calendar, else a freshly created default. */
async function resolvePrivateCalendar(
  db: Db,
  userId: string,
  spaceId: string,
  calendarName: string,
  scope: LocalTimeScope,
): Promise<string> {
  const calendars = await storeListCalendars(db, userId, spaceId);
  const first = calendars[0];
  if (first) return first.id;
  const created = await storeCreateCalendar(db, userId, spaceId, { name: calendarName, zone: defaultCalendarZone(scope) });
  return created.id;
}

/** ProductivityCallbacks bound to one space the account belongs to, shared by
 *  the device turn and the web chat turn. notifyEmail is omitted unless the
 *  caller has verified a personal context. Store calls remain RLS-scoped. */
export function bindPrivateCallbacks(
  db: Db,
  userId: string,
  spaceId: string,
  scope: LocalTimeScope,
  options: PrivateCallbackOptions = {},
): ProductivityCallbacks {
  const calendarName = options.calendarName ?? 'Private';
  const callbacks: ProductivityCallbacks = {
    async listTasks(input: ListTasksInput): Promise<TaskSummary[]> {
      const rows = await storeListTasks(db, userId, spaceId, { status: input.status });
      return rows.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        due: taskDueText(task, scope),
      }));
    },
    async createTask(input: CreateTaskInput) {
      const due =
        input.due === undefined
          ? undefined
          : input.due.kind === 'date'
            ? { kind: 'date' as const, date: input.due.date }
            : dueInstant(input.due, scope);
      const assignee = await resolveToolAssignee(db, userId, spaceId, input.assigneeHandle);
      const created = await storeCreateTask(db, userId, spaceId, { title: input.title, due, assigneeUserId: assignee?.userId });
      return { taskId: created.id, spaceId: created.spaceId, title: created.title, ...(assignee && { assignee: assignee.label }) };
    },
    async completeTask(input: CompleteTaskInput) {
      const updated = await storeCompleteTask(db, userId, input.taskId);
      return { taskId: updated.id, spaceId: updated.spaceId, title: updated.title };
    },
    async updateTask(input: UpdateTaskInput) {
      const current = await storeGetTask(db, userId, input.taskId);
      if (current.spaceId !== spaceId) throw new Error('task not found');
      let due: TaskDue | null | undefined;
      if (input.due === null) due = null;
      else if (input.due !== undefined) {
        if (input.due.kind === 'date') due = { kind: 'date', date: input.due.date };
        else {
          due = dueInstant(input.due, scope);
          if (Number.isNaN(due.at)) throw new Error('invalid due');
        }
      }
      const assignee = await resolveToolAssignee(db, userId, spaceId, input.assigneeHandle);
      const updated = await storeUpdateTask(db, userId, input.taskId, {
        revision: current.revision,
        title: input.title,
        body: input.notes,
        due,
        assigneeUserId: assignee?.userId,
      });
      return { taskId: updated.id, spaceId: updated.spaceId, title: updated.title, ...(assignee && { assignee: assignee.label }) };
    },
    async listAgenda(input: ListAgendaInput): Promise<AgendaItem[]> {
      const rows = await storeListAgenda(db, userId, { from: Date.parse(input.fromIso), to: Date.parse(input.toIso) });
      return rows.map((occ) => ({
        id: occ.eventId,
        title: occ.title,
        startIso: agendaTimeText(occ.startAt, occ.startDate, scope),
        endIso: agendaTimeText(occ.endAt, occ.endDate, scope),
      }));
    },
    async createEvent(input: CreateEventInput) {
      const calendarId = await resolvePrivateCalendar(db, userId, spaceId, calendarName, scope);
      const created = await storeCreateEvent(db, userId, calendarId, { title: input.title, ...eventTiming(input, scope) });
      return { eventId: created.id, spaceId: created.spaceId, title: created.title };
    },
  };
  if (options.allowNotifyEmail === true) {
    callbacks.notifyEmail = async (input) => {
      const space = await getSpace(db, userId, spaceId);
      if (space.kind !== 'private' || space.ownerUserId !== userId) {
        throw new Error('notification is only available in a personal space');
      }
      // Every request is its own note, so asking twice sends twice; the note id
      // keys the notification, so a replayed enqueue never mails it again.
      const note = await storeCreateNote(db, userId, spaceId, {
        title: input.title,
        body: input.body,
        aiAssisted: true,
      });
      const outcome = await notifyBobMessage(db, userId, note.id, `bob_message:note:${note.id}`)
        .catch((cause: unknown): never => {
          throw new Error('notification could not be queued', { cause });
        });
      if (outcome.status === 'delivered') return { noteId: note.id, delivery: 'queued' };
      if (outcome.status === 'muted') return { noteId: note.id, delivery: 'muted' };
      throw new Error('notification could not be queued');
    };
  }
  return callbacks;
}
