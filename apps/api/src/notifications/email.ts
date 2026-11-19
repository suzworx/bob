/** The email.notification outbox handler. It reads the notification and its
 *  resource back AS the recipient (so RLS decides they still exist for them),
 *  acks when there is nothing to send, and throws only when the send itself
 *  fails, so the worker retries. Journal lines carry a reason code and the
 *  template id, never an address, name, title or body. */
import { moduleJournal } from '../platform/logger.ts';
import { withTraceContext } from '@bob/ai';
import { traceDelivery } from '../platform/observability/delivery-span.ts';
import { StoreError, withUser, type Db } from '../platform/db/db.ts';
import { emailEffectSent, getNotificationByEffectKey, markEmailEffectSent,
  parseEmailEffectKey, type StoredNotification } from './store.ts';
import type { StoredOutboxRow } from '../platform/outbox/store.ts';
import { getEvent, listAttendees, type StoredEvent } from '../calendar/store.ts';
import { getReminder } from '../reminders/store.ts';
import { getTask } from '../tasks/store.ts';
import { getGoogleAccount } from '../integrations/google-store.ts';
import { listDevices } from '../devices/store.ts';
import { getNote } from '../notes/store.ts';
import { getSpace, listMembers, type StoredSpace } from '../spaces/store.ts';
import { encodeCursor, getThread, listMessages } from '../conversations/thread-store.ts';
import { appUrl, emailConfigured, recipientEmail, sendTemplateEmail } from './email-client.ts';
import type { OutboxHandler } from '../platform/outbox/worker.ts';
import { NOTIFICATION_STALE_MS } from './notify.ts';

const journal = moduleJournal('notifications');

type EmailNotificationDeps = {
  db: Db;
  send?: typeof sendTemplateEmail;
  configured?: () => boolean;
  now?: () => number;
};

type TemplateMail = { template: string; data: Record<string, unknown> };

// ui-v2 paths (apps/ui-v2/src/routes.ts).
const SETTINGS_PATH = '/settings#notifications';
const spaceUrl = (spaceId: string, section?: string): string =>
  appUrl(`/spaces/${encodeURIComponent(spaceId)}${section ? `/${section}` : ''}`);
const threadUrl = (spaceId: string, threadId: string): string =>
  spaceUrl(spaceId, `threads/${encodeURIComponent(threadId)}`);

const EXCERPT_MAX = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An instant as e.g. "Sep 22, 2026, 6:30 PM GMT+5:30" in zone (UTC if the zone is bad). */
function formatInstant(ms: number, zone: string | null): string {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZoneName: 'short',
  };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone ?? 'UTC' }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(new Date(ms));
  }
}

function formatDate(ymd: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' })
    .format(new Date(`${ymd}T00:00:00Z`));
}

/** A member's display name as the viewer sees it, never an email or an id. */
async function memberName(db: Db, viewerUserId: string, spaceId: string,
  userId: string | null): Promise<string> {
  if (userId === null) return 'Bob';
  const members = await listMembers(db, viewerUserId, spaceId);
  const name = members.find((m) => m.userId === userId)?.displayName?.trim();
  return name && !name.includes('@') ? name : 'Someone';
}

function eventWhen(event: StoredEvent): string {
  if (event.allDay && event.startDate) return formatDate(event.startDate);
  return event.startAt === null ? '' : formatInstant(event.startAt, event.zone);
}

function sharedSpaceName(space: StoredSpace): string | undefined {
  return space.kind === 'private' ? undefined : space.name;
}

