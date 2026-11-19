// Ask Bob proposals, durable (#1191). Real Postgres via createTestDb: RLS, the
// claim-then-run approve, and an audit trail with no text in it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StoreConflictError, StoreNotFoundError, withUser, type Db } from '../../src/platform/db/db.ts';
import type { CreateProposal } from '../../src/conversations/approval.ts';
import {
  approveProposal,
  createProposal,
  declineProposal,
  getProposal,
  type StepExecutors,
} from '../../src/conversations/approval-store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
let owner: TestAccount;
let other: TestAccount;

const TITLE = 'Move your design review on Thursday';
const input = (): CreateProposal => ({
  title: TITLE,
  steps: [
    { action: 'move_event', title: 'Move Design review', subline: 'From 11:00 AM to 2:00 PM', params: { event_id: 'evt-1' } },
    { action: 'notify_people', title: 'Notify Work crew' },
    { action: 'create_reminder', title: 'Remind me', params: { minutes: 10 } },
  ],
  changes: [{ label: 'Design review', before: 'Was 11:00 AM', after: 'Today, 2:00 PM' }],
  notify: [{ name: 'Work crew', detail: '2 people' }],
  reminder: { label: 'Fires before the event', offset_minutes: 10 },
});

const audit = (userId: string, proposalId: string) =>
  withUser(db, userId, (tx) =>
    tx.query<{ action: string; outcome: string }>(
      `SELECT action, outcome FROM bob.approval_audit WHERE proposal_id = $1 ORDER BY created_at, id`,
      [proposalId],
    ),
  );

const executorsThatSucceed = (): { executors: StepExecutors; ran: string[] } => {
  const ran: string[] = [];
  const run = (action: string) => async () => {
    ran.push(action);
  };
  return {
    ran,
    executors: { move_event: run('move_event'), notify_people: run('notify_people'), create_reminder: run('create_reminder') },
  };
};

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  owner = await addAccount(pg);
  other = await addAccount(pg);
});

afterAll(async () => {
  await closeTestDb(pg);
});

describe('createProposal and getProposal', () => {
  it('stores a pending proposal and runs nothing', async () => {
    const proposal = await createProposal(db, owner.userId, input());
    expect(proposal.status).toBe('pending');
    expect(proposal.decidedAt).toBeNull();
    expect(proposal.title).toBe(TITLE);
    expect(proposal.steps.map((s) => s.action)).toEqual(['move_event', 'notify_people', 'create_reminder']);
    expect(proposal.reminder).toEqual({ label: 'Fires before the event', offset_minutes: 10 });
    expect(await audit(owner.userId, proposal.id)).toEqual([]);
    const read = await getProposal(db, owner.userId, proposal.id);
    expect(read).toEqual(proposal);
  });

  it('keeps a proposal private: another account cannot read it and gets a plain not found', async () => {
    const proposal = await createProposal(db, owner.userId, input());
    await expect(getProposal(db, other.userId, proposal.id)).rejects.toBeInstanceOf(StoreNotFoundError);
    const rows = await withUser(db, other.userId, (tx) =>
      tx.query(`SELECT id FROM bob.approval_proposals WHERE id = $1`, [proposal.id]),
    );
    expect(rows).toEqual([]);
  });
});

