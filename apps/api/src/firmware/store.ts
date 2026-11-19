import { createHash } from 'node:crypto';
import { asServer, type Db } from '../platform/db/db.ts';
import { moduleJournal } from '../platform/logger.ts';
import { toSpanAttrs, traceSpan } from '@bob/ai';
import { shouldHalt } from './auto-halt.ts';
import type { ChannelInfo, FirmwareChannelName, ReleaseInfo } from './offer-policy.ts';
import { compareVersions } from './semver.ts';
import { FirmwareVerifyError, firmwareKeysFromEnv, verifyRelease } from './verify.ts';

const journal = moduleJournal('firmware');

export interface IngestInput {
  manifestBytes: Buffer;
  sigB64: string;
  image: Buffer;
}

export interface IngestResult {
  version: string;
  inserted: boolean;
  /** Boards whose dev channel now points at this version. */
  advanced: string[];
}

type OtaResult ='start' | 'ok' | 'rolled_back' | 'failed';

/** What a device reports about its previous OTA attempt. */
export interface LastOta {
  result: OtaResult;
  to: string;
  reason: string | null;
}

export interface DeviceFirmware {
  channel: FirmwareChannelName;
  pinVersion: string | null;
  board: string | null;
  attempts: number;
}

const call = <T>(db: Db, sql: string, params: unknown[]): Promise<T[]> =>
  asServer(db, (s) => s.query<T>(sql, params));

/** Verifies the signature, checks the image against the manifest, stores both and advances the dev channel. */
export async function ingestRelease(
  db: Db,
  { manifestBytes, sigB64, image }: IngestInput,
  keys: Readonly<Record<string, string>> = firmwareKeysFromEnv(),
): Promise<IngestResult> {
  const manifest = verifyRelease({ manifestBytes, sigB64, keys });
  const sha = createHash('sha256').update(image).digest('hex');
  if (image.length !== manifest.image.size || sha !== manifest.image.sha256) {
    throw new FirmwareVerifyError('image_mismatch');
  }
  return db.tx(async (tx) => {
    const [put] = await call<{ inserted: boolean }>(
      tx,
      `select bob_private.fw_put_release($1, $2::text[], $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) as inserted`,
      [
        manifest.version, manifest.boards, manifest.image.size, sha, sigB64, manifestBytes.toString('utf8'),
        manifest.key_id, manifest.min_from, manifest.mandatory, manifest.security_fix, manifest.rollback_safe,
        manifest.requires_bootloader, manifest.settings_schema, manifest.git_sha, manifest.notes, image,
      ],
    );
    const advanced: string[] = [];
    for (const board of manifest.boards) {
      const current = await getChannel(tx, 'dev', board);
      if (current === null || (compareVersions(manifest.version, current.version) ?? 0) > 0) {
        await call(tx, 'select bob_private.fw_set_channel($1, $2, $3, 100)', ['dev', board, manifest.version]);
        advanced.push(board);
      }
    }
    return { version: manifest.version, inserted: put?.inserted === true, advanced };
  });
}

export async function getChannel(
  db: Db,
  channel: FirmwareChannelName,
  board: string,
): Promise<(ChannelInfo & { version: string }) | null> {
  const [row] = await call<{ version: string; rollout_pct: number; halted: boolean; min_fw_version: string | null }>(
    db, 'select * from bob_private.fw_get_channel($1, $2)', [channel, board],
  );
  if (row === undefined) return null;
  return { version: row.version, rolloutPct: row.rollout_pct, halted: row.halted, minFwVersion: row.min_fw_version };
}

/** The device's channel, pin, board and attempt count; null for an unknown or revoked device. */
export async function channelFor(db: Db, deviceId: string): Promise<DeviceFirmware | null> {
  const [row] = await call<{ channel: FirmwareChannelName; pin_version: string | null; board: string | null; attempts: number }>(
    db, 'select * from bob_private.fw_device($1::uuid)', [deviceId],
  );
  return row === undefined
    ? null
    : { channel: row.channel, pinVersion: row.pin_version, board: row.board, attempts: row.attempts };
}

export async function recentFailures(db: Db, deviceId: string, version: string): Promise<number> {
  const [row] = await call<{ n: number }>(db, 'select bob_private.fw_recent_failures($1::uuid, $2) as n', [deviceId, version]);
  return row?.n ?? 0;
}

