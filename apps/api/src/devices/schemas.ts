import { z } from 'zod';
import { DeviceModeSchema, DeviceVolumeSchema, RingSecondsSchema, RingSoundSchema, WakeWordSchema } from '../voice/protocol.ts';
import { ANNOUNCE_BODY_MAX, ANNOUNCE_TITLE_MAX } from './settings.ts';
import { OpaqueId } from '../platform/id-schemas.ts';

/** The device's 8-char user code, as typed. */
export const PairLookupRequestSchema = z.object({ user_code: z.string().min(1).max(16) }).strict();

export const PairApproveRequestSchema = z
  .object({
    pairing_id: z.string().uuid(),
    name: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

export const PairDenyRequestSchema = z.object({ pairing_id: z.string().uuid() }).strict();

const DeviceIdSchema = z.string().uuid();

/** A conversation id ("cnv_...") or a space-thread ref ("thr_<uuid>"). */
export const ConversationIdSchema = z.string().min(1).max(100);

const DeviceSettingsSchema = z
  .object({
    volume: DeviceVolumeSchema,
    muted: z.boolean(),
    mode: DeviceModeSchema,
    dnd: z.boolean(),
    ring_seconds: RingSecondsSchema,
    ring_sound: RingSoundSchema,
    // The stored wake word, else the brand default (Bob's board or a heybob.xyz host: 'bob').
    wake_word: WakeWordSchema,
  })
  .strict();

/** What the connected device last reported; the extras are null when offline or unreported. */
const DeviceLiveSchema = z
  .object({
    connected: z.boolean(),
    battery_pct: z.number().int().min(0).max(100).nullable(),
    charging: z.boolean().nullable(),
    fw_version: z.string().min(1).max(16).nullable(),
  })
  .strict();

export const DeviceSettingsPatchSchema = DeviceSettingsSchema.partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'send at least one setting' });

/** `pending` is always true: only the device's matching device_state confirms a change. */
export const DeviceSettingsResponseSchema = z
  .object({ id: z.string().uuid(), settings: DeviceSettingsSchema, delivered: z.boolean(), pending: z.boolean() })
  .strict();

const DeviceSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(40),
    model: z.string().min(1).max(64),
    paired_at: z.number().int().positive(),
    last_seen_at: z.number().int().positive().nullable(),
    // A live socket in this server process right now.
    connected: z.boolean(),
    settings: DeviceSettingsSchema,
    // A web change the device has not confirmed with device_state yet.
    pending: z.boolean(),
    // The device has ever reported device_state, so its firmware understands device_control.
    settings_supported: z.boolean(),
    // The device has ever reported ring_seconds, so its firmware takes the ring keys.
    ring_settings_supported: z.boolean(),
    // The firmware takes wake_word: it has reported one, or its live hello has cap 'wake_word'.
    wake_word_supported: z.boolean(),
    live: DeviceLiveSchema,
    // This device's own pointer, when it has one (else it follows the account's).
    active_conversation_id: OpaqueId.nullable().optional(),
    active_space_id: z.string().uuid().nullable().optional(),
  })
  .strict();

export const DevicesResponseSchema = z
  .object({
    devices: z.array(DeviceSummarySchema),
    active_conversation: z
      .object({ id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), title: z.string().min(1).max(200) })
      .strict()
      .nullable(),
    active_space: z.object({ id: z.string().uuid(), name: z.string().min(1).max(60) }).strict().nullable(),
  })
  .strict();

/** Null clears the pointer; a device_id moves only that device's own pointer. */
export const ActiveSpaceRequestSchema = z
  .object({ space_id: z.string().uuid().nullable(), device_id: DeviceIdSchema.optional() })
  .strict();

/** A thread_id needs conversation_id null and the thread's own space as space_id. */
export const ActiveConversationRequestSchema = z
  .object({
    conversation_id: ConversationIdSchema.nullable(),
    space_id: z.string().uuid().nullable(),
    thread_id: z.string().uuid().optional(),
    device_id: DeviceIdSchema.optional(),
  })
  .strict()
  .refine((body) => body.thread_id === undefined || (body.conversation_id === null && body.space_id !== null));

export const ActiveSpaceResponseSchema = z
  .object({
    active_space: z.object({ id: z.string().uuid(), name: z.string().min(1).max(60) }).strict().nullable(),
  })
  .strict();

export type ActiveSpaceRequest = z.infer<typeof ActiveSpaceRequestSchema>;
export type ActiveConversationRequest = z.infer<typeof ActiveConversationRequestSchema>;

export const DeviceRenameRequestSchema = z.object({ name: z.string().trim().min(1).max(40) }).strict();

export const DeviceRenameResponseSchema = z
  .object({ id: z.string().uuid(), name: z.string().min(1).max(40) })
  .strict();

export const DeviceAnnounceRequestSchema = z
  .object({
    kind: z.literal('notice'),
    title: z.string().min(1).max(ANNOUNCE_TITLE_MAX),
    body: z.string().max(ANNOUNCE_BODY_MAX).optional(),
    ring: z.boolean(),
  })
  .strict();

/** `held` while the device is busy or in DND. */
export const DeviceAnnounceResponseSchema = z.object({ status: z.enum(['sent', 'held']) }).strict();

export const DEVICE_ACTIVITY_MAX = 20;
export const HEARD_EXCERPT_MAX = 80;

export const DeviceActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(DEVICE_ACTIVITY_MAX).default(5),
}).strict();

const ActivityTurnFields = {
  kind: z.literal('turn'),
  at: z.number().int().nonnegative(),
  title: z.string(),
  // Shown to the owner, never journaled.
  heard_excerpt: z.string().max(HEARD_EXCERPT_MAX),
};

/** A timer rings every device, so it carries scope 'account', not a per-device claim. */
const DeviceActivityItemSchema = z.union([
  z.object({ ...ActivityTurnFields, conversation_id: z.string().min(1) }).strict(),
  z.object({ ...ActivityTurnFields, thread_id: z.string().uuid(), space_id: z.string().uuid() }).strict(),
  z.object({
    kind: z.literal('timer'),
    at: z.number().int().nonnegative(),
    label: z.string().nullable(),
    status: z.enum(['fired', 'dismissed']),
    scope: z.literal('account'),
  }).strict(),
]);

export const DeviceActivityResponseSchema = z.object({
  items: z.array(DeviceActivityItemSchema).max(DEVICE_ACTIVITY_MAX),
}).strict();

export type DeviceSummary = z.infer<typeof DeviceSummarySchema>;
export type DevicesResponse = z.infer<typeof DevicesResponseSchema>;
