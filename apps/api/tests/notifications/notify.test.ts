// core/notify.ts delivery outcomes (#507). deliver() tells 'delivered',
// 'muted' and 'failed' apart, so the reminder fanout retries only a failure; a
// failure is journaled with an enum reason and never content; a snoozed
// re-delivery is its own inbox item. (Event cancel: web-calendars.test.ts;
// every type's mute: notify-types.test.ts.)
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as notificationProducers from '../../src/notifications/notify.ts';
import { notifyReminderDue, type DeliveryOutcome } from '../../src/notifications/notify.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { type Db } from '../../src/platform/db/db.ts';
import { emailEffectKey, listNotifications, upsertPreference, type NotificationType } from '../../src/notifications/store.ts';
import { claimOutboxBatch } from '../../src/platform/outbox/store.ts';
import { createNote } from '../../src/notes/store.ts';
import { occurrenceEffectKey, type OccurrenceKey } from '../../src/reminders/store.ts';
import { addMember, createSpace, ensurePrivateSpace } from '../../src/spaces/store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
let owner: TestAccount;
let spaceId: string;
const lines: string[] = [];

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  owner = await addAccount(pg);
  spaceId = (await createSpace(db, owner.userId, { kind: 'group', name: 'Family' })).id;
  setJournalSink((line) => lines.push(line));
});

afterEach(() => {
  lines.length = 0;
});

afterAll(async () => {
  setJournalSink(null);
  await closeTestDb(pg).catch(() => undefined);
});

async function freshMember(): Promise<TestAccount> {
  const account = await addAccount(pg);
  await addMember(db, owner.userId, spaceId, account.userId, 'member');
  return account;
}

/** A Db that fails any SQL (inside a transaction too) containing `marker`. */
function failingDb(marker: string): Db {
  return wrap(db, marker);
}

function wrap(inner: Db, marker: string): Db {
  return {
    query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (sql.includes(marker)) return Promise.reject(new Error('injected failure'));
      return inner.query<T>(sql, params);
    },
    tx<T>(fn: (txDb: Db) => Promise<T>): Promise<T> {
      return inner.tx((tx) => fn(wrap(tx, marker)));
    },
  };
}

function occurrence(userId: string): OccurrenceKey {
  return { reminderId: randomUUID(), userId, occurrenceAt: Date.now(), scheduleRevision: 1 };
}

function journaled(event: string): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === event);
}

const notifyBobMessage = (notificationProducers as typeof notificationProducers & {
  notifyBobMessage?: (db: Db, recipientUserId: string, noteId: string, effectKey: string) => Promise<DeliveryOutcome>;
}).notifyBobMessage;
const bobMessageType = 'bob_message' as NotificationType;

function requireBobMessageNotifier(): NonNullable<typeof notifyBobMessage> {
  expect(notifyBobMessage, 'notifyBobMessage is part of the notification producer API').toBeTypeOf('function');
  return notifyBobMessage!;
}

describe('notifyReminderDue outcomes (#507)', () => {
  it('delivered: one row, keyed by the occurrence', async () => {
    const recipient = await freshMember();
    const key = occurrence(recipient.userId);
    expect(await notifyReminderDue(db, key, spaceId)).toEqual({ status: 'delivered', enqueued: 1, muted: 0 });
    const rows = await listNotifications(db, recipient.userId, { limit: 10 });
    expect(rows.map((row) => row.effectKey)).toEqual([occurrenceEffectKey(key)]);
  });

  it('muted: nothing enqueued, and it is not a failure', async () => {
    const recipient = await freshMember();
    await upsertPreference(db, recipient.userId, { type: 'reminder', muted: true });
    expect(await notifyReminderDue(db, occurrence(recipient.userId), spaceId))
      .toEqual({ status: 'muted', enqueued: 0, muted: 1 });
    expect(journaled('v2.notifications_enqueue_failed')).toHaveLength(0);
  });

  it.each([
    ['notifications_enqueue', 'enqueue_failed'],
    ['notification_preferences', 'preferences_unreadable'],
  ])('failed when %s fails: outcome reason %s, journaled with no content', async (marker, reason) => {
    const recipient = await freshMember();
    const outcome = await notifyReminderDue(failingDb(marker), occurrence(recipient.userId), spaceId);
    expect(outcome).toEqual({ status: 'failed', reason });
    expect(journaled('v2.notifications_enqueue_failed')).toEqual([
      { ts: expect.any(String), level: 'error', message: 'v2.notifications_enqueue_failed', source: 'api', module: 'notifications', conversation_id: 'none', conversation_source: 'none',
        event: 'v2.notifications_enqueue_failed', type: 'reminder', count: 1 },
    ]);
    expect(await listNotifications(db, recipient.userId, { limit: 10 })).toHaveLength(0);
  });

  it('a snoozed re-delivery is a distinct inbox item', async () => {
    const recipient = await freshMember();
    const key = occurrence(recipient.userId);
    await notifyReminderDue(db, key, spaceId);
    await notifyReminderDue(db, { ...key, snoozedUntil: key.occurrenceAt + 600_000 }, spaceId);
    const keys = (await listNotifications(db, recipient.userId, { limit: 10 })).map((row) => row.effectKey);
    expect(keys.sort()).toEqual([occurrenceEffectKey(key),
      `${occurrenceEffectKey(key)}:snooze:${key.occurrenceAt + 600_000}`].sort());
  });
});

