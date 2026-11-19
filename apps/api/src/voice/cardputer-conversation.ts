/**
 * Device turns into and out of the durable conversation store. The Db and
 * account id are always passed in, and persistence failures are thrown: the
 * caller owns resilience and journals it. A device turn follows the pointer
 * pinned at turn_start; with none (or a deleted one) the first turn creates a
 * conversation titled deriveTitle(transcript) and sets the pointer in the same
 * transaction.
 */
import { convertToModelMessages, type ModelMessage, type UIMessage } from 'ai';
import type { Db } from '../platform/db/db.ts';
import type { ChatMessage } from '../conversations/chat-message.ts';
import { MAX_HISTORY_MESSAGES, trimHistory } from './turn-core.ts';
import { appendMessage, createConversation, deriveTitle, isToolPart, loadRecentHistory, markReplyInterrupted } from '../conversations/store.ts';
import { getConversationScope, isSharedConversation, type ConversationScope, type ConversationSpaceKind } from '../conversations/scope.ts';
import { listRecentMessages } from '../conversations/thread-store.ts';
import { now as stampNow, setActive } from '../conversations/active.ts';
import { StoreNotFoundError } from '../platform/db/db.ts';
import { UUID_RE } from '../conversations/active.ts';
import { parseDeviceRef, threadRef } from '../devices/conversation-ref.ts';
import { jsonbParam } from '../platform/db/jsonb.ts';
import { primeActiveConversation } from '../platform/observability/active-conversation.ts';
import { saveSharedTurn, type DeviceTurnEvents, type DeviceTurnInput } from './device-thread.ts';
import { withUser } from '../platform/db/db.ts';

interface DeviceTurn extends DeviceTurnInput {
  pinnedRef: string | undefined;
  prepared?: PreparedDeviceTurn;
  /** The run's tool parts (deviceToolParts), saved before the reply text in a private conversation. */
  toolParts?: ReadonlyArray<Record<string, unknown>>;
}

export interface PreparedDeviceTurn {
  conversationId: string;
  userMessageId: string;
  replyMessageId: string;
  scope: ConversationScope;
  created: boolean;
  changedAt: number;
}

interface PrepareInput {
  pinnedRef: string | undefined;
  transcriptText: string;
  deviceId: string | null;
  userMessageId: string;
  replyMessageId: string;
}

function privateScope(scope: ConversationScope | null): scope is ConversationScope {
  return scope !== null && scope.spaceKind === 'private' && !scope.spaceArchived && scope.archivedAt === null;
}

async function existingAnchor(tx: Db, userId: string, messageId: string): Promise<ConversationScope | null> {
  const rows = await tx.query<{ conversation_id: string; role: string; origin: string }>(
    'select conversation_id, role, origin from bob.messages where id = $1', [messageId]);
  const row = rows[0];
  if (!row) return null;
  const scope = await getConversationScope(tx, userId, row.conversation_id);
  if (row.role !== 'user' || row.origin !== 'device' || !privateScope(scope)) throw new StoreNotFoundError('device_turn_anchor_invalid');
  return scope;
}

interface PrepareRow {
  outcome: 'existing' | 'anchor_invalid' | 'not_private' | 'scope_invalid' | 'not_found' | 'prepared';
  conversationId: string;
  spaceId: string | null;
  spaceName: string | null;
  title: string;
  created: boolean;
}

/** The conversation id a pinned ref names for the scope read. A ref that
 *  parses to nothing is passed as-is: no conversation has that id, so it
 *  reads as unknown (not private), after the anchor check. */
function pinnedConversationId(ref: string | undefined): string | null {
  if (ref === undefined) return null;
  const parsed = parseDeviceRef(ref);
  if (parsed === null) return ref;
  return parsed.kind === 'thread' ? parsed.threadId : parsed.conversationId;
}

