// Leaf pieces of the device wire shared by protocol.ts and protocol-ota.ts.
import { z } from 'zod';

export const V2_VERSION = 1 as const;

// Device health, sent by newer firmware only (absent on older builds):
// Wi-Fi signal, heap watermarks, and serial lines dropped under pressure.
export const DeviceHealthSchema = z.object({
  rssi_dbm: z.number().int().min(-100).max(0).optional(),
  heap_free: z.number().int().nonnegative().optional(),
  heap_largest: z.number().int().nonnegative().optional(),
  log_dropped: z.number().int().nonnegative().optional(),
});

export const OpaqueIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const PayloadSchema = z.record(z.string(), z.unknown());
export const EnvelopeSchema = z.object({
  v: z.literal(V2_VERSION),
  type: z.string(),
  id: OpaqueIdSchema,
  turn_ref: OpaqueIdSchema.optional(),
  seq: z.number().int().nonnegative().optional(),
  payload: PayloadSchema.default({}),
}).strict();

// The firmware's build version (SemVer, "x.y.z" for a release,
// "x.y.z-dev+<sha>" for a local build), bounded and never used in a path.
const FW_VERSION_MAX = 32;
export const FirmwareVersionSchema = z.string().max(FW_VERSION_MAX).regex(
  /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
);

/** A timer label clipped to `max` UTF-16 units without splitting a surrogate pair. */
export function clipLabel(label: string, max: number): string {
  if (label.length <= max) return label;
  const cut = label.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
