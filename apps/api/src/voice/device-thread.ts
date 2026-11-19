/**
 * The shared half of a Cardputer voice turn.
 * A pair or group conversation's turn runs in SHARED mode (no memory, no game,
 * tools bound to its space) and is saved, through persistDeviceTurn, as the
 * account's own message plus the assistant's reply, exactly as an @bob
 * invocation would leave it. Every active member's open tabs learn of each new
 * message by id only. The device names such a conversation `thr_<uuid>`.
 *
 * Like cardputer-conversation.ts, the Db port and account id are passed in;
 * failures other than a lost conversation are thrown for the caller to journal.
 */
import type { Db } from '../platform/db/db.ts';
import { parseDeviceRef } from '../devices/conversation-ref.ts';
import { type AccountEvents } from '../account/events-bus.ts';
import { postAssistantMessage, postMessage, type StoredThreadMessage } from '../conversations/thread-store.ts';
import { StoreNotFoundError } from '../platform/db/db.ts';
import type { ConversationScope } from '../conversations/scope.ts';
import { getSpace, listMembers } from '../spaces/store.ts';
import { claimInvocation, InvocationBusyError, setInvocationState } from '../conversations/invocations-store.ts';

/** The thread a body may hold at most (threads_init.sql body check). */
const MAX_BODY_CHARS = 8000;

/** The thread id a device ref names (for the journal), or null for a General conversation or no ref. */
export function deviceThreadId(ref: string | undefined): string | null {
  if (ref === undefined) return null;
  const parsed = parseDeviceRef(ref);
  return parsed?.kind === 'thread' ? parsed.threadId : null;
}

/** Where a shared turn's thread.message_appended events go. */
export type DeviceTurnEvents = Pick<AccountEvents, 'publish'>;

/** The turn a device spoke, as both kinds of conversation save it. */
export interface DeviceTurnInput {
  sessionId: string;
  turnRef: string;
  /** The paired device that spoke the turn (null for a legacy token). */
  deviceId?: string | null;
  transcriptText: string;
  replyText: string;
  /** Set when playback was cut short: only this many reply chars were heard. */
  heardChars?: number;
}

/** The outcome of a turn saved into a shared conversation: ids and counts only. */
interface SharedTurnResult {
  spaceId: string;
  userMessageId: string;
  replyMessageId: string | null;
  /** False when a retry found the turn's message already saved. */
  created: boolean;
  outcome: 'completed' | 'busy' | 'duplicate' | 'unheard';
  published: number;
}

/** A body that fits the thread's check, or null when nothing is left. */
function fitBody(text: string): string | null {
  const body = text.slice(0, MAX_BODY_CHARS);
  return body.trim().length === 0 ? null : body;
}

/**
 * Saves one device turn into a shared (pair or group) conversation: (1) the
 * transcript as the account's message, idempotent on `device:<session>:<turn>`;
 * (2) an invocation claimed with it as trigger; (3) only the heard slice of the
 * reply as the assistant (author null); (4) the invocation completed. A busy
 * conversation still gets the reply (the device already spoke it). Returns null
 * when it is archived or the account is no longer a member, so the caller falls
 * back to a new private conversation.
 */
export async function saveSharedTurn(
  db: Db,
  userId: string,
  scope: ConversationScope,
  turn: DeviceTurnInput,
  events: DeviceTurnEvents,
): Promise<SharedTurnResult | null> {
  const threadId = scope.conversationId;
  if (scope.archivedAt !== null || scope.spaceId === null) return null;
  const spaceId = scope.spaceId;
  let membershipRevision: number;
  try {
    membershipRevision = (await getSpace(db, userId, spaceId)).membershipRevision;
  } catch (error) {
    if (error instanceof StoreNotFoundError) return null;
    throw error;
  }
  const posted = await postMessage(db, userId, {
    threadId,
    body: fitBody(turn.transcriptText) ?? '…',
    clientMessageId: `device:${turn.sessionId}:${turn.turnRef}`,
    deviceId: turn.deviceId,
  });
  const trigger = posted.message;
  // The key is unique per author, not per thread: never reuse another thread's message.
  if (trigger.threadId !== threadId) throw new Error('device turn key names another thread');
  const saved: StoredThreadMessage[] = posted.created ? [trigger] : [];
  const heard = turn.heardChars === undefined ? turn.replyText : turn.replyText.slice(0, turn.heardChars);
  const body = fitBody(heard);
  let outcome: SharedTurnResult['outcome'] = 'completed';
  let replyMessageId: string | null = null;
  let invocationId: string;
  try {
    const claim = await claimInvocation(db, userId, {
      spaceId, threadId, triggerMessageId: trigger.id,
      contextHighWater: trigger.sequence, membershipRevision,
    });
    invocationId = claim.invocation.id;
    if (!claim.claimed && (claim.invocation.state !== 'running' || claim.invocation.resultMessageId !== null)) {
      outcome = 'duplicate';
      replyMessageId = claim.invocation.resultMessageId;
    }
  } catch (error) {
    if (!(error instanceof InvocationBusyError)) throw error;
    outcome = 'busy';
    invocationId = `device-busy-${trigger.id}`;
  }
  if (outcome !== 'duplicate') {
    if (body === null) {
      if (outcome === 'completed') await setInvocationState(db, userId, invocationId, 'cancelled');
      outcome = 'unheard';
    } else {
      const reply = await postAssistantMessage(db, userId, { threadId, spaceId }, invocationId, body, turn.deviceId ?? null);
      saved.push(reply);
      replyMessageId = reply.id;
      if (outcome === 'completed') {
        await setInvocationState(db, userId, invocationId, 'completed', { resultMessageId: reply.id });
      }
    }
  }
  const published = await publishAppended(db, userId, spaceId, saved, events);
  return { spaceId, userMessageId: trigger.id, replyMessageId, created: posted.created, outcome, published };
}

/** Publishes thread.message_appended for each saved message to every active
 *  member of the space. Returns the number of events published. */
async function publishAppended(
  db: Db,
  userId: string,
  spaceId: string,
  messages: StoredThreadMessage[],
  events: DeviceTurnEvents,
): Promise<number> {
  if (messages.length === 0) return 0;
  const members = await listMembers(db, userId, spaceId);
  let published = 0;
  for (const member of members) {
    for (const message of messages) {
      events.publish(member.userId, {
        type: 'thread.message_appended',
        thread_id: message.threadId, space_id: message.spaceId, message_id: message.id, sequence: message.sequence,
      });
      published += 1;
    }
  }
  return published;
}
