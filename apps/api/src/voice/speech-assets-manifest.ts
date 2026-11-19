import { z } from 'zod';

const clipId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const text = z.string().min(1).max(200);

/** A reviewed pack of PCM clips and exact response templates. */
export const SpeechAssetManifestSchema = z.strictObject({
  schemaVersion: z.literal(2),
  buildVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  model: z.string().min(1).max(128),
  voice: z.string().min(1).max(128),
  locale: z.string().min(2).max(32),
  clips: z.array(z.strictObject({
    id: clipId,
    path: z.string().min(1).max(180),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().min(2).max(320 * 1024),
    durationMs: z.number().int().positive(),
    sampleRateHz: z.literal(16_000),
  })).max(256),
  templates: z.array(z.strictObject({
    id: clipId,
    segments: z.array(z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('literal'), text, clipId }),
      z.strictObject({ type: z.literal('slot'), values: z.array(z.strictObject({ text, clipId })).min(1).max(64) }),
    ])).min(1).max(8),
  })).max(64),
});

export type SpeechAssetManifest = z.infer<typeof SpeechAssetManifestSchema>;
export type SpeechAssetClip = SpeechAssetManifest['clips'][number];
