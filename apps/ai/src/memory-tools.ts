/**
 * Memory agent tools (`remember`, `forget`, `list_actions`, `complete_action`)
 * over injected callbacks. apps/ai NEVER imports the DB: apps/api implements
 * MemoryToolCallbacks and passes it in.
 *
 * A callback that reports `{ disabled: true }` (memory store off) makes
 * the tool return a short "memory is off" result, never an error (FR-002,
 * FR-008). complete_action carries the below-threshold top-3 candidates so the
 * agent can ask the user which item it meant (T-09, T-15).
 */
import { MEMORY_CONTENT_STYLE_SHORT } from './memory-style.ts';
import { z } from 'zod';
import { tool } from 'ai';
import { isSecretLike } from './memory-safety.ts';

/** Contract actionItemStatusSchema / listActionsInputSchema status enum. */
const actionItemStatusSchema = z.enum(['open', 'done', 'dropped']);
type ActionItemStatus = z.infer<typeof actionItemStatusSchema>;

/** Contract ActionItemView (memory-tools.md), due_at as ISO-8601. */
const actionItemViewSchema = z
  .object({
    id: z.string().min(1),
    content: z.string(),
    status: actionItemStatusSchema,
    due_at: z.string().nullable(),
  })
  .strict();
export type ActionItemView = z.infer<typeof actionItemViewSchema>;

/** Contract listActionsInputSchema: status optional, defaults to open. */
export const listActionsInputSchema = z
  .object({
    status: actionItemStatusSchema.optional(),
  })
  .strict();
export type ListActionsInput = z.infer<typeof listActionsInputSchema>;

/** list_actions output: the item rows plus an optional disabled flag. */
export const listActionsOutputSchema = z
  .object({
    items: z.array(actionItemViewSchema),
    disabled: z.boolean().optional(),
  })
  .strict();
export type ListActionsOutput = z.infer<typeof listActionsOutputSchema>;

/** Contract completeActionInputSchema: exactly one of id or query. */
export const completeActionInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    query: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => (v.id === undefined) !== (v.query === undefined), {
    message: 'provide exactly one of id or query',
  });
export type CompleteActionInput = z.infer<typeof completeActionInputSchema>;

/** A below-threshold candidate (top 3), so the agent can disambiguate. */
const actionItemCandidateSchema = z
  .object({ id: z.string().min(1), content: z.string() })
  .strict();
export type ActionItemCandidate = z.infer<typeof actionItemCandidateSchema>;

/** Contract completeActionOutputSchema, extended with the candidate list. */
export const completeActionOutputSchema = z
  .object({
    completed: z.boolean(),
    action_item_id: z.string().min(1).nullable(),
    disabled: z.boolean().optional(),
    candidates: z.array(actionItemCandidateSchema).optional(),
  })
  .strict();
export type CompleteActionOutput = z.infer<typeof completeActionOutputSchema>;

/** Contract memoryKindSchema (memory-tools.md): the four memory kinds. */
const memoryKindSchema = z.enum(['fact', 'preference', 'intent', 'action_item']);
type MemoryKind = z.infer<typeof memoryKindSchema>;

/** Contract rememberInputSchema (memory-tools.md): due is action_item only. */
export const rememberInputSchema = z
  .object({
    content: z.string().trim().min(1).max(2000),
    kind: memoryKindSchema.optional(),
    due: z.string().datetime({ offset: true }).optional(),
    sensitive: z.boolean().optional(),
  })
  .strict();
export type RememberInput = z.infer<typeof rememberInputSchema>;

/**
 * The input the model sees for `remember`: only the timeless kinds and
 * no `due`. Anything the person should be told at a time is a reminder
 * (create_reminder) and a to-do is a task (create_task), so the model has no
 * field for a time and no kind for a to-do. rememberInputSchema and
 * memoryKindSchema keep every kind and `due` for the callbacks, storage and
 * the memories API, so existing rows still load and display.
 */
const rememberToolKindSchema = z.enum(['fact', 'preference']);
const rememberToolInputSchema = rememberInputSchema
  .omit({ due: true, kind: true })
  .extend({ kind: rememberToolKindSchema.optional() })
  .strict();

/** Contract rememberOutputSchema. refused marks an FR-018 secret refusal. */
export const rememberOutputSchema = z
  .object({
    stored: z.boolean(),
    refused: z.boolean(),
    memory_id: z.string().min(1).nullable(),
    sensitive: z.boolean(),
    disabled: z.boolean().optional(),
  })
  .strict();
export type RememberOutput = z.infer<typeof rememberOutputSchema>;

/** Contract forgetInputSchema: exactly one of id or query. */
export const forgetInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    query: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => (v.id === undefined) !== (v.query === undefined), {
    message: 'provide exactly one of id or query',
  });
export type ForgetInput = z.infer<typeof forgetInputSchema>;

