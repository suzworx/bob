import { z } from 'zod';
import { OpaqueId } from '../platform/id-schemas.ts';

const ActionItemStatusSchema = z.enum(['open', 'done', 'dropped']);

/** One action item as returned by GET /api/action-items / PATCH /api/action-items/:id. */
export const ActionItemSummarySchema = z
  .object({
    id: OpaqueId,
    memory_id: OpaqueId,
    content: z.string().min(1).max(2000),
    confidence: z.number().min(0).max(1),
    status: ActionItemStatusSchema,
    due_at: z.number().int().positive().nullable(),
    created_at: z.number().int().positive(),
    updated_at: z.number().int().positive(),
  })
  .strict();

/** GET /api/action-items query. */
export const ActionItemsQuerySchema = z
  .object({
    status: ActionItemStatusSchema.optional(),
    due_before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

/** GET /api/action-items success body; empty is `{ action_items: [] }`. */
export const ActionItemsResponseSchema = z
  .object({ action_items: z.array(ActionItemSummarySchema) })
  .strict();

/** PATCH /api/action-items/:id request: the new status. */
export const ActionItemUpdateRequestSchema = z.object({ status: ActionItemStatusSchema }).strict();

/** A due value is HONEST about date-only versus time-specific: a date is a
 *  calendar date (never a midnight instant); an instant carries its IANA zone. */
const DueValueSchema = z.union([
  z.object({ kind: z.literal('date'), date: z.string().date() }).strict(),
  z.object({ kind: z.literal('instant'), at: z.number().int().positive(), zone: z.string().min(1) }).strict(),
]);

const TaskStatusSchema = z.enum(['open', 'completed']);

/** One task as returned by GET /api/spaces/:spaceId/tasks and /api/tasks/:id. */
export const TaskSummarySchema = z
  .object({
    id: z.string().uuid(),
    space_id: z.string().uuid(),
    parent_task_id: z.string().uuid().nullable(),
    title: z.string().min(1).max(200),
    body: z.string().max(8000).nullable(),
    status: TaskStatusSchema,
    assignee_user_id: z.string().uuid().nullable(),
    due: DueValueSchema.nullable(),
    order_key: z.string().min(1),
    revision: z.number().int().positive(),
    created_by: z.string().uuid(),
    completed_at: z.number().int().positive().nullable(),
    completed_by: z.string().uuid().nullable(),
    trashed_at: z.number().int().positive().nullable(),
    created_at: z.number().int().positive(),
    updated_at: z.number().int().positive(),
  })
  .strict();
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

/** POST /api/spaces/:spaceId/tasks body. */
export const CreateTaskRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(8000).optional(),
    assignee_user_id: z.string().uuid().optional(),
    due: DueValueSchema.optional(),
    parent_task_id: z.string().uuid().optional(),
  })
  .strict();
type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

/** POST /api/tasks/:id/items body: a checklist item; the parent rides the path. */
export const CreateTaskItemRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(8000).optional(),
    assignee_user_id: z.string().uuid().optional(),
    due: DueValueSchema.optional(),
  })
  .strict();

/** PATCH /api/tasks/:id body: the revision the caller read is required. */
export const UpdateTaskRequestSchema = z
  .object({
    revision: z.number().int().positive(),
    status: TaskStatusSchema.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(8000).nullable().optional(),
    assignee_user_id: z.string().uuid().nullable().optional(),
    due: DueValueSchema.nullable().optional(),
    /** Move to another space the caller belongs to; its checklist moves with it. */
    space_id: z.string().uuid().optional(),
  })
  .strict();

/** PATCH /api/tasks/:id/items/:itemId body: move after or before exactly one sibling. */
export const MoveTaskItemRequestSchema = z.union([
  z.object({ revision: z.number().int().positive(), after_item_id: z.string().uuid() }).strict(),
  z.object({ revision: z.number().int().positive(), before_item_id: z.string().uuid() }).strict(),
]);

/** GET /api/spaces/:spaceId/tasks query. */
export const TasksQuerySchema = z
  .object({
    status: TaskStatusSchema.optional(),
    assignee: z.string().uuid().optional(),
    due_before: z.string().date().optional(),
    parent: z.string().uuid().optional(),
    trashed: z.enum(['true']).optional(),
  })
  .strict();

/** GET /api/spaces/:spaceId/tasks success body. */
export const TasksResponseSchema = z.object({ tasks: z.array(TaskSummarySchema) }).strict();

/** GET /api/tasks/:id/items success body. */
export const TaskItemsResponseSchema = z.object({ items: z.array(TaskSummarySchema) }).strict();

/** One task watcher (distinct from the single assignee). */
export const TaskSubscriberSchema = z
  .object({
    task_id: z.string().uuid(),
    user_id: z.string().uuid(),
    created_at: z.number().int().positive(),
  })
  .strict();

/** POST /api/tasks/:id/subscribers body: who to watch. */
export const AddSubscriberRequestSchema = z.object({ user_id: z.string().uuid() }).strict();

/** GET /api/tasks/:id/subscribers success body. */
export const SubscribersResponseSchema = z
  .object({ subscribers: z.array(TaskSubscriberSchema) })
  .strict();
