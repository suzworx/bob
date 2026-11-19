import type { WebSocket } from 'ws';
import { debugLog, recordObservationMetrics, toSpanAttrs, traceSpan } from '@bob/ai';
import {
  CONVERSATIONS_LIST_CAP, FirmwareVersionSchema, INITIAL_CREDIT_BYTES, PCM16_16K_MONO_FORMAT,
  SPACES_LIST_CAP, V2_VERSION, compareFirmwareVersions, messageId,
  type ActiveConversationDto, type ActiveSpaceDto, type ClientControlDto, type FirmwareCap,
  type OtaOfferWire, type PairCodeDto, type PairDeniedDto, type PairExpiredDto, type PairedDto,
  type PairingRequiredDto, type ServerControlDto, type SessionDto, type SpaceRef, type StatusStage, type UpdateRequiredReason, type V2ErrorCode,
} from './protocol.ts';
import { moduleJournal } from '../platform/logger.ts';
import { type Db } from '../platform/db/db.ts';
import { createTokenBucket } from '../platform/http/rate-limit.ts';
import { getActive } from '../conversations/active.ts';
import { listConversations, type StoredConversation } from '../conversations/store.ts';
import { listThreads } from '../conversations/thread-store.ts';
import { getActiveSpace } from '../spaces/active.ts';
import { listSpaces } from '../spaces/store.ts';
import { threadRef } from '../devices/conversation-ref.ts';
import { type DeviceAuth } from '../devices/device-auth.ts';
import { getAccountEvents } from '../devices/pairing-service.ts';
import { forFirmware, setDeviceSettings } from '../devices/settings-store.ts';
import type { DeviceSessions } from './device-sessions.ts';
import { rejectControl } from './control-diagnostics.ts';
import { deviceCorrelation } from './socket-diagnostics.ts';
import { capsOf } from './device-caps.ts';
import { flushUplink, pcmFrames } from './turn/uplink.ts';
import { closeTurnRoot, runInTurnRoot, setTurnRootConversation, turnRootOf } from './turn/turn-root.ts';
import { pinDeviceConversation } from './turn-start-conversation.ts';
import { recordTurnEnd } from './turn/stream-stt.ts';

const journal = moduleJournal('voice');
const deviceJournal = moduleJournal('devices', 'device');


/** The session state plus the upgrade outcome. `auth` is absent only while server.ts has not
 *  passed request.deviceAuth through, in which case hello answers a plain `welcome`. */
export interface DeviceSession extends SessionDto {
  /** This connection negotiated the bounded turn_start name preference. */
  assistantNameSupported?: boolean;
  auth?: DeviceAuth;
  /** The pairing_id of the code shown to an unpaired socket; a new pair_request unregisters it. */
  pairingId?: string;
  /** The pinned conversation's title, so active.changed and the welcome need no extra store read. */
  activeConversationTitle?: string;
  /** The last new_conversation this session applied: a repeat of the same
   *  request_id re-sends this ack instead of clearing the pointer again, so a
   *  retry cannot clobber a pointer another surface set in between. */
  lastNewConversation?: { requestId: string; changedAt: number };
  /** Set once the first device_state is handled: a web change still pending then is re-pushed once, never again. */
  settingsReported?: boolean;
  /** When device_control was last sent to this socket (for ack_ms). */
  settingsPushedAt?: number;
  /** The hello's fw_version, 'unknown' when absent or 'invalid'. */
  fwVersion?: string;
  /** Set when hello answered update_required; turns are refused. */
  updateRequired?: boolean;
  /** The last check_update answer and when it was given (one fresh answer a minute). */
  lastUpdateCheck?: { at: number; payload: UpdateOfferPayload };
}

export type UpdateOfferPayload = OtaOfferWire | { offer: null };

export interface SessionDeps {
  getDb(): Promise<Db>;
  deviceSessions: DeviceSessions;
}

