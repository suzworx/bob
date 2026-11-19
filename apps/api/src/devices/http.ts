/**
 * REST routes for the account's devices, mounted under /api/devices; DELETE
 * additionally runs under requireActiveSession. Revoke closes the live socket
 * with WS code 4003, publishes device.changed, and journals the opaque device
 * id only, so the revoke path carries no account uuid beyond the device's own id.
 */
import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { moduleJournal } from '../platform/logger.ts';
import { route, sendError } from '../platform/http/route.ts';
import { type DeviceSessions } from '../voice/device-sessions.ts';
import type { AccountEvent } from '../account/events-bus.ts';
import { notifySecurityEvent } from '../notifications/notify.ts';
import { PairingNotFoundError, revokeDevice } from './pairing-store.ts';
import { DeviceNotFoundError, listDevices, renameDevice } from './store.ts';
import { DEFAULT_WAKE_WORD, deviceModelLabel, type WakeWord } from './settings.ts';
import { listDeviceActivity } from './activity.ts';
import { z } from 'zod';
import { threadRef } from './conversation-ref.ts';
import { getActive, type ActiveConversation } from '../conversations/active.ts';
import { getConversationSummary } from '../conversations/store.ts';
import { getActiveSpace } from '../spaces/active.ts';
import { DEFAULT_DEVICE_SETTINGS, getDeviceSettings, patchDeviceSettings, pickSettings, type DeviceSettings } from './settings-store.ts';
import { StoreError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import {
  ThreadSpaceMismatchError, publishCleared, setWebActiveConversation, setWebActiveSpace, type ClearedPointer,
} from '../workflows/workflow-active-context-change.ts';
import {
  ActiveConversationRequestSchema,
  ActiveSpaceRequestSchema,
  ConversationIdSchema,
  type ActiveConversationRequest,
  type ActiveSpaceRequest,
  DeviceActivityQuerySchema,
  DeviceActivityResponseSchema,
  DeviceAnnounceRequestSchema,
  DeviceAnnounceResponseSchema,
  ActiveSpaceResponseSchema,
  DeviceRenameRequestSchema,
  DeviceRenameResponseSchema,
  DeviceSettingsPatchSchema,
  DeviceSettingsResponseSchema,
  DevicesResponseSchema,
  type DeviceSummary,
  type DevicesResponse,
} from '../web-schemas.ts';

const journal = moduleJournal('devices');
const webJournal = moduleJournal('devices', 'web');

/** How long a web announcement held by a busy or DND device stays deliverable. */
const WEB_ANNOUNCE_TTL_MS = 15 * 60 * 1000;

/** Its success body: the acknowledged pointers. */
export const DeviceConversationResponseSchema = z
  .object({
    active_conversation: z.object({ id: ConversationIdSchema, title: z.string() }).strict().nullable(),
    active_space: z.object({ id: z.string().uuid(), name: z.string().min(1).max(60) }).strict().nullable(),
  })
  .strict();

/** Its 202 body: stored, applied when a paired device next connects. */
export const DeviceConversationPendingSchema = z.object({ status: z.literal('pending') }).strict();

interface DevicesRouterDeps {
  getDb: () => Promise<Db>;
  requireActiveSession: (request: Request, response: Response, next: NextFunction) => Promise<void>;
  /** The per-account bus device.changed is published on (getAccountEvents()). */
  events: { publish: (userId: string, event: AccountEvent) => void };
  /** The device-session registry: closeDevice closes the live socket, forDevice
   *  reads the live state, sendDeviceControl pushes a settings change,
   *  announceToDevice sends a notice card to one device, and rememberDb lets
   *  the registry read device rows when it publishes. */
  deviceSessions: Pick<DeviceSessions, 'announceToDevice' | 'closeDevice' | 'forDevice' | 'sendDeviceControl'>
    & Partial<Pick<DeviceSessions, 'hasCap'>> & { rememberDb?: (getDb: () => Promise<Db>) => void };
}

/** The live half of a device row: connected, plus what the device last reported. */
function liveState(deviceSessions: DevicesRouterDeps['deviceSessions'], deviceId: string): {
  connected: boolean; battery_pct: number | null; charging: boolean | null; fw_version: string | null;
} {
  const entry = deviceSessions.forDevice(deviceId);
  const state = entry?.session.deviceState;
  return {
    connected: entry !== undefined,
    battery_pct: state?.battery_pct ?? null,
    charging: state?.charging ?? null,
    fw_version: state?.fw_version ?? null,
  };
}

type WireSettings = DeviceSettings & { wake_word: WakeWord };

/** The settings with the wake word filled in for display: "Hey Bob" is the only one. */
function withWakeWord(settings: DeviceSettings): WireSettings {
  return { ...settings, wake_word: settings.wake_word ?? DEFAULT_WAKE_WORD };
}

/** Whether the device's live socket advertised cap 'wake_word'. */
function liveWakeWordCap(deviceSessions: DevicesRouterDeps['deviceSessions'], userId: string, deviceId: string): boolean {
  return deviceSessions.hasCap?.(userId, deviceId, 'wake_word') === true;
}

/** Stored settings win (a device that never reported shows the firmware
 *  defaults and the brand's wake word), plus whether a web change is
 *  unconfirmed, whether the firmware takes device_control (it has reported
 *  device_state, stored or live), whether it takes the ring keys (it has
 *  reported ring_seconds) and whether it takes the wake word (it has reported
 *  one, or its live hello has cap 'wake_word'). */
async function settingsFor(
  db: Db, userId: string, deviceId: string, live: { fw: string | null; wakeWordCap: boolean },
): Promise<{
  settings: WireSettings; pending: boolean; settings_supported: boolean; ring_settings_supported: boolean; wake_word_supported: boolean;
}> {
  const stored = await getDeviceSettings(db, userId, deviceId);
  return {
    settings: withWakeWord(stored === null ? { ...DEFAULT_DEVICE_SETTINGS } : pickSettings(stored)),
    pending: stored?.pendingPush ?? false,
    settings_supported: stored?.deviceReported === true || live.fw !== null,
    ring_settings_supported: stored?.ringReported === true,
    wake_word_supported: stored?.wakeWordReported === true || live.wakeWordCap,
  };
}

/** One GET /api/devices row, including this device's own pointer --
 *  null when it has none, so it follows the account pointer alongside. */
async function deviceRow(
  db: Db, userId: string, deviceSessions: DevicesRouterDeps['deviceSessions'],
  device: { id: string; name: string; model: string; board: string | null; pairedAt: number; lastSeenAt: number | null },
): Promise<DeviceSummary> {
  const live = liveState(deviceSessions, device.id);
  const devicePointer = await getActive(db, userId, { deviceId: device.id });
  const deviceSpace = await getActiveSpace(db, userId, device.id);
  return {
    id: device.id,
    name: device.name,
    model: deviceModelLabel(device),
    paired_at: device.pairedAt,
    last_seen_at: device.lastSeenAt,
    connected: live.connected,
    ...(await settingsFor(
      db, userId, device.id, { fw: live.fw_version, wakeWordCap: liveWakeWordCap(deviceSessions, userId, device.id) },
    )),
    live,
    active_conversation_id: devicePointer?.conversationId ?? null,
    active_space_id: deviceSpace?.spaceId ?? null,
  };
}

/** device_id, when given, must be the caller's own paired device
 *  (true when absent -- nothing to check -- or when it belongs to them). */
async function deviceBelongsToCaller(db: Db, userId: string, deviceId: string | undefined): Promise<boolean> {
  return deviceId === undefined || (await listDevices(db, userId)).some((device) => device.id === deviceId);
}

/** device_id must be the caller's own paired device (404) or, absent,
 *  the account needs at least one paired device (409 no_device); either way
 *  returns whether a live device is reachable (the 202/200 decision). Sends
 *  the error body and returns null when the request must stop here. */
async function resolveConversationDeviceScope(
  response: Response, db: Db, userId: string, deviceId: string | undefined, deviceSessions: DevicesRouterDeps['deviceSessions'],
): Promise<{ connected: boolean } | null> {
  const devices = await listDevices(db, userId);
  if (deviceId !== undefined) {
    if (!devices.some((device) => device.id === deviceId)) {
      sendError(response, 404, 'not_found');
      return null;
    }
    return { connected: deviceSessions.forDevice(deviceId) !== undefined };
  }
  if (devices.length === 0) {
    sendError(response, 409, 'no_device');
    return null;
  }
  return { connected: devices.some((device) => deviceSessions.forDevice(device.id) !== undefined) };
}

/** The conversation_id's title; null with none given. Sends the shared 404
 *  and returns undefined for an id that does not resolve. */
async function resolveConversationTitle(
  response: Response, db: Db, userId: string, conversationId: string | null,
): Promise<string | null | undefined> {
  if (conversationId === null) return null;
  const conversation = await getConversationSummary(db, userId, conversationId);
  if (conversation === null) {
    sendError(response, 404, 'not_found');
    return undefined;
  }
  return conversation.title;
}

/** The shared error mapping for both PUT routes below. */
function mapPointerError(response: Response, error: unknown): void {
  if (error instanceof ThreadSpaceMismatchError) {
    sendError(response, 400, 'invalid_request');
    return;
  }
  if (error instanceof StoreNotFoundError) {
    sendError(response, 404, 'not_found');
    return;
  }
  mapError(response, error);
}

/** A store outage must be loud, never a fake empty device list. */
function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreError) {
    sendError(response, 500, 'store_error');
    return;
  }
  throw error;
}

