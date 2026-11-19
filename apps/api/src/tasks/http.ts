/**
 * REST routes for shared tasks, checklists and subscribers. RLS decides access
 * from active membership, so a task in a space the caller is not a member of
 * answers exactly like a missing id (no oracle). A stale `revision` on PATCH
 * answers 409 `conflict` carrying the current revision so the client can
 * preserve the user's draft. Journal events carry ids and counts only, never
 * task content.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { moduleJournal } from '../platform/logger.ts';
import { route, sendError } from '../platform/http/route.ts';
import { notifyTaskAssigned, notifyTaskFollowers, readTask, taskChangeNotifiesFollowers } from '../notifications/notify.ts';
import { StoreError, StoreConflictError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import {
  addSubscriber,
  createTask,
  getTask,
  listSubscribers,
  listTasks,
  moveTaskItem,
  removeSubscriber,
  restoreTask,
  TaskConflictError,
  trashTask,
  type StoredSubscriber,
  type StoredTask,
  updateTask,
} from './store.ts';
import {
  AddSubscriberRequestSchema,
  CreateTaskItemRequestSchema,
  CreateTaskRequestSchema,
  MoveTaskItemRequestSchema,
  SubscribersResponseSchema,
  TaskItemsResponseSchema,
  TaskSubscriberSchema,
  TasksQuerySchema,
  TasksResponseSchema,
  TaskSummarySchema,
  UpdateTaskRequestSchema,
  type TaskSummary,
} from '../web-schemas.ts';

const journal = moduleJournal('tasks');

interface TasksRouterDeps {
  getDb: () => Promise<Db>;
}

const UuidPath = z.string().uuid();

/** StoredTask -> the contract TaskSummarySchema (due reconstructed as a union). */
export function toTaskSummary(task: StoredTask): TaskSummary {
  const due: TaskSummary['due'] =
    task.dueDate !== null
      ? { kind: 'date', date: task.dueDate }
      : task.dueAt !== null && task.dueZone !== null
        ? { kind: 'instant', at: task.dueAt, zone: task.dueZone }
        : null;
  return {
    id: task.id,
    space_id: task.spaceId,
    parent_task_id: task.parentTaskId,
    title: task.title,
    body: task.body,
    status: task.status,
    assignee_user_id: task.assigneeUserId,
    due,
    order_key: task.orderKey,
    revision: task.revision,
    created_by: task.createdBy,
    completed_at: task.completedAt,
    completed_by: task.completedBy,
    trashed_at: task.trashedAt,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

function toSubscriber(sub: StoredSubscriber): { task_id: string; user_id: string; created_at: number } {
  return { task_id: sub.taskId, user_id: sub.userId, created_at: sub.createdAt };
}

/** Maps a store error to the contract shape; rethrows unknown errors so the
 *  express error handler (or the JWT guard) sees a 500, never a silent 200. */
function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreNotFoundError) {
    sendError(response, 404, 'not_found', error.message);
    return;
  }
  if (error instanceof TaskConflictError) {
    response.status(409).json({
      error: { code: 'conflict', message: error.message, current_revision: error.current.revision },
    });
    return;
  }
  if (error instanceof StoreConflictError) {
    sendError(response, 409, 'conflict', error.message);
    return;
  }
  if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23503') {
    // A foreign key a write could not satisfy is a refused change, never a 500.
    sendError(response, 409, 'conflict', 'task is linked to something that cannot change');
    return;
  }
  if (error instanceof StoreError) {
    // A bad assignee (or a same-space parent violation) is a conflict per the
    // contract; the Zod layer already rejected shape-level mistakes.
    sendError(response, 409, 'conflict', error.message);
    return;
  }
  throw error;
}

const SpaceParams = z.object({ spaceId: UuidPath });
const IdParams = z.object({ id: UuidPath });
const ItemParams = z.object({ id: UuidPath, itemId: UuidPath });
const SubscriberParams = z.object({ id: UuidPath, userId: UuidPath });

