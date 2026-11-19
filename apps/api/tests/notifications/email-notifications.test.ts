// core/email-notifications.ts tests: the email.notification outbox handler
// against the real store on the local test stack, with sendTemplateEmail
// injected. Each notification type/effect_key maps to its catalog template with
// names (never addresses) and absolute app URLs; it skips (acks) when email is
// off, the recipient has no address, the notification is read or its resource
// is gone, and rethrows only a failed send. No journal line carries an address,
// a name or a title.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildNotificationMail, createEmailNotificationHandler } from '../../src/notifications/email.ts';
import { EmailSendError, appUrl } from '../../src/notifications/email-client.ts';
import { createOutboxWorker } from '../../src/platform/outbox/worker.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { createCalendar, createEvent, setAttendeeResponse } from '../../src/calendar/store.ts';
import { acceptInvitation, createInvitation } from '../../src/spaces/invitations.ts';
import { emailEffectKey, emailEffectSent, enqueueNotifications, listNotifications,
  markEmailEffectSent, markRead, type NewNotification } from '../../src/notifications/store.ts';
import { claimOutboxBatch, type StoredOutboxRow } from '../../src/platform/outbox/store.ts';
import { createReminder } from '../../src/reminders/store.ts';
import { addMember, createSpace, ensurePrivateSpace, type StoredSpace } from '../../src/spaces/store.ts';
import { createNote } from '../../src/notes/store.ts';
import { createTask } from '../../src/tasks/store.ts';
import { createThread, postMessage } from '../../src/conversations/thread-store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, withAdminAuth, type TestDb } from '../support/test-db.ts';

type Sent = { template: string; to: string; data: Record<string, unknown> };

let pg: TestDb;
let db: Db;
let maya: string;
let arjun: string;
let space: StoredSpace;
const sent: Sent[] = [];
const lines: string[] = [];
const APP = appUrl('/').replace(/\/$/, '');

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  maya = (await addAccount(pg)).userId;
  arjun = (await addAccount(pg)).userId;
  await withAdminAuth(pg, async (admin) => {
    await admin.setProfile(maya, { email: 'maya@example.com', name: 'Maya' });
    await admin.setProfile(arjun, { email: 'arjun@example.com', name: 'Arjun' });
  });
  space = await createSpace(db, maya, { kind: 'group', name: 'Home' });
  await addMember(db, maya, space.id, arjun, 'member');
  setJournalSink((line) => lines.push(line));
});

afterAll(async () => {
  setJournalSink(null);
  await closeTestDb(pg).catch(() => undefined);
});

beforeEach(() => {
  sent.length = 0;
  lines.length = 0;
});

/** The email notification handler, with the worker's AbortSignal defaulted to
 *  a live one: direct calls in these tests stand in for the worker, which
 *  always passes a signal (see #1322 S1). */
const handler = (options: { configured?: boolean; fail?: boolean; now?: () => number } = {}):
  (row: StoredOutboxRow, signal?: AbortSignal) => Promise<void> => {
  const inner = createEmailNotificationHandler({
    db,
    configured: () => options.configured ?? true,
    ...(options.now ? { now: options.now } : {}),
    send: async (input) => {
      if (options.fail) throw new EmailSendError('http_502');
      sent.push(input);
    },
  });
  return async (row, signal) => inner(row, signal ?? new AbortController().signal);
};

/** Enqueues one notification and returns the outbox row it produced. The
 *  outbox is FORCE RLS with no policies and the test connection is the
 *  nobypassrls bob_server role, so it is read through the claim definer. */
async function enqueue(row: NewNotification): Promise<StoredOutboxRow> {
  await enqueueNotifications(db, [row]);
  const key = emailEffectKey(row.recipientUserId, row.effectKey);
  // available_at is the database's now(); claim a minute ahead so a DB clock
  // slightly ahead of this process (CI's Docker) cannot hide a fresh row.
  const claimed = await claimOutboxBatch(db, { owner: 'test', limit: 1000, leaseMs: 60_000,
    now: Date.now() + 60_000 });
  const found = claimed.filter((r) => r.effectKey === key);
  expect(found).toHaveLength(1);
  expect(found[0]!.eventType).toBe('email.notification');
  return found[0]!;
}

