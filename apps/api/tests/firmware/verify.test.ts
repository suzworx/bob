import { describe, expect, it } from 'vitest';
import { FirmwareVerifyError, firmwareKeysFromEnv, verifyRelease } from '../../src/firmware/verify.ts';
import { makeImage, makeKey, makeManifest, signManifest } from './fixture.ts';

const key = makeKey('k1');
const image = makeImage();
const keys = { k1: key.pem };

const refusal = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof FirmwareVerifyError ? error.code : `untyped:${String(error)}`;
  }
  return undefined;
};

describe('verifyRelease', () => {
  it('returns the parsed manifest for a good signature', () => {
    const manifest = makeManifest(image, key);
    const { manifestBytes, sigB64 } = signManifest(manifest, key);
    expect(verifyRelease({ manifestBytes, sigB64, keys })).toEqual(manifest);
  });

  it('rejects a tampered manifest', () => {
    const { manifestBytes, sigB64 } = signManifest(makeManifest(image, key), key);
    const tampered = Buffer.from(manifestBytes.toString('utf8').replace('"1.2.0"', '"9.9.9"'));
    expect(refusal(() => verifyRelease({ manifestBytes: tampered, sigB64, keys }))).toBe('bad_signature');
  });

  it('rejects a signature made by a different key', () => {
    const { manifestBytes, sigB64 } = signManifest(makeManifest(image, key), makeKey('k1'));
    expect(refusal(() => verifyRelease({ manifestBytes, sigB64, keys }))).toBe('bad_signature');
  });

  it('rejects an unknown key_id and never falls back to another key', () => {
    const { manifestBytes, sigB64 } = signManifest(makeManifest(image, key, { key_id: 'nope' }), key);
    expect(refusal(() => verifyRelease({ manifestBytes, sigB64, keys }))).toBe('unknown_key');
    const proto = signManifest(makeManifest(image, key, { key_id: 'constructor' }), key);
    expect(refusal(() => verifyRelease({ ...proto, keys }))).toBe('unknown_key');
  });

  it('rejects garbage signatures and keys without leaking', () => {
    const { manifestBytes } = signManifest(makeManifest(image, key), key);
    expect(refusal(() => verifyRelease({ manifestBytes, sigB64: '!!!', keys }))).toBe('bad_signature');
    expect(refusal(() => verifyRelease({ manifestBytes, sigB64: 'AAAA', keys: { k1: 'not a pem' } }))).toBe('bad_signature');
  });

  it.each([
    ['not json', Buffer.from('{nope')],
    ['an extra field', Buffer.from(JSON.stringify({ ...makeManifest(image, key), extra: 1 }))],
    ['a bad version', Buffer.from(JSON.stringify(makeManifest(image, key, { version: '1.2' })))],
    ['notes over 80 characters', Buffer.from(JSON.stringify(makeManifest(image, key, { notes: 'x'.repeat(81) })))],
    ['a short sha256', Buffer.from(JSON.stringify(makeManifest(image, key, { image: { file: 'f', size: 1, sha256: 'ab' } })))],
  ])('rejects a malformed manifest: %s', (_name, bytes) => {
    expect(refusal(() => verifyRelease({ manifestBytes: bytes, sigB64: 'AAAA', keys }))).toBe('bad_manifest');
  });
});

describe('firmwareKeysFromEnv', () => {
  it('reads the JSON map, treats unset as empty and refuses junk without echoing it', () => {
    expect(firmwareKeysFromEnv({ BOB_FW_PUBKEYS: JSON.stringify({ k1: 'pem' }) })).toEqual({ k1: 'pem' });
    expect(firmwareKeysFromEnv({})).toEqual({});
    expect(() => firmwareKeysFromEnv({ BOB_FW_PUBKEYS: 'secret-junk' })).toThrow(/BOB_FW_PUBKEYS/);
    expect(() => firmwareKeysFromEnv({ BOB_FW_PUBKEYS: '["a"]' })).toThrow(/BOB_FW_PUBKEYS/);
    try {
      firmwareKeysFromEnv({ BOB_FW_PUBKEYS: 'secret-junk' });
    } catch (error) {
      expect(String(error)).not.toContain('secret-junk');
    }
  });
});