describe('approveProposal', () => {
  it('claims the proposal, runs every step in order and records each outcome', async () => {
    const proposal = await createProposal(db, owner.userId, input());
    const { executors, ran } = executorsThatSucceed();
    const done = await approveProposal(db, owner.userId, proposal.id, executors);
    expect(done.status).toBe('approved');
    expect(done.decidedAt).not.toBeNull();
    expect(ran).toEqual(['move_event', 'notify_people', 'create_reminder']);
    expect(await audit(owner.userId, proposal.id)).toEqual([
      { action: 'decision', outcome: 'approved' },
      { action: 'move_event', outcome: 'succeeded' },
      { action: 'notify_people', outcome: 'succeeded' },
      { action: 'create_reminder', outcome: 'succeeded' },
    ]);
  });

  it('refuses another account and runs nothing for it', async () => {
    const proposal = await createProposal(db, owner.userId, input());
    const spy = vi.fn(async () => undefined);
    await expect(approveProposal(db, other.userId, proposal.id, { move_event: spy, notify_people: spy, create_reminder: spy })).rejects.toBeInstanceOf(StoreNotFoundError);
    expect(spy).not.toHaveBeenCalled();
    expect((await getProposal(db, owner.userId, proposal.id)).status).toBe('pending');
  });

  it('runs the steps once: a second approve is a conflict', async () => {
    const proposal = await createProposal(db, owner.userId, input());
    const { executors, ran } = executorsThatSucceed();
    await approveProposal(db, owner.userId, proposal.id, executors);
    await expect(approveProposal(db, owner.userId, proposal.id, executors)).rejects.toBeInstanceOf(StoreConflictError);
    expect(ran).toHaveLength(3);
  });

  it('lets exactly one of two simultaneous approvals win', async () => {
    const proposal = await createProposal(db, owner.userId, input());
    const { executors, ran } = executorsThatSucceed();
    const results = await Promise.allSettled([
      approveProposal(db, owner.userId, proposal.id, executors),
      approveProposal(db, owner.userId, proposal.id, executors),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(StoreConflictError);
    expect(ran).toHaveLength(3);
  });

  it('fails the proposal when a step throws, and does not run the steps after it', async () => {
    const proposal = await createProposal(db, owner.userId, input());
    const ran: string[] = [];
    const failed = await approveProposal(db, owner.userId, proposal.id, {
      move_event: async () => { ran.push('move_event'); },
      notify_people: async () => { throw new Error('mail down'); },
      create_reminder: async () => { ran.push('create_reminder'); },
    });
    expect(failed.status).toBe('failed');
    expect(failed.decidedAt).not.toBeNull();
    expect(ran).toEqual(['move_event']);
    expect(await audit(owner.userId, proposal.id)).toEqual([
      { action: 'decision', outcome: 'approved' },
      { action: 'move_event', outcome: 'succeeded' },
      { action: 'notify_people', outcome: 'failed' },
    ]);
  });

  it('fails a step that has no executor, without throwing', async () => {
    const proposal = await createProposal(db, owner.userId, input());
    const failed = await approveProposal(db, owner.userId, proposal.id, {});
    expect(failed.status).toBe('failed');
    expect((await audit(owner.userId, proposal.id)).at(-1)).toEqual({ action: 'move_event', outcome: 'failed' });
  });
});

describe('declineProposal', () => {
  it('declines without running anything, and a later approve is a conflict', async () => {
    const proposal = await createProposal(db, owner.userId, input());
    const spy = vi.fn(async () => undefined);
    const declined = await declineProposal(db, owner.userId, proposal.id);
    expect(declined.status).toBe('declined');
    expect(declined.decidedAt).not.toBeNull();
    expect(await audit(owner.userId, proposal.id)).toEqual([{ action: 'decision', outcome: 'declined' }]);
    await expect(approveProposal(db, owner.userId, proposal.id, { move_event: spy })).rejects.toBeInstanceOf(StoreConflictError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses another account and an unknown id', async () => {
    const proposal = await createProposal(db, owner.userId, input());
    await expect(declineProposal(db, other.userId, proposal.id)).rejects.toBeInstanceOf(StoreNotFoundError);
    await expect(declineProposal(db, owner.userId, '00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(StoreNotFoundError);
  });
});

describe('the audit trail', () => {
  it('holds only the action, the outcome and the time: no titles, params or text', async () => {
    const columns = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'bob' AND table_name = 'approval_audit' ORDER BY column_name`,
    );
    expect(columns.rows.map((c) => c.column_name)).toEqual(['action', 'created_at', 'id', 'outcome', 'proposal_id', 'user_id']);
    const proposal = await createProposal(db, owner.userId, input());
    await approveProposal(db, owner.userId, proposal.id, executorsThatSucceed().executors);
    const rows = await withUser(db, owner.userId, (tx) =>
      tx.query<{ row: string }>(`SELECT to_json(a)::text AS row FROM bob.approval_audit a WHERE proposal_id = $1`, [proposal.id]),
    );
    const text = rows.map((r) => r.row).join(' ');
    for (const secret of [TITLE, 'Move Design review', 'Notify Work crew', 'evt-1', 'Work crew']) {
      expect(text).not.toContain(secret);
    }
  });

  it('cannot be written for someone else’s proposal', async () => {
    const proposal = await createProposal(db, owner.userId, input());
    await expect(
      withUser(db, other.userId, (tx) =>
        tx.query(`INSERT INTO bob.approval_audit (user_id, proposal_id, action, outcome) VALUES ($1, $2, 'decision', 'approved')`, [other.userId, proposal.id]),
      ),
    ).rejects.toThrow();
    expect(await audit(owner.userId, proposal.id)).toEqual([]);
  });
});