/** Commit the private user anchor before generation; IDs are allocated by the server, never the device.
 *  One call to bob.prepare_device_turn (20261028060000) runs every step under the caller's RLS. */
export async function preparePrivateDeviceTurn(db: Db, userId: string, input: PrepareInput): Promise<PreparedDeviceTurn | null> {
  const pointerDeviceId = input.deviceId !== null && UUID_RE.test(input.deviceId) ? input.deviceId : null;
  const changedAt = stampNow();
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<PrepareRow>(
      `select * from bob.prepare_device_turn($1, $2, $3, $4, ${jsonbParam('$5')}, $6, $7, $8)`,
      [userId, input.userMessageId, pinnedConversationId(input.pinnedRef), deriveTitle(input.transcriptText),
        JSON.stringify([{ type: 'text', text: input.transcriptText }]), input.deviceId, pointerDeviceId, changedAt],
    );
    const row = rows[0];
    if (!row || row.outcome === 'anchor_invalid') throw new StoreNotFoundError('device_turn_anchor_invalid');
    if (row.outcome === 'not_private') return null;
    if (row.outcome === 'scope_invalid') throw new StoreNotFoundError('device_turn_scope_invalid');
    if (row.outcome === 'not_found') throw new StoreNotFoundError('conversation not found');
    const scope: ConversationScope = { conversationId: row.conversationId, spaceId: row.spaceId, spaceKind: 'private',
      spaceName: row.spaceName, spaceArchived: false, archivedAt: null, title: row.title };
    const prepared = { conversationId: row.conversationId, userMessageId: input.userMessageId, replyMessageId: input.replyMessageId, scope };
    if (row.outcome === 'existing') return { ...prepared, created: false, changedAt: 0 };
    primeActiveConversation(userId, row.conversationId);
    return { ...prepared, created: row.created, changedAt };
  });
}

/** Failure releases only this server-owned anchor; crash-held anchors are never guessed complete. */
export async function releasePreparedDeviceTurn(db: Db, userId: string, prepared: PreparedDeviceTurn): Promise<void> {
  await withUser(db, userId, async (tx) => {
    await tx.query(`update bob.messages set device_turn_pending = false
      where id = $1 and conversation_id = $2 and role = 'user' and origin = 'device'`, [prepared.userMessageId, prepared.conversationId]);
  });
}

function preparedReplyParts(turn: DeviceTurn): unknown[] {
  const toolParts = turn.toolParts ?? [];
  const textParts = turn.replyText === '' ? [] : [{ type: 'text', text: turn.replyText }];
  return [...toolParts, ...(toolParts.length > 0 && textParts.length > 0 ? [{ type: 'step-start' }] : []), ...textParts];
}

async function finishPreparedTurn(db: Db, userId: string, turn: DeviceTurn, prepared: PreparedDeviceTurn): Promise<DeviceTurnPersistResult> {
  await withUser(db, userId, async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`device-turn:${prepared.userMessageId}`]);
    const scope = await existingAnchor(tx, userId, prepared.userMessageId);
    if (!scope || scope.conversationId !== prepared.conversationId) throw new StoreNotFoundError('device_turn_anchor_invalid');
    const existing = await tx.query<{ conversation_id: string; role: string }>('select conversation_id, role from bob.messages where id = $1', [prepared.replyMessageId]);
    if (existing[0]) {
      if (existing[0].conversation_id !== scope.conversationId || existing[0].role !== 'assistant') throw new StoreNotFoundError('device_turn_reply_invalid');
      return;
    }
    await appendMessage(tx, userId, scope.conversationId, { id: prepared.replyMessageId, role: 'assistant', origin: 'device', parts: preparedReplyParts(turn) });
    await stampDevice(tx, prepared.replyMessageId, turn.deviceId ?? null);
    if (turn.heardChars !== undefined) await markReplyInterrupted(tx, userId, scope.conversationId, prepared.replyMessageId, turn.heardChars);
    await releasePreparedDeviceTurn(tx, userId, prepared);
  });
  return { conversationId: prepared.conversationId, userMessageId: prepared.userMessageId, replyMessageId: prepared.replyMessageId,
    spaceId: prepared.scope.spaceId, spaceKind: 'private', title: prepared.scope.title, created: prepared.created,
    changedAt: prepared.changedAt, outcome: 'completed', published: 0, fellBackFromShared: false };
}

