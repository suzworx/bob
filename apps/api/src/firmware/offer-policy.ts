import { createHash } from 'node:crypto';
import { compareVersions, isDevVersion } from './semver.ts';

export type FirmwareChannelName = 'dev' | 'beta' | 'stable';

export interface ReleaseInfo {
  version: string;
  boards: readonly string[];
  size: number;
  sha256: string;
  keyId: string;
  minFrom: string;
  mandatory: boolean;
  securityFix: boolean;
  notes: string | null;
}

export interface ChannelInfo {
  rolloutPct: number;
  halted: boolean;
  minFwVersion: string | null;
}

export interface OfferInput {
  deviceId: string;
  board: string;
  current: string;
  deviceChannel: FirmwareChannelName;
  pinVersion: string | null;
  /** The pinned release row; null when the pin names a version that does not exist. */
  pinnedRelease: ReleaseInfo | null;
  channel: ChannelInfo | null;
  /** The release the channel points at; null when the channel has none for the board. */
  target: ReleaseInfo | null;
  /** The release to offer first when current is below the target's min_from. */
  steppingStone: ReleaseInfo | null;
  /** Failed or rolled-back attempts for the target in the last 24 hours. */
  recentFailures: number;
}

/** The wire shape the offer routes will send, so keys are snake_case. */
export interface Offer {
  version: string;
  size: number;
  sha256: string;
  key_id: string;
  mandatory: boolean;
  apply_after_s: number;
  notes: string | null;
}

const MAX_JITTER_S = 21_600;
const BACKOFF_FAILURES = 2;

function firstWord(text: string): number {
  return createHash('sha256').update(text).digest().readUInt32BE(0);
}

/** A stable 0..99 slot per device, the rollout gate compares it with rollout_pct. */
export function rolloutBucket(deviceId: string): number {
  return firstWord(deviceId) % 100;
}

function below(a: string, b: string): boolean {
  return (compareVersions(a, b) ?? 0) < 0;
}

function offerRelease(input: OfferInput, target: ReleaseInfo, pinned: boolean): Offer | null {
  if (!target.boards.includes(input.board)) return null;
  const order = compareVersions(input.current, target.version);
  if (order === null || order >= 0) return null;
  if (isDevVersion(target.version) && input.deviceChannel !== 'dev') return null;
  const minFw = input.channel?.minFwVersion ?? null;
  const forced = target.mandatory || target.securityFix || (minFw !== null && below(input.current, minFw));
  if (!pinned && !forced && input.channel !== null && rolloutBucket(input.deviceId) >= input.channel.rolloutPct) {
    return null;
  }
  if (input.recentFailures >= BACKOFF_FAILURES) return null;
  return {
    version: target.version,
    size: target.size,
    sha256: target.sha256,
    key_id: target.keyId,
    mandatory: forced,
    apply_after_s: forced ? 0 : firstWord(`${input.deviceId}|${target.version}`) % (MAX_JITTER_S + 1),
    notes: target.notes,
  };
}

export function decideOffer(input: OfferInput): Offer | null {
  const pinned = input.pinVersion !== null;
  const target = pinned ? input.pinnedRelease : input.target;
  if (target === null) return null;
  if (!pinned && (input.channel === null || input.channel.halted)) return null;
  if (!target.boards.includes(input.board)) return null;
  const order = compareVersions(input.current, target.version);
  if (order === null || order >= 0) return null;
  if (below(input.current, target.minFrom)) {
    const stone = input.steppingStone;
    return stone === null ? null : offerRelease({ ...input, recentFailures: 0 }, stone, pinned);
  }
  return offerRelease(input, target, pinned);
}