export interface ControlContext {
  deps: SessionDeps;
  socket: WebSocket;
  session: DeviceSession;
  onTurnEnd: (session: SessionDto, turnRef: string) => void | Promise<void>;
}

export function createSession(auth?: DeviceAuth): DeviceSession {
  return {
    id: messageId('session'), stage: 'await_hello', nextUplinkSeq: 0, creditBytes: INITIAL_CREDIT_BYTES,
    audioChunks: [], totalAudioBytes: 0, messages: [], formatId: PCM16_16K_MONO_FORMAT, downFramesSent: 0, auth,
  };
}

export function resetSession(deps: Pick<SessionDeps, 'deviceSessions'>, session: SessionDto): void {
  flushUplink(session, sessionUserId(session as DeviceSession));
  // A running pipeline is still inside the root; handleTurnEnd ends it when the pipeline settles.
  if (session.turnDone === undefined) closeTurnRoot(session);
  session.stage = 'ready'; session.turnRef = undefined; session.nextUplinkSeq = 0; session.creditBytes = INITIAL_CREDIT_BYTES;
  session.audioChunks = []; session.totalAudioBytes = 0;
  // The finished turn's abort handle goes with it (a cancel already holding
  // its turnDone still awaits the same promise).
  session.turnAbort = undefined; session.turnDone = undefined;
  // A held active_conversation push is flushed now that the session is ready
  // again: the turn calls resetSession right after playback_end, which is the
  // point the contract allows the display to redraw.
  deps.deviceSessions.flushPending(session);
}


/** The server-originated pairing envelopes, which ServerControlDtoSchema does
 *  not list, so sendDto accepts them too. */
type PairingServerControlDto =
  | PairingRequiredDto | PairCodeDto | PairedDto | PairExpiredDto | PairDeniedDto | ActiveConversationDto | ActiveSpaceDto;

/** Messages sent only to a device whose hello caps include the token. */
const CAP_GATED: Partial<Record<string, FirmwareCap>> = { reply_text: 'reply_text' };

export function sendDto(socket: WebSocket, dto: ServerControlDto | PairingServerControlDto): void {
  if (socket.readyState !== 1) return;
  const cap = CAP_GATED[dto.type];
  const caps = capsOf(socket);
  if (cap !== undefined && caps !== undefined && !caps.has(cap)) {
    journal('v2.message_skipped', { type: dto.type, reason: 'no_cap' });
    return;
  }
  socket.send(JSON.stringify(dto));
}

export function sendStatus(socket: WebSocket, session: SessionDto, stage: StatusStage, turnRef: string): void {
  sendDto(socket, { v: V2_VERSION, type: 'status', id: messageId('status'), turn_ref: turnRef, payload: { stage } });
}

export function errorDto(session: SessionDto, code: V2ErrorCode): ServerControlDto {
  return { v: V2_VERSION, type: 'error', id: messageId('error'), ...(session.turnRef ? { turn_ref: session.turnRef } : {}), payload: { code } };
}

export function sendError(socket: WebSocket, session: SessionDto, code: V2ErrorCode): void {
  rejectControl(code);
  journal('v2.error', { session: session.id, stage: session.stage, code }); sendDto(socket, errorDto(session, code));
  debugLog('session.error_sent', {
    session: session.id, stage: session.stage, code, turn_ref: session.turnRef,
    uplink_frames: pcmFrames(session.totalAudioBytes), uplink_msgs: session.nextUplinkSeq, credit_bytes: session.creditBytes,
  });
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}


const PAIR_REQUEST_RPM = 5;

export function envPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

let pairRequestBucket = createTokenBucket(envPositiveInt('BOB_PAIR_REQUEST_RPM', PAIR_REQUEST_RPM));

/** Test seam: rebuilds the pair_request bucket, re-reading the env rate. */
export function resetPairRequestBucket(): void {
  pairRequestBucket = createTokenBucket(envPositiveInt('BOB_PAIR_REQUEST_RPM', PAIR_REQUEST_RPM));
}