interface DeviceTurnPersistResult {
  /** The device ref the turn landed in (`thr_<uuid>` for a shared conversation). */
  conversationId: string;
  spaceId: string | null;
  spaceKind: ConversationSpaceKind;
  /** Private: the turn created its conversation (pointer absent/cleared). Shared:
   *  the turn's message was new (false when a retry found it already saved). */
  created: boolean;
  title: string;
  userMessageId: string;
  replyMessageId: string | null;
  outcome: 'completed' | 'busy' | 'duplicate' | 'unheard';
  /** thread.message_appended events published (shared only). */
  published: number;
  /** The pointer's changed_at stamp; null when the turn wrote no pointer (shared). */
  changedAt: number | null;
  /** The pinned conversation was shared but lost or archived: saved to a new private one. */
  fellBackFromShared: boolean;
}

/** Stamps a just-appended message with the device that spoke it, in the
 *  append's transaction. The store's append has no device field; the
 *  migration grants update on this one column only. The id resolves through
 *  bob.devices under RLS: a device deleted mid-session, or not the caller's,
 *  stamps null and never fails the turn. */
async function stampDevice(tx: Db, messageId: string, deviceId: string | null): Promise<void> {
  if (deviceId === null) return;
  await tx.query(
    `UPDATE bob.messages SET device_id = (SELECT d.id FROM bob.devices d WHERE d.id::text = $1) WHERE id = $2`,
    [deviceId, messageId],
  );
}

/**
 * Saves one device turn into the conversation its pinned ref names, by that
 * conversation's space kind. A live shared (pair or group) conversation gets
 * the thread steps (saveSharedTurn: heard slice only, invocation claimed,
 * members told). Otherwise the private steps run: the pinned conversation, or a
 * new one titled deriveTitle(transcript) when it is gone, hidden, or a lost
 * shared one; the FULL reply is saved, then cut to what was heard on barge-in.
 * Failures are thrown for the caller to journal.
 */
export async function persistDeviceTurn(db: Db, userId: string, turn: DeviceTurn, events: DeviceTurnEvents): Promise<DeviceTurnPersistResult>;
/** The positional private-only form (no events, no retry key). */
export async function persistDeviceTurn(
  db: Db, userId: string, pinnedRef: string | undefined, transcriptText: string, replyText: string, deviceId?: string | null,
): Promise<DeviceTurnPersistResult>;
export async function persistDeviceTurn(
  db: Db,
  userId: string,
  input: DeviceTurn | string | undefined,
  eventsOrTranscript: DeviceTurnEvents | string,
  replyText = '',
  deviceId: string | null = null,
): Promise<DeviceTurnPersistResult> {
  const turn: DeviceTurn = typeof input === 'object'
    ? input
    : { pinnedRef: input, sessionId: '', turnRef: '', deviceId, transcriptText: String(eventsOrTranscript), replyText };
  const events = typeof eventsOrTranscript === 'string' ? { publish: () => undefined } : eventsOrTranscript;
  if (turn.prepared) return finishPreparedTurn(db, userId, turn, turn.prepared);
  const scope = turn.pinnedRef === undefined ? null : await getConversationScope(db, userId, turn.pinnedRef);
  const shared = isSharedConversation(turn.pinnedRef, scope);
  if (shared && scope !== null) {
    const saved = await saveSharedTurn(db, userId, scope, turn, events);
    if (saved !== null) {
      return {
        ...saved, conversationId: threadRef(scope.conversationId), spaceKind: scope.spaceKind, title: scope.title,
        changedAt: null, fellBackFromShared: false,
      };
    }
  }
  const saved = await savePrivateTurn(db, userId, shared ? null : scope, turn);
  return { ...saved, outcome: 'completed', published: 0, fellBackFromShared: shared };
}