async function mentionMail(db: Db, n: StoredNotification): Promise<TemplateMail | null> {
  const r = n.recipientUserId;
  const thread = await getThread(db, r, n.resourceId);
  const space = await getSpace(db, r, thread.spaceId);
  // revision is the mentioning message's sequence; sequence is unique per thread.
  const page = await listMessages(db, r, thread.id, {
    cursor: encodeCursor(Math.max(n.revision - 1, 0), thread.id), limit: 1,
  });
  const message = page.messages[0];
  if (!message || message.sequence !== n.revision || message.tombstonedAt !== null) return null;
  const body = message.body.trim();
  return { template: 'thread-mention', data: {
    actorName: await memberName(db, r, space.id, message.authorUserId),
    spaceName: space.name,
    threadTitle: thread.title,
    excerpt: body.length > EXCERPT_MAX ? `${body.slice(0, EXCERPT_MAX - 1)}…` : body,
    threadUrl: threadUrl(space.id, thread.id),
    manageUrl: appUrl(SETTINGS_PATH),
  } };
}

async function assignmentMail(db: Db, n: StoredNotification): Promise<TemplateMail | null> {
  const r = n.recipientUserId;
  const task = await getTask(db, r, n.resourceId);
  // Trashed, or reassigned since: this assignment no longer stands.
  if (task.trashedAt !== null || task.assigneeUserId !== r) return null;
  const space = await getSpace(db, r, task.spaceId);
  const dueLabel = task.dueAt !== null ? formatInstant(task.dueAt, task.dueZone)
    : task.dueDate !== null ? formatDate(task.dueDate) : undefined;
  return { template: 'task-assigned', data: {
    // The assigner is not stored on the notification; the task's creator is
    // the closest durable actor.
    actorName: await memberName(db, r, space.id, task.createdBy),
    spaceName: space.name,
    taskTitle: task.title,
    ...(dueLabel !== undefined ? { dueLabel } : {}),
    taskUrl: spaceUrl(space.id, 'tasks'),
    manageUrl: appUrl(SETTINGS_PATH),
  } };
}

async function reminderMail(db: Db, n: StoredNotification): Promise<TemplateMail | null> {
  const r = n.recipientUserId;
  const reminder = await getReminder(db, r, n.resourceId);
  if (reminder.status === 'cancelled') return null;
  const space = await getSpace(db, r, reminder.spaceId);
  // effect_key is reminder:<id>:<user>:<occurrenceAt>:<scheduleRevision>.
  const occurrenceAt = Number(n.effectKey.split(':')[3]);
  const at = Number.isFinite(occurrenceAt) ? occurrenceAt : reminder.dueAt;
  const dueLabel = at !== null ? formatInstant(at, reminder.dueZone)
    : reminder.dueDate !== null ? formatDate(reminder.dueDate) : '';
  const spaceName = sharedSpaceName(space);
  return { template: 'reminder-due', data: {
    title: reminder.title,
    dueLabel,
    ...(spaceName !== undefined ? { spaceName } : {}),
    url: appUrl('/today'),
    manageUrl: appUrl(SETTINGS_PATH),
  } };
}

async function bobMessageMail(db: Db, n: StoredNotification): Promise<TemplateMail | null> {
  if (n.resourceType !== 'note' || n.spaceId === null) return null;
  const recipientUserId = n.recipientUserId;
  const note = await getNote(db, recipientUserId, n.resourceId);
  if (note.createdBy !== recipientUserId || !note.aiAssisted || note.spaceId !== n.spaceId || note.trashedAt !== null) {
    return null;
  }
  const space = await getSpace(db, recipientUserId, note.spaceId);
  if (space.kind !== 'private' || space.ownerUserId !== recipientUserId) return null;
  return { template: 'bob-message', data: {
    noteTitle: note.title,
    noteBody: note.body,
    noteUrl: appUrl(`/spaces/${encodeURIComponent(space.id)}/notes?note=${encodeURIComponent(note.id)}`),
    manageUrl: appUrl(SETTINGS_PATH),
  } };
}