/** Takes one pair_request token for this client IP; false when it is over the rate. */
export function takePairRequestToken(ip: string): boolean {
  return pairRequestBucket.take(ip);
}


/** The account a device or legacy session acts as; undefined for a session
 *  with no auth (pre-wiring server.ts), whose store lookups are skipped. */
export function sessionUserId(session: DeviceSession): string | undefined {
  const auth = session.auth;
  return auth !== undefined && (auth.kind === 'device' || auth.kind === 'legacy') ? auth.userId : undefined;
}

/** The paired device id behind this session, so the active-pointer helpers use
 *  that device's own pointer. Undefined for a legacy session (no device of its
 *  own) or one with no auth yet, which keep account-only behaviour. */
export function sessionDeviceId(session: DeviceSession): string | undefined {
  const auth = session.auth;
  return auth?.kind === 'device' ? auth.deviceId : undefined;
}

/** Applies the active pointer to the session, pinning its id for a turn. A null
 *  result leaves the session unpinned: the next device turn creates a
 *  conversation instead. The in-memory history is dropped too, or a
 *  cleared/deleted pointer would feed the previous conversation into the next
 *  agent call (buildAgentMessages falls back to it when nothing is pinned). */
export function applyActiveToSession(session: DeviceSession, active: Awaited<ReturnType<typeof getActive>> | null): void {
  if (active !== null && active.conversationId !== null) {
    session.activeConversationId = active.conversationId;
    session.activeConversationTitle = active.title ?? undefined;
  } else {
    session.activeConversationId = undefined;
    session.activeConversationTitle = undefined;
    session.messages = [];
  }
}

/** How many of the active Space's threads the picker lists. */
const PICKER_THREAD_SLOTS = 5;

/** A read or a Space move cleared a thread pointer, so the account's other
 *  surfaces (and its device) learn the null pointer. deviceId, when the clear
 *  came from that device's own pointer, scopes the push to that one device. */
export function publishActiveCleared(userId: string, changedAt: number, deviceId?: string): void {
  getAccountEvents().publish(userId, {
    type: 'active.changed', conversation_id: null, title: null, surface: 'device', changed_at: changedAt, device_id: deviceId,
  });
  journal('v2.active_changed', { surface: 'device' });
}

/** The picker's thread rows. With an active Space, up to PICKER_THREAD_SLOTS of
 *  its non-archived threads, most recently updated first (listThreads' order);
 *  the current thread pointer is always present, taking the last slot when it
 *  is not already listed. deviceId scopes both pointer reads to the calling
 *  device, so device B's picker is never built from device A's pointer. */
async function pickerThreads(db: Db, userId: string, deviceId?: string): Promise<{ id: string; title: string }[]> {
  const space = await getActiveSpace(db, userId, deviceId);
  if (space !== null && space.cleared) {
    getAccountEvents().publish(userId, {
      type: 'active_space.changed', space_id: null, name: null, surface: 'device', changed_at: space.changedAt, device_id: deviceId,
    });
  }
  const rows = space === null || space.spaceId === null
    ? []
    : (await listThreads(db, userId, space.spaceId)).slice(0, PICKER_THREAD_SLOTS)
      .map((thread) => ({ id: threadRef(thread.id), title: thread.title }));
  const active = await getActive(db, userId, { deviceId });
  if (active !== null && active.cleared) publishActiveCleared(userId, active.changedAt, deviceId);
  if (active?.kind === 'thread' && active.conversationId !== null && active.title !== null) {
    const current = active.conversationId;
    if (!rows.some((row) => row.id === current)) {
      if (rows.length === PICKER_THREAD_SLOTS) rows.pop();
      rows.push({ id: current, title: active.title });
    }
  }
  return rows;
}


/** Why a device must update before it may take turns, or undefined. With no
 *  minimum nothing is required. An absent version (all firmware that predates
 *  the field) is never gated, or setting a minimum would lock out the whole
 *  fleet; a reported version that is not SemVer cannot prove it is new enough. */