function assertJournalPrivate(): void {
  const all = lines.join('\n');
  for (const secret of ['maya@example.com', 'arjun@example.com', 'Maya', 'Arjun', 'Home']) {
    expect(all).not.toContain(secret);
  }
}

describe('email notification handler: template mapping', () => {
  it('mention -> thread-mention to the mentioned member', async () => {
    const thread = await createThread(db, maya, { spaceId: space.id, title: 'Weekend' });
    const { message } = await postMessage(db, maya, {
      threadId: thread.id, body: 'Can you bring snacks @arjun?', clientMessageId: randomUUID() });
    await handler()(await enqueue({ recipientUserId: arjun, spaceId: space.id, type: 'mention',
      resourceType: 'thread', resourceId: thread.id, revision: message.sequence,
      effectKey: `mention:thread:${thread.id}:${message.sequence}` }));
    expect(sent).toEqual([{ template: 'thread-mention', to: 'arjun@example.com', data: {
      actorName: 'Maya', spaceName: 'Home', threadTitle: 'Weekend',
      excerpt: 'Can you bring snacks @arjun?',
      threadUrl: `${APP}/spaces/${space.id}/threads/${thread.id}`,
      manageUrl: `${APP}/settings#notifications` } }]);
    assertJournalPrivate();
  });

  it('assignment -> task-assigned with a due label', async () => {
    const task = await createTask(db, maya, space.id, { title: 'Buy milk', assigneeUserId: arjun,
      due: { kind: 'date', date: '2026-09-30' } });
    await handler()(await enqueue({ recipientUserId: arjun, spaceId: space.id, type: 'assignment',
      resourceType: 'task', resourceId: task.id, revision: task.revision,
      effectKey: `assignment:task:${task.id}:${task.revision}` }));
    expect(sent).toEqual([{ template: 'task-assigned', to: 'arjun@example.com', data: {
      actorName: 'Maya', spaceName: 'Home', taskTitle: 'Buy milk', dueLabel: 'Sep 30, 2026',
      taskUrl: `${APP}/spaces/${space.id}/tasks`, manageUrl: `${APP}/settings#notifications` } }]);
  });

  it('reminder -> reminder-due at the occurrence instant', async () => {
    const at = Date.UTC(2026, 9, 1, 9, 0);
    const reminder = await createReminder(db, maya, space.id, { title: 'Water plants',
      due: { kind: 'instant', at, zone: 'UTC' } });
    await handler()(await enqueue({ recipientUserId: arjun, spaceId: space.id, type: 'reminder',
      resourceType: 'reminder', resourceId: reminder.id, revision: reminder.scheduleRevision,
      effectKey: `reminder:${reminder.id}:${arjun}:${at}:${reminder.scheduleRevision}` }));
    expect(sent).toEqual([{ template: 'reminder-due', to: 'arjun@example.com', data: {
      title: 'Water plants', dueLabel: 'Oct 1, 2026, 9:00 AM UTC', spaceName: 'Home',
      url: `${APP}/today`, manageUrl: `${APP}/settings#notifications` } }]);
  });

  it('Bob message -> bob-message from the recipient-owned private note', async () => {
      const personalSpace = await ensurePrivateSpace(db, arjun);
      const note = await createNote(db, arjun, personalSpace.id, {
        title: 'Weekend plan',
        body: 'Pack a picnic.',
        aiAssisted: true,
      });
      await handler()(await enqueue({ recipientUserId: arjun, spaceId: personalSpace.id, type: 'bob_message',
        resourceType: 'note', resourceId: note.id, revision: note.revision,
        effectKey: `bob_message:note:${note.id}` }));
      expect(sent).toEqual([{ template: 'bob-message', to: 'arjun@example.com', data: {
        noteTitle: 'Weekend plan',
        noteBody: 'Pack a picnic.',
        noteUrl: `${APP}/spaces/${personalSpace.id}/notes?note=${note.id}`,
        manageUrl: `${APP}/settings#notifications`,
      } }]);
      expect(lines.join('\n')).not.toContain('Weekend plan');
      expect(lines.join('\n')).not.toContain('Pack a picnic.');
  });
});