async function invitationMail(db: Db, n: StoredNotification): Promise<TemplateMail | null> {
  const r = n.recipientUserId;
  // accepted_by is not on StoredInvitation; the inviter reads it under RLS.
  const rows = await withUser(db, r, (tx) => tx.query<{ spaceId: unknown; acceptedBy: unknown }>(
    `SELECT space_id AS "spaceId", accepted_by AS "acceptedBy"
       FROM bob.space_invitations WHERE id = $1`, [n.resourceId]));
  const row = rows[0];
  if (!row || row.acceptedBy === null) return null;
  const space = await getSpace(db, r, String(row.spaceId));
  return { template: 'space-invite-accepted', data: {
    memberName: await memberName(db, r, space.id, String(row.acceptedBy)),
    spaceName: space.name,
    spaceUrl: spaceUrl(space.id),
    manageUrl: appUrl(SETTINGS_PATH),
  } };
}

async function eventMail(db: Db, n: StoredNotification): Promise<TemplateMail | null> {
  const r = n.recipientUserId;
  const [prefix] = n.effectKey.split(':');
  const event = await getEvent(db, r, n.resourceId);
  const space = await getSpace(db, r, event.spaceId);
  const base = { eventTitle: event.title, whenLabel: eventWhen(event) };
  const eventUrl = spaceUrl(space.id, 'agenda');
  const manageUrl = appUrl(SETTINGS_PATH);
  if (prefix === 'event_cancelled') {
    return { template: 'event-cancelled', data: { ...base, spaceName: space.name,
      actorName: await memberName(db, r, space.id, event.organizerUserId) } };
  }
  if (event.status === 'cancelled') return null;
  if (prefix === 'event_invited') {
    return { template: 'event-invited', data: { ...base, spaceName: space.name,
      organizerName: await memberName(db, r, space.id, event.organizerUserId),
      ...(event.location ? { location: event.location } : {}), eventUrl, manageUrl } };
  }
  if (prefix === 'event_updated') {
    // What changed is not stored; the producer only fires on time/place/title.
    return { template: 'event-updated', data: { ...base,
      actorName: await memberName(db, r, space.id, event.organizerUserId),
      changesLabel: 'The time, place or title changed.', eventUrl, manageUrl } };
  }
  if (prefix === 'event_rsvp') {
    // effect_key is event_rsvp:<event id>:<attendee user id>:<response>; the
    // key's response is the one this notification is about.
    const parts = n.effectKey.split(':');
    const attendeeId = parts.find((part, i) => i > 1 && UUID_RE.test(part));
    if (!attendeeId) return null;
    const attendee = (await listAttendees(db, r, event.id)).find((a) => a.userId === attendeeId);
    if (!attendee) return null;
    const keyed = parts[parts.indexOf(attendeeId) + 1];
    const response = keyed === 'accepted' || keyed === 'declined' || keyed === 'tentative'
      ? keyed : attendee.response;
    if (response === 'needs_action') return null;
    return { template: 'event-rsvp', data: { eventTitle: event.title, response,
      attendeeName: await memberName(db, r, space.id, attendeeId), eventUrl, manageUrl } };
  }
  return null;
}

async function securityMail(db: Db, n: StoredNotification): Promise<TemplateMail | null> {
  const r = n.recipientUserId;
  const [prefix] = n.effectKey.split(':');
  // Sent directly at unlink time (web-google-accounts.ts DELETE), while the
  // address is still readable: ack without sending so it never double-sends.
  if (prefix === 'google_unlinked') return null;
  if (prefix === 'google_linked') {
    const account = await getGoogleAccount(db, r, n.resourceId);
    return account ? { template: 'google-account-linked',
      data: { googleEmail: account.email, manageUrl: appUrl('/integrations') } } : null;
  }
  if (prefix === 'device_paired') {
    const device = (await listDevices(db, r)).find((d) => d.id === n.resourceId);
    return device ? { template: 'device-paired',
      data: { deviceName: device.name, manageUrl: appUrl('/devices') } } : null;
  }
  if (prefix === 'device_removed') {
    // listDevices hides revoked devices; the owner can still read the row.
    const rows = await withUser(db, r, (tx) => tx.query<{ name: unknown }>(
      'SELECT name FROM bob.devices WHERE id = $1', [n.resourceId]));
    return rows[0] ? { template: 'device-removed', data: { deviceName: String(rows[0].name) } } : null;
  }
  return null;
}