export function updateRequiredReason(fwVersion: string | undefined, minVersion: string | undefined): UpdateRequiredReason | undefined {
  if (minVersion === undefined || fwVersion === undefined) return undefined;
  if (!FirmwareVersionSchema.safeParse(fwVersion).success) return 'unknown_version';
  return compareFirmwareVersions(fwVersion, minVersion) < 0 ? 'below_minimum' : undefined;
}


export async function handleTurnStart(ctx: ControlContext, dto: Extract<ClientControlDto, { type: 'turn_start' }>): Promise<void> {
  const { deps, socket, session } = ctx;
  if (session.stage !== 'ready') return sendError(socket, session, 'STATE_VIOLATION');
  if (dto.payload.assistant_name !== undefined && !session.assistantNameSupported) {
    return sendError(socket, session, 'BAD_MESSAGE');
  }
  session.assistantName = dto.payload.assistant_name === 'bob' ? 'Bob' : undefined;
  session.stage = 'capturing'; session.turnRef = dto.turn_ref; session.nextUplinkSeq = 0; session.creditBytes = INITIAL_CREDIT_BYTES;
  // turn_id joins this to the stage events and v2.turn_completed.
  const userId = sessionUserId(session);
  await traceSpan(
    'device-turn-started',
    toSpanAttrs({ surface: 'device', workflowNamespace: session.id, turnId: dto.turn_ref, ...(userId !== undefined ? { userId } : {}) }),
    () => journal('v2.turn_started', { session: session.id, turn_id: dto.turn_ref, stage: session.stage, assistant_name: dto.payload.assistant_name }),
  );
  debugLog('session.turn_start', { session: session.id, turn_ref: dto.turn_ref, credit_bytes: session.creditBytes });
  // Resolve the active pointer once here and pin it for the whole turn: a
  // mid-turn pointer change must not move this turn, which persists to the
  // pinned id.
  const claimed = dto.payload.conversation_id;
  if (userId === undefined) {
    if (claimed !== undefined) journal('v2.turn_conversation_ignored', { session: session.id, reason: 'unpaired' });
    return;
  }
  try {
    const db = await deps.getDb();
    const deviceId = sessionDeviceId(session);
    const active = await getActive(db, userId, { deviceId });
    applyActiveToSession(session, active);
    if (active !== null && active.cleared) publishActiveCleared(userId, active.changedAt, deviceId);
  } catch (error) {
    journal('v2.conversation_resolve_failed', { session: session.id, error: errorName(error) });
  }
  if (claimed !== undefined && claimed !== session.activeConversationId) await pinDeviceConversation(deps.getDb, session, userId, claimed);
  const conversationId = deviceCorrelation(session, userId).conversationId;
  if (conversationId !== undefined) setTurnRootConversation(session, conversationId);
}

