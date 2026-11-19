// One table over every NotificationType (#127 criterion 2): each type's real
// producer runs for a recipient with no mute, a type mute and a global mute.
// An unmuted type produces exactly one row, a muted one nothing -- except
// 'security', which gets through every mute (criterion 1). The producer table
// is a Record over NotificationType, so a new type fails to compile until it
// is covered here.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as notificationProducers from '../../src/notifications/notify.ts';
import {
  notifyEventAttendeesAdded,
  notifyReminderDue,
  notifySecurityEvent,
  notifyTaskAssigned,
  notifyTaskFollowers,
  notifyThreadMentions,
} from '../../src/notifications/notify.ts';
import { notifyInvitationAccepted } from '../../src/workflows/workflow-space-invitation.ts';
import type { StoredEvent } from '../../src/calendar/store.ts';
import { type Db } from '../../src/platform/db/db.ts';
import { createNote } from '../../src/notes/store.ts';
import { acceptInvitation, createInvitation } from '../../src/spaces/invitations.ts';
import {
  listNotifications,
  NOTIFICATION_TYPES,
  upsertPreference,
  type NotificationPreferenceInput,
  type NotificationType,
} from '../../src/notifications/store.ts';
import { addMember, createSpace, ensurePrivateSpace, listMembers } from '../../src/spaces/store.ts';
import { addSubscriber, createTask, type StoredTask } from '../../src/tasks/store.ts';
import type { StoredThreadMessage } from '../../src/conversations/thread-store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, withAdminAuth, type TestAccount,
  type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
let actor: TestAccount;
let spaceId: string;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  actor = await addAccount(pg);
  spaceId = (await createSpace(db, actor.userId, { kind: 'group', name: 'Family' })).id;
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

/** Each type's producer, run by `actor` for `recipient` (an admin of the space). */
const PRODUCERS: Record<NotificationType, (recipient: string) => Promise<void>> = {
  mention: async (recipient) => {
    const members = await listMembers(db, actor.userId, spaceId);
    const handle = members.find((member) => member.userId === recipient)!.handle;
    await notifyThreadMentions(db, actor.userId, { id: randomUUID(), threadId: randomUUID(), spaceId,
      authorUserId: actor.userId, body: `ping @${handle}`, sequence: 1 } as StoredThreadMessage);
  },
  assignment: async (recipient) => {
    await notifyTaskAssigned(db, actor.userId, { id: randomUUID(), spaceId, assigneeUserId: recipient,
      trashedAt: null, revision: 1 } as StoredTask, null);
  },
  reminder: async (recipient) => {
    await notifyReminderDue(db, { reminderId: randomUUID(), userId: recipient, occurrenceAt: Date.now(),
      scheduleRevision: 1 }, spaceId);
  },
  event_change: async (recipient) => {
    await notifyEventAttendeesAdded(db, actor.userId, { id: randomUUID(), spaceId,
      organizerUserId: actor.userId, revision: 1 } as StoredEvent, [recipient]);
  },
  invitation: async (recipient) => {
    const accepter = await addAccount(pg);
    const email = `${randomUUID()}@example.com`;
    await withAdminAuth(pg, (admin) => admin.setProfile(accepter.userId, { email }));
    const { token } = await createInvitation(db, recipient, spaceId, { email, role: 'member' });
    expect(await acceptInvitation(db, accepter.userId, token)).toBe('accepted');
    await notifyInvitationAccepted(db, accepter.userId, token);
  },
  security: async (recipient) => {
    await notifySecurityEvent(db, recipient, 'device_paired', randomUUID(), 1);
  },
  task_update: async (recipient) => {
    const task = await createTask(db, actor.userId, spaceId, { title: 'Follow me' });
    await addSubscriber(db, actor.userId, task.id, recipient);
    await notifyTaskFollowers(db, actor.userId, task);
  },
  bob_message: async (recipient) => {
    const space = await ensurePrivateSpace(db, recipient);
    const note = await createNote(db, recipient, space.id, { title: 'Bob note', body: 'Hello.', aiAssisted: true });
    const notify = (notificationProducers as typeof notificationProducers & {
      notifyBobMessage?: (db: Db, userId: string, noteId: string, effectKey: string) => Promise<unknown>;
    }).notifyBobMessage;
    expect(notify, 'notifyBobMessage is part of the notification producer API').toBeTypeOf('function');
    await notify!(db, recipient, note.id, `bob_message:note:${note.id}`);
  },
};

type MuteMode = 'none' | 'type' | 'global';

function mutes(mode: MuteMode, type: NotificationType): NotificationPreferenceInput[] {
  if (mode === 'type') return [{ type, muted: true }];
  if (mode === 'global') return [{ muted: true }];
  return [];
}

const CASES = NOTIFICATION_TYPES.flatMap((type) =>
  (['none', 'type', 'global'] as const).map((mode) => ({
    type, mode, expected: mode === 'none' || type === 'security' ? 1 : 0,
  })));

describe('every NotificationType honours its mute (#127)', () => {
  it('registers Bob messages as a notification type with an explicit producer', () => {
    expect(NOTIFICATION_TYPES).toContain('bob_message');
    expect(PRODUCERS).toHaveProperty('bob_message');
  });

  it('the table covers every type in all three mute modes', () => {
    expect(new Set(CASES.map((c) => c.type))).toEqual(new Set(NOTIFICATION_TYPES));
    expect(CASES).toHaveLength(NOTIFICATION_TYPES.length * 3);
  });

  it.each(CASES)('$type with mute=$mode produces $expected row(s)', async ({ type, mode, expected }) => {
    const recipient = await addAccount(pg);
    await addMember(db, actor.userId, spaceId, recipient.userId, 'admin');
    for (const pref of mutes(mode, type)) await upsertPreference(db, recipient.userId, pref);

    await PRODUCERS[type](recipient.userId);
    const rows = (await listNotifications(db, recipient.userId, { limit: 100 }))
      .filter((row) => row.type === type);
    expect(rows).toHaveLength(expected);
  });
});
