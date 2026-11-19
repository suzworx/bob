/**
 * Workflow: an AI invocation in a shared thread ("@bob add milk to the grocery list") makes one task appear in that space, linked from the reply.
 * Trigger: POST /threads/:id/invocations (conversations/invocations-http.ts), entered only when a message addresses the assistant or the explicit invocation route is called; an ordinary post makes zero model calls.
 * Steps: 1. Authorize: the actor is an active member; record membership_revision. 2. Claim: insert the invocation as running, busy if another is already running. 3. Build context: the thread up to context_high_water only, plus the space's tasks and events. 4. Bind capabilities: closures capture ctx, and the agent gets an explicit empty memory set. 5. Run the agent. 6. Re-check membership and revision under the audience lock and insert the reply in that same transaction. 7. Mark the persisted reply completed.
 * Outcome: completed with the reply linked as result_message_id; failed when the agent throws (no reply persisted); cancelled when the audience changed before the reply landed. A non-member actor throws (a 500). Every capability write re-checks membership, and shared mode never touches personal memory.
 * Journal: trace 'thread-invocation' (the span over steps 3-7). This file emits no v2.* event; the v2.invocation_* events are emitted by the trigger (conversations/invocations-http.ts).
 */
import { telemetryConversationId } from '../platform/observability/conversation-correlation.ts';
import { authorizeAppInvocation } from '../bob-apps/bound-app-turn.ts';
import type { AppTurnExtension } from '../bob-apps/app-turn-extension.ts';
import { StoreError, withUser } from '../platform/db/db.ts';
import type { ChatAppBinding } from '../conversations/schemas.ts';
import { getSpace } from '../spaces/store.ts';
import {
  claimInvocation,
  InvocationBusyError,
  setInvocationState,
  type StoredInvocation,
} from '../conversations/invocations-store.ts';
import { listMessages, postAssistantMessage, ThreadAudienceChangedError, type StoredThreadMessage } from '../conversations/thread-store.ts';
import { bindSpaceMemberCallbacks } from '../conversations/space-member-callbacks.ts';
import { completeTask as storeCompleteTask, createTask as storeCreateTask, getTask as storeGetTask, listTasks as storeListTasks, updateTask as storeUpdateTask, type TaskDue } from '../tasks/store.ts';
import { createCalendar, createEvent as storeCreateEvent, listAgenda as storeListAgenda, listCalendars } from '../calendar/store.ts';
import { agendaTimeText, defaultCalendarZone, dueInstant, eventTiming, taskDueText, type LocalTimeScope } from '../conversations/invocations-service.ts';
import { resolveToolAssignee } from '../tasks/assignee.ts';
import type { Db } from '../platform/db/db.ts';
import { prepareToolPolicyFilter } from '../tools/policy.ts';
import type { ChatMessage } from '../conversations/chat-message.ts';
import { createBobAgent, resolveTimeZone, type TurnMode, createProductivityTools, createSpaceMemberTools, toSpanAttrs, traceSpan, localTimeDuesEnabled, type AgendaItem, type CreateEventInput, type CreateBobAgentOptions, type CreateTaskInput, type ListAgendaInput, type ListTasksInput, type ProductivityCallbacks, type TaskSummary, type UpdateTaskInput } from '@bob/ai';

/** Where an invocation gets its agent: the agent port from AppDeps satisfies this structurally. Kept local so this module never imports the voice module (which imports conversations). */
export interface InvocationAgentSource {
  createInvocation(options: CreateBobAgentOptions): ReturnType<typeof createBobAgent>;
}

/** Identity and audience come from the authenticated request and thread.
 *  A validated app binding is request context, never authority by itself. */
export interface InvocationContext {
  actorUserId: string;
  sessionId?: string;
  spaceId: string;
  threadId: string;
  triggerMessageId: string;
  appBinding?: ChatAppBinding;
  /** The thread sequence at dispatch; context is built only up to here. */
  contextHighWater: number;
  /** The actor's account timezone (`user_metadata.time_zone` from the verified
   *  JWT). Anchors "today" for the agent; UTC when absent or invalid. */
  timeZone?: string;
}

interface InvocationDeps {
  db: Db;
  /** The agent port (stub or real, chosen once at the composition root); omitted, the real factory answers. */
  agent?: InvocationAgentSource | undefined;
  /** Overrides the port's invocation agent; tests substitute a stubbed factory. */
  createAgent?: typeof createBobAgent;
  /** The installed apps' one turn extension (AppDeps.appTurnTools); the thread reaches apps only through it. */
  appTurnTools: AppTurnExtension;
}

export type InvocationResult =
  | {
      claimed: true;
      invocation: StoredInvocation;
      outcome: 'completed' | 'cancelled' | 'failed';
      resultMessageId: string | null;
    }
  | { claimed: false; reason: 'busy'; invocation: null }
  | { claimed: false; reason: 'duplicate'; invocation: StoredInvocation };

