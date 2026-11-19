// Typed client for the device endpoints (/api/devices). v1 keeps this inline in
// its devices page; the shapes and status handling here are copied from it.
// Every call goes through fetchWithAuth, so a 401 refreshes the session once.

import { fetchWithAuth } from '@/lib/auth/use-session';

/** How the device listens (#330): push-to-talk, wake word, or never. */
export type ListeningMode = 'ptt' | 'wake' | 'announce_only';

/** The built-in sound a timer or alarm rings with (#389). */
export type RingSound = 'classic' | 'chime' | 'pulse';

/** The phrase the device wakes to: "Hey Bob", the only one. */
type WakeWord = 'bob';

/** A device's stored settings (#327), as the server last acknowledged them.
 *  ring_seconds is how long a timer or alarm rings, 10..120 (#389); wake_word
 *  is the stored one, else the brand default. */
export type DeviceSettings = {
  volume: number;
  muted: boolean;
  mode: ListeningMode;
  dnd: boolean;
  ring_seconds: number;
  ring_sound: RingSound;
  wake_word: WakeWord;
};

/** What the connected device last reported; the extras are null when unknown. */
export type DeviceLive = {
  connected: boolean;
  battery_pct: number | null;
  charging: boolean | null;
  fw_version: string | null;
};

export type Device = {
  id: string;
  name: string;
  model: string;
  paired_at: number;
  last_seen_at: number | null;
  connected?: boolean;
  settings: DeviceSettings;
  /** A web change the device has not confirmed yet (#327). */
  pending: boolean;
  /** The device's firmware takes settings from the web: it has reported them. */
  settings_supported: boolean;
  /** The firmware takes the ring settings: it has reported them (#389). */
  ring_settings_supported: boolean;
  /** The firmware takes the wake word: it reported one or its hello has cap wake_word. */
  wake_word_supported: boolean;
  live: DeviceLive;
  /** This device's own pointer (#900); null when it has none of its own, so
   *  it follows the account pointer. Absent on an older server response. */
  active_conversation_id?: string | null;
  active_space_id?: string | null;
};

/**
 * The one "is it online" rule every surface uses (row dot, header status,
 * offline notes, the pending-applied check): the server's live socket, as
 * GET /api/devices reports it in either field.
 */
export function isDeviceOnline(device: Pick<Device, 'connected' | 'live'>): boolean {
  return device.connected === true || device.live.connected;
}

/** The product name a person knows the device by, and the hardware behind it
 *  (shown once, under About). The server lists a Bob board as "Bob (Waveshare
 *  1.85C)"; anything else keeps its paired model and has no separate hardware. */
export function deviceProduct(model: string): { name: string; hardware: string | null } {
  const match = /^(.+?)\s*\((.+)\)$/.exec(model.trim());
  return match ? { name: match[1], hardware: match[2] } : { name: model, hardware: null };
}

type UpdateSettingsResult =
  | { ok: true; settings: DeviceSettings; delivered: boolean; pending: boolean }
  | { ok: false };

/**
 * PATCH /api/devices/:id/settings with only the changed fields. `delivered` is
 * false when the device is offline and gets them when it reconnects; `pending`
 * stays true until the device reports them back. Any refusal or network
 * failure is `ok: false`.
 */
export async function updateDeviceSettings(id: string, patch: Partial<DeviceSettings>): Promise<UpdateSettingsResult> {
  try {
    const response = await fetchWithAuth(`${devicePath(id)}/settings`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(patch),
    });
    if (!response.ok) return { ok: false };
    const body = (await response.json()) as { settings: DeviceSettings; delivered: boolean; pending: boolean };
    return { ok: true, settings: body.settings, delivered: body.delivered, pending: body.pending };
  } catch {
    return { ok: false };
  }
}

export type ActiveConversation = { id: string; title: string };

/** The Space a device's new conversations start in, as last acknowledged by the server. */
export type ActiveSpace = { id: string; name: string };

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function devicePath(id: string): string {
  return `/api/devices/${encodeURIComponent(id)}`;
}

/** Throws when the list cannot be fetched (non-2xx or network failure). */
export async function listDevices(): Promise<{
  devices: Device[];
  activeConversation: ActiveConversation | null;
  activeSpace: ActiveSpace | null;
}> {
  const response = await fetchWithAuth('/api/devices');
  if (!response.ok) throw new Error('list_failed');
  const body = (await response.json()) as {
    devices: Device[];
    active_conversation?: ActiveConversation | null;
    active_space?: ActiveSpace | null;
  };
  return {
    devices: body.devices,
    activeConversation: body.active_conversation ?? null,
    activeSpace: body.active_space ?? null,
  };
}

type SetActiveSpaceResult =
  | { ok: true; activeSpace: ActiveSpace | null }
  | { ok: false; reason: 'not_found' | 'failed' };

/**
 * PUT /api/devices/active-space. `not_found` is the server's one 404 for an
 * unknown, archived or no-longer-shared Space; any other refusal or a network
 * failure is `failed`. #900: an optional deviceId moves only that device's
 * own pointer; omitted, it moves the account pointer and every device follows.
 */
export async function setActiveSpace(spaceId: string | null, deviceId?: string): Promise<SetActiveSpaceResult> {
  try {
    const response = await fetchWithAuth('/api/devices/active-space', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ space_id: spaceId, device_id: deviceId }),
    });
    if (response.status === 404) return { ok: false, reason: 'not_found' };
    if (!response.ok) return { ok: false, reason: 'failed' };
    const body = (await response.json()) as { active_space: ActiveSpace | null };
    return { ok: true, activeSpace: body.active_space };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Resolves true only for a 2xx response, false for any other status. A network
 * failure rejects, which the page treats differently from a refusal (v1 keeps
 * the rename box open on a thrown error but closes it on a non-2xx).
 */
export async function renameDevice(id: string, name: string): Promise<boolean> {
  const response = await fetchWithAuth(devicePath(id), {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
  return response.ok;
}

/** Resolves true only for the server's 204; anything else is a refusal. */
export async function revokeDevice(id: string): Promise<boolean> {
  const response = await fetchWithAuth(devicePath(id), { method: 'DELETE' });
  return response.status === 204;
}
