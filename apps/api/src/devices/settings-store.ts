/**
 * Per-device settings in columns of bob.devices, plus the caller's account
 * time zone. RLS limits rows to the caller's devices, so a foreign id reads as
 * null and a write to one is refused (no oracle). Writes also require
 * revoked_at IS NULL, which the devices update policy does not check. Each
 * write locks the row for its read-then-write, so concurrent writes never
 * lose a field.
 */
import { StoreError, withUser, type Db } from '../platform/db/db.ts';
import { modelForBoard, type DeviceMode, type RingSound, type WakeWord } from './settings.ts';

export type DeviceSettings = {
  volume: number;
  muted: boolean;
  mode: DeviceMode;
  dnd: boolean;
  ring_seconds: number;
  ring_sound: RingSound;
  /** Absent until the device reports one or the web picks one: the display default applies. */
  wake_word?: WakeWord;
};

/** Older firmware reports no ring keys and no wake word. */
type DeviceReport = Omit<DeviceSettings, 'ring_seconds' | 'ring_sound'>
  & Partial<Pick<DeviceSettings, 'ring_seconds' | 'ring_sound'>>;

type StoredDeviceSettings = DeviceSettings & {
  pendingPush: boolean; deviceReported: boolean; ringReported: boolean; wakeWordReported: boolean;
  /** The stored wake word is a web pick the device has not confirmed: the only wake word ever pushed. */
  wakeWordPending: boolean; updatedAt: number;
};

type DeviceReportResult = {
  settings: DeviceSettings;
  pendingPush: boolean;
  ringReported: boolean;
  wakeWordPending: boolean;
  outcome: 'stored' | 'synced' | 'kept_pending' | 'device_override';
  changed: Array<keyof DeviceSettings>;
};

/** Firmware defaults. */
export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  volume: 6, muted: false, mode: 'ptt', dnd: false, ring_seconds: 30, ring_sound: 'classic',
};

const FIELDS = ['dnd', 'mode', 'muted', 'ring_seconds', 'ring_sound', 'volume', 'wake_word'] as const;
const PUSHED_FIELDS = FIELDS.filter((field) => field !== 'wake_word');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function pickSettings(source: DeviceSettings): DeviceSettings {
  return {
    volume: source.volume, muted: source.muted, mode: source.mode, dnd: source.dnd,
    ring_seconds: source.ring_seconds, ring_sound: source.ring_sound,
    ...(source.wake_word !== undefined ? { wake_word: source.wake_word } : {}),
  };
}

/** The ring keys only once the firmware has reported them. The wake word only
 *  while it is an unconfirmed web pick (`wakeWordPending`): a reported or default
 *  wake word is never pushed. pushDeviceControl also drops it for a socket
 *  without cap 'wake_word'. */
export function forFirmware(settings: DeviceSettings, ringReported: boolean, wakeWordPending = false): DeviceReport {
  const { ring_seconds, ring_sound, wake_word, ...rest } = pickSettings(settings);
  const wake = wakeWordPending && wake_word !== undefined ? { wake_word } : {};
  return ringReported ? { ...rest, ring_seconds, ring_sound, ...wake } : { ...rest, ...wake };
}

type SettingsRow = {
  volume: unknown; muted: boolean; mode: DeviceMode; dnd: boolean; ring_seconds: unknown; ring_sound: RingSound;
  wake_word: WakeWord | null; pending_push: boolean; device_reported: boolean; ring_reported: boolean;
  wake_word_reported: boolean; wake_word_pending: boolean; updatedAt: unknown;
};

/** settings_updated_at is null while none are stored (the columns hold their defaults). */
const SELECT_SETTINGS = `SELECT volume, muted, mode, dnd, ring_seconds, ring_sound, wake_word, pending_push, device_reported,
              ring_reported, wake_word_reported, wake_word_pending,
              floor(extract(epoch from settings_updated_at) * 1000)::bigint AS "updatedAt"
         FROM bob.devices WHERE id = $1`;

function fromRow(row: SettingsRow): StoredDeviceSettings {
  return {
    volume: Number(row.volume), muted: row.muted, mode: row.mode, dnd: row.dnd,
    ring_seconds: Number(row.ring_seconds), ring_sound: row.ring_sound,
    ...(row.wake_word !== null ? { wake_word: row.wake_word } : {}),
    pendingPush: row.pending_push, deviceReported: row.device_reported, ringReported: row.ring_reported,
    wakeWordReported: row.wake_word_reported, wakeWordPending: row.wake_word_pending, updatedAt: Number(row.updatedAt),
  };
}

function refused(name: string): (error: unknown) => never {
  return (error) => {
    throw new StoreError(`${name}: ${error instanceof Error ? error.name : 'refused'}`);
  };
}

/** The device's stored settings, or null when none are stored or it is not the caller's. */
export async function getDeviceSettings(db: Db, userId: string, deviceId: string): Promise<StoredDeviceSettings | null> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<SettingsRow>(SELECT_SETTINGS, [deviceId]);
    const row = rows[0];
    return row && row.updatedAt !== null ? fromRow(row) : null;
  });
}

/**
 * A web change, stored pending until the device's matching device_state
 * clears it. Null for an unknown, revoked or other account's device (one
 * 404); 'ring_unsupported' for a ring change the firmware cannot take;
 * 'wake_word_unsupported' for a wake word change when the firmware has never
 * reported one and its live hello (`wakeWordCap`) did not advertise one.
 */