/** Reads every thread message with sequence <= contextHighWater, ascending. */
async function messagesUpToHighWater(
  db: Db,
  ctx: InvocationContext,
): Promise<StoredThreadMessage[]> {
  const collected: StoredThreadMessage[] = [];
  let cursor: string | undefined;
  let done = false;
  while (!done) {
    const { messages, nextCursor } = await listMessages(db, ctx.actorUserId, ctx.threadId, {
      limit: 200,
      cursor,
    });
    for (const message of messages) {
      if (message.sequence > ctx.contextHighWater) {
        done = true;
        break;
      }
      collected.push(message);
    }
    if (done || nextCursor === null) break;
    cursor = nextCursor;
  }
  return collected;
}

/** The space's tasks and upcoming events, as a compact model-facing block. */
async function buildSpaceContext(db: Db, ctx: InvocationContext): Promise<string> {
  const tasks = await storeListTasks(db, ctx.actorUserId, ctx.spaceId, {});
  const from = Date.now();
  const events = await storeListAgenda(db, ctx.actorUserId, {
    spaceId: ctx.spaceId,
    from,
    to: from + 30 * 86_400_000,
  });
  const lines: string[] = ['[Current shared space state]'];
  for (const task of tasks) {
    const due = task.dueDate ?? (task.dueAt !== null ? new Date(task.dueAt).toISOString() : null);
    lines.push(`TASK ${task.id} "${task.title}" [${task.status}]${due ? ` due ${due}` : ''}`);
  }
  for (const event of events) {
    const start =
      event.startAt !== null ? new Date(event.startAt).toISOString() : `${event.startDate}T00:00:00Z`;
    lines.push(`EVENT ${event.eventId} "${event.title}" starts ${start}`);
  }
  return lines.join('\n');
}

/** The agent prompt: shared space context first, then the thread transcript. */
async function buildMessages(db: Db, ctx: InvocationContext, conversationOnly: boolean): Promise<ChatMessage[]> {
  const context = conversationOnly ? null : await buildSpaceContext(db, ctx);
  const transcript = (await messagesUpToHighWater(db, ctx))
    .filter((message) => message.tombstonedAt === null)
    .map(
      (message): ChatMessage => ({
        role: message.authorUserId === null ? 'assistant' : 'user',
        content: message.body,
      }),
    );
  return context === null ? transcript : [{ role: 'user', content: context }, ...transcript];
}

/** True while the actor is an active member of the space (RLS decides). */
async function isMember(db: Db, ctx: InvocationContext): Promise<boolean> {
  try {
    await getSpace(db, ctx.actorUserId, ctx.spaceId);
    return true;
  } catch {
    return false;
  }
}

/** The calendar to own a new native event: the space's first, else a freshly
 *  created default. */
async function resolveCalendar(
  db: Db,
  ctx: InvocationContext,
  scope: LocalTimeScope,
): Promise<string> {
  const calendars = await listCalendars(db, ctx.actorUserId, ctx.spaceId);
  if (calendars.length > 0) {
    const cal = calendars[0];
    if (!cal) throw new Error('resolveCalendar: no calendar');
    return cal.id;
  }
  const created = await createCalendar(db, ctx.actorUserId, ctx.spaceId, {
    name: 'Family',
    zone: defaultCalendarZone(scope),
  });
  return created.id;
}

/** ProductivityCallbacks bound to ctx. Every WRITE re-checks membership first;
 *  reads are already RLS-scoped. Inputs carry no space or actor (the schemas
 *  forbid it), so the closures capture ctx's. */
