import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { FirmwareManifest } from '../../src/firmware/verify.ts';

export interface TestKey {
  keyId: string;
  privateKey: KeyObject;
  pem: string;
}

/** An ephemeral ECDSA P-256 key pair; never a real signing key. */
export function makeKey(keyId = 'test-key'): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { keyId, privateKey, pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

export function makeImage(fill = 7, size = 2048): Buffer {
  return Buffer.alloc(size, fill);
}

export function makeManifest(image: Buffer, key: TestKey, over: Partial<FirmwareManifest> = {}): FirmwareManifest {
  return {
    schema: 1, product: 'bob-cardputer', version: '1.2.0', boards: ['cardputer'],
    image: { file: 'firmware.bin', size: image.length, sha256: createHash('sha256').update(image).digest('hex') },
    min_from: '0.0.0', allow_downgrade: false, rollback_safe: true, settings_schema: 1,
    requires_bootloader: null, mandatory: false, security_fix: false, key_id: key.keyId,
    git_sha: 'abc1234', built_at: '2026-10-04T10:00:00.000Z', notes: 'test build', ...over,
  };
}

/** The signed bytes and the base64 DER signature over them. */
export function signManifest(manifest: unknown, key: TestKey): { manifestBytes: Buffer; sigB64: string } {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const sigB64 = sign('sha256', manifestBytes, { key: key.privateKey, dsaEncoding: 'der' }).toString('base64');
  return { manifestBytes, sigB64 };
}