/**
 * The private steps: the user's transcript and the assistant's reply, each with
 * origin 'device', into the scoped conversation or, with none, a new
 * one titled deriveTitle(transcript). The pointer is written with
 * surface 'device' in the SAME transaction as the creation or the user-message
 * append, once per turn. deviceId stamps both messages.
 * The FULL reply is saved; with heardChars it is then cut back to what
 * was heard and flagged interrupted, as web voice's heard-portion PATCH does.
 */
async function savePrivateTurn(
  db: Db,
  userId: string,
  scope: ConversationScope | null,
  turn: DeviceTurn,
): Promise<Omit<DeviceTurnPersistResult, 'outcome' | 'published' | 'fellBackFromShared'>> {
  const deviceId = turn.deviceId ?? null;
  // A device turn also writes its OWN pointer, leaving other devices' alone.
  // setActive binds deviceId straight into a uuid column, so a non-uuid id
  // would throw; skip it instead, as stampDevice does.
  const pointerOptions = deviceId !== null && UUID_RE.test(deviceId) ? { deviceId } : {};
  let conversationId: string;
  let title: string;
  const spaceId = scope?.spaceId ?? null;
  let changedAt = 0;
  const created = scope === null;
  if (scope === null) {
    const outcome = await withUser(db, userId, async (tx) => {
      const record = await createConversation(tx, userId, deriveTitle(turn.transcriptText));
      const stamp = await setActive(tx, userId, record.id, 'device', pointerOptions);
      return { record, stamp };
    });
    conversationId = outcome.record.id;
    title = outcome.record.title;
    changedAt = outcome.stamp;
  } else {
    conversationId = scope.conversationId;
    title = scope.title;
  }
  const userMessageId = await withUser(db, userId, async (tx) => {
    const stored = await appendMessage(tx, userId, conversationId, {
      role: 'user',
      parts: [{ type: 'text', text: turn.transcriptText }],
      origin: 'device',
    });
    if (!stored) throw new Error('persistDeviceTurn: no stored message');
    await stampDevice(tx, stored.id, deviceId);
    // The pointer write rides the turn's user-message append unless the
    // creation already wrote it a moment ago (one write per turn).
    if (!created) changedAt = await setActive(tx, userId, conversationId, 'device', pointerOptions);
    return stored.id;
  });
  // The tools the turn ran are saved with it, as web chat saves them, so the
  // next turn's model sees the call it made and not just its words.
  const toolParts = turn.toolParts ?? [];
  const textPart = { type: 'text', text: turn.replyText };
  const replyMessageId = await withUser(db, userId, async (tx) => {
    const reply = await appendMessage(tx, userId, conversationId, {
      role: 'assistant',
      // With tools, an empty reply adds no (empty) text part: a provider can reject one.
      parts: toolParts.length === 0 ? [textPart] : [...toolParts, ...(turn.replyText === '' ? [] : [{ type: 'step-start' }, textPart])],
      origin: 'device',
    });
    if (reply) await stampDevice(tx, reply.id, deviceId);
    return reply?.id ?? null;
  });
  if (turn.heardChars !== undefined && replyMessageId !== null) {
    await markReplyInterrupted(db, userId, conversationId, replyMessageId, turn.heardChars);
  }
  return { conversationId, spaceId, spaceKind: 'private', created, title, userMessageId, replyMessageId, changedAt };
}

/** A shared conversation's newest messages as the agent's history, other
 *  members included (author null = assistant). A lost one (null scope) throws
 *  StoreNotFoundError, so the caller falls back to its in-memory history. */
