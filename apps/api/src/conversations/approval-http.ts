/**
 * REST routes for Ask Bob proposals (story #1191). Owner-only: every handler acts as
 * req.account.userId and RLS decides access, so another account's proposal answers
 * exactly like a missing id. Journal events carry ids and counts only, never a title,
 * a param or any message text.
 *
 *   POST /api/approvals               create a pending proposal (nothing runs)
 *   GET  /api/approvals/:id           read the card
 *   POST /api/approvals/:id/approve   claim, run the steps, record the outcome
 *   POST /api/approvals/:id/decline   decline, nothing runs
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { moduleJournal } from '../platform/logger.ts';
import { route, sendError } from '../platform/http/route.ts';
import { StoreConflictError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { CreateProposalSchema, ProposalViewSchema, type ProposalView } from './approval.ts';
import {
  approveProposal,
  createProposal,
  declineProposal,
  getProposal,
  type StepExecutors,
  type StoredProposal,
} from './approval-store.ts';

const journal = moduleJournal('conversations');

interface ApprovalRouterDeps {
  getDb: () => Promise<Db>;
  /** Runs a step for the owner. An action with no executor fails the proposal when approved. */
  executors: StepExecutors;
}

const IdParams = z.object({ id: z.string().uuid() });

/** The card a client may read: steps without their params. */
function toProposalView(proposal: StoredProposal): ProposalView {
  return {
    id: proposal.id,
    status: proposal.status,
    title: proposal.title,
    steps: proposal.steps.map((step) => ({
      action: step.action,
      title: step.title,
      ...(step.subline === undefined ? {} : { subline: step.subline }),
    })),
    changes: proposal.changes,
    notify: proposal.notify,
    reminder: proposal.reminder ?? null,
    created_at: proposal.createdAt,
    decided_at: proposal.decidedAt,
  };
}

function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreNotFoundError) {
    sendError(response, 404, 'not_found', 'No such proposal.');
    return;
  }
  if (error instanceof StoreConflictError) {
    sendError(response, 409, 'conflict', 'That proposal was already decided.');
    return;
  }
  throw error;
}

export function createApprovalRouter({ getDb, executors }: ApprovalRouterDeps): Router {
  const router = Router();

  router.post('/approvals', route({ body: CreateProposalSchema, mapError }, async ({ body, userId }, _request, response) => {
    const proposal = await createProposal(await getDb(), userId, body);
    journal('v2.approval_created', { proposal_id: proposal.id, steps: proposal.steps.length });
    response.status(201).json(ProposalViewSchema.parse(toProposalView(proposal)));
  }));

  router.get('/approvals/:id', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    const proposal = await getProposal(await getDb(), userId, params.id);
    response.status(200).json(ProposalViewSchema.parse(toProposalView(proposal)));
  }));

  router.post('/approvals/:id/approve', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    const proposal = await approveProposal(await getDb(), userId, params.id, executors);
    journal('v2.approval_decided', { proposal_id: proposal.id, decision: 'approve', status: proposal.status });
    response.status(200).json(ProposalViewSchema.parse(toProposalView(proposal)));
  }));

  router.post('/approvals/:id/decline', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    const proposal = await declineProposal(await getDb(), userId, params.id);
    journal('v2.approval_decided', { proposal_id: proposal.id, decision: 'decline', status: proposal.status });
    response.status(200).json(ProposalViewSchema.parse(toProposalView(proposal)));
  }));

  return router;
}
