/** Notification producers. A write that should reach someone else's inbox
 *  enqueues it here, AFTER the write commits. Pass the RAW Db from getDb(): the
 *  enqueue definer is EXECUTE-able only by bob_server, and inside withUser the
 *  call is denied and aborts the transaction. Nothing here throws: a failure
 *  journals a type and a count, and the user's write still succeeds. Rows carry
 *  ids, a type and a revision only. Quiet hours do not apply, because they defer
 *  push and the inbox item appears immediately. */
import { moduleJournal } from '../platform/logger.ts';
import { currentCorrelation } from '@bob/ai';
import { traceDelivery } from '../platform/observability/delivery-span.ts';
import { traceWorkflow } from '../platform/observability/workflow-diagnostics.ts';
import { StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { enqueueNotifications, getPreferences, isMuted, type NewNotification, type NotificationType } from './store.ts';
import { getEvent, listAttendees, type AttendeeResponse, type EventPatch, type StoredEvent } from '../calendar/store.ts';
import { getNote } from '../notes/store.ts';
import { getTask, listSubscribers, type StoredTask } from '../tasks/store.ts';
import { occurrenceEffectKey, type OccurrenceKey } from '../reminders/store.ts';
import { parseMentions, resolveMentions } from '../spaces/mentions.ts';
import { getSpace, listMembers } from '../spaces/store.ts';
import type { StoredThreadMessage } from '../conversations/thread-store.ts';

const journal = moduleJournal('notifications');

type DeliveryFailureReason = 'preferences_unreadable' | 'enqueue_failed';

/** 'muted' means every recipient muted it (nothing to retry); 'failed' means
 *  nothing is known to have been delivered, so the caller may retry. */
export type DeliveryOutcome =
  | { status: 'delivered'; enqueued: number; muted: number }
  | { status: 'muted'; enqueued: 0; muted: number }
  | { status: 'failed'; reason: DeliveryFailureReason }
  | { status: 'none' };

export interface OutboundNotification {
  type: NotificationType;
  rows: NewNotification[];
  /** For thread-level mutes. */
  threadId: string | null;
}

export interface NotifyChannel {
  readonly id: 'inbox' | 'email' | 'push' | 'device' | 'sms';
  /** Never throws (a failure is a `failed` outcome). */
  send(notification: OutboundNotification): Promise<DeliveryOutcome>;
}

export const NOTIFICATION_COVERAGE = {
  mention: 'notification-deliver', assignment: 'notification-deliver', reminder: 'notification-deliver',
  event_change: 'notification-deliver', invitation: 'notification-deliver', security: 'notification-deliver',
  task_update: 'notification-deliver', bob_message: 'notification-deliver',
} as const satisfies Record<NotificationType, 'notification-deliver'>;

/** The first channel is the primary: its outcome is the result (the reminder
 *  fan-out retries on its failure). The others are best effort. Never throws. */
export async function deliverThrough(channels: readonly NotifyChannel[], notification: OutboundNotification): Promise<DeliveryOutcome> {
  // Background delivery (no acting user in context) is correlated to its recipient when there is exactly one.
  const recipients = new Set(notification.rows.map((row) => row.recipientUserId));
  const [only] = recipients;
  const userId = recipients.size === 1 && currentCorrelation().user_id === undefined ? only : undefined;
  if (notification.rows.length === 0) return traceWorkflow(NOTIFICATION_COVERAGE[notification.type],
    { metadata: { action: notification.type } }, (outcome) => { outcome('skipped'); return { status: 'none' }; });
  let primary: DeliveryOutcome = { status: 'none' };
  for (const [index, channel] of channels.entries()) {
    try {
      const outcome = await traceWorkflow(NOTIFICATION_COVERAGE[notification.type], {
        ...(userId !== undefined ? { userId } : {}),
        metadata: { action: notification.type, target: channel.id },
      }, async (report) => {
        const result = await channel.send(notification);
        if (result.status === 'failed') report('failed');
        else if (result.status !== 'delivered') report('skipped');
        return result;
      });
      if (index === 0) primary = outcome;
    } catch {
      if (index === 0) primary = { status: 'failed', reason: 'enqueue_failed' };
    }
  }
  return primary;
}

function traceEnqueued(fields: { type: string; count: number; muted: number }): Promise<void> {
  return traceDelivery('notifications-enqueued', fields, () => journal('v2.notifications_enqueued', fields));
}

/** The recipient's mutes, then one enqueue that writes the inbox rows and their
 *  email outbox rows together (email follows through the outbox worker). */
export function createInboxChannel(db: Db): NotifyChannel {
  return {
    id: 'inbox',
    async send({ type, rows, threadId }): Promise<DeliveryOutcome> {
      if (rows.length === 0) return { status: 'none' };
      const kept: NewNotification[] = [];
      try {
        for (const row of rows) {
          const prefs = await getPreferences(db, row.recipientUserId);
          if (!isMuted(prefs, { spaceId: row.spaceId ?? null, threadId, type })) kept.push(row);
        }
      } catch {
        // The line keeps its {type, count} shape; the reason travels in the outcome.
        journal('v2.notifications_enqueue_failed', { type, count: rows.length });
        return { status: 'failed', reason: 'preferences_unreadable' };
      }
      const muted = rows.length - kept.length;
      if (kept.length === 0) {
        await traceEnqueued({ type, count: 0, muted });
        return { status: 'muted', enqueued: 0, muted };
      }
      try {
        await enqueueNotifications(db, kept);
      } catch {
        journal('v2.notifications_enqueue_failed', { type, count: kept.length });
        return { status: 'failed', reason: 'enqueue_failed' };
      }
      await traceEnqueued({ type, count: kept.length, muted });
      return { status: 'delivered', enqueued: kept.length, muted };
    },
  };
}

function deliver(db: Db, type: NotificationType, rows: NewNotification[],
  threadId: string | null): Promise<DeliveryOutcome> {
  return deliverThrough([createInboxChannel(db)], { type, rows, threadId });
}

export async function notifyTaskAssigned(db: Db, actorUserId: string, task: StoredTask,
  previousAssigneeUserId: string | null | undefined): Promise<void> {
  const recipient = task.assigneeUserId;
  if (recipient === null || recipient === actorUserId || recipient === previousAssigneeUserId) return;
  if (task.trashedAt !== null) return;
  await deliver(db, 'assignment', [{ recipientUserId: recipient, spaceId: task.spaceId,
    type: 'assignment', resourceType: 'task', resourceId: task.id, revision: task.revision,
    effectKey: `assignment:task:${task.id}:${task.revision}` }], null);
}

/**
 * Enqueues a Bob-authored personal note for its owner. The effect key must be
 * stable across retries (normally `bob_message:note:<noteId>`); the inbox row
 * and its email outbox row are committed together by the existing pipeline.
 */
export async function notifyBobMessage(db: Db, recipientUserId: string, noteId: string,
  effectKey: string): Promise<DeliveryOutcome> {
  let note: Awaited<ReturnType<typeof getNote>>;
  let space: Awaited<ReturnType<typeof getSpace>>;
  try {
    note = await getNote(db, recipientUserId, noteId);
    space = await getSpace(db, recipientUserId, note.spaceId);
  } catch (error) {
    if (error instanceof StoreNotFoundError) return { status: 'none' };
    journal('v2.notifications_enqueue_failed', { type: 'bob_message', count: 1 });
    return { status: 'failed', reason: 'enqueue_failed' };
  }
  if (note.createdBy !== recipientUserId || !note.aiAssisted || note.trashedAt !== null
    || space.kind !== 'private' || space.ownerUserId !== recipientUserId) {
    return { status: 'none' };
  }
  try {
    return await deliver(db, 'bob_message', [{
      recipientUserId,
      spaceId: note.spaceId,
      type: 'bob_message',
      resourceType: 'note',
      resourceId: note.id,
      revision: note.revision,
      effectKey,
    }], null);
  } catch {
    journal('v2.notifications_enqueue_failed', { type: 'bob_message', count: 1 });
    return { status: 'failed', reason: 'enqueue_failed' };
  }
}

/** The task as the actor sees it, or undefined if it can't be read. Never throws. */
export async function readTask(db: Db, actorUserId: string, taskId: string):
  Promise<StoredTask | undefined> {
  try { return await getTask(db, actorUserId, taskId); } catch { return undefined; }
}

/** Only a status, assignee or due change tells followers (not a title or notes edit). */
export function taskChangeNotifiesFollowers(before: StoredTask | undefined, after: StoredTask): boolean {
  if (before === undefined) return false;
  return before.status !== after.status || before.assigneeUserId !== after.assigneeUserId
    || before.dueDate !== after.dueDate || before.dueAt !== after.dueAt;
}

/** `except` holds a new assignee, who already gets an 'assignment'. Keyed per
 *  task revision, so a replayed write adds nothing. */
export async function notifyTaskFollowers(db: Db, actorUserId: string, task: StoredTask,
  except: ReadonlyArray<string | null> = []): Promise<void> {
  if (task.trashedAt !== null) return;
  let recipients: string[];
  try {
    recipients = (await listSubscribers(db, actorUserId, task.id)).map((sub) => sub.userId)
      .filter((userId) => userId !== actorUserId && !except.includes(userId));
  } catch {
    journal('v2.notifications_enqueue_failed', { type: 'task_update', count: 0 });
    return;
  }
  await deliver(db, 'task_update', recipients.map((recipientUserId) => ({
    recipientUserId, spaceId: task.spaceId, type: 'task_update' as const, resourceType: 'task',
    resourceId: task.id, revision: task.revision,
    effectKey: `task_update:task:${task.id}:${task.revision}`,
  })), null);
}

/** @bob and unknown handles never notify. */
export async function notifyThreadMentions(db: Db, actorUserId: string,
  message: StoredThreadMessage): Promise<void> {
  const personMentions = parseMentions(message.body).mentions
    .filter((mention) => mention.kind === 'person').length;
  if (personMentions === 0) return; // no member query for ordinary messages
  let recipients: string[];
  try {
    const members = await listMembers(db, actorUserId, message.spaceId);
    const resolved = resolveMentions(message.body,
      members.map((member) => ({ user_id: member.userId, handle: member.handle })));
    recipients = resolved.people.map((person) => person.user_id)
      .filter((userId) => userId !== actorUserId);
  } catch {
    journal('v2.notifications_enqueue_failed', { type: 'mention', count: personMentions });
    return;
  }
  await deliver(db, 'mention', recipients.map((recipientUserId) => ({
    recipientUserId, spaceId: message.spaceId, type: 'mention' as const,
    resourceType: 'thread', resourceId: message.threadId, revision: message.sequence,
    effectKey: `mention:thread:${message.threadId}:${message.sequence}`,
  })), message.threadId);
}

/** Tells every member except the joiner and the inviter (who is told the
 *  invitation was accepted instead). resource_type 'space_member' marks it apart
 *  from that notice, and it is inbox only (no template). */
export async function notifyMemberJoined(db: Db, joinerUserId: string,
  invitation: { id: string; spaceId: string; inviterUserId: string }): Promise<void> {
  let recipients: string[];
  try {
    recipients = (await listMembers(db, joinerUserId, invitation.spaceId)).map((member) => member.userId)
      .filter((userId) => userId !== joinerUserId && userId !== invitation.inviterUserId);
  } catch {
    journal('v2.notifications_enqueue_failed', { type: 'invitation', count: 0 });
    return;
  }
  await deliver(db, 'invitation', recipients.map((recipientUserId) => ({
    recipientUserId, spaceId: invitation.spaceId, type: 'invitation' as const,
    resourceType: 'space_member', resourceId: joinerUserId,
    effectKey: `member_joined:${invitation.id}`,
  })), null);
}

/** The event as the actor sees it, or undefined if it can't be read. Never throws. */
export async function readEvent(db: Db, actorUserId: string, eventId: string):
  Promise<StoredEvent | undefined> {
  try { return await getEvent(db, actorUserId, eventId); } catch { return undefined; }
}

const DETAIL_FIELDS = ['title', 'location', 'allDay', 'startDate', 'endDate', 'startAt', 'endAt',
  'zone', 'rrule'] as const;

/** Only a time, place or title change notifies. Without the prior event, any
 *  such field in the patch counts. */
export function eventPatchChangesDetails(before: StoredEvent | undefined, patch: EventPatch): boolean {
  return DETAIL_FIELDS.some((field) => {
    const next = patch[field];
    if (next === undefined) return false;
    if (before === undefined) return true;
    return JSON.stringify(next) !== JSON.stringify(before[field]);
  });
}

function eventRow(event: StoredEvent, recipientUserId: string, effectKey: string): NewNotification {
  return { recipientUserId, spaceId: event.spaceId, type: 'event_change', resourceType: 'event',
    resourceId: event.id, revision: event.revision, effectKey };
}

/** Keyed per attendee, so re-adding an attendee never re-invites. */
export async function notifyEventAttendeesAdded(db: Db, actorUserId: string, event: StoredEvent,
  attendeeUserIds: ReadonlyArray<string | null>): Promise<void> {
  const recipients = [...new Set(attendeeUserIds)]
    .filter((userId): userId is string => userId !== null && userId !== actorUserId);
  await deliver(db, 'event_change', recipients.map((userId) =>
    eventRow(event, userId, `event_invited:${event.id}:${userId}`)), null);
}

/** Every attendee and the organizer except the actor, or undefined (journaled)
 *  when the attendees can't be read. */
async function eventRecipients(db: Db, actorUserId: string, event: StoredEvent):
  Promise<string[] | undefined> {
  try {
    const attendees = await listAttendees(db, actorUserId, event.id);
    return [...new Set([event.organizerUserId, ...attendees.map((a) => a.userId)])]
      .filter((userId): userId is string => userId !== null && userId !== actorUserId);
  } catch {
    journal('v2.notifications_enqueue_failed', { type: 'event_change', count: 0 });
    return undefined;
  }
}

/** The caller decides the edit is worth it (eventPatchChangesDetails). */
export async function notifyEventUpdated(db: Db, actorUserId: string, event: StoredEvent):
  Promise<void> {
  const recipients = await eventRecipients(db, actorUserId, event);
  if (recipients === undefined) return;
  await deliver(db, 'event_change', recipients.map((userId) =>
    eventRow(event, userId, `event_updated:${event.id}:${event.revision}`)), null);
}

/** Keyed per occurrence (or the series) and revision, so a replayed cancel adds nothing. */
export async function notifyEventCancelled(db: Db, actorUserId: string, event: StoredEvent,
  occurrenceStart: number | undefined): Promise<void> {
  const recipients = await eventRecipients(db, actorUserId, event);
  if (recipients === undefined) return;
  const scope = occurrenceStart === undefined ? 'series' : String(occurrenceStart);
  await deliver(db, 'event_change', recipients.map((userId) =>
    eventRow(event, userId, `event_cancelled:${event.id}:${scope}:${event.revision}`)), null);
}

/** One row per attendee and response, so changing an answer notifies again. */
export async function notifyEventRsvp(db: Db, actorUserId: string, eventId: string,
  response: AttendeeResponse): Promise<void> {
  const event = await readEvent(db, actorUserId, eventId);
  if (event === undefined || event.organizerUserId === actorUserId) return;
  await deliver(db, 'event_change', [eventRow(event, event.organizerUserId,
    `event_rsvp:${event.id}:${actorUserId}:${response}`)], null);
}

export type SecurityEventKind = 'google_linked' | 'google_unlinked' | 'device_paired' | 'device_removed';

const SECURITY_RESOURCE: Record<SecurityEventKind, string> = {
  google_linked: 'google_account', google_unlinked: 'google_account',
  device_paired: 'device', device_removed: 'device',
};

export async function notifySecurityEvent(db: Db, userId: string, kind: SecurityEventKind,
  resourceId: string, revision: number): Promise<void> {
  await deliver(db, 'security', [{ recipientUserId: userId, spaceId: null, type: 'security',
    resourceType: SECURITY_RESOURCE[kind], resourceId, revision,
    effectKey: `${kind}:${resourceId}:${revision}` }], null);
}

/** How old a notification may get and still be delivered, so delivery that was
 *  down for days never blasts weeks-old reminders or mail. */
export const NOTIFICATION_STALE_MS = 24 * 60 * 60 * 1000;

/** A snoozed re-delivery suffixes the effect key so it is a new inbox item.
 *  Resolves to the outcome, so the fanout retries a failed occurrence. */
export async function notifyReminderDue(db: Db,
  occurrence: OccurrenceKey & { snoozedUntil?: number | null }, spaceId: string):
  Promise<DeliveryOutcome> {
  const snooze = occurrence.snoozedUntil ?? null;
  const effectKey = snooze === null
    ? occurrenceEffectKey(occurrence) : `${occurrenceEffectKey(occurrence)}:snooze:${snooze}`;
  return deliver(db, 'reminder', [{ recipientUserId: occurrence.userId, spaceId, type: 'reminder',
    resourceType: 'reminder', resourceId: occurrence.reminderId,
    revision: occurrence.scheduleRevision, effectKey }], null);
}
