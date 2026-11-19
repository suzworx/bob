// A timer firing is work done for its owner: the span and journal line carry their id and, for a timer
// set outside a conversation, their active conversation (source `active`, read in one batch for the
// sweep), like the reminder fanout. Real telemetry, in-memory exporter.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportedAttributes, otlpSpans } from '../support/memory-otlp.ts';

vi.mock('@opentelemetry/exporter-trace-otlp-proto', async () => ({
  OTLPTraceExporter: (await import('../support/memory-otlp.ts')).MemoryOtlpTraceExporter,
}));

import { flushTelemetry, initTelemetry } from '@bob/ai';
import { setActive } from '../../src/conversations/active.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { withUser } from '../../src/platform/db/db.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { telemetryConversationId } from '../../src/platform/observability/conversation-correlation.ts';
import { startTimerScheduler } from '../../src/timers/scheduler.ts';
import { createTimer } from '../../src/timers/store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const T0 = Date.parse('2030-01-01T12:00:00Z');
let pg: TestDb;
const lines: Array<Record<string, unknown>> = [];

beforeEach(async () => {
  initTelemetry();
  otlpSpans.reset();
  lines.length = 0;
  setJournalSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
  pg = await createTestDb();
});
afterEach(async () => {
  setJournalSink(null);
  await closeTestDb(pg).catch(() => undefined);
});

describe('timer fire correlation', () => {
  it('carries the owner and their active conversation on the span and the journal line', async () => {
    const { userId } = await addAccount(pg);
    const db = asDb(pg);
    const ref = (await createConversation(db, userId, 'Kitchen')).id;
    await withUser(db, userId, (tx) => setActive(tx, userId, ref, 'web_text'));
    const CONVERSATION = telemetryConversationId(ref);
    await createTimer(db, userId, { durationMs: 60_000, now: T0 });
    const scheduler = startTimerScheduler({ db, now: () => T0 + 60_000, setTimer: () => () => undefined, onFire: () => undefined, afterFire: () => undefined });
    await scheduler.reschedule();
    scheduler.stop();
    await flushTelemetry();
    expect(exportedAttributes('timer-fire')).toMatchObject({
      'user.id': userId, 'bob.conversation.id': CONVERSATION, 'gen_ai.conversation.id': CONVERSATION, 'bob.conversation.source': 'active',
    });
    expect(lines.find((line) => line.event === 'v2.timer_fired')).toMatchObject({
      user_id: userId, conversation_id: CONVERSATION, conversation_source: 'active',
    });
    // The sweep itself is system work.
    expect(exportedAttributes('timer-sweep')).toMatchObject({ 'bob.conversation.id': 'none' });
  });
});
