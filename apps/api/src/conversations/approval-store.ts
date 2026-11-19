/**
 * Ask Bob proposals, durable (story #1191). Every call runs under withUser(),
 * so RLS keeps a proposal visible to its owner alone: another account's id is
 * indistinguishable from a missing one (StoreNotFoundError, no oracle).
 *
 * Deciding is claim-then-run. approve first flips pending -> approved with
 * UPDATE ... WHERE status = 'pending', which only one caller can win, so a
 * double tap or a replay never runs the steps twice. Then each step runs through
 * the injected executor for its action; an action with no executor, or one that
 * throws, marks the proposal failed. Completed steps are not rolled back.
 * The audit trail records the action type, the time and the outcome only, never
 * a title, a subline, a param or any message text.
 */
import { StoreConflictError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { jsonbParam } from '../platform/db/jsonb.ts';
import { type CreateProposal, type ProposalAction, type ProposalStatus, type ProposalStep } from './approval.ts';

export type StoredProposal = {
  id: string;
  userId: string;
  status: ProposalStatus;
  title: string;
  steps: ProposalStep[];
  changes: CreateProposal['changes'];
  notify: CreateProposal['notify'];
  reminder: CreateProposal['reminder'] | null;
  createdAt: number;
  decidedAt: number | null;
};

/** Runs one step for the owner. Throw to fail the proposal. */
type StepExecutor = (step: ProposalStep, context: { userId: string; proposalId: string }) => Promise<void>;
export type StepExecutors = Partial<Record<ProposalAction, StepExecutor>>;

type Row = {
  id: string;
  user_id: string;
  status: ProposalStatus;
  title: string;
  steps: ProposalStep[];
  changes: CreateProposal['changes'];
  notify: CreateProposal['notify'];
  reminder: CreateProposal['reminder'] | null;
  created_ms: string | number;
  decided_ms: string | number | null;
};

const COLUMNS = `id, user_id, status, title, steps, changes, notify, reminder,
  (extract(epoch from created_at) * 1000)::bigint AS created_ms,
  (extract(epoch from decided_at) * 1000)::bigint AS decided_ms`;

function toProposal(row: Row): StoredProposal {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    title: row.title,
    steps: row.steps,
    changes: row.changes,
    notify: row.notify,
    reminder: row.reminder,
    createdAt: Number(row.created_ms),
    decidedAt: row.decided_ms === null ? null : Number(row.decided_ms),
  };
}

/** Stores a pending proposal. Nothing it describes runs. */
export async function createProposal(db: Db, userId: string, input: CreateProposal): Promise<StoredProposal> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<Row>(
      `INSERT INTO heybob.xyzroval_proposals (user_id, title, steps, changes, notify, reminder)
       VALUES ($1, $2, ${jsonbParam('$3')}, ${jsonbParam('$4')}, ${jsonbParam('$5')}, ${jsonbParam('$6')})
       RETURNING ${COLUMNS}`,
      [
        userId,
        input.title,
        JSON.stringify(input.steps),
        JSON.stringify(input.changes),
        JSON.stringify(input.notify),
        input.reminder === undefined ? null : JSON.stringify(input.reminder),
      ],
    );
    const row = rows[0];
    if (!row) throw new StoreNotFoundError('createProposal: no row returned');
    return toProposal(row);
  });
}

export async function getProposal(db: Db, userId: string, id: string): Promise<StoredProposal> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<Row>(`SELECT ${COLUMNS} FROM heybob.xyzroval_proposals WHERE id = $1`, [id]);
    if (!rows[0]) throw new StoreNotFoundError('proposal not found');
    return toProposal(rows[0]);
  });
}

async function audit(db: Db, userId: string, proposalId: string, action: string, outcome: string): Promise<void> {
  await withUser(db, userId, (tx) =>
    tx.query(
      `INSERT INTO heybob.xyzroval_audit (user_id, proposal_id, action, outcome) VALUES ($1, $2, $3, $4)`,
      [userId, proposalId, action, outcome],
    ),
  );
}

/** pending -> `to`, or the reason it could not be: missing (not found) or already decided (conflict). */
async function claim(db: Db, userId: string, id: string, to: 'approved' | 'declined'): Promise<StoredProposal> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<Row>(
      `UPDATE heybob.xyzroval_proposals SET status = $3, decided_at = now()
       WHERE id = $1 AND user_id = $2 AND status = 'pending'
       RETURNING ${COLUMNS}`,
      [id, userId, to],
    );
    if (rows[0]) return toProposal(rows[0]);
    const existing = await tx.query<{ status: ProposalStatus }>(
      `SELECT status FROM heybob.xyzroval_proposals WHERE id = $1`,
      [id],
    );
    if (!existing[0]) throw new StoreNotFoundError('proposal not found');
    throw new StoreConflictError('proposal already decided');
  });
}

export async function declineProposal(db: Db, userId: string, id: string): Promise<StoredProposal> {
  const proposal = await claim(db, userId, id, 'declined');
  await audit(db, userId, id, 'decision', 'declined');
  return proposal;
}

/** Claims the proposal, runs its steps in order, and records the outcome. */
export async function approveProposal(
  db: Db,
  userId: string,
  id: string,
  executors: StepExecutors,
): Promise<StoredProposal> {
  const claimed = await claim(db, userId, id, 'approved');
  await audit(db, userId, id, 'decision', 'approved');
  for (const step of claimed.steps) {
    const executor = executors[step.action];
    let ok = false;
    if (executor) {
      try {
        await executor(step, { userId, proposalId: id });
        ok = true;
      } catch {
        ok = false;
      }
    }
    await audit(db, userId, id, step.action, ok ? 'succeeded' : 'failed');
    if (!ok) {
      await withUser(db, userId, (tx) =>
        tx.query(`UPDATE heybob.xyzroval_proposals SET status = 'failed' WHERE id = $1 AND user_id = $2`, [id, userId]),
      );
      return getProposal(db, userId, id);
    }
  }
  return getProposal(db, userId, id);
}
