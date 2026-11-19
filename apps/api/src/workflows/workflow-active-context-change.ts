/**
 * Workflow: moves the active context (conversation or thread pointer, and active Space) for a device or the account.
 * Trigger: the device picker's select_conversation, new_conversation and select_space control messages (voice/session.ts
 *   table), and the web "Use on Cardputer" routes PUT /api/devices/active-space and PUT /api/devices/active-conversation
 *   (devices/http.ts).
 * Steps: device picker: 1. a thread moves the thread and Space pointers in one transaction; a General conversation is read,
 *   then its pointer is written ('picker'). 2. new_conversation clears the pointer ('device'), a repeated request_id re-sends
 *   its ack. 3. select_space moves the Space pointer and clears a thread pointer in another Space in the same transaction.
 *   4. publish active_space.changed / active.changed on the account bus, then answer the device. Web: 1. one transaction
 *   moves the Space (and, account-wide, resets every device's own pointers) or both pointers. 2. a cleared thread pointer
 *   and both changes are published with surface 'web' / 'activate'; the route answers 200 or 202 pending.
 * Outcome: every surface of the account (or only the named device, which never moves the account pointer) follows the new
 *   context. Unknown, archived and not-a-member ids change nothing (CONVERSATION_NOT_FOUND / SPACE_NOT_FOUND, or 404).
 * Journal: voice: v2.active_changed, v2.active_space_changed, v2.active_write_failed, v2.active_space_write_failed,
 *   v2.conversation_selected, v2.conversation_select_failed, v2.new_conversation, v2.new_conversation_duplicate;
 *   devices: v2.active_changed, v2.active_space_changed. publishActiveCleared (session-handlers.ts) journals
 *   v2.active_changed. No trace names of its own. Titles and names are user text: published, never journaled.
 */