export function createTasksRouter({ getDb }: TasksRouterDeps): Router {
  const router = Router();

  router.get('/spaces/:spaceId/tasks', route({ query: TasksQuerySchema, params: SpaceParams, mapError },
    async ({ query, params, userId }, _request, response) => {
      const tasks = await listTasks(await getDb(), userId, params.spaceId, {
        status: query.status,
        assigneeUserId: query.assignee,
        dueBefore: query.due_before,
        parentTaskId: query.parent,
        includeTrashed: query.trashed === 'true',
      });
      journal('v2.tasks_listed', { space_id: params.spaceId, count: tasks.length });
      response.status(200).json(TasksResponseSchema.parse({ tasks: tasks.map(toTaskSummary) }));
    }));

  router.post('/spaces/:spaceId/tasks', route({ body: CreateTaskRequestSchema, params: SpaceParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const db = await getDb();
      const task = await createTask(db, userId, params.spaceId, {
        title: body.title,
        body: body.body,
        assigneeUserId: body.assignee_user_id,
        due: body.due,
        parentTaskId: body.parent_task_id,
      });
      journal('v2.task_created', { task_id: task.id, space_id: params.spaceId, parent: task.parentTaskId !== null });
      await notifyTaskAssigned(db, userId, task, null);
      response.status(201).json(TaskSummarySchema.parse(toTaskSummary(task)));
    }));

  router.get('/tasks/:id', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    const task = await getTask(await getDb(), userId, params.id);
    journal('v2.task_read', { task_id: params.id });
    response.status(200).json(TaskSummarySchema.parse(toTaskSummary(task)));
  }));

  router.patch('/tasks/:id', route({ body: UpdateTaskRequestSchema, params: IdParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const db = await getDb();
      const id = params.id;
      const assigning = typeof body.assignee_user_id === 'string' && body.assignee_user_id !== userId;
      const before = await readTask(db, userId, id);
      const task = await updateTask(db, userId, id, {
        revision: body.revision,
        status: body.status,
        title: body.title,
        body: body.body,
        assigneeUserId: body.assignee_user_id,
        due: body.due,
        spaceId: body.space_id,
      });
      journal('v2.task_updated', { task_id: id, revision: task.revision });
      const previousAssignee = before?.assigneeUserId;
      if (assigning) await notifyTaskAssigned(db, userId, task, previousAssignee);
      if (taskChangeNotifiesFollowers(before, task)) {
        // A newly assigned follower already has the 'assignment'.
        const assigned = task.assigneeUserId !== previousAssignee ? task.assigneeUserId : null;
        await notifyTaskFollowers(db, userId, task, [assigned]);
      }
      response.status(200).json(TaskSummarySchema.parse(toTaskSummary(task)));
    }));

  // Trash, not purge.
  router.delete('/tasks/:id', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    await trashTask(await getDb(), userId, params.id);
    journal('v2.task_trashed', { task_id: params.id });
    response.status(204).end();
  }));

  router.post('/tasks/:id/restore', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    const task = await restoreTask(await getDb(), userId, params.id);
    journal('v2.task_restored', { task_id: params.id });
    response.status(200).json(TaskSummarySchema.parse(toTaskSummary(task)));
  }));

  // Checklist items are child tasks. The space id is resolved from the parent
  // so the same-space invariant holds and RLS scopes it.
  router.get('/tasks/:id/items', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    const db = await getDb();
    const parent = await getTask(db, userId, params.id);
    const items = await listTasks(db, userId, parent.spaceId, { parentTaskId: params.id });
    journal('v2.task_items_listed', { task_id: params.id, count: items.length });
    response.status(200).json(TaskItemsResponseSchema.parse({ items: items.map(toTaskSummary) }));
  }));

  router.post('/tasks/:id/items', route({ body: CreateTaskItemRequestSchema, params: IdParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const db = await getDb();
      const parent = await getTask(db, userId, params.id);
      const item = await createTask(db, userId, parent.spaceId, {
        title: body.title,
        body: body.body,
        assigneeUserId: body.assignee_user_id,
        due: body.due,
        parentTaskId: params.id,
      });
      journal('v2.task_item_created', { task_id: params.id, item_id: item.id });
      await notifyTaskAssigned(db, userId, item, null);
      response.status(201).json(TaskSummarySchema.parse(toTaskSummary(item)));
    }));

  // An item that is not a child of :id answers exactly like a missing one.
  router.patch('/tasks/:id/items/:itemId', route({ body: MoveTaskItemRequestSchema, params: ItemParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const { id, itemId } = params;
      const db = await getDb();
      const existing = await getTask(db, userId, itemId);
      if (existing.parentTaskId !== id) throw new StoreNotFoundError('task not found');
      const item = await moveTaskItem(
        db,
        userId,
        itemId,
        'after_item_id' in body
          ? { afterItemId: body.after_item_id, revision: body.revision }
          : { beforeItemId: body.before_item_id, revision: body.revision },
      );
      journal('v2.task_item_moved', { task_id: id, item_id: itemId, revision: item.revision });
      response.status(200).json(TaskSummarySchema.parse(toTaskSummary(item)));
    }));

  router.get('/tasks/:id/subscribers', route({ params: IdParams, mapError },
    async ({ params, userId }, _request, response) => {
      const subs = await listSubscribers(await getDb(), userId, params.id);
      journal('v2.task_subscribers_listed', { task_id: params.id, count: subs.length });
      response.status(200).json(SubscribersResponseSchema.parse({ subscribers: subs.map(toSubscriber) }));
    }));

  router.post('/tasks/:id/subscribers', route({ body: AddSubscriberRequestSchema, params: IdParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const sub = await addSubscriber(await getDb(), userId, params.id, body.user_id);
      journal('v2.task_subscriber_added', { task_id: params.id, user_id: body.user_id });
      response.status(201).json(TaskSubscriberSchema.parse(toSubscriber(sub)));
    }));

  router.delete('/tasks/:id/subscribers/:userId', route({ params: SubscriberParams, mapError },
    async ({ params, userId }, _request, response) => {
      await removeSubscriber(await getDb(), userId, params.id, params.userId);
      journal('v2.task_subscriber_removed', { task_id: params.id, user_id: params.userId });
      response.status(204).end();
    }));

  return router;
}