export async function handleTurnEnd(ctx: ControlContext, dto: Extract<ClientControlDto, { type: 'turn_end' }>): Promise<void> {
  const { socket, session, onTurnEnd } = ctx;
  if (session.stage !== 'capturing' || dto.turn_ref !== session.turnRef) return sendError(socket, session, 'SEQUENCE_GAP');
  const expectedSeq = session.nextUplinkSeq === 0 ? 0 : session.nextUplinkSeq - 1;
  if (dto.seq !== expectedSeq) return sendError(socket, session, 'SEQUENCE_GAP');
  recordTurnEnd(session, dto.turn_ref); // the server's turn_end receipt, for eot_lag_ms and eot_source
  session.stage = 'responding'; flushUplink(session, sessionUserId(session)); // the receive window ends here
  await traceSpan(
    'device-turn-ended',
    toSpanAttrs({ surface: 'device', workflowNamespace: session.id, turnId: dto.turn_ref, metadata: { frames: String(pcmFrames(session.totalAudioBytes)) } }),
    () => journal('v2.turn_ended', { session: session.id, turn_id: dto.turn_ref, stage: session.stage, frames: pcmFrames(session.totalAudioBytes), msgs: session.nextUplinkSeq }),
  );
  debugLog('session.turn_end', {
    session: session.id, turn_ref: dto.turn_ref, uplink_frames: pcmFrames(session.totalAudioBytes), uplink_msgs: session.nextUplinkSeq, uplink_bytes: session.totalAudioBytes,
    uplink_duration_ms: Math.round((session.totalAudioBytes / 2 / 16_000) * 1000),
  });
  // The turn gets its own abort handle; `cancel` aborts it and waits for the
  // pipeline to unwind (playback_end if started, status idle, reset), so a
  // turn_start queued behind the cancel always finds ready. The whole pipeline
  // runs inside the workflow root: STT, agent generations, tool calls, TTS
  // usage, and playback nest under one trace.
  session.turnAbort = new AbortController();
  const userId = sessionUserId(session);
  const root = turnRootOf(session);
  const done = runInTurnRoot(session, dto.turn_ref, () => traceSpan(
    'turn-pipeline',
    toSpanAttrs({
      surface: 'device', workflowNamespace: session.id, turnId: dto.turn_ref,
      ...deviceCorrelation(session, userId),
    }),
    () => onTurnEnd(session, dto.turn_ref),
  ));
  // The root ends once the pipeline has unwound (resetSession leaves it open while turnDone is set).
  if (done instanceof Promise) {
    session.turnDone = done.catch(() => undefined);
    void done.then(() => root?.end(), () => root?.end(true));
  } else root?.end();
}

export async function handleCancel(ctx: ControlContext): Promise<void> {
  const { deps, socket, session } = ctx;
  if (session.stage === 'await_hello') return sendError(socket, session, 'STATE_VIOLATION');
  await traceSpan(
    'device-turn-cancelled',
    toSpanAttrs({ surface: 'device', workflowNamespace: session.id, ...(session.turnRef !== undefined ? { turnId: session.turnRef } : {}) }),
    () => journal('v2.cancelled', { session: session.id, stage: session.stage }),
  );
  debugLog('session.cancelled', { session: session.id, stage: session.stage, turn_ref: session.turnRef });
  const inFlight = session.turnDone;
  if (session.turnAbort !== undefined && inFlight !== undefined) {
    session.turnAbort.abort();
    await inFlight;
    return;
  }
  resetSession(deps, session);
}


type DeviceStatePayload = Extract<ClientControlDto, { type: 'device_state' }>['payload'];
type RingKeys = { ring_seconds: number; ring_sound: NonNullable<DeviceStatePayload['ring_sound']> } | Record<string, never>;