import { V2_VERSION, messageId, type ClientControlDto } from '../voice/protocol.ts';
import { moduleJournal } from '../platform/logger.ts';
import { StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import type { AccountEvent } from '../account/events-bus.ts';
import { clearActiveThreadInSpace, clearDevicePointers, getActive, setActive, type ActiveSurface } from '../conversations/active.ts';
import { getConversation, type ConversationDetail } from '../conversations/store.ts';
import { getThread } from '../conversations/thread-store.ts';
import { setActiveSpace } from '../spaces/active.ts';
import { parseDeviceRef } from '../devices/conversation-ref.ts';
import { getAccountEvents } from '../devices/pairing-service.ts';
import {
  applyActiveToSession, errorName, publishActiveCleared, sendDto, sendError, sessionDeviceId, sessionUserId,
  type ControlContext, type SessionDeps,
} from '../voice/session-handlers.ts';

const journal = moduleJournal('voice');
const devicesJournal = moduleJournal('devices');

/**
 * The device_id a device action's active.changed/active_space.changed publish
 * should carry, so the registry can tell a move that also moved the account's
 * pointer (every device without its own pointer must still hear it) from one
 * device's own business, and never yanks a session with its own pointer.
 * Also hands the registry this process's getDb, so it can read device rows per
 * publish without importing the composition-root singleton. Omitted when this
 * is the account's only connected session: there is nothing else to exclude,
 * and some callers still check the published event byte for byte. A legacy
 * session (deviceId undefined) always omits it and skips remembering.
 */
function exclusiveDeviceId(
  deps: Pick<SessionDeps, 'deviceSessions' | 'getDb'>, userId: string, deviceId: string | undefined,
): string | undefined {
  if (deviceId === undefined) return undefined;
  deps.deviceSessions.rememberDb(deps.getDb);
  return deps.deviceSessions.forAccount(userId).length > 1 ? deviceId : undefined;
}

/** A Space thread moves both pointers in one transaction. Unknown, archived and
 *  not-a-member are one StoreNotFoundError (RLS), answered
 *  CONVERSATION_NOT_FOUND with both pointers untouched. */
async function selectThread(ctx: ControlContext, userId: string, conversationId: string, threadId: string): Promise<void> {
  const { deps, socket, session } = ctx;
  const deviceId = sessionDeviceId(session);
  let selected: { title: string; spaceId: string; spaceName: string | null; spaceAt: number; changedAt: number };
  try {
    selected = await withUser(await deps.getDb(), userId, async (tx) => {
      const thread = await getThread(tx, userId, threadId);
      if (thread.archivedAt !== null) throw new StoreNotFoundError('thread not found');
      const space = await setActiveSpace(tx, userId, thread.spaceId, 'device', deviceId);
      const changedAt = await setActive(tx, userId, conversationId, 'picker', { deviceId });
      return { title: thread.title, spaceId: thread.spaceId, spaceName: space.name, spaceAt: space.changedAt, changedAt };
    });
  } catch (error) {
    if (error instanceof StoreNotFoundError) return sendError(socket, session, 'CONVERSATION_NOT_FOUND');
    journal('v2.active_write_failed', { surface: 'picker', error: errorName(error) });
    return sendError(socket, session, 'INTERNAL');
  }
  session.activeConversationId = conversationId;
  session.activeConversationTitle = selected.title;
  getAccountEvents().publish(userId, {
    type: 'active_space.changed', space_id: selected.spaceId, name: selected.spaceName, surface: 'device',
    changed_at: selected.spaceAt, device_id: exclusiveDeviceId(deps, userId, deviceId),
  });
  journal('v2.active_space_changed', { session: session.id, surface: 'device' });
  getAccountEvents().publish(userId, {
    type: 'active.changed', conversation_id: conversationId, title: selected.title, surface: 'picker',
    changed_at: selected.changedAt, device_id: exclusiveDeviceId(deps, userId, deviceId),
  });
  journal('v2.active_changed', { surface: 'picker' });
  journal('v2.conversation_selected', { session: session.id, conversation_id: conversationId });
  return sendDto(socket, {
    v: V2_VERSION, type: 'conversation_selected', id: messageId('csel'), payload: { conversation_id: conversationId, title: selected.title },
  });
}

export async function handleSelectConversation(ctx: ControlContext, dto: Extract<ClientControlDto, { type: 'select_conversation' }>): Promise<void> {
  const { deps, socket, session } = ctx;
  if (session.stage !== 'ready') return sendError(socket, session, 'STATE_VIOLATION');
  const conversationId = dto.payload.conversation_id;
  const userId = sessionUserId(session);
  if (userId === undefined) return sendError(socket, session, 'INTERNAL');
  const ref = parseDeviceRef(conversationId);
  if (ref === null) return sendError(socket, session, 'CONVERSATION_NOT_FOUND');
  if (ref.kind === 'thread') return selectThread(ctx, userId, conversationId, ref.threadId);
  const deviceId = sessionDeviceId(session);
  let conversation: ConversationDetail | null;
  try {
    conversation = await getConversation(await deps.getDb(), userId, conversationId);
  } catch (error) {
    journal('v2.conversation_select_failed', { session: session.id, error: errorName(error) });
    return sendError(socket, session, 'INTERNAL');
  }
  if (conversation === null) return sendError(socket, session, 'CONVERSATION_NOT_FOUND');
  session.activeConversationId = conversationId;
  session.activeConversationTitle = conversation.title;
  // A picker selection moves the account's pointer (surface 'picker') and
  // publishes active.changed; the device push follows from the bus. A
  // pointer-write failure is journaled, not fatal to the selection the device
  // already sees.
  try {
    const changedAt = await withUser(await deps.getDb(), userId, (tx) => setActive(tx, userId, conversationId, 'picker', { deviceId }));
    getAccountEvents().publish(userId, {
      type: 'active.changed', conversation_id: conversationId, title: conversation.title, surface: 'picker',
      changed_at: changedAt, device_id: exclusiveDeviceId(deps, userId, deviceId),
    });
    journal('v2.active_changed', { surface: 'picker' });
  } catch (error) {
    journal('v2.active_write_failed', { surface: 'picker', error: errorName(error) });
  }
  journal('v2.conversation_selected', { session: session.id, conversation_id: conversationId });
  return sendDto(socket, {
    v: V2_VERSION, type: 'conversation_selected', id: messageId('csel'), payload: { conversation_id: conversationId, title: conversation.title },
  });
}

export async function handleNewConversation(ctx: ControlContext, dto: Extract<ClientControlDto, { type: 'new_conversation' }>): Promise<void> {
  const { deps, socket, session } = ctx;
  if (session.stage !== 'ready') return sendError(socket, session, 'STATE_VIOLATION');
  const userId = sessionUserId(session);
  if (userId === undefined) return sendError(socket, session, 'INTERNAL');
  const requestId = dto.payload.request_id;
  const deviceId = sessionDeviceId(session);
  // A retry of an applied request re-sends its ack and writes nothing, so a
  // pointer another surface set since is never clobbered.
  const previous = session.lastNewConversation;
  if (previous !== undefined && previous.requestId === requestId) {
    journal('v2.new_conversation_duplicate', { session: session.id });
    return sendDto(socket, {
      v: V2_VERSION, type: 'conversation_cleared', id: messageId('ncnv'), payload: { request_id: requestId, changed_at: previous.changedAt },
    });
  }
  // Clearing the pointer is the whole action: the conversation is created
  // lazily on the next turn, so a cancelled or silent "new chat" leaves no
  // empty row. Surface 'device' because the CHECK constraint has no dedicated value.
  let changedAt: number;
  try {
    changedAt = await withUser(await deps.getDb(), userId, (tx) => setActive(tx, userId, null, 'device', { deviceId }));
  } catch (error) {
    journal('v2.active_write_failed', { surface: 'device', error: errorName(error) });
    return sendError(socket, session, 'INTERNAL');
  }
  session.activeConversationId = undefined;
  session.activeConversationTitle = undefined;
  session.messages = [];
  session.lastNewConversation = { requestId, changedAt };
  getAccountEvents().publish(userId, {
    type: 'active.changed', conversation_id: null, title: null, surface: 'device',
    changed_at: changedAt, device_id: exclusiveDeviceId(deps, userId, deviceId),
  });
  journal('v2.active_changed', { surface: 'device' });
  journal('v2.new_conversation', { session: session.id });
  return sendDto(socket, {
    v: V2_VERSION, type: 'conversation_cleared', id: messageId('ncnv'), payload: { request_id: requestId, changed_at: changedAt },
  });
}

export async function handleSelectSpace(ctx: ControlContext, dto: Extract<ClientControlDto, { type: 'select_space' }>): Promise<void> {
  const { deps, socket, session } = ctx;
  if (session.stage !== 'ready') return sendError(socket, session, 'STATE_VIOLATION');
  const userId = sessionUserId(session);
  if (userId === undefined) return sendError(socket, session, 'INTERNAL');
  const spaceId = dto.payload.space_id;
  // The store authorizes membership; unknown, not-a-member and archived are one
  // StoreNotFoundError, answered SPACE_NOT_FOUND with the pointer untouched.
  // The last committed write wins across surfaces. A thread pointer in any
  // other Space is cleared in the same transaction; threadClearedAt is that
  // write's stamp, else null.
  let result: { changedAt: number; name: string | null; threadClearedAt: number | null };
  const deviceId = sessionDeviceId(session);
  try {
    result = await withUser(await deps.getDb(), userId, async (tx) => {
      const space = await setActiveSpace(tx, userId, spaceId, 'device', deviceId);
      const active = await getActive(tx, userId, { deviceId });
      let threadClearedAt = active !== null && active.cleared ? active.changedAt : null;
      if (active?.kind === 'thread' && active.spaceId !== null && active.spaceId !== spaceId) {
        threadClearedAt = await clearActiveThreadInSpace(tx, userId, active.spaceId, { deviceId });
      }
      return { ...space, threadClearedAt };
    });
  } catch (error) {
    if (error instanceof StoreNotFoundError) return sendError(socket, session, 'SPACE_NOT_FOUND');
    journal('v2.active_space_write_failed', { session: session.id, surface: 'device', error: errorName(error) });
    return sendError(socket, session, 'INTERNAL');
  }
  const name = spaceId === null ? null : result.name;
  getAccountEvents().publish(userId, {
    type: 'active_space.changed', space_id: spaceId, name, surface: 'device', changed_at: result.changedAt,
    device_id: exclusiveDeviceId(deps, userId, deviceId),
  });
  journal('v2.active_space_changed', { session: session.id, surface: 'device' });
  if (result.threadClearedAt !== null) {
    applyActiveToSession(session, null);
    publishActiveCleared(userId, result.threadClearedAt, deviceId);
  }
  return sendDto(socket, { v: V2_VERSION, type: 'space_selected', id: messageId('ssel'), payload: { space_id: spaceId, name } });
}

/** The account bus the web routes publish on (getAccountEvents()). */
type AccountEventsPublisher = { publish: (userId: string, event: AccountEvent) => void };

/** The thread lives in another space than the body's space_id; rolls the write back. */
export class ThreadSpaceMismatchError extends Error {}

/** A cleared pointer to publish: the stamp and the surface it keeps. */
export type ClearedPointer = { changedAt: number; surface: ActiveSurface };

/** A cleared thread pointer tells the account's other surfaces (both null);
 *  deviceId scopes it to one device's own clear. */
export function publishCleared(
  events: AccountEventsPublisher, userId: string, cleared: ClearedPointer | null, deviceId: string | undefined,
): void {
  if (cleared === null) return;
  events.publish(userId, {
    type: 'active.changed', conversation_id: null, title: null, surface: cleared.surface, changed_at: cleared.changedAt, device_id: deviceId,
  });
  devicesJournal('v2.active_changed', { surface: cleared.surface });
}

/**
 * Moving the active space clears a thread pointer in any other space,
 * on the caller's transaction. A stale thread nulled by the read counts too.
 */
async function clearThreadOutside(tx: Db, userId: string, spaceId: string | null, deviceId: string | undefined): Promise<ClearedPointer | null> {
  // Scoped to deviceId's own effective pointer, never the account's.
  const active = await getActive(tx, userId, { deviceId });
  if (active === null) return null;
  if (active.cleared) return { changedAt: active.changedAt, surface: active.surface };
  if (active.kind !== 'thread' || active.spaceId === null) return null;
  if (spaceId !== null && active.spaceId === spaceId.toLowerCase()) return null;
  const changedAt = await clearActiveThreadInSpace(tx, userId, active.spaceId, { deviceId, moveAccount: deviceId === undefined });
  return changedAt === null ? null : { changedAt, surface: active.surface };
}

/** PUT /active-space once the caller owns deviceId: moves the Space pointer, publishes it and any cleared thread
 *  pointer, and returns the Space's name (null when cleared). */
export async function setWebActiveSpace(
  db: Db, events: AccountEventsPublisher, userId: string, spaceId: string | null, deviceId: string | undefined,
): Promise<{ name: string | null }> {
  // Without device_id, every device's own pointer is reset so none
  // overrides the account pointer just set; with it (moveAccount false),
  // only that device moves -- setActiveSpace and clearThreadOutside do the
  // device-vs-account scoping internally, in this one transaction.
  const result = await withUser(db, userId, async (tx) => {
    const space = await setActiveSpace(tx, userId, spaceId, 'web', deviceId, deviceId === undefined);
    // A space-only account move also clears a device's own conversation
    // pointer, not just its space one (setActiveSpace owns only the latter;
    // collaboration can't import this back without a module cycle, so the
    // reciprocal call lives here instead).
    if (deviceId === undefined) await clearDevicePointers(tx, userId);
    return { ...space, cleared: await clearThreadOutside(tx, userId, spaceId, deviceId) };
  });
  const name = spaceId === null ? null : result.name;
  events.publish(userId, {
    type: 'active_space.changed', space_id: spaceId, name, surface: 'web', changed_at: result.changedAt, device_id: deviceId,
  });
  devicesJournal('v2.active_space_changed', { surface: 'web' });
  publishCleared(events, userId, result.cleared, deviceId);
  return { name };
}

/** The transaction that moves both pointers (pointerOptions scopes the
 *  conversation write to one device). Throws ThreadSpaceMismatchError or the
 *  store's not-found error for the route's catch. */
async function writeActivePointers(
  db: Db, userId: string, ref: string | null, spaceId: string | null, threadId: string | undefined,
  pointerOptions: { deviceId?: string; moveAccount?: boolean }, deviceId: string | undefined,
): Promise<{ space: { name: string | null; changedAt: number }; changedAt: number; threadTitle: string | null }> {
  return withUser(db, userId, async (tx) => {
    // Unknown, archived and non-member threads throw the one not-found error.
    const changedAt = await setActive(tx, userId, ref, 'activate', pointerOptions);
    let threadTitle: string | null = null;
    if (threadId !== undefined) {
      // Scoped to deviceId, so a device-only PUT reads its OWN
      // just-written pointer here rather than the (untouched) account one.
      const active = await getActive(tx, userId, { deviceId });
      if (active?.spaceId !== spaceId?.toLowerCase()) throw new ThreadSpaceMismatchError();
      threadTitle = active?.title ?? null;
    }
    const space = await setActiveSpace(tx, userId, spaceId, 'web', deviceId, pointerOptions.moveAccount !== false);
    return { space, changedAt, threadTitle };
  });
}

/** PUT /active-conversation once the scope and title are resolved: moves both pointers, publishes both changes and
 *  returns the acknowledged title (the thread's for a thread) and Space name, for the route's 200 body. */
export async function setWebActiveConversation(
  db: Db, events: AccountEventsPublisher, userId: string,
  params: { ref: string | null; foundTitle: string | null; threadId: string | undefined; spaceId: string | null; deviceId: string | undefined },
): Promise<{ title: string | null; name: string | null }> {
  const { ref, foundTitle, threadId, spaceId, deviceId } = params;
  // A web PUT with device_id moves only that device, never the account
  // pointer (moveAccount false); writeActivePointers' two store calls clear
  // the other devices' pointers themselves when it IS an account-level
  // write (no device_id), so nothing more runs here.
  const pointerOptions = deviceId === undefined ? {} : { deviceId, moveAccount: false };
  const written = await writeActivePointers(db, userId, ref, spaceId, threadId, pointerOptions, deviceId);
  const title = threadId !== undefined ? written.threadTitle : foundTitle;
  const name = spaceId === null ? null : written.space.name;
  events.publish(userId, {
    type: 'active_space.changed', space_id: spaceId, name, surface: 'web', changed_at: written.space.changedAt, device_id: deviceId,
  });
  events.publish(userId, {
    type: 'active.changed', conversation_id: title === null ? null : ref, title, surface: 'activate',
    changed_at: written.changedAt, device_id: deviceId,
  });
  devicesJournal('v2.active_changed', { surface: 'activate' });
  return { title, name };
}
