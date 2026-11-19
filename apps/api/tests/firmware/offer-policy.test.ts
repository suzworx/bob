import { describe, expect, it } from 'vitest';
import { shouldHalt } from '../../src/firmware/auto-halt.ts';
import {
  decideOffer,
  rolloutBucket,
  type OfferInput,
  type ReleaseInfo,
} from '../../src/firmware/offer-policy.ts';
import { compareVersions, parseVersion } from '../../src/firmware/semver.ts';

const release = (version: string, over: Partial<ReleaseInfo> = {}): ReleaseInfo => ({
  version, boards: ['cardputer'], size: 1000, sha256: 'a'.repeat(64), keyId: 'k1',
  minFrom: '0.0.0', mandatory: false, securityFix: false, notes: null, ...over,
});

const idWithBucket = (want: (b: number) => boolean): string => {
  for (let i = 0; i < 1000; i++) if (want(rolloutBucket(`device-${i}`))) return `device-${i}`;
  throw new Error('no device id found');
};
const LOW = idWithBucket((b) => b < 10);
const HIGH = idWithBucket((b) => b >= 10);

const base = (over: Partial<OfferInput> = {}): OfferInput => ({
  deviceId: LOW, board: 'cardputer', current: '1.0.0', deviceChannel: 'stable', pinVersion: null,
  pinnedRelease: null, channel: { rolloutPct: 100, halted: false, minFwVersion: null },
  target: release('1.1.0'), steppingStone: null, recentFailures: 0, ...over,
});

describe('semver', () => {
  it.each([
    ['1.2.3', '1.2.4', -1], ['1.10.0', '1.9.9', 1], ['2.0.0', '2.0.0', 0],
    ['1.2.3-dev+abc', '1.2.3', -1], ['1.2.3', '1.2.3-dev+abc', 1], ['1.2.3-dev+abc', '1.2.2', 1],
  ])('%s vs %s is %i', (a, b, sign) => expect(compareVersions(a, b)).toBe(sign));

  it.each(['', '1.2', 'v1.2.3', '1.2.3-beta', '1.2.3-dev', '1.2.x', '1.2.3-dev+'])('rejects %j', (text) => {
    expect(parseVersion(text)).toBeNull();
    expect(compareVersions(text, '1.0.0')).toBeNull();
  });
});

describe('rolloutBucket', () => {
  it('is stable and within 0..99', () => {
    expect(rolloutBucket('abc')).toBe(rolloutBucket('abc'));
    for (let i = 0; i < 200; i++) expect(rolloutBucket(`d${i}`)).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 200; i++) expect(rolloutBucket(`d${i}`)).toBeLessThan(100);
  });
});

describe('decideOffer', () => {
  it('offers the channel target with a deterministic jitter', () => {
    const offer = decideOffer(base());
    expect(offer).toMatchObject({ version: '1.1.0', size: 1000, key_id: 'k1', mandatory: false, notes: null });
    expect(offer?.apply_after_s).toBeGreaterThanOrEqual(0);
    expect(offer?.apply_after_s).toBeLessThanOrEqual(21_600);
    expect(decideOffer(base())).toEqual(offer);
  });

  const none: Array<[string, Partial<OfferInput>]> = [
    ['no target', { target: null }],
    ['no channel row', { channel: null }],
    ['halted channel', { channel: { rolloutPct: 100, halted: true, minFwVersion: null } }],
    ['wrong board', { board: 'other' }],
    ['current equals target', { current: '1.1.0' }],
    ['current above target', { current: '1.2.0' }],
    ['unparseable current', { current: 'garbage' }],
    ['rollout 0', { channel: { rolloutPct: 0, halted: false, minFwVersion: null } }],
    ['bucket at or above rollout', { deviceId: HIGH, channel: { rolloutPct: 10, halted: false, minFwVersion: null } }],
    ['two recent failures', { recentFailures: 2 }],
    ['dev version on stable device', { target: release('1.1.0-dev+abc') }],
    ['min_from without a stepping stone', { target: release('1.1.0', { minFrom: '1.0.5' }) }],
    ['pin naming a missing release', { pinVersion: '9.9.9', pinnedRelease: null }],
  ];
  it.each(none)('offers nothing: %s', (_name, over) => expect(decideOffer(base(over))).toBeNull());

  it.each([
    ['rollout 10 and a bucket below it', { channel: { rolloutPct: 10, halted: false, minFwVersion: null } }],
    ['rollout 100 for any bucket', { deviceId: HIGH }],
    ['one recent failure', { recentFailures: 1 }],
    ['dev version on a dev device', { deviceChannel: 'dev' as const, target: release('1.1.0-dev+abc') }],
  ])('offers: %s', (_name, over) => expect(decideOffer(base(over))).not.toBeNull());

  it('mandatory and security fixes ignore rollout and apply at once', () => {
    const closed = { rolloutPct: 0, halted: false, minFwVersion: null };
    for (const flags of [{ mandatory: true }, { securityFix: true }]) {
      expect(decideOffer(base({ channel: closed, target: release('1.1.0', flags) }))).toMatchObject({ mandatory: true, apply_after_s: 0 });
    }
  });

  it('a device below the channel min_fw_version ignores rollout and is mandatory', () => {
    const channel = { rolloutPct: 0, halted: false, minFwVersion: '1.0.5' };
    expect(decideOffer(base({ channel }))).toMatchObject({ version: '1.1.0', mandatory: true, apply_after_s: 0 });
    expect(decideOffer(base({ channel, current: '1.0.5' }))).toBeNull();
  });

  it('a pin wins over a halted channel, the rollout and the channel target', () => {
    const channel = { rolloutPct: 0, halted: true, minFwVersion: null };
    const pinned = release('1.0.9');
    expect(decideOffer(base({ channel, pinVersion: '1.0.9', pinnedRelease: pinned }))).toMatchObject({ version: '1.0.9' });
    expect(decideOffer(base({ channel, pinVersion: '1.0.9', pinnedRelease: pinned, board: 'other' }))).toBeNull();
  });

  it('below min_from offers the stepping stone, not the target', () => {
    const target = release('1.1.0', { minFrom: '1.0.5' });
    expect(decideOffer(base({ target, steppingStone: release('1.0.5') }))).toMatchObject({ version: '1.0.5' });
    expect(decideOffer(base({ target, steppingStone: release('1.0.5', { boards: ['other'] }) }))).toBeNull();
  });
});

describe('shouldHalt', () => {
  it.each([
    [{ attempts: 9, rollbacks: 9, fleetSize: 50 }, false],
    [{ attempts: 10, rollbacks: 0, fleetSize: 50 }, false],
    [{ attempts: 100, rollbacks: 5, fleetSize: 500 }, false],
    [{ attempts: 100, rollbacks: 6, fleetSize: 500 }, true],
    [{ attempts: 10, rollbacks: 1, fleetSize: 50 }, true],
    [{ attempts: 3, rollbacks: 2, fleetSize: 19 }, true],
    [{ attempts: 3, rollbacks: 1, fleetSize: 19 }, false],
    [{ attempts: 3, rollbacks: 2, fleetSize: 20 }, false],
  ])('%j -> %s', (input, expected) => expect(shouldHalt(input)).toBe(expected));
});