/** The template and data for a notification, or null when there is nothing to
 *  mail (its resource is gone, hidden from the recipient, or superseded). */
export async function buildNotificationMail(db: Db,
  n: StoredNotification): Promise<TemplateMail | null> {
  try {
    switch (n.type) {
      case 'mention': return await mentionMail(db, n);
      case 'assignment': return await assignmentMail(db, n);
      case 'reminder': return await reminderMail(db, n);
      case 'invitation': return await invitationMail(db, n);
      case 'event_change': return await eventMail(db, n);
      case 'security': return await securityMail(db, n);
      case 'task_update': return null; // inbox only (see the handler)
      case 'bob_message': return await bobMessageMail(db, n);
    }
  } catch (error) {
    // Not found / not visible reads raise StoreError: the resource is gone.
    if (error instanceof StoreError) return null;
    throw error;
  }
  return null;
}

async function skip(reason: string, template?: string): Promise<void> {
  const fields = { reason, ...(template ? { template } : {}) };
  await traceDelivery('email-notification', { outcome: 'skipped', ...fields },
    () => journal('v2.email_notification_skipped', fields));
}

export function createEmailNotificationHandler(deps: EmailNotificationDeps): OutboxHandler {
  const { db } = deps;
  const send = deps.send ?? sendTemplateEmail;
  const configured = deps.configured ?? emailConfigured;
  const now = deps.now ?? Date.now;
  return async (row: StoredOutboxRow): Promise<void> => {
    if (!configured()) return skip('not_configured');
    // The outbox row is written with its notification, so its age is the
    // notification's: a day-old email is noise, not news.
    if (now() - row.createdAt > NOTIFICATION_STALE_MS) return skip('stale');
    const key = parseEmailEffectKey(row.effectKey);
    if (!key) return skip('bad_key');
    // The outbox tick is system work; mail for a recipient runs as that user (spans below join their active conversation).
    return withTraceContext({ userId: key.recipientUserId }, () => deliver(row, key));
  };

  async function deliver(row: StoredOutboxRow, key: NonNullable<ReturnType<typeof parseEmailEffectKey>>): Promise<void> {
    // Exactly once: a row reclaimed after its send (the worker died before
    // the ack) finds its marker and acks without mailing again.
    if (await emailEffectSent(db, row.effectKey)) return skip('already_sent');
    const notification = await getNotificationByEffectKey(db, key.recipientUserId, key.effectKey);
    if (!notification) return skip('gone');
    if (notification.readAt !== null) return skip('read');
    // A followed task's change is an inbox item only: it has no catalog
    // template, and a family's routine edits should not fill a mailbox.
    if (notification.type === 'task_update') return skip('inbox_only');
    // A member-joined notice to the other members is inbox only too (#858):
    // its only template would be the inviter's space-invite-accepted.
    if (notification.type === 'invitation' && notification.resourceType === 'space_member') {
      return skip('inbox_only');
    }
    const to = await recipientEmail(db, key.recipientUserId);
    if (!to) return skip('no_address');
    const mail = await buildNotificationMail(db, notification);
    if (!mail) return skip('gone');
    await send({ template: mail.template, to, data: mail.data });
    // Marked before returning (the worker acks after), so the window in which
    // a crash can still re-send is this one write, not the ack round-trip.
    await markEmailEffectSent(db, row.effectKey, key.recipientUserId);
    await traceDelivery('email-notification', { template: mail.template, outcome: 'sent' },
      () => journal('v2.email_notification_sent', { template: mail.template }));
  }
}
