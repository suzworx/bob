/**
 * Workflow: answer a device's hello with its welcome, and the update or pairing answer that goes with it.
 * Trigger: the device's hello control message, dispatched by voice/session.ts (the first message on a device socket).
 * Steps: 1. accept the hello (format, firmware version, caps). 2. an unpaired device gets pairing_required and nothing
 *   else. 3. read the account's active conversation and active Space (a stale pointer is cleared here). 4. offer an OTA
 *   update when the device advertised the ota cap. 5. trace the welcome. 6. build the welcome, and decide update_required
 *   from the minimum firmware version. 7. seed the stored device settings. 8. register a paired socket with the device
 *   registry, unless it must update. 9. send welcome, then update_required, or the pending settings, the replayed
 *   announcements and the timers state.
 * Outcome: a paired device is registered and gets its welcome with its active pointers, then any pending settings,
 *   announcements and timers. A device below the minimum firmware gets update_required after welcome, is not
 *   registered, and has its turns refused. A store failure in a read is journaled and the hello still answers.
 * Journal: v2.hello, v2.pairing_required, v2.update_required, v2.welcome (trace device-welcome, debug session.hello),
 *   v2.conversation_resolve_failed, v2.active_space_changed, v2.active_space_resolve_failed, v2.ota.error (hello_failed),
 *   v2.device_model_refresh_failed, v2.device_settings_read_failed, v2.min_fw_version_invalid. The active-cleared push
 *   (v2.active_changed) comes from publishActiveCleared in session-handlers.ts.
 */
import type { WebSocket } from 'ws';
import { debugLog, toSpanAttrs, traceSpan } from '@bob/ai';
import {
  AUDIO_PAYLOAD_LIMIT_BYTES, FirmwareVersionSchema, INITIAL_CREDIT_BYTES, V2_PROTOCOL, V2_VERSION, messageId, otaOfferWire,
  titleForDevice, type ClientControlDto, type DeviceControlPatch, type OtaOfferWire, type ServerControlDto, type SpaceRef,
} from '../voice/protocol.ts';
import { moduleJournal } from '../platform/logger.ts';
import { getActive } from '../conversations/active.ts';
import { getActiveSpace } from '../spaces/active.ts';
import { getAccountEvents } from '../devices/pairing-service.ts';
import { forFirmware, getDeviceSettings, refreshModelFromBoard } from '../devices/settings-store.ts';
import { offerOnHello } from '../firmware/device-offer.ts';
import { rememberSocketCaps, socketHasCap } from '../voice/device-caps.ts';
import { sendTimersStateOnWelcome } from '../voice/device-tools.ts';
import { recordBoard, sessionBoard } from '../voice/session-board.ts';
import {
  applyActiveToSession, errorName, publishActiveCleared, sendDto, sendError, sessionDeviceId, sessionUserId, updateRequiredReason,
  type ControlContext, type DeviceSession,
} from '../voice/session-handlers.ts';

const journal = moduleJournal('voice');

type HelloPayload = Extract<ClientControlDto, { type: 'hello' }>['payload'];

/** BOB_MIN_FW_VERSION when set and valid; unset means no minimum. A malformed
 *  value is journaled and ignored rather than locking every device out. */
function minFirmwareVersion(): string | undefined {
  const raw = process.env.BOB_MIN_FW_VERSION?.trim();
  if (raw === undefined || raw === '') return undefined;
  if (FirmwareVersionSchema.safeParse(raw).success) return raw;
  journal('v2.min_fw_version_invalid', {});
  return undefined;
}

/** Stores what the hello reported and returns the update to put in welcome, if
 *  any. Only a paired device that advertised cap 'ota' takes part; an error
 *  never costs the hello. */
async function offerForHello(ctx: ControlContext, payload: HelloPayload): Promise<OtaOfferWire | undefined> {
  const { deps, socket, session } = ctx;
  const auth = session.auth;
  if (auth?.kind !== 'device' || !socketHasCap(socket, 'ota')) return undefined;
  const { board, last_ota: lastOta } = payload;
  try {
    const offer = await offerOnHello(await deps.getDb(), auth.deviceId, {
      version: session.fwVersion ?? 'unknown',
      ...(board !== undefined ? { board } : {}),
      ...(lastOta !== undefined ? { lastOta: { result: lastOta.result, to: lastOta.to, reason: lastOta.reason ?? null } } : {}),
    });
    return offer === null ? undefined : otaOfferWire(offer);
  } catch {
    journal('v2.ota.error', { session: session.id, reason: 'hello_failed' });
    return undefined;
  }
}

type ActiveRef = { id: string | null; title: string | null };

type WelcomePayload = Extract<ServerControlDto, { type: 'welcome' }>['payload'];
const ACKED_CAPS = ['device_log', 'turn_conversation', 'assistant_name', 'turn_timing'] as const;

