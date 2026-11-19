/**
 * What an inbox row is about, read at request time AS the recipient: the
 * inbox table still stores ids only, and every name, title and time here is
 * fetched through the resource's own store under withUser(), so RLS decides
 * it on every read (a resource the recipient can no longer see describes as
 * null, and the client shows the generic text without a link). Nothing here is
 * journaled except a count.
 */
import { StoreError, withUser, type Db } from '../platform/db/db.ts';
import { encodeCursor, getThread, listMessages } from '../conversations/thread-store.ts';
import { getEvent } from '../calendar/store.ts';
import { getGoogleAccount } from '../integrations/google-store.ts';
import { getNote } from '../notes/store.ts';
import { getReminder } from '../reminders/store.ts';
import { getSpace, listMembers } from '../spaces/store.ts';
import { getTask } from '../tasks/store.ts';
import type { StoredNotification } from './store.ts';

export const NOTIFICATION_ACTIONS = [
  'invited', 'updated', 'cancelled', 'accepted', 'declined', 'tentative',
  'google_linked', 'google_unlinked', 'device_paired', 'device_removed',
] as const;

type NotificationAction = (typeof NOTIFICATION_ACTIONS)[number];

/** Who did it, to what, where and when. Every field may be null. */
export type NotificationAbout = {
  actorName: string | null;
  title: string | null;
  /** Null for a private space: "Private" tells the reader nothing. */
  spaceName: string | null;
  /** An instant (epoch ms) the item is about: a reminder's ring, an event's start. */
  at: number | null;
  /** An all-day date (YYYY-MM-DD) when there is no instant. */
  date: string | null;
  action: NotificationAction | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EMPTY: NotificationAbout = {
  actorName: null, title: null, spaceName: null, at: null, date: null, action: null,
};

type Lookups = {
  names: (spaceId: string) => Promise<Map<string, string>>;
  space: (spaceId: string) => Promise<{ name: string | null }>;
};

/** One members and one space read per space per request, shared by its rows. */
function lookups(db: Db, viewer: string): Lookups {
  const names = new Map<string, Promise<Map<string, string>>>();
  const spaces = new Map<string, Promise<{ name: string | null }>>();
  return {
    names: (spaceId) => {
      let found = names.get(spaceId);
      if (!found) {
        found = listMembers(db, viewer, spaceId).then((members) => new Map(members.flatMap((m) => {
          const name = m.displayName?.trim();
          // A display name that is an address is not shown; the handle is.
          return [[m.userId, name && !name.includes('@') ? name : `@${m.handle}`] as const];
        })));
        names.set(spaceId, found);
      }
      return found;
    },
    space: (spaceId) => {
      let found = spaces.get(spaceId);
      if (!found) {
        found = getSpace(db, viewer, spaceId).then((s) => ({ name: s.kind === 'private' ? null : s.name }));
        spaces.set(spaceId, found);
      }
      return found;
    },
  };
}

async function nameIn(look: Lookups, spaceId: string, userId: string | null): Promise<string | null> {
  if (userId === null) return null;
  return (await look.names(spaceId)).get(userId) ?? null;
}

async function describeMention(db: Db, look: Lookups, n: StoredNotification): Promise<NotificationAbout | null> {
  const r = n.recipientUserId;
  const thread = await getThread(db, r, n.resourceId);
  // revision is the mentioning message's sequence.
  const page = await listMessages(db, r, thread.id, {
    cursor: encodeCursor(Math.max(n.revision - 1, 0), thread.id), limit: 1,
  });
  const message = page.messages[0];
  const author = message && message.sequence === n.revision && message.tombstonedAt === null
    ? message.authorUserId : null;
  return { ...EMPTY, title: thread.title, spaceName: (await look.space(thread.spaceId)).name,
    actorName: await nameIn(look, thread.spaceId, author) };
}

async function describeTask(db: Db, look: Lookups, n: StoredNotification): Promise<NotificationAbout | null> {
  const task = await getTask(db, n.recipientUserId, n.resourceId);
  if (task.trashedAt !== null) return null;
  // The assigner is not stored, so no actor is named rather than a wrong one.
  return { ...EMPTY, title: task.title, spaceName: (await look.space(task.spaceId)).name,
    at: task.dueAt, date: task.dueDate };
}

async function describeBobMessage(db: Db, n: StoredNotification): Promise<NotificationAbout | null> {
  if (n.resourceType !== 'note' || n.spaceId === null) return null;
  const note = await getNote(db, n.recipientUserId, n.resourceId);
  const space = await getSpace(db, n.recipientUserId, note.spaceId);
  if (note.createdBy !== n.recipientUserId || !note.aiAssisted || note.spaceId !== n.spaceId || note.trashedAt !== null
    || space.kind !== 'private' || space.ownerUserId !== n.recipientUserId) {
    return null;
  }
  return { ...EMPTY, actorName: 'Bob', title: note.title };
}

async function describeReminder(db: Db, look: Lookups, n: StoredNotification): Promise<NotificationAbout | null> {
  const reminder = await getReminder(db, n.recipientUserId, n.resourceId);
  if (reminder.status === 'cancelled') return null;
  // effect_key is reminder:<id>:<user>:<occurrenceAt>:<scheduleRevision>[:snooze:<ms>].
  const occurrenceAt = Number(n.effectKey.split(':')[3]);
  return { ...EMPTY, title: reminder.title, spaceName: (await look.space(reminder.spaceId)).name,
    at: Number.isFinite(occurrenceAt) ? occurrenceAt : reminder.dueAt,
    date: Number.isFinite(occurrenceAt) || reminder.dueAt !== null ? null : reminder.dueDate };
}

async function describeEvent(db: Db, look: Lookups, n: StoredNotification): Promise<NotificationAbout | null> {
  const event = await getEvent(db, n.recipientUserId, n.resourceId);
  const parts = n.effectKey.split(':');
  const base = { ...EMPTY, title: event.title, spaceName: (await look.space(event.spaceId)).name,
    at: event.allDay ? null : event.startAt, date: event.allDay ? event.startDate : null };
  if (parts[0] === 'event_rsvp') {
    // event_rsvp:<event id>:<attendee user id>:<response>
    const attendee = parts.find((part, i) => i > 1 && UUID_RE.test(part)) ?? null;
    const keyed = attendee === null ? undefined : parts[parts.indexOf(attendee) + 1];
    const action = keyed === 'accepted' || keyed === 'declined' || keyed === 'tentative' ? keyed : null;
    return { ...base, action, actorName: await nameIn(look, event.spaceId, attendee) };
  }
  const action = parts[0] === 'event_invited' ? 'invited' : parts[0] === 'event_cancelled' ? 'cancelled' : 'updated';
  if (action !== 'cancelled' && event.status === 'cancelled') return null;
  return { ...base, action, actorName: await nameIn(look, event.spaceId, event.organizerUserId) };
}

async function describeInvitation(db: Db, look: Lookups, n: StoredNotification): Promise<NotificationAbout | null> {
  if (n.spaceId === null) return null;
  const space = await look.space(n.spaceId);
  if (n.resourceType === 'space_member') {
    return { ...EMPTY, spaceName: space.name, actorName: await nameIn(look, n.spaceId, n.resourceId) };
  }
  // accepted_by is not on StoredInvitation; the inviter reads it under RLS.
  const rows = await withUser(db, n.recipientUserId, (tx) => tx.query<{ acceptedBy: unknown }>(
    'SELECT accepted_by AS "acceptedBy" FROM bob.space_invitations WHERE id = $1', [n.resourceId]));
  const accepted = rows[0]?.acceptedBy;
  return { ...EMPTY, spaceName: space.name,
    actorName: accepted === null || accepted === undefined ? null : await nameIn(look, n.spaceId, String(accepted)) };
}

async function describeSecurity(db: Db, n: StoredNotification): Promise<NotificationAbout | null> {
  const [prefix] = n.effectKey.split(':');
  if (prefix === 'google_linked' || prefix === 'google_unlinked') {
    // An unlinked account's row is gone; the notice still says what happened.
    const account = prefix === 'google_linked' ? await getGoogleAccount(db, n.recipientUserId, n.resourceId) : null;
    return { ...EMPTY, action: prefix, title: account?.email ?? null };
  }
  if (prefix === 'device_paired' || prefix === 'device_removed') {
    // The owner can read a revoked device's row too.
    const rows = await withUser(db, n.recipientUserId, (tx) => tx.query<{ name: unknown }>(
      'SELECT name FROM bob.devices WHERE id = $1', [n.resourceId]));
    return { ...EMPTY, action: prefix, title: rows[0] ? String(rows[0].name) : null };
  }
  return EMPTY;
}

function describeOne(db: Db, look: Lookups, n: StoredNotification): Promise<NotificationAbout | null> {
  switch (n.type) {
    case 'mention': return describeMention(db, look, n);
    case 'assignment':
    case 'task_update': return describeTask(db, look, n);
    case 'reminder': return describeReminder(db, look, n);
    case 'event_change': return describeEvent(db, look, n);
    case 'invitation': return describeInvitation(db, look, n);
    case 'security': return describeSecurity(db, n);
    case 'bob_message': return describeBobMessage(db, n);
  }
}

/** One result per notification, in order. A resource that is gone or hidden
 *  describes as null; so does one whose read fails, which is counted in
 *  `failed` so the caller can journal it -- the list itself still answers. */
export async function describeNotifications(db: Db, viewer: string,
  notifications: readonly StoredNotification[]): Promise<{ about: (NotificationAbout | null)[]; failed: number }> {
  const look = lookups(db, viewer);
  let failed = 0;
  const about: (NotificationAbout | null)[] = [];
  // One at a time: each read is its own withUser transaction, and a page of
  // 25 in parallel would hold 25 pool connections.
  for (const n of notifications) {
    try {
      about.push(await describeOne(db, look, n));
    } catch (error) {
      if (!(error instanceof StoreError)) failed += 1;
      about.push(null);
    }
  }
  return { about, failed };
}