describe('email notification handler: invitation, events, account', () => {
  it('invitation -> space-invite-accepted to the inviter, naming the new member', async () => {
    const lina = (await addAccount(pg)).userId;
    await withAdminAuth(pg, (admin) => admin.setProfile(lina, { email: 'lina@example.com', name: 'Lina' }));
    const { invitation, token } = await createInvitation(db, maya, space.id,
      { email: 'lina@example.com', role: 'member' });
    expect(await acceptInvitation(db, lina, token)).toBe('accepted');
    await handler()(await enqueue({ recipientUserId: maya, spaceId: space.id, type: 'invitation',
      resourceType: 'invitation', resourceId: invitation.id,
      effectKey: `invitation_accepted:${invitation.id}` }));
    expect(sent).toEqual([{ template: 'space-invite-accepted', to: 'maya@example.com', data: {
      memberName: 'Lina', spaceName: 'Home', spaceUrl: `${APP}/spaces/${space.id}`,
      manageUrl: `${APP}/settings#notifications` } }]);
  });

  it('a member-joined notice is inbox only: no space-invite-accepted mail to other members (#858)', async () => {
    const omar = (await addAccount(pg)).userId;
    await withAdminAuth(pg, (admin) => admin.setProfile(omar, { email: 'omar@example.com', name: 'Omar' }));
    const { invitation, token } = await createInvitation(db, maya, space.id,
      { email: 'omar@example.com', role: 'member' });
    expect(await acceptInvitation(db, omar, token)).toBe('accepted');
    await handler()(await enqueue({ recipientUserId: arjun, spaceId: space.id, type: 'invitation',
      resourceType: 'space_member', resourceId: omar, effectKey: `member_joined:${invitation.id}` }));
    expect(sent).toEqual([]);
    expect(lines.some((line) => line.includes('inbox_only'))).toBe(true);
  });

  it('event_invited / event_updated / event_rsvp -> the matching event template', async () => {
    const calendar = await createCalendar(db, maya, space.id, { name: 'Family', zone: 'UTC' });
    const startAt = Date.UTC(2026, 9, 3, 18, 30);
    const event = await createEvent(db, maya, calendar.id, { title: 'Dinner', location: 'Cafe',
      allDay: false, startAt, endAt: startAt + 3_600_000, zone: 'UTC',
      attendees: [{ userId: arjun, role: 'required' }] });
    const eventRow = (recipientUserId: string, effectKey: string): NewNotification => ({
      recipientUserId, spaceId: space.id, type: 'event_change', resourceType: 'event',
      resourceId: event.id, revision: event.revision, effectKey });
    const whenLabel = 'Oct 3, 2026, 6:30 PM UTC';
    const eventUrl = `${APP}/spaces/${space.id}/agenda`;

    await handler()(await enqueue(eventRow(arjun, `event_invited:${event.id}:${arjun}`)));
    await handler()(await enqueue(eventRow(arjun, `event_updated:${event.id}:${event.revision}`)));
    await setAttendeeResponse(db, arjun, event.id, 'accepted');
    await handler()(await enqueue(eventRow(maya, `event_rsvp:${event.id}:${arjun}:accepted`)));

    expect(sent.map((m) => [m.template, m.to])).toEqual([
      ['event-invited', 'arjun@example.com'],
      ['event-updated', 'arjun@example.com'],
      ['event-rsvp', 'maya@example.com'],
    ]);
    expect(sent[0]!.data).toEqual({ eventTitle: 'Dinner', whenLabel, spaceName: 'Home',
      organizerName: 'Maya', location: 'Cafe', eventUrl, manageUrl: `${APP}/settings#notifications` });
    expect(sent[1]!.data).toMatchObject({ actorName: 'Maya', eventTitle: 'Dinner', whenLabel, eventUrl });
    expect(sent[1]!.data.changesLabel).toEqual(expect.any(String));
    expect(sent[2]!.data).toEqual({ attendeeName: 'Arjun', eventTitle: 'Dinner',
      response: 'accepted', eventUrl, manageUrl: `${APP}/settings#notifications` });
    assertJournalPrivate();
  });
});