/** Records the board the device runs on and, when it reports a previous OTA attempt, that result as an event.
 *  True when a new result event was stored (a repeated report is dropped). */
export async function recordDeviceFirmware(
  db: Db,
  deviceId: string,
  { board, version, lastOta }: { board: string; version: string; lastOta: LastOta | null },
): Promise<boolean> {
  const from = lastOta === null || lastOta.result === 'ok' ? null : version;
  const [row] = await call<{ inserted: boolean }>(
    db,
    'select bob_private.fw_record_event($1::uuid, $2, $3, $4, $5, $6) as inserted',
    [deviceId, board, lastOta?.result ?? null, from, lastOta?.to ?? null, lastOta?.reason ?? null],
  );
  const stored = lastOta !== null && row?.inserted === true;
  if (lastOta !== null && stored) {
    traceSpan(
      'firmware-ota-result',
      toSpanAttrs({ surface: 'firmware', metadata: { result: lastOta.result, board, ...(from !== null ? { from } : {}), to: lastOta.to } }),
      () => journal('v2.ota.result', { result: lastOta.result, board, from: from ?? undefined, to: lastOta.to, reason: lastOta.reason ?? undefined }),
    );
  }
  return stored;
}

/** Records that the device was offered `version` (a repeat of its latest event is dropped), journaling the version only. */
export async function recordOffer(db: Db, deviceId: string, version: string): Promise<void> {
  const [row] = await call<{ inserted: boolean }>(
    db, 'select bob_private.fw_record_event($1::uuid, null, $2, null, $3, null) as inserted', [deviceId, 'offer', version],
  );
  if (row?.inserted === true) journal('v2.ota.offer', { version });
}

/** One release row as the offer policy reads it; null when no such version exists. */
export async function getRelease(db: Db, version: string): Promise<ReleaseInfo | null> {
  const [row] = await call<{
    version: string; boards: string[]; size: number; sha256: string; key_id: string; min_from: string;
    mandatory: boolean; security_fix: boolean; notes: string | null;
  }>(db, 'select * from bob_private.fw_get_release($1)', [version]);
  if (row === undefined) return null;
  return {
    version: row.version, boards: row.boards, size: row.size, sha256: row.sha256, keyId: row.key_id,
    minFrom: row.min_from, mandatory: row.mandatory, securityFix: row.security_fix, notes: row.notes,
  };
}

export async function getImage(db: Db, version: string, board: string): Promise<{ bytes: Buffer; etag: string } | null> {
  const [row] = await call<{ bytes: Uint8Array; sha256: string }>(db, 'select * from bob_private.fw_get_image($1, $2)', [version, board]);
  return row === undefined ? null : { bytes: Buffer.from(row.bytes), etag: `"${row.sha256}"` };
}

/** The exact signed manifest bytes of a release and their base64 signature, for the device to verify. */
export async function getManifest(db: Db, version: string, board: string): Promise<{ bytes: Buffer; signature: string } | null> {
  const [row] = await call<{ manifest: string; signature: string; boards: string[] }>(db, 'select * from bob_private.fw_get_release($1)', [version]);
  return row === undefined || !row.boards.includes(board) ? null : { bytes: Buffer.from(row.manifest, 'utf8'), signature: row.signature };
}

/** Reads the last 7 days of outcomes for the channel's current version and halts the channel when they say so. */
export async function evaluateAutoHalt(db: Db, channel: FirmwareChannelName, board: string): Promise<boolean> {
  const [counts] = await call<{ attempts: number; rollbacks: number; fleet_size: number }>(
    db, 'select * from bob_private.fw_halt_counts($1, $2)', [channel, board],
  );
  if (counts === undefined || !shouldHalt({ attempts: counts.attempts, rollbacks: counts.rollbacks, fleetSize: counts.fleet_size })) {
    return false;
  }
  const [set] = await call<{ changed: boolean }>(db, 'select bob_private.fw_set_halted($1, $2, true) as changed', [channel, board]);
  if (set?.changed === true) journal('v2.ota.halt', { channel, board, attempts: counts.attempts, rollbacks: counts.rollbacks });
  return true;
}
