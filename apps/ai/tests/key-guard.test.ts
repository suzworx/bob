// #1041: dev/test runs spent the production key's budget. Live and test runs
// refuse the key whose fingerprint is BOB_PROD_KEY_FINGERPRINT (unless
// BOB_ALLOW_PROD_KEY=1), production refuses BOB_DEV_KEY_FINGERPRINT, and
// no message ever carries the key.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keyFingerprint, liveKeyRefusal, productionKeyRefusal, refuseProductionKey } from '../src/key-guard.ts';

const PROD_KEY = 'prod-key-for-tests-only';
const DEV_KEY = 'dev-key-for-tests-only';
const PROD_FP = keyFingerprint(PROD_KEY);
const DEV_FP = keyFingerprint(DEV_KEY);

describe('keyFingerprint', () => {
  it('is the first 8 hex characters of the SHA-256, never the key', () => {
    expect(PROD_FP).toBe(createHash('sha256').update(PROD_KEY).digest('hex').slice(0, 8));
    expect(PROD_FP).toMatch(/^[0-9a-f]{8}$/);
    expect(PROD_FP).not.toContain(PROD_KEY.slice(0, 4));
  });
});

describe('liveKeyRefusal (live and test runs)', () => {
  it('refuses the production key, naming variables only', () => {
    const reason = liveKeyRefusal({ AI_GATEWAY_API_KEY: PROD_KEY, BOB_PROD_KEY_FINGERPRINT: PROD_FP });
    expect(reason).toContain('BOB_PROD_KEY_FINGERPRINT');
    expect(reason).toContain('BOB_ALLOW_PROD_KEY=1');
    expect(reason).not.toContain(PROD_KEY);
    expect(reason).not.toContain(PROD_FP);
  });

  it('matches regardless of case and surrounding space', () => {
    expect(liveKeyRefusal({ AI_GATEWAY_API_KEY: PROD_KEY, BOB_PROD_KEY_FINGERPRINT: ` ${PROD_FP.toUpperCase()} ` })).toBeDefined();
  });

  it('allows the dev key, a missing key and an unset fingerprint', () => {
    expect(liveKeyRefusal({ AI_GATEWAY_API_KEY: DEV_KEY, BOB_PROD_KEY_FINGERPRINT: PROD_FP })).toBeUndefined();
    expect(liveKeyRefusal({ BOB_PROD_KEY_FINGERPRINT: PROD_FP })).toBeUndefined();
    expect(liveKeyRefusal({ AI_GATEWAY_API_KEY: PROD_KEY })).toBeUndefined();
  });

  it('allows the production key only with BOB_ALLOW_PROD_KEY=1', () => {
    const env = { AI_GATEWAY_API_KEY: PROD_KEY, BOB_PROD_KEY_FINGERPRINT: PROD_FP };
    expect(liveKeyRefusal({ ...env, BOB_ALLOW_PROD_KEY: '1' })).toBeUndefined();
    expect(liveKeyRefusal({ ...env, BOB_ALLOW_PROD_KEY: 'true' })).toBeDefined();
  });

  it('refuses a malformed fingerprint rather than silently switching the guard off', () => {
    for (const bad of ['abc', 'zzzzzzzz', `${PROD_FP}00`, PROD_KEY]) {
      const reason = liveKeyRefusal({ AI_GATEWAY_API_KEY: DEV_KEY, BOB_PROD_KEY_FINGERPRINT: bad });
      expect(reason).toContain('must be 8 hex characters');
      expect(reason).not.toContain(PROD_KEY);
    }
  });

  it('refuseProductionKey throws the refusal before any spend', () => {
    expect(() => refuseProductionKey({ AI_GATEWAY_API_KEY: PROD_KEY, BOB_PROD_KEY_FINGERPRINT: PROD_FP })).toThrow(/production key/);
    expect(() => refuseProductionKey({ AI_GATEWAY_API_KEY: DEV_KEY, BOB_PROD_KEY_FINGERPRINT: PROD_FP })).not.toThrow();
  });
});

describe('productionKeyRefusal (production boot)', () => {
  it('refuses the dev/test key and allows any other', () => {
    const reason = productionKeyRefusal({ AI_GATEWAY_API_KEY: DEV_KEY, BOB_DEV_KEY_FINGERPRINT: DEV_FP });
    expect(reason).toContain('BOB_DEV_KEY_FINGERPRINT');
    expect(reason).not.toContain(DEV_KEY);
    expect(productionKeyRefusal({ AI_GATEWAY_API_KEY: PROD_KEY, BOB_DEV_KEY_FINGERPRINT: DEV_FP })).toBeUndefined();
    expect(productionKeyRefusal({ AI_GATEWAY_API_KEY: PROD_KEY })).toBeUndefined();
  });

  it('is not switched off by BOB_ALLOW_PROD_KEY', () => {
    expect(productionKeyRefusal({ AI_GATEWAY_API_KEY: DEV_KEY, BOB_DEV_KEY_FINGERPRINT: DEV_FP, BOB_ALLOW_PROD_KEY: '1' })).toBeDefined();
  });
});