// The account mappings run against a fake Db: on the local test stack the
// authenticated role has no USAGE on schema auth, so addGoogleAccount's direct
// auth.uid() call cannot seed a row there (reported, outside this unit).
describe('email notification handler: account mappings (fake Db)', () => {
  const googleId = randomUUID();
  const deviceId = randomUUID();
  function fakeDb(tables: { google?: boolean; device?: 'active' | 'revoked' }): Db {
    const fake: Db = {
      async query<T>(sql: string): Promise<T[]> {
        if (sql.includes('bob.google_accounts') && tables.google) {
          return [{ id: googleId, installation_id: 'i', provider_account_id: 'g', email: 'arjun.g@example.com',
            name: null, selected: true, created_at: new Date() }] as T[];
        }
        if (sql.includes('bob.devices') && tables.device !== undefined) {
          if (sql.includes('revoked_at is null') && tables.device === 'revoked') return [];
          return [{ id: deviceId, name: 'Kitchen Cardputer', model: 'cardputer',
            paired_at: new Date(), last_seen_at: null }] as T[];
        }
        return [];
      },
      tx: (fn) => fn(fake),
    };
    return fake;
  }
  const security = (effectKey: string, resourceId: string): Parameters<typeof buildNotificationMail>[1] => ({
    id: randomUUID(), recipientUserId: randomUUID(), spaceId: null, type: 'security',
    resourceType: 'account', resourceId, revision: 1, effectKey, cursor: 1, readAt: null, createdAt: 0 });

  it('google_linked -> google-account-linked; a deleted account is skipped', async () => {
    expect(await buildNotificationMail(fakeDb({ google: true }), security(`google_linked:${googleId}:1`, googleId)))
      .toEqual({ template: 'google-account-linked',
        data: { googleEmail: 'arjun.g@example.com', manageUrl: `${APP}/integrations` } });
    expect(await buildNotificationMail(fakeDb({}), security(`google_linked:${googleId}:1`, googleId))).toBeNull();
  });

  it('google_unlinked acks without sending, even when the row is still readable', async () => {
    // web-google-accounts.ts sends google-account-unlinked directly at unlink time.
    expect(await buildNotificationMail(fakeDb({ google: true }), security(`google_unlinked:${googleId}:2`, googleId)))
      .toBeNull();
    expect(await buildNotificationMail(fakeDb({}), security(`google_unlinked:${googleId}:2`, googleId))).toBeNull();
  });

  it('device_paired / device_removed -> the device templates', async () => {
    expect(await buildNotificationMail(fakeDb({ device: 'active' }), security(`device_paired:${deviceId}:1`, deviceId)))
      .toEqual({ template: 'device-paired',
        data: { deviceName: 'Kitchen Cardputer', manageUrl: `${APP}/devices` } });
    expect(await buildNotificationMail(fakeDb({ device: 'revoked' }), security(`device_removed:${deviceId}:2`, deviceId)))
      .toEqual({ template: 'device-removed', data: { deviceName: 'Kitchen Cardputer' } });
    expect(await buildNotificationMail(fakeDb({}), security(`device_removed:${deviceId}:2`, deviceId))).toBeNull();
  });
});

describe('email notification handler: skips and failures', () => {
  async function taskRow(recipientUserId = arjun): Promise<StoredOutboxRow> {
    const task = await createTask(db, maya, space.id, { title: 'Sweep', assigneeUserId: recipientUserId });
    return enqueue({ recipientUserId, spaceId: space.id, type: 'assignment', resourceType: 'task',
      resourceId: task.id, revision: task.revision, effectKey: `assignment:task:${task.id}:${task.revision}` });
  }
  const skipped = (): string[] => lines.map((l) => JSON.parse(l) as { event: string; reason?: string })
    .filter((e) => e.event === 'v2.email_notification_skipped').map((e) => e.reason ?? '');

  it('acks without sending when email is not configured', async () => {
    await handler({ configured: false })(await taskRow());
    expect(sent).toHaveLength(0);
    expect(skipped()).toEqual(['not_configured']);
  });

  it('acks when the recipient has no address', async () => {
    const noMail = (await addAccount(pg)).userId;
    await addMember(db, maya, space.id, noMail, 'member');
    await handler()(await taskRow(noMail));
    expect(sent).toHaveLength(0);
    expect(skipped()).toEqual(['no_address']);
  });

  it('acks when the notification was already read', async () => {
    const row = await taskRow();
    const [latest] = await listNotifications(db, arjun, { limit: 1 });
    await markRead(db, arjun, { ids: [latest!.id] });
    await handler()(row);
    expect(sent).toHaveLength(0);
    expect(skipped()).toEqual(['read']);
  });

  it('acks when the resource is gone', async () => {
    const id = randomUUID();
    await handler()(await enqueue({ recipientUserId: arjun, spaceId: space.id, type: 'assignment',
      resourceType: 'task', resourceId: id, effectKey: `assignment:task:${id}:1` }));
    expect(sent).toHaveLength(0);
    expect(skipped()).toEqual(['gone']);
  });

  it('acks without sending a notification older than 24 h (stale), and still mails one just inside it', async () => {
    const DAY = 24 * 60 * 60_000;
    const old = await taskRow();
    await handler({ now: () => old.createdAt + DAY + 60_000 })(old);
    expect(sent).toHaveLength(0);
    expect(skipped()).toEqual(['stale']);

    const recent = await taskRow();
    await handler({ now: () => recent.createdAt + DAY - 60_000 })(recent);
    expect(sent.map((m) => m.template)).toEqual(['task-assigned']);
  });

  it('throws when the send fails, so the worker retries', async () => {
    await expect(handler({ fail: true })(await taskRow())).rejects.toBeInstanceOf(EmailSendError);
  });
});

