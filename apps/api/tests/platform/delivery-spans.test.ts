// Delivery workflows observe actual operations; journals retain exact delivery
// counts, while spans carry bounded outcomes and numeric duration/failure scores.
// Legacy notification companions remain metadata-only. Never export content,
// addresses, provider URLs or credentials.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { traceSpan, type ObservationMetricSample, type SpanAttrs } from '@bob/ai';

const spans = vi.hoisted(() => ({ calls: [] as Array<{
  name: string; attrs: SpanAttrs; result: Promise<unknown>; metrics: ObservationMetricSample[];
}> }));

vi.mock('@bob/ai', async (orig) => {
  const original = await orig<typeof import('@bob/ai')>();
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const active = new AsyncLocalStorage<(typeof spans.calls)[number]>();
  return {
    ...original,
    traceSpan: vi.fn((name: string, attrs: SpanAttrs, run: () => unknown) => {
      const result: Promise<unknown> = Promise.resolve().then(() => active.run(call, run));
      const call = { name, attrs: { ...attrs, metadata: { ...attrs.metadata } }, result, metrics: [] as ObservationMetricSample[] };
      spans.calls.push(call);
      return result;
    }),
    updateActiveSpanMetadata: vi.fn((metadata: Record<string, string>) => {
      const call = active.getStore();
      if (call) call.attrs.metadata = { ...call.attrs.metadata, ...metadata };
    }),
    recordObservationMetrics: vi.fn((samples: readonly ObservationMetricSample[]) => { active.getStore()?.metrics.push(...samples); }),
  };
});
vi.mock('../../src/platform/logger.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/platform/logger.ts')>()),
  ...(await import('../helpers/journal-mock.ts')).loggerMock(),
}));
vi.mock('../../src/platform/outbox/store.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/platform/outbox/store.ts')>()),
  claimOutboxBatch: vi.fn(async () => []), reclaimExpiredOutbox: vi.fn(),
  ackOutbox: vi.fn(async () => true), releaseOutbox: vi.fn(),
}));

import { claimOutboxBatch, type StoredOutboxRow } from '../../src/platform/outbox/store.ts';
import { createOutboxWorker } from '../../src/platform/outbox/worker.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { createReminderFanout } from '../../src/workflows/workflow-reminder-fire.ts';
import { createReminder, setRecipients } from '../../src/reminders/store.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createEmailNotificationHandler } from '../../src/notifications/email.ts';
import { EMAIL_NOTIFICATION_EVENT } from '../../src/notifications/store.ts';
import { EmailSendError, sendTemplateEmail } from '../../src/notifications/email-client.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { journal } from '../../src/platform/logger.ts';

function metadataOf(name: string): Record<string, string> | undefined {
  const call = spans.calls.find((c) => c.name === name);
  return call === undefined ? undefined : (call.attrs as { metadata?: Record<string, string> }).metadata;
}

function attrsOf(name: string): Record<string, unknown> {
  return (spans.calls.find((c) => c.name === name)?.attrs ?? {}) as Record<string, unknown>;
}

function metricsOf(name: string): ObservationMetricSample[] {
  return spans.calls.find((call) => call.name === name)?.metrics ?? [];
}

beforeEach(() => {
  spans.calls.length = 0;
  vi.mocked(traceSpan).mockClear();
  vi.mocked(journal).mockClear();
});

describe('reminder fanout spans', () => {
  let pg: TestDb;
  let db: Db;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
  });

  afterAll(async () => {
    await closeTestDb(pg).catch(() => undefined);
  });

  it('a tick with a due reminder emits reminder-fanout and notifications-enqueued with counts only', async () => {
    const owner = await addAccount(pg);
    const member = await addAccount(pg);
    const spaceId = (await createSpace(db, owner.userId, { kind: 'group', name: 'Family' })).id;
    await addMember(db, owner.userId, spaceId, member.userId, 'member');
    const due = Date.now() - 60_000;
    const reminder = await createReminder(db, owner.userId, spaceId, {
      title: 'water the plants', due: { kind: 'instant', at: due, zone: 'Asia/Kolkata' },
    });
    await setRecipients(db, owner.userId, reminder.id, [member.userId]);

    expect(await createReminderFanout({ db, announce: vi.fn(), now: () => due + 1_000 }).tick()).toBe(1);
    await Promise.allSettled(spans.calls.map((c) => c.result));

    expect(metadataOf('reminder-fanout')).toEqual({ workflow: 'reminder-fanout', outcome: 'ok' });
    expect(attrsOf('reminder-fanout')).toMatchObject({ detached: true });
    expect(metricsOf('reminder-fanout')).toEqual([
      { name: 'workflow.duration_ms', value: expect.any(Number) },
      { name: 'workflow.failed', value: 0 }, { name: 'workflow.rejected', value: 0 },
    ]);
    expect(journal).toHaveBeenCalledWith('v2.reminder_fanout', {
      due: 1, enqueued: 1, failed: 0, delivery_failed: 0, announced: 1, announce_failed: 0, stale: 0,
    });
    expect(metadataOf('notifications-enqueued')).toEqual({ type: 'reminder', count: '1', muted: '0' });
    // The recipient is the correlation key (`userId`); no id may appear anywhere else.
    const exported = JSON.stringify(spans.calls.map((c) => c.attrs), (key, value: unknown) => (key === 'userId' ? undefined : value));
    expect(spans.calls.find((c) => c.name === 'notification-deliver')?.attrs).toMatchObject({ userId: member.userId });
    for (const secret of ['water the plants', reminder.id, member.userId, owner.userId, spaceId]) {
      expect(exported).not.toContain(secret);
    }
  });
});

