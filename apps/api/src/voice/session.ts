import type { RawData, WebSocket } from 'ws';
import { debugLog, isFrameDebugEnabled } from '@bob/ai';
import {
  ACCUMULATE_MAX_BYTES,
  INITIAL_CREDIT_BYTES,
  V2_VERSION,
  endOfTurnDto,
  messageId,
  parseAudioUp,
  type ClientControlDto,
  type SessionDto,
} from './protocol.ts';
import { moduleJournal } from '../platform/logger.ts';
import { traceSynchronousWorkflow } from '../platform/observability/workflow-diagnostics.ts';
import {
  envPositiveInt,
  errorName,
  handleAnnounceAck,
  handleCancel,
  handleDeviceLog,
  handleDeviceState,
  handleListConversations,
  handleListSpaces,
  handleTurnEnd,
  handleTurnStart,
  resetSession,
  sessionUserId,
  sendDto,
  sendError,
  type ControlContext,
  type DeviceSession,
  type SessionDeps,
} from './session-handlers.ts';
import { handleHello } from '../workflows/workflow-device-hello.ts';
import { handlePairRequest } from '../workflows/workflow-device-pairing.ts';
import { handleCheckUpdate, handleOtaProgress } from '../workflows/workflow-device-ota-check.ts';
import { handleNewConversation, handleSelectConversation, handleSelectSpace } from '../workflows/workflow-active-context-change.ts';
import { diagnoseControl } from './control-diagnostics.ts';
import { deviceCorrelation } from './socket-diagnostics.ts';
import { countUplink } from './turn/uplink.ts';
import { abortSttStream, endOfTurnState, openSttStream, pushSttStream, recordServerEndOfTurn, watchEndOfTurn, type SttStreamOpener } from './turn/stream-stt.ts';
import { socketHasCap } from './device-caps.ts';
import { closeTurnRoot, openTurnRoot, runInTurnRoot, turnRootOf } from './turn/turn-root.ts';
import { handleTurnTiming, trackTurnTiming } from './turn/device-timing.ts';
import type { TurnDeps } from './turn/deps.ts';

const journal = moduleJournal('voice');

type ControlHandler = (ctx: ControlContext, dto: ClientControlDto) => void | Promise<void>;

const HANDLERS: Record<ClientControlDto['type'], ControlHandler> = {
  hello: handleHello,
  pair_request: handlePairRequest,
  turn_start: handleTurnStart,
  turn_end: handleTurnEnd,
  cancel: handleCancel,
  device_state: handleDeviceState,
  device_log: handleDeviceLog,
  turn_timing: handleTurnTiming,
  announce_ack: handleAnnounceAck,
  list_conversations: handleListConversations,
  select_conversation: handleSelectConversation,
  new_conversation: handleNewConversation,
  list_spaces: handleListSpaces,
  select_space: handleSelectSpace,
  check_update: handleCheckUpdate,
  ota_progress: handleOtaProgress,
  pong: () => undefined,
} as Record<ClientControlDto['type'], ControlHandler>;

/** All an unpaired session may send; anything else is answered UNPAIRED. */
const UNPAIRED_ALLOWED_TYPES = new Set(['hello', 'pair_request', 'pong']);
/** All a device told to update may still send: no turns, no pickers, but it must still be able to update. */
const UPDATE_REQUIRED_ALLOWED_TYPES = new Set(['pong', 'device_state', 'check_update', 'ota_progress']);

const UNPAIRED_IDLE_CLOSE_MS = 11 * 60 * 1000;
const unpairedIdleTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>();
const wiredIdleSockets = new WeakSet<WebSocket>();

function armUnpairedIdleClose(socket: WebSocket): void {
  if (!wiredIdleSockets.has(socket)) {
    wiredIdleSockets.add(socket);
    socket.once('close', () => {
      const timer = unpairedIdleTimers.get(socket);
      if (timer) clearTimeout(timer);
      unpairedIdleTimers.delete(socket);
    });
  }
  const existing = unpairedIdleTimers.get(socket);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    unpairedIdleTimers.delete(socket);
    traceSynchronousWorkflow('device-unpaired-expiry', { detached: true }, () => {
      journal('v2.unpaired_idle_close', {});
      socket.close();
    });
  }, envPositiveInt('BOB_UNPAIRED_IDLE_MS', UNPAIRED_IDLE_CLOSE_MS));
  timer.unref?.();
  unpairedIdleTimers.set(socket, timer);
}

/** The server chains calls per session, so messages are handled in arrival order;
 *  onTurnEnd is injected so this module never imports the turn pipeline. */