export function bindCallbacks(
  db: Db,
  ctx: InvocationContext,
  scope: LocalTimeScope = { timeZone: resolveTimeZone(ctx.timeZone), localTimeDues: localTimeDuesEnabled() },
): ProductivityCallbacks {
  return {
    async listTasks(input: ListTasksInput): Promise<TaskSummary[]> {
      const rows = await storeListTasks(db, ctx.actorUserId, ctx.spaceId, {
        status: input.status,
      });
      return rows.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        due: taskDueText(task, scope),
      }));
    },
    async createTask(input: CreateTaskInput) {
      if (!(await isMember(db, ctx))) throw new Error('not a member of the space');
      const due =
        input.due === undefined
          ? undefined
          : input.due.kind === 'date'
            ? { kind: 'date' as const, date: input.due.date }
            : dueInstant(input.due, scope);
      const assignee = await resolveToolAssignee(db, ctx.actorUserId, ctx.spaceId, input.assigneeHandle);
      const created = await storeCreateTask(db, ctx.actorUserId, ctx.spaceId, { title: input.title, due, assigneeUserId: assignee?.userId });
      return { taskId: created.id, spaceId: created.spaceId, title: created.title, ...(assignee && { assignee: assignee.label }) };
    },
    async completeTask(input) {
      if (!(await isMember(db, ctx))) throw new Error('not a member of the space');
      const current = await storeGetTask(db, ctx.actorUserId, input.taskId);
      if (current.spaceId !== ctx.spaceId) throw new Error('task not found');
      const updated = await storeCompleteTask(db, ctx.actorUserId, input.taskId);
      return { taskId: updated.id, spaceId: updated.spaceId, title: updated.title };
    },
    async updateTask(input: UpdateTaskInput) {
      if (!(await isMember(db, ctx))) throw new Error('not a member of the space');
      const current = await storeGetTask(db, ctx.actorUserId, input.taskId);
      if (current.spaceId !== ctx.spaceId) throw new Error('task not found');
      let due: TaskDue | null | undefined;
      if (input.due === null) due = null;
      else if (input.due !== undefined) {
        if (input.due.kind === 'date') due = { kind: 'date', date: input.due.date };
        else {
          due = dueInstant(input.due, scope);
          if (Number.isNaN(due.at)) throw new Error('invalid due');
        }
      }
      const assignee = await resolveToolAssignee(db, ctx.actorUserId, ctx.spaceId, input.assigneeHandle);
      const updated = await storeUpdateTask(db, ctx.actorUserId, input.taskId, {
        revision: current.revision,
        title: input.title,
        body: input.notes,
        due,
        assigneeUserId: assignee?.userId,
      });
      return { taskId: updated.id, spaceId: updated.spaceId, title: updated.title, ...(assignee && { assignee: assignee.label }) };
    },
    async listAgenda(input: ListAgendaInput): Promise<AgendaItem[]> {
      const rows = await storeListAgenda(db, ctx.actorUserId, {
        spaceId: ctx.spaceId,
        from: Date.parse(input.fromIso),
        to: Date.parse(input.toIso),
      });
      return rows.map((occ) => ({
        id: occ.eventId,
        title: occ.title,
        startIso: agendaTimeText(occ.startAt, occ.startDate, scope),
        endIso: agendaTimeText(occ.endAt, occ.endDate, scope),
      }));
    },
    async createEvent(input: CreateEventInput) {
      if (!(await isMember(db, ctx))) throw new Error('not a member of the space');
      const calendarId = await resolveCalendar(db, ctx, scope);
      const created = await storeCreateEvent(db, ctx.actorUserId, calendarId, {
        title: input.title,
        ...eventTiming(input, scope),
      });
      return { eventId: created.id, spaceId: created.spaceId, title: created.title };
    },
  };
}

async function persistInvocationReply(
  db: Db, ctx: InvocationContext, invocationId: string, membershipRevision: number, text: string,
): Promise<StoredThreadMessage | null> {
  try {
    const persist = (tx: Db): Promise<StoredThreadMessage> => postAssistantMessage(tx, ctx.actorUserId,
      { threadId: ctx.threadId, spaceId: ctx.spaceId, expectedMembershipRevision: membershipRevision }, invocationId, text);
    const binding = ctx.appBinding;
    if (!binding) return await persist(db);
    return await withUser(db, ctx.actorUserId, async (tx) => {
      await authorizeAppInvocation(tx, ctx.actorUserId, binding, ctx.threadId, ctx.sessionId, ctx.triggerMessageId);
      return persist(tx);
    });
  } catch (error) {
    if (!(error instanceof ThreadAudienceChangedError) && !(ctx.appBinding && error instanceof StoreError)) throw error;
    return null;
  }
}