/** The account's active-conversation pointer for the welcome. null when no
 *  pointer row exists (whole-object null on the wire); {id:null,title:null}
 *  means the pointer was set and then cleared by deleting its conversation. */
async function helloActiveConversation(ctx: ControlContext, userId: string, deviceId: string | undefined): Promise<ActiveRef | null> {
  const { deps, session } = ctx;
  try {
    const active = await getActive(await deps.getDb(), userId, { deviceId });
    applyActiveToSession(session, active);
    if (active === null) return null;
    // A stale thread was nulled by this read: this session learns it from its
    // welcome, the account's other surfaces by event (scoped to this device).
    if (active.cleared) publishActiveCleared(userId, active.changedAt, deviceId);
    return { id: active.conversationId, title: titleForDevice(active.title) };
  } catch (error) {
    // The store must never block a device from talking: journal metadata and
    // leave activeConversationId undefined so turns fall back to in-memory.
    journal('v2.conversation_resolve_failed', { session: session.id, error: errorName(error) });
    return null;
  }
}

/** The active-Space pointer, resolved on its own so a failure here never costs
 *  the conversation pointer. null = no Space (no row, cleared, or just found
 *  stale); undefined = store outage, the field is omitted. */
async function helloActiveSpace(ctx: ControlContext, userId: string, deviceId: string | undefined): Promise<SpaceRef | null | undefined> {
  const { deps, session } = ctx;
  try {
    const space = await getActiveSpace(await deps.getDb(), userId, deviceId);
    // A stale id (archived, deleted, revoked) was nulled by this read: tell the
    // account's other surfaces. This session registers only later, so it
    // learns the null from its welcome, not a push.
    if (space !== null && space.cleared) {
      getAccountEvents().publish(userId, {
        type: 'active_space.changed', space_id: null, name: null, surface: 'device', changed_at: space.changedAt, device_id: deviceId,
      });
      journal('v2.active_space_changed', { session: session.id, surface: 'device' });
    }
    return space !== null && space.spaceId !== null && space.name !== null ? { id: space.spaceId, name: space.name } : null;
  } catch (error) {
    journal('v2.active_space_resolve_failed', { session: session.id, error: errorName(error) });
    return undefined;
  }
}

/** The device's persisted settings seed the session until its first
 *  device_state, so a DND set before a reboot still holds announcements
 *  replayed after welcome. A store failure leaves them unknown (not DND).
 *  Returns the settings to push when a web change was made offline (ring keys once
 *  reported, a wake word only as an unconfirmed web pick); a Waveshare board refreshes the model. */
async function seedStoredSettings(ctx: ControlContext, board: string | undefined): Promise<DeviceControlPatch | undefined> {
  const { deps, session } = ctx;
  const userId = sessionUserId(session);
  if (userId === undefined || session.auth?.kind !== 'device') return undefined;
  try {
    await refreshModelFromBoard(await deps.getDb(), userId, session.auth.deviceId, board).catch((error: unknown) => journal('v2.device_model_refresh_failed', { session: session.id, error: errorName(error) }));
    const stored = await getDeviceSettings(await deps.getDb(), userId, session.auth.deviceId);
    if (stored === null) return undefined;
    session.deviceState = forFirmware(stored, stored.ringReported);
    return stored.pendingPush ? forFirmware(stored, stored.ringReported, stored.wakeWordPending) : undefined;
  } catch (error) {
    journal('v2.device_settings_read_failed', { session: session.id, error: errorName(error) });
    return undefined;
  }
}

/** A paired session joins the account's device registry so active.changed
 *  pushes reach its socket, and unregisters on close. The once() guard keeps
 *  unit tests' fake sockets working (they carry only send/readyState). */
function registerPairedSocket(ctx: ControlContext, userId: string, deviceId: string | null): void {
  const { deps, socket, session } = ctx;
  deps.deviceSessions.register(socket, session, userId, deviceId);
  if (typeof (socket as { once?: unknown }).once === 'function') {
    (socket as { once: (event: string, listener: () => void) => void }).once('close', () => {
      deps.deviceSessions.unregister(session);
    });
  }
}

function welcomePayload(
  session: DeviceSession, hello: HelloPayload, activeRef: ActiveRef | null, activeSpace: SpaceRef | null | undefined,
  minVersion: string | undefined, updateOffer: OtaOfferWire | undefined,
): WelcomePayload {
  const auth = session.auth;
  const payload: WelcomePayload = {
    protocol: V2_PROTOCOL, format_id: session.formatId, max_audio_bytes: AUDIO_PAYLOAD_LIMIT_BYTES,
    credit_bytes: INITIAL_CREDIT_BYTES, session_id: session.id,
  };
  // Each acknowledged only to a device that advertised it, in contract key order.
  for (const cap of ACKED_CAPS) if (hello.caps?.includes(cap)) payload[cap] = true;
  const paired = auth?.kind === 'device' || auth?.kind === 'legacy';
  if (paired) {
    payload.device = auth.kind === 'device' ? { id: auth.deviceId, name: auth.name } : null;
    payload.active_conversation = activeRef;
    if (activeSpace !== undefined) payload.active_space = activeSpace;
  }
  if (minVersion !== undefined) payload.min_fw_version = minVersion;
  if (updateOffer !== undefined) payload.update_offer = updateOffer;
  return payload;
}

