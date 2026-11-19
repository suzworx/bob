import { beforeEach, expect, it, vi } from 'vitest';
import { recordObservationMetrics, traceSpan } from '@bob/ai';
import type { Db } from '../../src/platform/db/db.ts';
import { createOutboxWorker, OUTBOX_DISPATCH_VARIANTS } from '../../src/platform/outbox/worker.ts';
import { createOutboxLanes } from '../../src/platform/outbox/lanes.ts';
import { ackOutbox, claimOutboxBatch, releaseOutbox, type StoredOutboxRow } from '../../src/platform/outbox/store.ts';
import { ADMIN_INVITATION_EVENT } from '../../src/account/admin-invitation.ts';
import { EMAIL_NOTIFICATION_EVENT } from '../../src/notifications/store.ts';

vi.mock('@bob/ai', async (orig) => ({
  ...(await orig<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, run) => run()),
  recordObservationMetrics: vi.fn(),
}));
vi.mock('../../src/platform/outbox/store.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/platform/outbox/store.ts')>()),
  claimOutboxBatch: vi.fn(), reclaimExpiredOutbox: vi.fn(),
  ackOutbox: vi.fn(async () => true), releaseOutbox: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

it('traces a drained delivery using row identity without exporting its payload', async () => {
  const row = {
    id: 'row-1', attempts: 0, eventType: 'task.completed',
    payload: { forbidden: 'private content' },
  } as unknown as StoredOutboxRow;
  vi.mocked(claimOutboxBatch).mockResolvedValue([row]);
  const handler = vi.fn(async () => {});
  const worker = createOutboxWorker({
    db: {} as Db, owner: 'worker-1', handlers: { 'task.completed': handler }, journal: vi.fn(),
  });
  expect(await worker.tick()).toMatchObject({ claimed: 1, acked: 1 });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(ackOutbox).toHaveBeenCalledTimes(1);
  expect(traceSpan).toHaveBeenCalledWith('outbox-drain', expect.objectContaining({
    workflowNamespace: 'outbox', turnId: 'row-1',
  }), expect.any(Function));
  expect(JSON.stringify(vi.mocked(traceSpan).mock.calls.map((call) => call[1]))).not.toContain('private content');
  await worker.stop();
});

it('preserves retry behavior when a traced handler fails', async () => {
  vi.mocked(claimOutboxBatch).mockResolvedValue([{ id: 'row-2', attempts: 0, eventType: 'task.completed' } as StoredOutboxRow]);
  const handler = vi.fn(async () => { throw new Error('private failure'); });
  const worker = createOutboxWorker({ db: {} as Db, owner: 'worker-1', handlers: { 'task.completed': handler }, journal: vi.fn() });
  expect(await worker.tick()).toMatchObject({ acked: 0, released: 1 });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(releaseOutbox).toHaveBeenCalledTimes(1);
  expect(ackOutbox).not.toHaveBeenCalled();
  await worker.stop();
});