describe('notifyBobMessage delivery', () => {
  it('enqueues the recipient-owned note once to the inbox and email outbox', async () => {
    const recipient = await freshMember();
    const personalSpace = await ensurePrivateSpace(db, recipient.userId);
    const note = await createNote(db, recipient.userId, personalSpace.id, {
      title: 'Bob note: weekend plan',
      body: 'The picnic is Saturday.',
      aiAssisted: true,
    });

    const notify = requireBobMessageNotifier();
    const effectKey = `bob_message:note:${note.id}`;
    await expect(notify(db, recipient.userId, note.id, effectKey))
      .resolves.toEqual({ status: 'delivered', enqueued: 1, muted: 0 });
    await notify(db, recipient.userId, note.id, effectKey);

    const rows = await listNotifications(db, recipient.userId, { limit: 10 });
    expect(rows).toMatchObject([{
      type: bobMessageType,
      resourceType: 'note',
      resourceId: note.id,
      effectKey,
    }]);
    expect(rows).toHaveLength(1);

    const mailed = await claimOutboxBatch(db, {
      owner: `bob-message-test-${randomUUID()}`,
      limit: 1000,
      leaseMs: 60_000,
      now: Date.now() + 60_000,
    });
    const emailRows = mailed.filter((row) =>
      row.effectKey === emailEffectKey(recipient.userId, `bob_message:note:${note.id}`));
    expect(emailRows).toHaveLength(1);
    expect(emailRows[0]!.eventType).toBe('email.notification');
  });

  it('does not notify for a note owned by another member or a note hidden by RLS', async () => {
    const owner = await freshMember();
    const recipient = await freshMember();
    const ownerSpace = await ensurePrivateSpace(db, owner.userId);
    const ownerNote = await createNote(db, owner.userId, ownerSpace.id, { title: 'Owner only', body: 'Private text.' });

    const notify = requireBobMessageNotifier();
    await expect(notify(db, recipient.userId, ownerNote.id, `bob_message:note:${ownerNote.id}`))
      .resolves.toEqual({ status: 'none' });
    const missingId = randomUUID();
    await expect(notify(db, recipient.userId, missingId, `bob_message:note:${missingId}`))
      .resolves.toEqual({ status: 'none' });
    await expect(listNotifications(db, recipient.userId, { limit: 10 })).resolves.toHaveLength(0);
  });

  it('does not point at a shared-space note, even when the recipient authored it', async () => {
    const recipient = await freshMember();
    const note = await createNote(db, recipient.userId, spaceId, { title: 'Shared note', body: 'Not personal.' });
    const notify = requireBobMessageNotifier();

    await expect(notify(db, recipient.userId, note.id, `bob_message:note:${note.id}`))
      .resolves.toEqual({ status: 'none' });
    await expect(listNotifications(db, recipient.userId, { limit: 10 })).resolves.toHaveLength(0);
  });

  it('suppresses a muted Bob note without making it retryable', async () => {
    const recipient = await freshMember();
    const personalSpace = await ensurePrivateSpace(db, recipient.userId);
    const note = await createNote(db, recipient.userId, personalSpace.id, {
      title: 'Bob note', body: 'Hello.', aiAssisted: true,
    });
    const humanNote = await createNote(db, recipient.userId, personalSpace.id, {
      title: 'Personal note', body: 'Written by the recipient.',
    });
    await upsertPreference(db, recipient.userId, { type: bobMessageType, muted: true });

    const notify = requireBobMessageNotifier();
    await expect(notify(db, recipient.userId, note.id, `bob_message:note:${note.id}`))
      .resolves.toEqual({ status: 'muted', enqueued: 0, muted: 1 });
    await expect(notify(db, recipient.userId, humanNote.id, `bob_message:note:${humanNote.id}`))
      .resolves.toEqual({ status: 'none' });
    await expect(listNotifications(db, recipient.userId, { limit: 10 })).resolves.toHaveLength(0);
    expect(journaled('v2.notifications_enqueue_failed')).toHaveLength(0);
  });

  it.each([
    ['notification_preferences', 'preferences_unreadable'],
    ['notifications_enqueue', 'enqueue_failed'],
  ])('returns retryable failure when %s fails, without journaling note content', async (marker, reason) => {
    const recipient = await freshMember();
    const personalSpace = await ensurePrivateSpace(db, recipient.userId);
    const note = await createNote(db, recipient.userId, personalSpace.id, {
      title: 'CONTENT_TITLE_MUST_NOT_BE_JOURNALED',
      body: 'CONTENT_BODY_MUST_NOT_BE_JOURNALED',
      aiAssisted: true,
    });

    const notify = requireBobMessageNotifier();
    await expect(notify(failingDb(marker), recipient.userId, note.id, `bob_message:note:${note.id}`))
      .resolves.toEqual({ status: 'failed', reason });
    expect(journaled('v2.notifications_enqueue_failed')).toMatchObject([
      { type: bobMessageType, count: 1 },
    ]);
    expect(lines.join('\n')).not.toContain('CONTENT_TITLE_MUST_NOT_BE_JOURNALED');
    expect(lines.join('\n')).not.toContain('CONTENT_BODY_MUST_NOT_BE_JOURNALED');
  });
});
