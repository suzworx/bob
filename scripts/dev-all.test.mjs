import { describe, expect, it } from 'vitest';
import { envFileDefines, localPairingUrl } from './dev-all.mjs';

describe('localPairingUrl', () => {
  it('points the Cardputer at the local vite pairing page', () => {
    expect(localPairingUrl({}, '', '192.168.1.29')).toBe('http://192.168.1.29:5173/pair');
  });

  it('falls back to localhost when no LAN address is found', () => {
    expect(localPairingUrl({}, '', null)).toBe('http://localhost:5173/pair');
  });

  it('leaves an BOB_PAIRING_URL from the shell alone', () => {
    expect(localPairingUrl({ BOB_PAIRING_URL: 'https://example.test/pair' }, '', '192.168.1.29')).toBeNull();
  });

  it('leaves an BOB_PAIRING_URL from the root .env alone', () => {
    expect(localPairingUrl({}, 'BOB_PAIRING_URL=https://example.test/pair\n', '192.168.1.29')).toBeNull();
  });
});

describe('envFileDefines', () => {
  it('matches plain and exported assignments', () => {
    expect(envFileDefines('A=1\nBOB_PAIRING_URL=x', 'BOB_PAIRING_URL')).toBe(true);
    expect(envFileDefines('export BOB_PAIRING_URL = x', 'BOB_PAIRING_URL')).toBe(true);
  });

  it('ignores commented lines and longer keys', () => {
    expect(envFileDefines('# BOB_PAIRING_URL=x', 'BOB_PAIRING_URL')).toBe(false);
    expect(envFileDefines('BOB_PAIRING_URL_OLD=x', 'BOB_PAIRING_URL')).toBe(false);
  });
});