export async function patchDeviceSettings(
  db: Db, userId: string, deviceId: string, patch: Partial<DeviceSettings>, options: { wakeWordCap?: boolean } = {},
): Promise<DeviceSettings | 'ring_unsupported' | 'wake_word_unsupported' | null> {
  if (!UUID_RE.test(deviceId)) return null;
  return withUser(db, userId, async (tx) => {
    const fail = refused('patchDeviceSettings');
    const current = (await tx.query<SettingsRow>(
      `${SELECT_SETTINGS} AND revoked_at IS NULL FOR UPDATE`, [deviceId],
    ).catch(fail))[0];
    if (!current) return null;
    if ((patch.ring_seconds !== undefined || patch.ring_sound !== undefined) && current.ring_reported !== true) {
      return 'ring_unsupported';
    }
    if (patch.wake_word !== undefined && current.wake_word_reported !== true && options.wakeWordCap !== true) {
      return 'wake_word_unsupported';
    }
    const next = { ...pickSettings(fromRow(current)), ...patch };
    const updated = await tx.query(
      `UPDATE bob.devices
          SET volume = $3, muted = $4, mode = $5, dnd = $6, ring_seconds = $7, ring_sound = $8, wake_word = $9,
              wake_word_pending = wake_word_pending OR $10, pending_push = true, settings_updated_at = now()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [
        deviceId, userId, next.volume, next.muted, next.mode, next.dnd, next.ring_seconds, next.ring_sound, next.wake_word ?? null,
        patch.wake_word !== undefined,
      ],
    ).catch(fail);
    if (updated.length === 0) throw new StoreError('patchDeviceSettings: refused');
    return next;
  });
}

/**
 * A device report. With nothing pending it is the truth. With a web change
 * pending, an exact match clears it; a differing report keeps the pending
 * values when `keepPending` (the session still owes its one re-push) and
 * otherwise wins. A report without ring keys keeps the stored ring settings,
 * and one without a wake word keeps the stored wake word. A reported wake word
 * is the truth unless a web pick is pending (`wake_word_pending`); only then
 * does it take part in the match.
 */
export async function setDeviceSettings(
  db: Db, userId: string, deviceId: string, report: DeviceReport, options: { keepPending: boolean },
): Promise<DeviceReportResult> {
  return withUser(db, userId, async (tx) => {
    const fail = refused('setDeviceSettings');
    const current = (await tx.query<SettingsRow>(`${SELECT_SETTINGS} FOR UPDATE`, [deviceId]).catch(fail))[0];
    const before = current ? pickSettings(fromRow(current)) : DEFAULT_DEVICE_SETTINGS;
    const reported: DeviceSettings = {
      volume: report.volume, muted: report.muted, mode: report.mode, dnd: report.dnd,
      ring_seconds: report.ring_seconds ?? before.ring_seconds, ring_sound: report.ring_sound ?? before.ring_sound,
    };
    const wakeWord = report.wake_word ?? before.wake_word;
    if (wakeWord !== undefined) reported.wake_word = wakeWord;
    const wakePending = current?.pending_push === true && current.wake_word_pending;
    const matches = PUSHED_FIELDS.every((field) => before[field] === reported[field])
      && (!wakePending || before.wake_word === reported.wake_word);
    let outcome: DeviceReportResult['outcome'] = 'stored';
    if (current?.pending_push === true) outcome = matches ? 'synced' : options.keepPending ? 'kept_pending' : 'device_override';
    const next = outcome === 'kept_pending' ? before : reported;
    const pendingPush = outcome === 'kept_pending';
    const wakeWordPending = pendingPush && wakePending;
    const ringReported = current?.ring_reported === true || report.ring_seconds !== undefined;
    const rows = await tx.query<{ id: string }>(
      `UPDATE bob.devices
          SET volume = $3, muted = $4, mode = $5, dnd = $6, ring_seconds = $7, ring_sound = $8,
              pending_push = $9, device_reported = true, ring_reported = ring_reported OR $10,
              wake_word = $11, wake_word_reported = wake_word_reported OR $12, wake_word_pending = $13,
              settings_updated_at = now()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [
        deviceId, userId, next.volume, next.muted, next.mode, next.dnd, next.ring_seconds, next.ring_sound, pendingPush, ringReported,
        next.wake_word ?? null, report.wake_word !== undefined, wakeWordPending,
      ],
    ).catch(fail);
    // Same message the old RLS refusal produced (the contract snapshot pins it).
    if (rows.length === 0) throw new StoreError('setDeviceSettings: PostgresError');
    return {
      settings: next, pendingPush, ringReported, wakeWordPending, outcome, changed: FIELDS.filter((field) => before[field] !== next[field]),
    };
  });
}

/** Stores the model a hello board names (Bob's Waveshare) over the paired one:
 *  older firmware paired a Waveshare as "M5Stack Cardputer". Other boards keep it. */
export async function refreshModelFromBoard(db: Db, userId: string, deviceId: string, board: string | undefined): Promise<void> {
  const model = modelForBoard(board);
  if (model === null) return;
  await withUser(db, userId, (tx) => tx.query(
    'UPDATE bob.devices SET model = $1 WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL AND model IS DISTINCT FROM $1',
    [model, deviceId, userId],
  ));
}

/** The caller's own IANA time zone from their auth user_metadata, or null when unset. */
export async function getAccountTimeZone(db: Db, userId: string): Promise<string | null> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<{ zone: string | null }>(`SELECT bob_private.account_time_zone() AS zone`);
    return rows[0]?.zone ?? null;
  });
}