/** Applies the hello to the session: format, stage, firmware version and caps.
 *  Old firmware sends no fw_version ('unknown'); one Zod rejected reads
 *  'invalid'. Caps gate what this socket is sent (sendDto). */
function acceptHello(socket: WebSocket, session: DeviceSession, hello: HelloPayload): void {
  session.formatId = hello.format_id;
  session.stage = 'ready';
  const fwVersion = hello.fw_version ?? 'unknown';
  session.fwVersion = fwVersion;
  const caps = hello.caps;
  session.assistantNameSupported = caps?.includes('assistant_name') === true;
  if (caps !== undefined) rememberSocketCaps(socket, caps);
  journal('v2.hello', { session: session.id, fw_version: fwVersion, board: recordBoard(session, hello.board), ...(caps !== undefined ? { caps_count: caps.length } : {}) });
}

function traceWelcome(session: DeviceSession, userId: string | undefined, hello: HelloPayload): void {
  traceSpan(
    'device-welcome',
    toSpanAttrs({
      surface: 'device', ...(userId !== undefined ? { userId } : {}),
      metadata: { interface: 'cardputer', board: sessionBoard(session), fw_version: session.fwVersion ?? 'unknown' },
    }),
    () => journal('v2.welcome', { session: session.id, stage: session.stage, format_id: session.formatId }),
  );
  // The device's full hello: firmware build, requested format, and any other
  // metadata it advertises. The journal keeps only format_id.
  debugLog('session.hello', {
    session: session.id, format_id: session.formatId, hello_payload: hello,
    max_audio_bytes: AUDIO_PAYLOAD_LIMIT_BYTES, credit_bytes: INITIAL_CREDIT_BYTES,
  });
}

export async function handleHello(ctx: ControlContext, dto: Extract<ClientControlDto, { type: 'hello' }>): Promise<void> {
  const { deps, socket, session } = ctx;
  if (session.stage !== 'await_hello') return sendError(socket, session, 'STATE_VIOLATION');
  acceptHello(socket, session, dto.payload);
  const auth = session.auth;
  if (auth?.kind === 'unpaired') {
    const reason = auth.reason;
    journal('v2.pairing_required', { session: session.id, reason });
    return sendDto(socket, { v: V2_VERSION, type: 'pairing_required', id: messageId('pairreq'), payload: { reason } });
  }
  const userId = sessionUserId(session);
  const deviceId = sessionDeviceId(session);
  const activeRef = userId === undefined ? null : await helloActiveConversation(ctx, userId, deviceId);
  const activeSpace = userId === undefined ? undefined : await helloActiveSpace(ctx, userId, deviceId);
  const updateOffer = await offerForHello(ctx, dto.payload);
  traceWelcome(session, userId, dto.payload);
  const minVersion = minFirmwareVersion();
  const payload = welcomePayload(session, dto.payload, activeRef, activeSpace, minVersion, updateOffer);
  const updateReason = updateRequiredReason(dto.payload.fw_version, minVersion);
  const pendingSettings = await seedStoredSettings(ctx, dto.payload.board);
  const paired = userId !== undefined && (auth?.kind === 'device' || auth?.kind === 'legacy');
  // A device told to update is not registered: no pushes, announcements or timers reach it.
  if (updateReason === undefined && paired) registerPairedSocket(ctx, userId, auth.kind === 'device' ? auth.deviceId : null);
  sendDto(socket, { v: V2_VERSION, type: 'welcome', id: messageId('welcome'), payload });
  // Welcome first, so a firmware that predates update_required still reaches
  // Ready and sees its turns refused with UPDATE_REQUIRED.
  if (updateReason !== undefined && minVersion !== undefined) {
    session.updateRequired = true;
    journal('v2.update_required', { session: session.id, reason: updateReason, fw_version: session.fwVersion, min_version: minVersion });
    return sendDto(socket, {
      v: V2_VERSION, type: 'update_required', id: messageId('updreq'), payload: { min_version: minVersion, reason: updateReason },
    });
  }
  if (pendingSettings !== undefined) deps.deviceSessions.pushDeviceControl(socket, session, pendingSettings);
  // A reconnect replays every unacked, unexpired announcement, only after
  // welcome, which must be the first thing the device reads.
  deps.deviceSessions.flushPending(session);
  // The running timers for the Ready countdown go last so a store read never
  // delays the welcome or a replayed announcement.
  if (paired) await sendTimersStateOnWelcome(socket, session.id, userId, { registry: deps.deviceSessions, getDb: deps.getDb });
}