export async function loadDeviceThreadHistory(db: Db, userId: string, scope: ConversationScope | null): Promise<ChatMessage[]> {
  if (scope === null) throw new StoreNotFoundError('conversation not found');
  const rows = await listRecentMessages(db, userId, scope.conversationId, MAX_HISTORY_MESSAGES);
  return rows.filter((row) => row.content.trim().length > 0);
}

/**
 * Reads a conversation's stored messages as the agent's history. A text
 * message flattens to { role, content: string }; an assistant message that
 * ran tools becomes its tool call, result and text (toolTurnMessages).
 * Each message contributes its SELECTED version (falling back to the first);
 * a message that flattens to empty content is skipped, because
 * ChatMessage.content is min(1). The shared trimHistory rule picks the window,
 * so retention lives in exactly one place.
 */
export async function loadCardputerHistory(
  db: Db,
  userId: string,
  conversationId: string,
  excludeMessageId?: string,
): Promise<ModelMessage[]> {
  // The chunked window, taken over the stored rows by their
  // (contiguous, 0-based) positions BEFORE empty messages are skipped, so its
  // first message moves only in steps of 20. The window is at most 40 rows,
  // all among the newest 40, so one bounded read covers it; empties just drop.
  const rows = await loadRecentHistory(db, userId, conversationId, MAX_HISTORY_MESSAGES, { textOnly: true });
  const window = trimHistory(rows, MAX_HISTORY_MESSAGES, rows[0]?.position ?? 0);
  const messages: ModelMessage[] = [];
  for (const row of window) {
    if (row.id === excludeMessageId) continue;
    // A reply that ran tools replays them (D1): text alone taught the model
    // to confirm an action without calling the tool.
    if (row.role === 'assistant' && row.parts.some(isToolPart)) {
      messages.push(...(await toolTurnMessages(row.parts)));
      continue;
    }
    const content = flattenParts(row.parts);
    if (content.length > 0) messages.push({ role: row.role, content });
  }
  return messages;
}

/**
 * An assistant message that ran tools, as the model messages the SDK makes of
 * it (web chat's conversion): the tool call, its result, then the text. Only
 * text, step-start and tool parts pass; a file part becomes its placeholder,
 * since the history read drops its url. An unfinished call is dropped. If the
 * parts will not convert, the message's text alone is replayed.
 */
async function toolTurnMessages(parts: unknown[]): Promise<ModelMessage[]> {
  const kept: unknown[] = [];
  for (const part of parts) {
    const type = (part as { type?: unknown } | null)?.type;
    // An empty text part (a reply cut before anything was heard) is not passed on.
    if (type === 'text') {
      if ((part as { text?: unknown }).text !== '') kept.push(part);
    } else if (type === 'step-start' || isToolPart(part)) kept.push(part);
    else if (type === 'file') kept.push({ type: 'text', text: flattenParts([part]) });
  }
  try {
    return await convertToModelMessages([{ role: 'assistant', parts: kept } as Omit<UIMessage, 'id'>], { ignoreIncompleteToolCalls: true });
  } catch {
    const content = flattenParts(parts);
    return content.length > 0 ? [{ role: 'assistant', content }] : [];
  }
}

/**
 * Flattens a stored version's parts into one plain-text string. A 'text' part
 * contributes its text; a 'file' part contributes a short bracketed
 * placeholder (never the base64 data URL, which can be megabytes); any other
 * part type contributes nothing. Pieces are joined with a single space.
 */
function flattenParts(parts: unknown[]): string {
  const pieces: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'object' || part === null) continue;
    const candidate = part as { type?: unknown };
    if (candidate.type === 'text') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') pieces.push(text);
    } else if (candidate.type === 'file') {
      const mediaType = (part as { mediaType?: unknown }).mediaType;
      pieces.push(typeof mediaType === 'string' && mediaType.length > 0 ? `[file: ${mediaType}]` : '[file]');
    }
  }
  return pieces.join(' ').trim();
}
