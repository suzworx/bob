import type { Db } from '../platform/db/db.ts';
import { decideOffer, type Offer } from './offer-policy.ts';
import { compareVersions } from './semver.ts';
import {
  channelFor, evaluateAutoHalt, getChannel, getRelease, recentFailures, recordDeviceFirmware, recordOffer,
  type DeviceFirmware, type LastOta,
} from './store.ts';

async function decide(db: Db, deviceId: string, device: DeviceFirmware, board: string, current: string): Promise<Offer | null> {
  const channel = await getChannel(db, device.channel, board);
  const pinnedRelease = device.pinVersion === null ? null : await getRelease(db, device.pinVersion);
  const target = channel === null ? null : await getRelease(db, channel.version);
  const goal = device.pinVersion === null ? target : pinnedRelease;
  const behindMinFrom = goal !== null && (compareVersions(current, goal.minFrom) ?? 0) < 0;
  return decideOffer({
    deviceId, board, current, deviceChannel: device.channel, pinVersion: device.pinVersion, pinnedRelease, channel, target,
    steppingStone: behindMinFrom ? await getRelease(db, goal.minFrom) : null,
    recentFailures: goal === null ? 0 : await recentFailures(db, deviceId, goal.version),
  });
}

/** What a hello reports: the board, the running version and the outcome of the previous OTA attempt. */
export interface HelloReport {
  board?: string;
  version: string;
  lastOta?: LastOta;
}

/** Stores what the hello reported (a new result may halt its channel), then decides the offer and records it.
 *  Null for an unknown device, an unknown board or when nothing is on offer. */
export async function offerOnHello(db: Db, deviceId: string, report: HelloReport): Promise<Offer | null> {
  const device = await channelFor(db, deviceId);
  const board = report.board ?? device?.board ?? null;
  if (device === null || board === null) return null;
  if (report.board !== undefined || report.lastOta !== undefined) {
    const stored = await recordDeviceFirmware(db, deviceId, { board, version: report.version, lastOta: report.lastOta ?? null });
    if (stored) await evaluateAutoHalt(db, device.channel, board);
  }
  const offer = await decide(db, deviceId, device, board, report.version);
  if (offer !== null) await recordOffer(db, deviceId, offer.version);
  return offer;
}

/** The device's current offer on its already-known board; nothing is recorded. */
export async function currentOffer(db: Db, deviceId: string, version: string): Promise<Offer | null> {
  const device = await channelFor(db, deviceId);
  return device === null || device.board === null ? null : decide(db, deviceId, device, device.board, version);
}

/** Records that the device began installing `to` while running `version`. */
export async function recordOtaStart(db: Db, deviceId: string, version: string, to: string): Promise<void> {
  const device = await channelFor(db, deviceId);
  if (device === null || device.board === null) return;
  await recordDeviceFirmware(db, deviceId, { board: device.board, version, lastOta: { result: 'start', to, reason: null } });
}