/** Throws only for a non-member actor or an unexpected store failure (a 500). */
export async function runInvocation(
  ctx: InvocationContext,
  deps: InvocationDeps,
): Promise<InvocationResult> {
  ctx = { ...ctx, ...(ctx.appBinding ? { appBinding: { ...ctx.appBinding } } : {}) };
  const {
    db,
    agent: agentSource,
    appTurnTools,
    createAgent = agentSource ? (options?: Parameters<typeof createBobAgent>[0]) => agentSource.createInvocation(options ?? {}) : createBobAgent,
  } = deps;

  // 1. Authorize -- the actor is an active member; record membership_revision.
  let membershipRevision: number;
  let sharedSpace: boolean;
  let conversationOnly: boolean;
  try {
    const space = await getSpace(db, ctx.actorUserId, ctx.spaceId);
    membershipRevision = space.membershipRevision;
    sharedSpace = space.kind !== 'private';
    conversationOnly = space.conversationId != null;
  } catch {
    throw new Error('actor is not a member of the space');
  }

  // 2. Claim -- insert as running; busy if another is already running.
  let claim: Awaited<ReturnType<typeof claimInvocation>>;
  const binding = ctx.appBinding;
  try {
    claim = await claimInvocation(db, ctx.actorUserId, {
      spaceId: ctx.spaceId,
      threadId: ctx.threadId,
      triggerMessageId: ctx.triggerMessageId,
      contextHighWater: ctx.contextHighWater,
      membershipRevision,
      ...(binding ? { appBinding: binding } : {}),
    }, binding ? (tx) => authorizeAppInvocation(tx, ctx.actorUserId, binding, ctx.threadId, ctx.sessionId, ctx.triggerMessageId) : undefined);
  } catch (error) {
    if (error instanceof InvocationBusyError) return { claimed: false, reason: 'busy', invocation: null };
    throw error;
  }
  if (!claim.claimed) {
    return { claimed: false, reason: 'duplicate', invocation: claim.invocation };
  }
  const invocation = claim.invocation;
  return traceSpan('thread-invocation', toSpanAttrs({
    surface: 'invocation', turnId: invocation.id, conversationId: telemetryConversationId(ctx.threadId),
    conversationSource: 'explicit', userId: ctx.actorUserId,
    metadata: { interface: 'thread', invocation_id: invocation.id },
  }), async (): Promise<InvocationResult> => {

    // 3. Build context.
    const messages = await buildMessages(db, ctx, conversationOnly);

    // 4. Bind capabilities -- closures capture ctx; explicit empty memory set.
    const agent = createAgent(await invocationAgentOptions(db, ctx, conversationOnly, sharedSpace, appTurnTools));

    // 5. Run the agent.
    let text: string;
    try {
      const result = await agent.generate({ messages });
      text = result.text ?? '';
    } catch (error) {
      const code = error instanceof Error ? error.name : 'agent_failed';
      await setInvocationState(db, ctx.actorUserId, invocation.id, 'failed', { errorCode: code });
      return { claimed: true, invocation, outcome: 'failed', resultMessageId: null };
    }

    // 6. Re-check membership/revision under the audience lock and insert the
    // reply in that same transaction. A separate preflight check races leave.
    const reply = await persistInvocationReply(db, ctx, invocation.id, membershipRevision, text);
    if (reply === null) {
      await setInvocationState(db, ctx.actorUserId, invocation.id, 'cancelled');
      return { claimed: true, invocation, outcome: 'cancelled', resultMessageId: null };
    }
    // 7. Mark the persisted reply completed.
    await setInvocationState(db, ctx.actorUserId, invocation.id, 'completed', {
      resultMessageId: reply.id,
    });
    return {
      claimed: true,
      invocation,
      outcome: 'completed',
      resultMessageId: reply.id,
    };
  });
}

async function invocationAgentOptions(db: Db, ctx: InvocationContext, conversationOnly: boolean, sharedSpace: boolean, apps: AppTurnExtension): Promise<CreateBobAgentOptions> {
  const scope: LocalTimeScope = { timeZone: resolveTimeZone(ctx.timeZone), localTimeDues: localTimeDuesEnabled() };
  // A pair or group space can also name its members; a private one has no one else to name.
  const app = ctx.appBinding ? await apps.bind(db, ctx.actorUserId, ctx.appBinding, ctx.sessionId) : null;
  const generic = app?.generic ?? false;
  const appTools = await apps.tools(db, ctx.actorUserId, app, { conversationId: ctx.threadId, messageId: ctx.triggerMessageId });
  const boundAppTools = appTools.tools;
  const capabilityTools = {
    ...boundAppTools,
    ...(conversationOnly || generic ? {} : createProductivityTools(bindCallbacks(db, ctx, scope), { localTimeDues: scope.localTimeDues })),
    ...(sharedSpace && !generic ? createSpaceMemberTools(bindSpaceMemberCallbacks(db, ctx.actorUserId, ctx.spaceId)) : {}),
  };
  const filterTools = await prepareToolPolicyFilter(db, ctx.actorUserId, { spaceId: ctx.spaceId, conversationId: ctx.threadId }).catch(() => () => ({}));
  const permittedAppTools = filterTools(boundAppTools);
  const mode = invocationMode(ctx.appBinding, generic, Object.keys(permittedAppTools).length > 0);
  return { mode, capabilityTools, memoryTools: {}, timeZone: resolveTimeZone(ctx.timeZone), filterTools,
    ...(mode === 'group' ? {} : { contextToolNames: appTools.contextToolNames, ...(appTools.taskContext ? { taskContext: appTools.taskContext } : {}) }) };
}

/** A bound app runs as its shared row only while the policy still permits one of its tools; otherwise a plain group turn. */
function invocationMode(binding: InvocationContext['appBinding'], generic: boolean, permitted: boolean): TurnMode {
  if (!binding || !permitted) return 'group';
  if (generic) return 'shared_generic_app_refine';
  return binding.mode === 'run' ? 'shared_app_run' : 'shared_app_refine';
}