describe('email notification handler: exactly once (#506)', () => {
  it('a sibling reclaiming a row whose sender died before the ack does not mail again', async () => {
    const ravi = (await addAccount(pg)).userId;
    await withAdminAuth(pg, (admin) => admin.setProfile(ravi, { email: 'ravi@example.com', name: 'Ravi' }));
    await addMember(db, maya, space.id, ravi, 'member');
    const task = await createTask(db, maya, space.id, { title: 'Rake', assigneeUserId: ravi });
    let sends = 0;
    const counting = createEmailNotificationHandler({ db, configured: () => true,
      send: async (input) => {
        if (input.to === 'ravi@example.com') sends += 1;
      } });
    // Worker A leases the row and sends, then dies before its ack.
    const row = await enqueue({ recipientUserId: ravi, spaceId: space.id, type: 'assignment',
      resourceType: 'task', resourceId: task.id, revision: task.revision,
      effectKey: `assignment:task:${task.id}:${task.revision}` });
    await counting(row, new AbortController().signal);
    expect(sends).toBe(1);
    // Worker B runs after A's lease expired: it reclaims, re-runs and acks.
    const later = Date.now() + 10 * 60_000;
    const sibling = createOutboxWorker({ db, owner: 'sibling', batchSize: 1000,
      handlers: { 'email.notification': counting }, now: () => later });
    const result = await sibling.tick();
    expect(result.claimed).toBeGreaterThan(0);
    expect(sends).toBe(1);
    expect(lines.some((l) => l.includes('"already_sent"'))).toBe(true);
    // Acked: nothing left for a third worker to claim.
    const again = await claimOutboxBatch(db, { owner: 'third', limit: 1000, leaseMs: 60_000,
      now: later + 60_000 });
    expect(again.filter((r) => r.id === row.id)).toHaveLength(0);
    assertJournalPrivate();
  });

  it('a failed send records nothing, so the retry still mails', async () => {
    const task = await createTask(db, maya, space.id, { title: 'Mop', assigneeUserId: arjun });
    const row = await enqueue({ recipientUserId: arjun, spaceId: space.id, type: 'assignment',
      resourceType: 'task', resourceId: task.id, revision: task.revision,
      effectKey: `assignment:task:${task.id}:${task.revision}` });
    await expect(handler({ fail: true })(row)).rejects.toBeInstanceOf(EmailSendError);
    expect(await emailEffectSent(db, row.effectKey)).toBe(false);
    await handler()(row);
    expect(sent).toHaveLength(1);
    expect(await emailEffectSent(db, row.effectKey)).toBe(true);
    await handler()(row);
    expect(sent).toHaveLength(1);
  });

  it('the sent marker is idempotent and never readable by an account', async () => {
    const row = await enqueue({ recipientUserId: arjun, spaceId: space.id, type: 'assignment',
      resourceType: 'task', resourceId: randomUUID(), effectKey: `assignment:task:${randomUUID()}:1` });
    expect(await markEmailEffectSent(db, row.effectKey, arjun)).toBe(true);
    expect(await markEmailEffectSent(db, row.effectKey, arjun)).toBe(false);
    await expect(withUser(db, arjun, (tx) => tx.query('SELECT email_sent_at, recipient_user_id FROM bob.outbox')))
      .rejects.toThrow();
  });
});
