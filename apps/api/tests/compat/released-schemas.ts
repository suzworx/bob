/**
 * FROZEN client-message schemas of the RELEASED server: apps/api/src/voice/protocol.ts at
 * origin/main (6ddb3e9e131bbdd88c97cb9a33a46834652001c1), snapshot taken 2026-09-28. Generated; do not edit.
 * Refresh at each release with:
 *   node scripts/release/schema-snapshot.mjs --ref <deployed tag>
 * Read by tests/voice/wire-compat.test.ts (docs/testing/test-strategy.md §7).
 */
import { z } from 'zod';

const V2_VERSION = 1 as const;

const PCM16_16K_MONO_FORMAT = 1 as const;

const MP3_16K_MONO_FORMAT = 2 as const;

const OpaqueIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

const PayloadSchema = z.record(z.string(), z.unknown());

const EnvelopeSchema = z.object({
  v: z.literal(V2_VERSION),
  type: z.string(),
  id: OpaqueIdSchema,
  turn_ref: OpaqueIdSchema.optional(),
  seq: z.number().int().nonnegative().optional(),
  payload: PayloadSchema.default({}),
}).strict();

// #345: the firmware's build version (SemVer, "x.y.z" for a release,
// "x.y.z-dev+<sha>" for a local build), bounded and never used in a path.
const FW_VERSION_MAX = 32;

const FirmwareVersionSchema = z.string().max(FW_VERSION_MAX).regex(
  /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
);

/** hello's fw_version after Zod rejected the device's value: the hello itself stands. */
const INVALID_FW_VERSION = 'invalid' as const;

/** Capability tokens a firmware advertises in hello; unknown tokens are kept (newer firmware). */
const FW_CAPS_MAX = 16;

const FirmwareCapSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

const HelloDtoSchema = EnvelopeSchema.extend({
  type: z.literal('hello'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  // fw_version and caps are optional (older firmware sends neither) and never
  // fail the hello: a bad version reads as INVALID_FW_VERSION, bad caps as absent.
  // Unknown keys are stripped, not refused: a strict hello turned every newer
  // firmware field into BAD_MESSAGE with no welcome (HELLO-COMPAT).
  payload: z.object({
    format_id: z.union([z.literal(PCM16_16K_MONO_FORMAT), z.literal(MP3_16K_MONO_FORMAT)]),
    fw_version: FirmwareVersionSchema.optional().catch(INVALID_FW_VERSION),
    caps: z.array(FirmwareCapSchema).max(FW_CAPS_MAX).optional().catch(undefined),
  }).strip(),
});

const TurnStartDtoSchema = EnvelopeSchema.extend({
  type: z.literal('turn_start'),
  turn_ref: OpaqueIdSchema,
  seq: z.undefined().optional(),
  payload: z.object({}).strict(),
});

const TurnEndDtoSchema = EnvelopeSchema.extend({
  type: z.literal('turn_end'),
  turn_ref: OpaqueIdSchema,
  seq: z.number().int().nonnegative(),
  payload: z.object({}).strict(),
});

const CancelDtoSchema = EnvelopeSchema.extend({
  type: z.literal('cancel'),
  turn_ref: OpaqueIdSchema.optional(),
  seq: z.undefined().optional(),
  payload: z.object({}).strict(),
});

const PongDtoSchema = EnvelopeSchema.extend({
  type: z.literal('pong'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: z.object({}).strict(),
});

const ListConversationsDtoSchema = EnvelopeSchema.extend({
  type: z.literal('list_conversations'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: z.object({}).strict(),
});

const SelectConversationDtoSchema = EnvelopeSchema.extend({
  type: z.literal('select_conversation'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: z.object({ conversation_id: OpaqueIdSchema }).strict(),
});

// #302: clears the account's active-conversation pointer; the next device turn
// creates the conversation. request_id makes a retry idempotent.
const NewConversationDtoSchema = EnvelopeSchema.extend({
  type: z.literal('new_conversation'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: z.object({ request_id: OpaqueIdSchema }).strict(),
});

// #301: the Space picker. A Space id is the store's uuid; null clears the
// account's active-Space pointer.
const ListSpacesDtoSchema = EnvelopeSchema.extend({
  type: z.literal('list_spaces'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: z.object({}).strict(),
});

const SelectSpaceDtoSchema = EnvelopeSchema.extend({
  type: z.literal('select_space'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: z.object({ space_id: z.string().uuid().nullable() }).strict(),
});

const PairRequestDtoSchema = EnvelopeSchema.extend({
  type: z.literal('pair_request'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: z.object({
    model: z.string().min(1).max(64),
    fw_version: z.string().min(1).max(32),
    claim: z.string().regex(/^[0-9a-f]{32}$/),
    resume: z.string().uuid().optional(),
  }).strict(),
});

// Epic #311 device control contract. `mode` and the 0..10 volume are shared by
// device_state (device -> server) and device_control (server -> device).
const DeviceModeSchema = z.enum(['ptt', 'wake', 'announce_only']);

const DeviceVolumeSchema = z.number().int().min(0).max(10);

// #389: how long a timer or alarm rings before it counts as missed, and with which built-in sound.
const RING_SECONDS_MIN = 10;

const RING_SECONDS_MAX = 120;

const RingSecondsSchema = z.number().int().min(RING_SECONDS_MIN).max(RING_SECONDS_MAX);

const RingSoundSchema = z.enum(['classic', 'chime', 'pulse']);

// Ring firmware (#389) always sends both ring keys; older firmware sends neither.
const DeviceStatePayloadSchema = z.object({
  volume: DeviceVolumeSchema,
  muted: z.boolean(),
  mode: DeviceModeSchema,
  dnd: z.boolean(),
  ring_seconds: RingSecondsSchema.optional(),
  ring_sound: RingSoundSchema.optional(),
  battery_pct: z.number().int().min(0).max(100).nullable(),
  charging: z.boolean().nullable(),
  fw_version: z.string().min(1).max(16),
}).strict().refine(
  (payload) => (payload.ring_seconds === undefined) === (payload.ring_sound === undefined),
  { message: 'device_state carries both ring keys or neither' },
);

// #314/#330: the device's live settings, sent after welcome and on every local change.
const DeviceStateDtoSchema = EnvelopeSchema.extend({
  type: z.literal('device_state'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: DeviceStatePayloadSchema,
});

// #319: an announce_id is at most 60 chars so `ann_<announce_id>` stays an OpaqueId.
const AnnounceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,60}$/);

// #389: missed = the ring ran its full ring_seconds with no dismiss.
const AnnounceActionSchema = z.enum(['played', 'dismissed', 'snoozed', 'missed']);

const AnnounceAckDtoSchema = EnvelopeSchema.extend({
  type: z.literal('announce_ack'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: z.object({ announce_id: AnnounceIdSchema, action: AnnounceActionSchema }).strict(),
});

export const ClientControlDtoSchema = z.discriminatedUnion('type', [
  HelloDtoSchema,
  DeviceStateDtoSchema,
  AnnounceAckDtoSchema,
  TurnStartDtoSchema,
  TurnEndDtoSchema,
  CancelDtoSchema,
  PongDtoSchema,
  ListConversationsDtoSchema,
  SelectConversationDtoSchema,
  NewConversationDtoSchema,
  ListSpacesDtoSchema,
  SelectSpaceDtoSchema,
  PairRequestDtoSchema,
]);