export async function handleControl(
  // `turn.sttStream` is the turn deps' streaming STT opener, present only with BOB_STT_STREAMING=1;
  // `turn.startEarlyPrep` starts an accepted paired turn's transcript-free prep.
  deps: SessionDeps & { turn?: Partial<TurnDeps> & { sttStream?: SttStreamOpener } },
  socket: WebSocket,
  session: DeviceSession,
  dto: ClientControlDto,
  onTurnEnd: (session: SessionDto, turnRef: string) => void | Promise<void>,
): Promise<void> {
  // Cancel acts on the active server turn, regardless of the optional client reference.
  const turnRef = dto.type === 'cancel' ? session.turnRef : dto.turn_ref;
  // One root span per device turn: opened here so even ws.control.turn_start descends from it.
  // Every control, turn or not, carries the client session, the acting account and the device's conversation;
  // a paired control without one joins the user's active conversation in the span layer.
  const correlation = deviceCorrelation(session, sessionUserId(session));
  if (dto.type === 'turn_start' && session.stage === 'ready' && session.auth?.kind !== 'unpaired' && session.updateRequired !== true) {
    openTurnRoot(session, { turnRef: dto.turn_ref, ...correlation });
    // Opened before the handler awaits anything, so its provider setup overlaps the user talking.
    openSttStream(session, deps.turn?.sttStream);
  }
  if (dto.type === 'cancel') abortSttStream(session);
  const inRoot = turnRef !== undefined && turnRootOf(session)?.turnRef === turnRef;
  let failed = true;
  try {
    await runInTurnRoot(session, turnRef, () => diagnoseControl(dto.type, () => dispatchControl(deps, socket, session, dto, onTurnEnd), undefined, {
      ...(inRoot ? {} : { detached: true }), tags: ['device'],
      ...(turnRef ? { workflowNamespace: session.id, turnId: turnRef, traceName: 'device-turn' } : {}),
      ...correlation,
      // turn_start reads the active pointer itself (handleTurnStart), so its control span skips the fallback lookup.
      ...(dto.type === 'turn_start' && correlation.conversationId === undefined ? { conversationSource: 'none' as const } : {}),
    }));
    // Which turns may still send a timing summary; never delays the turn.
    trackTurnTiming(socket, session, dto, sessionUserId(session), turnRef);
    // The conversation is pinned now: read what the turn needs, bar the
    // transcript, while the user speaks (docs/voice-latency-rca.md "Prep to 5 ms").
    const startEarly = deps.turn?.startEarlyPrep;
    if (dto.type === 'turn_start' && session.stage === 'capturing' && sessionUserId(session) !== undefined && startEarly !== undefined) {
      runInTurnRoot(session, dto.turn_ref, () => { startEarly(session, dto.turn_ref); });
    }
    // The server's end of turn reads the streamed hypothesis, so it needs the stream opener (BOB_STT_STREAMING=1).
    if (dto.type === 'turn_start' && session.stage === 'capturing' && sessionUserId(session) !== undefined && deps.turn?.sttStream !== undefined) {
      watchTurnEndOfTurn(deps.turn, socket, session, dto.turn_ref);
    }
    failed = false;
  } finally {
    // A rejected turn_start never began a turn: its root must not stay open.
    if (dto.type === 'turn_start' && session.stage !== 'capturing') {
      closeTurnRoot(session, failed);
      abortSttStream(session);
    }
  }
}

/**
 * The streamed turn's semantic end of turn. The first 'end' sends end_of_turn to a socket
 * that advertised the cap; every 'end' is journaled (never the hypothesis); every event reaches the
 * turn deps' onEndOfTurn hook (the speculative reply).
 */
function watchTurnEndOfTurn(turn: Partial<TurnDeps>, socket: WebSocket, session: SessionDto, turnRef: string): void {
  let ends = 0;
  let sent = false;
  watchEndOfTurn(session, (event, hypothesis) => {
    if (event === 'end') {
      ends += 1;
      // `sent` on the journal line means this decision sent the message, not that the turn has.
      let sentNow = false;
      try {
        if (!sent && socketHasCap(socket, 'end_of_turn')) {
          sent = true;
          sentNow = true;
          recordServerEndOfTurn(session, turnRef);
          sendDto(socket, endOfTurnDto(turnRef));
        }
        const detector = endOfTurnState(session);
        journal('v2.turn_end_of_turn', {
          session: session.id, turn_id: turnRef, sent: sentNow, audio_ms: detector?.audioMs, silence_ms: detector?.silenceMs, n: ends,
        });
      } catch (error) {
        journal('v2.turn_end_of_turn_failed', { session: session.id, turn_id: turnRef, stage: 'send', error: errorName(error) });
      }
    }
    // The speculative reply's hook runs even when the send or its journal line threw.
    try {
      turn.onEndOfTurn?.(session, turnRef, event, hypothesis);
    } catch (error) {
      journal('v2.turn_end_of_turn_failed', { session: session.id, turn_id: turnRef, stage: 'hook', error: errorName(error) });
    }
  });
}

