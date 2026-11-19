import { verify as cryptoVerify } from 'node:crypto';
import { z } from 'zod';
import { parseVersion } from './semver.ts';

export type VerifyErrorCode = 'bad_manifest' | 'unknown_key' | 'bad_signature' | 'image_mismatch';

/** Typed so callers can map a refusal to a reason code; messages never carry manifest or key bytes. */
export class FirmwareVerifyError extends Error {
  constructor(readonly code: VerifyErrorCode) {
    super(`firmware release refused: ${code}`);
    this.name = 'FirmwareVerifyError';
  }
}

const versionText = z.string().refine((text) => parseVersion(text) !== null, 'not a firmware version');

const manifestSchema =z
  .object({
    schema: z.literal(1),
    product: z.literal('bob-cardputer'),
    version: versionText,
    boards: z.array(z.string().min(1)).min(1),
    image: z
      .object({
        file: z.string().min(1),
        size: z.number().int().positive(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    min_from: versionText,
    allow_downgrade: z.boolean(),
    rollback_safe: z.boolean(),
    settings_schema: z.number().int().nonnegative(),
    requires_bootloader: z.string().nullable(),
    mandatory: z.boolean(),
    security_fix: z.boolean(),
    key_id: z.string().min(1),
    git_sha: z.string().min(1),
    built_at: z.string().datetime(),
    notes: z.string().max(80),
  })
  .strict();

export type FirmwareManifest = z.infer<typeof manifestSchema>;

export interface VerifyInput {
  manifestBytes: Buffer;
  sigB64: string;
  /** key_id -> PEM public key (ECDSA P-256). */
  keys: Readonly<Record<string, string>>;
}

function parseManifest(bytes: Buffer): FirmwareManifest {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new FirmwareVerifyError('bad_manifest');
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) throw new FirmwareVerifyError('bad_manifest');
  return parsed.data;
}

/** Checks the manifest shape, then the DER ECDSA P-256 / SHA-256 signature over its exact bytes. */
export function verifyRelease({ manifestBytes, sigB64, keys }: VerifyInput): FirmwareManifest {
  const manifest = parseManifest(manifestBytes);
  const pem = Object.hasOwn(keys, manifest.key_id) ? keys[manifest.key_id] : undefined;
  if (pem === undefined) throw new FirmwareVerifyError('unknown_key');
  let good = false;
  try {
    good = cryptoVerify('sha256', manifestBytes, { key: pem, dsaEncoding: 'der' }, Buffer.from(sigB64, 'base64'));
  } catch {
    good = false;
  }
  if (!good) throw new FirmwareVerifyError('bad_signature');
  return manifest;
}

/** BOB_FW_PUBKEYS is a JSON object of key_id -> PEM; unset means no release can be ingested. */
export function firmwareKeysFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const raw = env.BOB_FW_PUBKEYS;
  if (raw === undefined || raw.trim() === '') return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('BOB_FW_PUBKEYS must be a JSON object of key id to PEM public key');
  }
  const parsed = z.record(z.string(), z.string()).safeParse(json);
  if (!parsed.success) throw new Error('BOB_FW_PUBKEYS must be a JSON object of key id to PEM public key');
  return parsed.data;
}
