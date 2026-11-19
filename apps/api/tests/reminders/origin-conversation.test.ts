// Background work carries the conversation it came from (#880): a reminder or timer created inside
// conversation A fires attributed to A (source `explicit`) even after the owner moved to B; a row with no
// originating conversation falls back to the owner's active one (source `active`); and a fan-out resolves
// every fallback in ONE read, never a lookup per job. Real telemetry, in-memory exporter, real database.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { otlpSpans } from '../support/memory-otlp.ts';

vi.mock('@opentelemetry/exporter-trace-otlp-proto', async () => ({
  OTLPTraceExporter: (await import('../support/memory-otlp.ts')).MemoryOtlpTraceExporter,
}));

import { flushTelemetry, initTelemetry, withCorrelation } from '@bob/ai';
import { setActive } from '../../src/conversations/active.ts';
import { createConversation } from '../../src/conversations/store.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { withUser } from '../../src/platform/db/db.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { setActiveConversationReader, telemetryConversationId } from '../../src/platform/observability/conversation-correlation.ts';
import { createReminderFanout } from '../../src/workflows/workflow-reminder-fire.ts';
import { createReminder } from '../../src/reminders/store.ts';
import { ensurePrivateSpace } from '../../src/spaces/store.ts';
import { startTimerScheduler } from '../../src/timers/scheduler.ts';
import { createTimer } from '../../src/timers/store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
const lines: Array<Record<string, unknown>> = [];
/** The per-span fallback lookup: a fan-out that batched its reads never calls it. */
const spanLookup = vi.fn(async (): Promise<string | null> => null);

beforeAll(async () => {
  initTelemetry();
  pg = await createTestDb();
  db = asDb(pg);
});
afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});
beforeEach(() => {
  otlpSpans.reset();
  lines.length = 0;
  spanLookup.mockClear();
  setJournalSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
  setActiveConversationReader(spanLookup);
});
afterEach(() => {
  setJournalSink(null);
  setActiveConversationReader(undefined);
});

/** An account with two conversations, A then B; returns their telemetry ids. */
async function accountWithConversations(): Promise<{ userId: string; a: string; b: string; refA: string; refB: string }> {
  const { userId } = await addAccount(pg);
  const refA = (await createConversation(db, userId, 'A')).id;
  const refB = (await createConversation(db, userId, 'B')).id;
  return { userId, a: telemetryConversationId(refA), b: telemetryConversationId(refB), refA, refB };
}

async function activate(userId: string, ref: string): Promise<void> {
  await withUser(db, userId, (tx) => setActive(tx, userId, ref, 'web_text'));
}

/** A one-shot reminder for the owner, due a second ago, created inside `conversation` when given. */
async function dueReminder(userId: string, conversation?: string): Promise<string> {
  const space = await ensurePrivateSpace(db, userId);
  const create = () => createReminder(db, userId, space.id, {
    title: 'water the plants', due: { kind: 'instant', at: Date.now() - 1000, zone: 'UTC' }, recipients: [userId],
  });
  const reminder = conversation === undefined ? await create()
    : await withCorrelation({ userId, conversationId: conversation, conversationSource: 'explicit' }, create);
  return reminder.id;
}

function deliverSpans(userId: string): Array<Record<string, unknown>> {
  return otlpSpans.getFinishedSpans()
    .filter((span) => span.name === 'notification-deliver' && span.attributes['user.id'] === userId)
    .map((span) => span.attributes);
}

const fanout = () => createReminderFanout({ db, announce: () => undefined });

describe('reminder fan-out attribution', () => {
  it('a reminder created in conversation A fires attributed to A even after the owner moved to B', async () => {
    const { userId, a, b, refA, refB } = await accountWithConversations();
    await activate(userId, refA);
    await dueReminder(userId, a);
    await activate(userId, refB);
    await fanout().tick();
    await flushTelemetry();
    const spans = deliverSpans(userId);
    expect(spans.length).toBeGreaterThan(0);
    for (const attrs of spans) expect(attrs).toMatchObject({ 'bob.conversation.id': a, 'bob.conversation.source': 'explicit' });
    expect(lines.find((line) => line.event === 'v2.notifications_enqueued' && line.user_id === userId))
      .toMatchObject({ conversation_id: a, conversation_source: 'explicit' });
    expect(b).not.toBe(a);
  });

  it('a reminder with no originating conversation falls back to the owner active one', async () => {
    const { userId, b, refB } = await accountWithConversations();
    await dueReminder(userId);
    await activate(userId, refB);
    await fanout().tick();
    await flushTelemetry();
    const spans = deliverSpans(userId);
    expect(spans.length).toBeGreaterThan(0);
    for (const attrs of spans) expect(attrs).toMatchObject({ 'bob.conversation.id': b, 'bob.conversation.source': 'active' });
  });

  it('a fan-out of N fallback jobs reads the active conversations once', async () => {
    const owners = await Promise.all([1, 2, 3].map(() => accountWithConversations()));
    for (const owner of owners) {
      await dueReminder(owner.userId);
      await activate(owner.userId, owner.refB);
    }
    const reads: string[] = [];
    const counted: Db = {
      query: (sql, params) => { if (sql.includes('active_conversation')) reads.push(sql); return db.query(sql, params); },
      tx: (fn) => db.tx(fn),
    };
    await createReminderFanout({ db: counted, announce: () => undefined }).tick();
    await flushTelemetry();
    expect(reads).toHaveLength(1);
    expect(spanLookup).not.toHaveBeenCalled();
    for (const owner of owners) {
      expect(deliverSpans(owner.userId)[0]).toMatchObject({ 'bob.conversation.id': owner.b, 'bob.conversation.source': 'active' });
    }
  });
});

describe('timer attribution', () => {
  it('a timer set in conversation A fires attributed to A even after the owner moved to B', async () => {
    const { userId, a, refA, refB } = await accountWithConversations();
    await activate(userId, refA);
    const T0 = Date.now();
    await withCorrelation({ userId, conversationId: a, conversationSource: 'device' }, () => createTimer(db, userId, { durationMs: 60_000, now: T0 }));
    await activate(userId, refB);
    const scheduler = startTimerScheduler({ db, now: () => T0 + 60_000, setTimer: () => () => undefined, onFire: () => undefined, afterFire: () => undefined });
    await scheduler.reschedule();
    scheduler.stop();
    await flushTelemetry();
    const fired = otlpSpans.getFinishedSpans().find((span) => span.name === 'timer-fire' && span.attributes['user.id'] === userId);
    expect(fired?.attributes).toMatchObject({ 'bob.conversation.id': a, 'bob.conversation.source': 'explicit' });
    expect(lines.find((line) => line.event === 'v2.timer_fired' && line.user_id === userId))
      .toMatchObject({ conversation_id: a, conversation_source: 'explicit' });
    expect(spanLookup).not.toHaveBeenCalled();
  });
});