async function dispatchControl(
  deps: SessionDeps, socket: WebSocket, session: DeviceSession, dto: ClientControlDto,
  onTurnEnd: (session: SessionDto, turnRef: string) => void | Promise<void>,
): Promise<void> {
  // Every inbound control message, in full. The journal records only that a
  // transition happened; this records what the device actually sent, which is
  // what a firmware/server state-machine disagreement turns on.
  debugLog('session.control_in', { session: session.id, stage: session.stage, type: dto.type, dto });
  // An unpaired session's idle clock re-arms on any inbound message (contract
  // "Unpaired-session limits").
  const unpaired = session.auth?.kind === 'unpaired';
  if (unpaired) {
    armUnpairedIdleClose(socket);
    if (!UNPAIRED_ALLOWED_TYPES.has(dto.type)) return sendError(socket, session, 'UNPAIRED');
  }
  if (session.updateRequired === true && !UPDATE_REQUIRED_ALLOWED_TYPES.has(dto.type)) {
    return sendError(socket, session, 'UPDATE_REQUIRED');
  }
  await HANDLERS[dto.type]({ deps, socket, session, onTurnEnd }, dto);
}

export function handleBinary(deps: Pick<SessionDeps, 'deviceSessions'>, socket: WebSocket, session: SessionDto, raw: RawData): void {
  if (session.stage !== 'capturing') {
    countUplink(session, 0, 'STATE_VIOLATION');
    return sendError(socket, session, 'STATE_VIOLATION');
  }
  const parsed = parseAudioUp(raw, session);
  if (!parsed.ok) {
    countUplink(session, 0, parsed.code);
    return sendError(socket, session, parsed.code);
  }
  // Each frame is consumed on arrival, so its credit comes straight back;
  // ACCUMULATE_MAX_BYTES is the real memory bound.
  session.creditBytes = Math.min(INITIAL_CREDIT_BYTES, session.creditBytes);
  session.audioChunks.push(Buffer.from(parsed.value.payload));
  pushSttStream(session, parsed.value.payload);
  session.totalAudioBytes += parsed.value.header.payloadBytes;
  session.nextUplinkSeq += 1;
  const lean = isLeanUplink();
  if (!lean) journal('v2.audio_up', { session: session.id, stage: session.stage, bytes: parsed.value.header.payloadBytes });
  // One line per uplink frame is hundreds of lines per turn, so it sits behind
  // its own flag; the per-turn totals above are enough for most diagnosis.
  if (isFrameDebugEnabled()) {
    debugLog('session.audio_up_frame', {
      session: session.id,
      seq: parsed.value.header.sequence,
      payload_bytes: parsed.value.header.payloadBytes,
      format_id: parsed.value.header.formatId,
      channels: parsed.value.header.channels,
      turn_handle: parsed.value.header.turnHandle,
      credit_bytes: session.creditBytes,
      total_audio_bytes: session.totalAudioBytes,
    });
  }
  if (session.totalAudioBytes > ACCUMULATE_MAX_BYTES) {
    countUplink(session, 0, 'QUEUE_FULL');
    journal('v2.accumulate_full', { session: session.id, bytes: session.totalAudioBytes });
    debugLog('session.accumulate_full', {
      session: session.id,
      total_audio_bytes: session.totalAudioBytes,
      limit_bytes: ACCUMULATE_MAX_BYTES,
      uplink_frames: session.nextUplinkSeq,
    });
    sendError(socket, session, 'QUEUE_FULL');
    abortSttStream(session);
    resetSession(deps, session);
    return;
  }
  countUplink(session, parsed.value.header.payloadBytes);
  if (lean) return;
  sendDto(socket, { v: V2_VERSION, type: 'ack', id: messageId('ack'), turn_ref: session.turnRef!, payload: { credit_bytes: session.creditBytes } });
}

/** BOB_LEAN_UPLINK=1 drops the per-frame `ack` (the firmware never reads it)
 *  and the per-frame `v2.audio_up` line; the per-turn totals on turn_end stay. Read per
 *  call so a test or a live env change takes effect without a restart. */
function isLeanUplink(): boolean {
  return process.env.BOB_LEAN_UPLINK === '1';
}
