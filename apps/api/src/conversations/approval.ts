/**
 * Ask Bob proposals (v4 screen 13): Bob proposes what he would do, shows what
 * changes, and waits for the owner's Approve before anything runs. This file is
 * the pure half: the strict wire shapes and the policy that says which actions
 * always ask. No database, no HTTP, no logging, no imports from other features.
 * The store (approval-store.ts) and the router (approval-http.ts) build on it.
 *
 * Strict on purpose: an unknown action or an extra key is rejected, so a raw
 * tool argument cannot ride along on a card. `params` is the one place a step
 * carries what an executor needs; it is stored for execution but never sent
 * back to the client and never copied into the audit trail.
 */
import { z } from 'zod';

/** Every action a proposal step may name. An action not listed here is rejected at the wire. */
export const PROPOSAL_ACTIONS = [
  'send_email',
  'send_message',
  'purchase',
  'delete_item',
  'share_item',
  'forget',
  'notify_people',
  'create_reminder',
  'create_task',
  'create_note',
  'create_event',
  'move_event',
  'complete_task',
] as const;

export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

export type ApprovalDecision = 'ask' | 'allow' | 'undoable';
export type ApprovalPolicy = Readonly<Record<string, ApprovalDecision>>;

/** What Bob must ask about, what he may just do, and what he does with an undo. */
export const STARTER_POLICY: ApprovalPolicy = Object.freeze({
  send_email: 'ask',
  send_message: 'ask',
  purchase: 'ask',
  delete_item: 'ask',
  share_item: 'ask',
  forget: 'ask',
  notify_people: 'ask',
  create_reminder: 'undoable',
  create_task: 'undoable',
  create_note: 'undoable',
  create_event: 'undoable',
  move_event: 'undoable',
  complete_task: 'undoable',
  set_timer: 'allow',
  list_agenda: 'allow',
});

/** An action missing from the policy (an empty string, an inherited name) always asks. */
export function classifyAction(action: string, policy: ApprovalPolicy = STARTER_POLICY): ApprovalDecision {
  if (!Object.hasOwn(policy, action)) return 'ask';
  return policy[action] ?? 'ask';
}

const Short = (max: number) => z.string().trim().min(1).max(max);

/** Scalar parameters an executor needs (an event id, a new time). Bounded so a card stays a card. */
const StepParamsSchema = z
  .record(z.string().min(1).max(40), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
  .refine((params) => Object.keys(params).length <= 12, { message: 'at most 12 params' });

const ProposalStepSchema = z
  .object({
    action: z.enum(PROPOSAL_ACTIONS),
    title: Short(80),
    subline: Short(120).optional(),
    params: StepParamsSchema.optional(),
  })
  .strict();

const ProposalChangeSchema = z
  .object({
    label: Short(40),
    before: Short(120).optional(),
    after: Short(120),
  })
  .strict();

const ProposalNotifySchema = z.object({ name: Short(60), detail: Short(120).optional() }).strict();

const ProposalReminderSchema = z
  .object({ label: Short(80), offset_minutes: z.number().int().min(0).max(10080) })
  .strict();

/** What a client (or the agent) posts to propose. */
export const CreateProposalSchema = z
  .object({
    title: Short(120),
    steps: z.array(ProposalStepSchema).min(1).max(8),
    changes: z.array(ProposalChangeSchema).max(8).default([]),
    notify: z.array(ProposalNotifySchema).max(10).default([]),
    reminder: ProposalReminderSchema.optional(),
  })
  .strict();

export type CreateProposal = z.infer<typeof CreateProposalSchema>;
export type ProposalStep = z.infer<typeof ProposalStepSchema>;

const PROPOSAL_STATUSES = ['pending', 'approved', 'declined', 'failed'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** What a client reads back: the card, never the step params. */
export const ProposalViewSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(PROPOSAL_STATUSES),
    title: Short(120),
    steps: z.array(z.object({ action: z.enum(PROPOSAL_ACTIONS), title: Short(80), subline: Short(120).optional() }).strict()),
    changes: z.array(ProposalChangeSchema),
    notify: z.array(ProposalNotifySchema),
    reminder: ProposalReminderSchema.nullable(),
    created_at: z.number().int().positive(),
    decided_at: z.number().int().positive().nullable(),
  })
  .strict();

export type ProposalView = z.infer<typeof ProposalViewSchema>;