/** The optional health keys present in a device_state, or undefined when none is. */
function healthFields(payload: DeviceStatePayload): Partial<Record<'rssi_dbm' | 'heap_free' | 'heap_largest' | 'log_dropped', number>> | undefined {
  const fields: Partial<Record<'rssi_dbm' | 'heap_free' | 'heap_largest' | 'log_dropped', number>> = {};
  for (const key of ['rssi_dbm', 'heap_free', 'heap_largest', 'log_dropped'] as const) {
    const value = payload[key];
    if (value !== undefined) fields[key] = value;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

/** Stores a paired device's reported settings. They are the truth unless a web
 *  change is pending; then a matching report clears it, the session's first
 *  differing report gets one re-push (it may predate the push sent after
 *  welcome), and any later differing report wins, so a clamped value never sticks. */
async function syncReportedSettings(
  ctx: ControlContext, userId: string, deviceId: string, payload: DeviceStatePayload, ring: RingKeys, firstReport: boolean,
): Promise<void> {
  const { deps, socket, session } = ctx;
  const { volume, muted, mode, dnd, wake_word: wakeWord } = payload;
  const wake = wakeWord !== undefined ? { wake_word: wakeWord } : {};
  try {
    const db = await deps.getDb();
    const result = await setDeviceSettings(db, userId, deviceId, { volume, muted, mode, dnd, ...ring, ...wake }, { keepPending: firstReport });
    if (result.outcome === 'synced') {
      const pushedAt = session.settingsPushedAt;
      journal('v2.device_settings_synced', {
        session: session.id, direction: 'to_device', ...(pushedAt !== undefined ? { ack_ms: Date.now() - pushedAt } : {}),
      });
    } else if (result.outcome === 'kept_pending') {
      deps.deviceSessions.pushDeviceControl(socket, session, forFirmware(result.settings, result.ringReported, result.wakeWordPending));
    } else if (result.outcome === 'device_override') {
      journal('v2.device_settings_synced', { session: session.id, direction: 'device_override' });
    } else if (firstReport) {
      journal('v2.device_settings_synced', { session: session.id, direction: 'from_device' });
    }
    if (result.changed.length > 0) {
      await traceSpan(
        'device-settings-changed',
        toSpanAttrs({ surface: 'device', userId, metadata: { fields: result.changed.join(',') } }),
        () => deviceJournal('v2.device_settings_changed', { session: session.id, fields: result.changed.join(',') }),
      );
    }
  } catch (error) {
    journal('v2.device_settings_write_failed', { session: session.id, error: errorName(error) });
  }
}

export async function handleDeviceState(ctx: ControlContext, dto: Extract<ClientControlDto, { type: 'device_state' }>): Promise<void> {
  const { deps, socket, session } = ctx;
  // Allowed in any paired stage (the device reports a volume key press
  // mid-playback). Kept on the session, where the registry and the web read
  // it, and persisted per device (legacy sessions have none).
  if (session.stage === 'await_hello') return sendError(socket, session, 'STATE_VIOLATION');
  const wasDnd = session.deviceState?.dnd === true;
  const { volume, muted, mode, dnd, ring_seconds, ring_sound, wake_word, battery_pct, charging, fw_version } = dto.payload;
  // Older firmware reports no ring keys and no wake word.
  const ring: RingKeys = ring_seconds !== undefined && ring_sound !== undefined ? { ring_seconds, ring_sound } : {};
  const wake = wake_word !== undefined ? { wake_word } : {};
  session.deviceState = { volume, muted, mode, dnd, ...ring, ...wake, battery_pct, charging, fw_version };
  const health = healthFields(dto.payload);
  deviceJournal('v2.device_state', { session: session.id, volume, muted, mode, dnd, ...ring, ...wake, ...health });
  const userId = sessionUserId(session);
  if (health !== undefined) {
    const metadata = Object.fromEntries(Object.entries(health).map(([key, value]) => [key, String(value)]));
    await traceSpan('device-health', toSpanAttrs({ surface: 'device', ...(userId !== undefined ? { userId } : {}), metadata }), () => undefined);
  }
  const auth = session.auth;
  const firstReport = session.settingsReported !== true;
  session.settingsReported = true;
  if (userId !== undefined && auth?.kind === 'device') {
    await syncReportedSettings(ctx, userId, auth.deviceId, dto.payload, ring, firstReport);
    getAccountEvents().publish(userId, { type: 'device.changed', device_id: auth.deviceId });
  }
  // Leaving DND delivers what it held (a no-op unless ready).
  if (wasDnd && !dnd) deps.deviceSessions.flushPending(session);
}

// Weak ownership follows socket lifetime; no global device-id registry grows.
const lastDeviceLogAt = new WeakMap<DeviceSession, number>();

export async function handleDeviceLog(ctx: ControlContext, dto: Extract<ClientControlDto, { type: 'device_log' }>): Promise<void> {
  const { session, socket } = ctx;
  if (session.stage === 'await_hello') return sendError(socket, session, 'STATE_VIOLATION');
  if (session.auth?.kind !== 'device' && session.auth?.kind !== 'legacy') return sendError(socket, session, 'UNPAIRED');
  const now = Date.now();
  const previous = lastDeviceLogAt.get(session);
  if (previous !== undefined && now - previous < 1000) return;
  lastDeviceLogAt.set(session, now);
  const { event, uptime_ms, heap_free, heap_largest } = dto.payload;
  const userId = sessionUserId(session);
  await traceSpan('device-log', toSpanAttrs({
    surface: 'device', workflowNamespace: session.id,
    ...(dto.turn_ref !== undefined ? { turnId: dto.turn_ref } : {}),
    ...(userId !== undefined ? { userId } : {}),
    metadata: { device_event: event, uptime_ms: String(uptime_ms), heap_free: String(heap_free), heap_largest: String(heap_largest) },
  }), () => {
    recordObservationMetrics([
      { name: 'device.heap_free_bytes', value: heap_free }, { name: 'device.heap_largest_bytes', value: heap_largest },
      { name: 'device.uptime_ms', value: uptime_ms },
    ]);
    deviceJournal('v2.device_log', {
      session: session.id, ...(dto.turn_ref !== undefined ? { turn_id: dto.turn_ref } : {}),
      device_event: event, uptime_ms, heap_free, heap_largest,
    });
  });
}

export async function handleAnnounceAck(ctx: ControlContext, dto: Extract<ClientControlDto, { type: 'announce_ack' }>): Promise<void> {
  const { deps, socket, session } = ctx;
  if (session.stage === 'await_hello') return sendError(socket, session, 'STATE_VIOLATION');
  const userId = sessionUserId(session);
  const known = userId !== undefined && deps.deviceSessions.ackAnnouncement(userId, dto.payload.announce_id);
  traceSpan(
    'device-announce-acked',
    toSpanAttrs({ surface: 'device', ...(userId !== undefined ? { userId } : {}), metadata: { action: dto.payload.action } }),
    () => journal('v2.announce_acked', { session: session.id, action: dto.payload.action, known }),
  );
}


export async function handleListConversations(ctx: ControlContext): Promise<void> {
  const { deps, socket, session } = ctx;
  if (session.stage !== 'ready') return sendError(socket, session, 'STATE_VIOLATION');
  let conversations: Pick<StoredConversation, 'id' | 'title'>[] = [];
  const userId = sessionUserId(session);
  if (userId !== undefined) {
    // The active Space's threads first. A failure here costs only the thread
    // rows, never the General list below.
    let threads: { id: string; title: string }[] = [];
    try {
      threads = await pickerThreads(await deps.getDb(), userId, sessionDeviceId(session));
    } catch (error) {
      journal('v2.conversation_list_failed', { session: session.id, error: errorName(error) });
    }
    try {
      const general = await listConversations(await deps.getDb(), userId, { limit: CONVERSATIONS_LIST_CAP - threads.length });
      conversations = [...threads, ...general];
    } catch (error) {
      journal('v2.conversation_list_failed', { session: session.id, error: errorName(error) });
      conversations = threads;
    }
  }
  journal('v2.conversation_listed', { session: session.id, count: conversations.length });
  return sendDto(socket, {
    v: V2_VERSION, type: 'conversations', id: messageId('conv'), payload: { conversations: conversations.map(({ id, title }) => ({ id, title })) },
  });
}

export async function handleListSpaces(ctx: ControlContext): Promise<void> {
  const { deps, socket, session } = ctx;
  if (session.stage !== 'ready') return sendError(socket, session, 'STATE_VIOLATION');
  // Live Spaces the account is an active member of (archived and revoked never
  // listed), newest first, capped for device RAM. A store outage answers an
  // empty list, as list_conversations does.
  let spaces: SpaceRef[] = [];
  const userId = sessionUserId(session);
  if (userId !== undefined) {
    try {
      spaces = (await listSpaces(await deps.getDb(), userId)).slice(0, SPACES_LIST_CAP).map(({ id, name }) => ({ id, name }));
    } catch (error) {
      journal('v2.space_list_failed', { session: session.id, error: errorName(error) });
    }
  }
  journal('v2.space_listed', { session: session.id, count: spaces.length });
  return sendDto(socket, { v: V2_VERSION, type: 'spaces', id: messageId('spcs'), payload: { spaces } });
}