it.each([EMAIL_NOTIFICATION_EVENT, ADMIN_INVITATION_EVENT])(
  'dispatches %s with its bounded trace action and without recipient payload',
  async (eventType) => {
    vi.mocked(claimOutboxBatch).mockResolvedValue([{
      id: 'email-row', attempts: 0, eventType,
      payload: { recipient_user_id: 'private-recipient' },
    } as unknown as StoredOutboxRow]);
    const handler = vi.fn(async () => {});
    const worker = createOutboxWorker({
      db: {} as Db, owner: 'test', handlers: { [eventType]: handler }, journal: vi.fn(),
    });
    expect(await worker.tick()).toMatchObject({ claimed: 1, acked: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(traceSpan).toHaveBeenCalledWith('outbox-drain', expect.objectContaining({
      metadata: expect.objectContaining({ action: eventType }),
    }), expect.any(Function));
    expect(JSON.stringify(vi.mocked(traceSpan).mock.calls)).not.toContain('private-recipient');
    await worker.stop();
  },
);

it('adds no lane metadata for the single-lane worker', async () => {
  const row = {
    id: 'row-4', attempts: 0, eventType: 'task.completed',
    payload: { forbidden: 'private content' },
  } as unknown as StoredOutboxRow;
  vi.mocked(claimOutboxBatch).mockResolvedValue([row]);
  const log = vi.fn();
  const worker = createOutboxWorker({ db: {} as Db, owner: 'worker-1', handlers: { 'task.completed': vi.fn(async () => {}) }, journal: log });
  expect(await worker.tick()).toMatchObject({ claimed: 1, acked: 1 });
  const attrs = vi.mocked(traceSpan).mock.calls.map((call) => call[1]);
  expect(attrs.at(-1)).not.toHaveProperty('metadata.lane');
  // The tick journal stays the exact pre-lanes shape.
  expect(log).toHaveBeenCalledWith('v2.outbox_tick', { claimed: 1, acked: 1, released: 0, parked: 0 });
  await worker.stop();
});

it('a single default lane from createOutboxLanes journals v2.outbox_tick with exactly the pre-lanes fields (no lane)', async () => {
  const row = { id: 'row-default', attempts: 0, eventType: 'task.completed' } as StoredOutboxRow;
  vi.mocked(claimOutboxBatch).mockResolvedValue([]);
  vi.mocked(claimOutboxBatch).mockResolvedValueOnce([row]);
  const log = vi.fn();
  const lanes = createOutboxLanes({
    db: {} as Db, owner: 'worker-1', journal: log, pollMs: 10,
    lanes: [{ handlers: { 'task.completed': vi.fn(async () => {}) } }],
  });
  lanes.start();
  try {
    await vi.waitFor(() => expect(log.mock.calls.some(([event]) => event === 'v2.outbox_tick')).toBe(true));
  } finally {
    await lanes.stop();
  }
  const ticks = log.mock.calls.filter(([event]) => event === 'v2.outbox_tick').map(([, fields]) => fields);
  expect(ticks).toEqual([{ claimed: 1, acked: 1, released: 0, parked: 0 }]);
  // Nor does the default lane stamp a lane into its span metadata.
  for (const attrs of vi.mocked(traceSpan).mock.calls.map((call) => call[1])) {
    expect(attrs).not.toHaveProperty('metadata.lane');
  }
});

it('stamps a lane-labelled worker with its lane in spans and tick journal, and never labels the action with it', async () => {
  const row = {
    id: 'row-5', attempts: 0, eventType: 'task.completed',
    payload: { forbidden: 'private content' },
  } as unknown as StoredOutboxRow;
  vi.mocked(claimOutboxBatch).mockResolvedValue([row]);
  const log = vi.fn();
  const worker = createOutboxWorker({
    db: {} as Db, owner: 'worker-1', handlers: { 'task.completed': vi.fn(async () => {}) },
    lane: 'email-lane', journal: log,
  });
  expect(await worker.tick()).toMatchObject({ claimed: 1, acked: 1 });
  expect(traceSpan).toHaveBeenCalledWith('outbox-drain', expect.objectContaining({
    metadata: expect.objectContaining({ action: 'other', lane: 'email-lane' }),
  }), expect.any(Function));
  expect(log).toHaveBeenCalledWith('v2.outbox_tick', { claimed: 1, acked: 1, released: 0, parked: 0, lane: 'email-lane' });
  // The drain span keeps the row identity metadata (turnId) and no payload.
  expect(JSON.stringify(vi.mocked(traceSpan).mock.calls.map((call) => call[1]))).not.toContain('private content');
  await worker.stop();
});

it('covers each built-in/production dispatcher and bounds unknown persisted event names', async () => {
  expect([...OUTBOX_DISPATCH_VARIANTS]).toEqual([EMAIL_NOTIFICATION_EVENT, ADMIN_INVITATION_EVENT]);
  vi.mocked(claimOutboxBatch).mockResolvedValue([{ id: 'row-3', attempts: 0, eventType: 'private.name' } as StoredOutboxRow]);
  const worker = createOutboxWorker({ db: {} as Db, owner: 'test', handlers: {}, journal: vi.fn() });
  expect(await worker.tick()).toMatchObject({ noHandler: 1 });
  expect(traceSpan).toHaveBeenCalledWith('outbox-drain', expect.objectContaining({ detached: true, metadata: expect.objectContaining({ action: 'other' }) }), expect.any(Function));
  expect(recordObservationMetrics).toHaveBeenCalledWith(expect.arrayContaining([{ name: 'workflow.rejected', value: 1 }]));
  expect(JSON.stringify(vi.mocked(traceSpan).mock.calls)).not.toContain('private.name');
  await worker.stop();
});

it('counts every empty poll in a minute summary without operation latency samples', async () => {
  vi.mocked(claimOutboxBatch).mockResolvedValue([]);
  let now = 0;
  const worker = createOutboxWorker({ db: {} as Db, owner: 'test', handlers: {}, now: () => now, journal: vi.fn() });
  await worker.tick();
  await worker.tick();
  expect(traceSpan).not.toHaveBeenCalled();
  now = 60000;
  await worker.tick();
  expect(traceSpan).toHaveBeenCalledWith('outbox.poll-summary', expect.objectContaining({ detached: true }), expect.any(Function));
  expect(recordObservationMetrics).toHaveBeenCalledWith([{ name: 'workflow.polls.empty', value: 3 }]);
  await worker.tick();
  await worker.stop();
  expect(recordObservationMetrics).toHaveBeenLastCalledWith([{ name: 'workflow.polls.empty', value: 1 }]);
});