function mapRenameError(response: Response, error: unknown): void {
  if (error instanceof DeviceNotFoundError) {
    // One generic body for unknown and other-account devices.
    sendError(response, 404, 'not_found');
    return;
  }
  mapError(response, error);
}

function mapRevokeError(response: Response, error: unknown): void {
  if (error instanceof PairingNotFoundError) {
    // Already revoked, unknown, or another account's device.
    sendError(response, 404, 'not_found');
    return;
  }
  mapError(response, error);
}

export function createDevicesRouter({
  getDb,
  requireActiveSession,
  events,
  deviceSessions,
}: DevicesRouterDeps): Router {
  const router = Router();
  deviceSessions.rememberDb?.(getDb);

  /** The cleared pointer a getActive read reports, if it nulled a stale thread. */
  function readCleared(active: ActiveConversation | null): ClearedPointer | null {
    return active !== null && active.cleared ? { changedAt: active.changedAt, surface: active.surface } : null;
  }

  router.get('/', route({ mapError }, async ({ userId }, request, response) => {
    const db = await getDb();
    const devices = await listDevices(db, userId);
    const active = await getActive(db, userId);
    const space = await getActiveSpace(db, userId);
    // A stale id (archived, deleted, revoked) was nulled by this read: tell the
    // account's other surfaces, so a connected Cardputer drops it too.
    if (space !== null && space.cleared) {
      events.publish(userId, {
        type: 'active_space.changed', space_id: null, name: null, surface: 'web', changed_at: space.changedAt,
      });
      journal('v2.active_space_changed', { surface: 'web' });
    }
    publishCleared(events, userId, readCleared(active), undefined);
    const rows: DeviceSummary[] = [];
    for (const device of devices) rows.push(await deviceRow(db, userId, deviceSessions, device));
    const payload: DevicesResponse = {
      devices: rows,
      active_conversation:
        active && active.conversationId !== null && active.title !== null
          ? { id: active.conversationId, title: active.title }
          : null,
      active_space:
        space !== null && space.spaceId !== null && space.name !== null
          ? { id: space.spaceId, name: space.name }
          : null,
    };
    response.status(200).json(DevicesResponseSchema.parse(payload));
  }));

  // Point the Cardputer context at a Space (or clear it). Only the JWT guard
  // applies, as for conversation activate. The store authorizes membership;
  // unknown, another account's and archived are one 404 body.
  router.put('/active-space', route({ body: ActiveSpaceRequestSchema, mapError: mapPointerError },
    async ({ body, userId }, _request, response) => {
      const { space_id: spaceId, device_id: deviceId }: ActiveSpaceRequest = body;
      const db = await getDb();
      if (!(await deviceBelongsToCaller(db, userId, deviceId))) {
        sendError(response, 404, 'not_found');
        return;
      }
      const { name } = await setWebActiveSpace(db, events, userId, spaceId, deviceId);
      response.status(200).json(
        ActiveSpaceResponseSchema.parse({
          active_space: spaceId !== null && name !== null ? { id: spaceId, name } : null,
        }),
      );
    }));

  // What the Cardputer talks in. A conversation id is "Use on Cardputer"; null
  // is "New conversation on Cardputer" (the next device turn creates one).
  // space_id is the space it works in (null: the main space). Both pointers move
  // in one transaction (docs/design/device-conversation.md). No paired device
  // is a 409 and writes nothing. A paired device that is offline gets the same
  // write and a 202 pending: its next welcome carries the stored pointers
  // (voice hello). Another account's ids are the one 404 body.
  router.put('/active-conversation', route({ body: ActiveConversationRequestSchema, mapError: mapPointerError },
    async ({ body, userId }, _request, response) => {
      const {
        conversation_id: conversationId, space_id: spaceId, thread_id: threadId, device_id: deviceId,
      }: ActiveConversationRequest = body;
      // A thread is pointed at by its device ref, conversation_id stays null.
      const ref = threadId === undefined ? conversationId : threadRef(threadId);
      const db = await getDb();
      const scope = await resolveConversationDeviceScope(response, db, userId, deviceId, deviceSessions);
      if (scope === null) return;
      const foundTitle = await resolveConversationTitle(response, db, userId, conversationId);
      if (foundTitle === undefined) return;
      const { title, name } = await setWebActiveConversation(db, events, userId, { ref, foundTitle, threadId, spaceId, deviceId });
      if (!scope.connected) {
        response.status(202).json(DeviceConversationPendingSchema.parse({ status: 'pending' }));
        return;
      }
      response.status(200).json(
        DeviceConversationResponseSchema.parse({
          active_conversation: ref !== null && title !== null ? { id: ref, title } : null,
          active_space: spaceId !== null && name !== null ? { id: spaceId, name } : null,
        }),
      );
    }));

  // Change a device's settings from the web. Merged and stored pending in one
  // locked transaction first, then pushed as device_control when the device is
  // connected; an offline device gets them after its next welcome. Pending
  // clears only when the device reports them back. Unknown, revoked and
  // other-account ids share one 404. A ring change for firmware that has never
  // reported the ring keys is refused (409): it could never apply; so is a
  // wake word for firmware that never reported one nor advertised cap 'wake_word'.
  // Hand-written: its 400 body lists the offending fields.
  router.patch('/:id/settings', async (request: Request, response: Response): Promise<void> => {
    const parsed = DeviceSettingsPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      const fields = parsed.error.issues
        .flatMap((issue) => (issue.code === 'unrecognized_keys' ? issue.keys : [issue.path.join('.')]))
        .filter((field) => field !== '');
      response.status(400).json({ error: { code: 'invalid_request', fields } });
      return;
    }
    const userId = request.account?.userId;
    if (!userId) {
      sendError(response, 401, 'invalid_token');
      return;
    }
    const deviceId = String(request.params.id);
    const patch = parsed.data;
    try {
      const db = await getDb();
      const settings = await patchDeviceSettings(db, userId, deviceId, patch, {
        wakeWordCap: liveWakeWordCap(deviceSessions, userId, deviceId),
      });
      if (settings === null) {
        sendError(response, 404, 'not_found');
        return;
      }
      if (settings === 'ring_unsupported' || settings === 'wake_word_unsupported') {
        sendError(response, 409, settings);
        return;
      }
      const delivered = deviceSessions.sendDeviceControl(userId, deviceId, patch) > 0;
      events.publish(userId, { type: 'device.changed', device_id: deviceId });
      webJournal('v2.device_settings_changed', { fields: Object.keys(patch).sort().join(','), delivered });
      response.status(200).json(DeviceSettingsResponseSchema.parse({
        id: deviceId, settings: withWakeWord(settings), delivered, pending: true,
      }));
    } catch (error) {
      mapError(response, error);
    }
  });

  // "Recent": the turns this device spoke and the account's timers that fired
  // alongside them, newest first. Unknown, revoked and other-account ids share
  // one 404. The excerpts are the owner's own words: returned, never journaled
  // (the event carries the count only).
  router.get('/:id/activity', route({ query: DeviceActivityQuerySchema, mapError },
    async ({ query, userId }, request, response) => {
      const deviceId = String(request.params.id);
      const db = await getDb();
      const device = (await listDevices(db, userId)).find((candidate) => candidate.id === deviceId);
      if (device === undefined) {
        sendError(response, 404, 'not_found');
        return;
      }
      const items = await listDeviceActivity(db, userId, device, query.limit);
      journal('v2.device_activity_listed', { count: items.length });
      response.json(DeviceActivityResponseSchema.parse({ items }));
    }));

  // A notice card on one device (Announce and Test speaker on the Devices
  // page), through the same outbox as reminders and timers: sent now, or held
  // while the device is busy or in DND. Not connected is a 409 that queues
  // nothing; unknown, revoked and other-account ids share one 404. The title
  // and body are user text: sent, never journaled.
  router.post('/:id/announce', route({ body: DeviceAnnounceRequestSchema, mapError },
    async ({ body, userId }, request, response) => {
      const deviceId = String(request.params.id);
      const devices = await listDevices(await getDb(), userId);
      if (!devices.some((device) => device.id === deviceId)) {
        sendError(response, 404, 'not_found');
        return;
      }
      const { title, body: text, ring } = body;
      const outcome = deviceSessions.announceToDevice(userId, deviceId, {
        announce_id: `an_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        kind: 'notice',
        title,
        body: text ?? '',
        ring,
        expires_at: Date.now() + WEB_ANNOUNCE_TTL_MS,
      });
      journal('v2.device_announce', { outcome, ring });
      if (outcome === 'no_device') {
        sendError(response, 409, 'no_device');
        return;
      }
      response.status(202).json(DeviceAnnounceResponseSchema.parse({ status: outcome }));
    }));

  router.patch('/:id', route({ body: DeviceRenameRequestSchema, mapError: mapRenameError },
    async ({ body, userId }, request, response) => {
      const updated = await renameDevice(await getDb(), userId, String(request.params.id), body.name);
      events.publish(userId, { type: 'device.changed', device_id: updated.id });
      response.status(200).json(DeviceRenameResponseSchema.parse(updated));
    }));

  router.delete('/:id', requireActiveSession, route({ mapError: mapRevokeError },
    async ({ userId }, request, response) => {
      const deviceId = String(request.params.id);
      const db = await getDb();
      await revokeDevice(db, userId, deviceId);
      // The contract's revoke close: the device reconnects with its stored
      // token and is answered pairing_required {reason:'revoked'}.
      deviceSessions.closeDevice(deviceId, 4003, 'revoked');
      events.publish(userId, { type: 'device.changed', device_id: deviceId });
      journal('v2.device_revoked', { device_id: deviceId });
      await notifySecurityEvent(db, userId, 'device_removed', deviceId, 1);
      response.status(204).end();
    }));

  return router;
}
