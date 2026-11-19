// The OTA part of the device wire (hello fields, offer, check_update, ota_progress).
import { z } from 'zod';
import { clipLabel, EnvelopeSchema, FirmwareVersionSchema, OpaqueIdSchema, V2_VERSION } from './protocol-base.ts';

// The OTA fields of hello. Each is optional and a bad value reads as
// absent (below), never a failed hello. The reason is a short code, not text.
export const OtaBoardSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,24}$/);
const OtaReasonSchema = z.string().regex(/^[a-z0-9_]{1,24}$/);
export const LastOtaSchema = z.object({
  result: z.enum(['ok', 'rolled_back', 'failed']),
  to: FirmwareVersionSchema,
  reason: OtaReasonSchema.optional().catch(undefined),
}).strip();

// The device asks for its current offer (answered with update_offer).
export const CheckUpdateDtoSchema = EnvelopeSchema.extend({
  type: z.literal('check_update'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: z.object({}).strip(),
});
// The device's update progress; only 'start' is recorded, the result
// reaches the server in the next hello's last_ota.
export const OtaProgressDtoSchema = EnvelopeSchema.extend({
  type: z.literal('ota_progress'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: z.object({
    stage: z.enum(['start', 'ok', 'failed']),
    to: FirmwareVersionSchema,
    reason: OtaReasonSchema.optional().catch(undefined),
  }).strip(),
});

// An offered update, exactly the firmware module's Offer in contract
// key order; `notes` is omitted when the release has none.
const OTA_NOTES_MAX = 80;
export const OtaOfferSchema = z.object({
  version: FirmwareVersionSchema,
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  key_id: z.string().regex(/^[A-Za-z0-9_-]{1,15}$/),
  mandatory: z.boolean(),
  apply_after_s: z.number().int().nonnegative(),
  notes: z.string().max(OTA_NOTES_MAX).optional(),
}).strict();
export type OtaOfferWire = z.infer<typeof OtaOfferSchema>;

/** The wire form of a firmware-module Offer: contract key order, notes clipped to 80 or omitted. */
export function otaOfferWire(offer: Omit<OtaOfferWire, 'notes'> & { notes: string | null }): OtaOfferWire {
  const wire: OtaOfferWire = {
    version: offer.version, size: offer.size, sha256: offer.sha256, key_id: offer.key_id,
    mandatory: offer.mandatory, apply_after_s: offer.apply_after_s,
  };
  if (offer.notes !== null && offer.notes !== '') wire.notes = clipLabel(offer.notes, OTA_NOTES_MAX);
  return wire;
}

// The answer to check_update; `offer: null` means nothing to offer.
export const UpdateOfferDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('update_offer'), id: OpaqueIdSchema,
  payload: z.union([OtaOfferSchema, z.object({ offer: z.null() }).strict()]),
}).strict();