/** Contract forgetOutputSchema. A below-threshold query is surfaced as text. */
export const forgetOutputSchema = z
  .object({
    deleted: z.number().int().nonnegative(),
    memory_id: z.string().min(1).nullable(),
    disabled: z.boolean().optional(),
  })
  .strict();
export type ForgetOutput = z.infer<typeof forgetOutputSchema>;

/** The callback result before the tool maps a disabled bag to the output. */
export type CompleteActionCallbackResult =
  | { disabled: true }
  | { completed: true; action_item_id: string | null }
  | { completed: false; candidates: ActionItemCandidate[] };

/** The callback result for remember: a stored memory, or the disabled bag. */
export type RememberCallbackResult =
  | { disabled: true }
  | { stored: boolean; memory_id: string | null; sensitive: boolean };

/** The callback result for forget: deleted, disabled, or below-threshold
 *  candidates (top 3) so the tool can ask the agent to disambiguate (T-15). */
export type ForgetCallbackResult =
  | { disabled: true }
  | { deleted: number; memory_id: string | null }
  | { deleted: 0; memory_id: null; candidates: ActionItemCandidate[] };

/** The callback bag implemented by apps/api against the store under withUser. */
export interface MemoryToolCallbacks {
  listActions(input: ListActionsInput): Promise<ActionItemView[] | { disabled: true }>;
  completeAction(input: CompleteActionInput): Promise<CompleteActionCallbackResult>;
  remember(input: RememberInput): Promise<RememberCallbackResult>;
  forget(input: ForgetInput): Promise<ForgetCallbackResult>;
}

/** Short, non-error result for a disabled (memory-off) bag (T-10). */
const DISABLED_LIST = { items: [], disabled: true };
const DISABLED_COMPLETE: CompleteActionOutput = {
  completed: false,
  action_item_id: null,
  disabled: true,
};
const DISABLED_REMEMBER: RememberOutput = {
  stored: false,
  refused: false,
  memory_id: null,
  sensitive: false,
  disabled: true,
};
const DISABLED_FORGET: ForgetOutput = { deleted: 0, memory_id: null, disabled: true };

/** Builds the memory tools; each maps the disabled marker to the "memory is off" result, never an error. */
export function createMemoryTools(callbacks: MemoryToolCallbacks) {
  return {
    remember: tool({
      description: 'Store a timeless memory: a fact or preference, never a time or a to-do. A request with a time to tell the person something (a date-time, a delay or a repeat) is a reminder whatever the words: use create_reminder instead. A to-do without a time: use create_task. Being away, busy or unavailable for specific days is a calendar block: use create_event instead, all-day across the span. Use only when the person asks you to keep something. ' + MEMORY_CONTENT_STYLE_SHORT,
      inputSchema: rememberToolInputSchema,
      outputSchema: rememberOutputSchema,
      execute: async (input): Promise<RememberOutput> => {
        if (isSecretLike(input.content)) {
          return { stored: false, refused: true, memory_id: null, sensitive: false };
        }
        const result = await callbacks.remember(input);
        if ('disabled' in result) return DISABLED_REMEMBER;
        return {
          stored: result.stored,
          refused: false,
          memory_id: result.memory_id,
          sensitive: result.sensitive,
        };
      },
    }),
    forget: tool({
      description: 'Forget a memory by id or short query; a vague query returns up to three candidates instead of deleting.',
      inputSchema: forgetInputSchema,
      outputSchema: forgetOutputSchema,
      execute: async (input): Promise<ForgetOutput | string> => {
        const result = await callbacks.forget(input);
        if ('disabled' in result) return DISABLED_FORGET;
        if ('candidates' in result) {
          const list = result.candidates
            .map((c) => `${c.content} (${c.id})`)
            .join(', ');
          return `No single memory matched clearly enough to delete. Did you mean one of: ${list}?`;
        }
        return { deleted: result.deleted, memory_id: result.memory_id };
      },
    }),
    list_actions: tool({
      description: 'List action items: follow-ups saved to memory, not tasks (for the to-do list, use list_tasks). Defaults to open items.',
      inputSchema: listActionsInputSchema,
      outputSchema: listActionsOutputSchema,
      execute: async (input): Promise<ListActionsOutput> => {
        const result = await callbacks.listActions(input);
        if ('disabled' in result) return DISABLED_LIST;
        return { items: result };
      },
    }),
    complete_action: tool({
      description: 'Mark one open action item done by id or short query. Action items are follow-ups saved to memory (see list_actions), not tasks: to finish a to-do task, use complete_task instead. Use when the person means an action item (calls it one, or one was just listed) or list_tasks has no match; a vague query returns up to three candidates.',
      inputSchema: completeActionInputSchema,
      outputSchema: completeActionOutputSchema,
      execute: async (input): Promise<CompleteActionOutput> => {
        const result = await callbacks.completeAction(input);
        if ('disabled' in result) return DISABLED_COMPLETE;
        if (result.completed) {
          return { completed: true, action_item_id: result.action_item_id };
        }
        return { completed: false, action_item_id: null, candidates: result.candidates };
      },
    }),
  };
}