describe('outbox and email spans', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('a drained email.notification row emits outbox-tick and a skipped email-notification', async () => {
    const row = {
      id: 'row-1', attempts: 0, eventType: EMAIL_NOTIFICATION_EVENT, createdAt: Date.now(),
      effectKey: 'reminder:secret-key', payload: { to: 'maya@example.com' },
    } as unknown as StoredOutboxRow;
    vi.mocked(claimOutboxBatch).mockResolvedValueOnce([row]);
    const log = vi.fn();
    const worker = createOutboxWorker({
      db: {} as Db, owner: 'worker-1', journal: log,
      handlers: { [EMAIL_NOTIFICATION_EVENT]: createEmailNotificationHandler({ db: {} as Db, configured: () => false }) },
    });
    expect(await worker.tick()).toMatchObject({ claimed: 1, acked: 1 });
    await Promise.allSettled(spans.calls.map((c) => c.result));

    expect(metadataOf('email-notification')).toEqual({ outcome: 'skipped', reason: 'not_configured' });
    expect(metadataOf('outbox-tick')).toEqual({ workflow: 'outbox-tick', outcome: 'ok' });
    expect(attrsOf('outbox-tick')).toMatchObject({ detached: true, startTime: expect.any(Date) });
    expect(metricsOf('outbox-tick')).toEqual([
      { name: 'workflow.duration_ms', value: expect.any(Number) },
      { name: 'workflow.failed', value: 0 }, { name: 'workflow.rejected', value: 0 },
    ]);
    expect(log).toHaveBeenCalledWith('v2.outbox_tick', { claimed: 1, acked: 1, released: 0, parked: 0 });
    const exported = JSON.stringify(spans.calls.map((c) => c.attrs));
    expect(exported).not.toContain('maya@example.com');
    expect(exported).not.toContain('secret-key');
    await worker.stop();
  });

  it('an empty tick emits no outbox-tick span or journal line', async () => {
    const log = vi.fn();
    const worker = createOutboxWorker({ db: {} as Db, owner: 'worker-1', handlers: {}, journal: log });
    expect(await worker.tick()).toMatchObject({ claimed: 0 });
    expect(spans.calls.map((c) => c.name)).not.toContain('outbox-tick');
    expect(log).not.toHaveBeenCalledWith('v2.outbox_tick', expect.anything());
    await worker.stop();
  });

  it('observes the actual email send, retains journal status and propagates failures inside the span', async () => {
    vi.stubEnv('BOB_NOTIFY_EMAIL_URL', 'https://notify.invalid/functions/v1/notify-email');
    vi.stubEnv('BOB_NOTIFY_EMAIL_SECRET', 'test-secret');
    const input = { template: 'reminder-due', to: 'maya@example.com', data: { title: 'water the plants' } };

    vi.stubGlobal('fetch', vi.fn(async () => {
      expect(spans.calls.filter((call) => call.name === 'email-send')).toHaveLength(1);
      return new Response('{}', { status: 200 });
    }));
    await sendTemplateEmail(input);
    expect(metadataOf('email-send')).toEqual({ workflow: 'email-send', outcome: 'ok' });
    expect(metricsOf('email-send')).toContainEqual({ name: 'workflow.failed', value: 0 });
    expect(journal).toHaveBeenCalledWith('v2.email_sent', { template: 'reminder-due' });

    spans.calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    await expect(sendTemplateEmail(input)).rejects.toBeInstanceOf(EmailSendError);
    expect(metadataOf('email-send')).toEqual({ workflow: 'email-send', outcome: 'failed' });
    expect(metricsOf('email-send')).toEqual([
      { name: 'workflow.duration_ms', value: expect.any(Number) },
      { name: 'workflow.failed', value: 1 }, { name: 'workflow.rejected', value: 0 },
    ]);
    expect(journal).toHaveBeenCalledWith('v2.email_send_failed', { template: 'reminder-due', code: 'http_503' });
    // traceSpan marks a span ERROR when its work rejects: the failure must reject inside it.
    await expect(spans.calls.find((c) => c.name === 'email-send')?.result).rejects.toBeInstanceOf(EmailSendError);
    const exported = JSON.stringify(spans.calls.map((c) => c.attrs));
    for (const secret of ['maya@example.com', 'water the plants', 'notify.invalid', 'test-secret']) {
      expect(exported).not.toContain(secret);
    }
  });
});
