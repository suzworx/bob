/**
 * Wire contract for the v2 cardputer protocol: Zod DTOs for client and server
 * control messages, protocol constants, the OLX2 PCM frame codec, and session
 * types. The authoritative reference for both the server and device firmware.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EXPRESS_EMOTIONS, EXPRESS_MAX_SECONDS, type ExpressEmotion } from '@bob/ai/express';
import type { RawData } from 'ws';
import type { ChatMessage } from '../conversations/chat-message.ts';
import { clipLabel, DeviceHealthSchema, EnvelopeSchema, FirmwareVersionSchema, OpaqueIdSchema, V2_VERSION } from './protocol-base.ts';
import {
  CheckUpdateDtoSchema, LastOtaSchema, OtaBoardSchema, OtaOfferSchema, OtaProgressDtoSchema, UpdateOfferDtoSchema,
} from './protocol-ota.ts';
export { otaOfferWire, type OtaOfferWire } from './protocol-ota.ts';
import { TurnTimingDtoSchema } from './protocol-timing.ts';
export { type TurnTimingDto } from './protocol-timing.ts';
import { ANNOUNCE_BODY_MAX, ANNOUNCE_TITLE_MAX, DeviceModeSchema, RingSoundSchema, WakeWordSchema } from '../devices/settings.ts';

// Domain types the protocol is built on; re-exported so wire importers keep one entry point.
export { type ChatMessage } from '../conversations/chat-message.ts';
export { DeviceModeSchema, RingSoundSchema, WakeWordSchema } from '../devices/settings.ts';

export const V2_PROTOCOL = 'bob.v2' as const;
export { V2_VERSION, FirmwareVersionSchema } from './protocol-base.ts';
export const V2_PATH = '/v2/cardputer' as const;
export const PCM16_16K_MONO_FORMAT = 1 as const;
export const MP3_16K_MONO_FORMAT = 2 as const;
type FormatId = typeof PCM16_16K_MONO_FORMAT | typeof MP3_16K_MONO_FORMAT;
export const PCM16_16K_MONO_RATE_HZ = 16_000;
export const CONTROL_LIMIT_BYTES = 1024;
export const AUDIO_HEADER_BYTES = 20;
export const AUDIO_PAYLOAD_LIMIT_BYTES = 4096;
export const INITIAL_CREDIT_BYTES = 16 * 1024;
// Max conversations in a device `conversations` reply (device RAM bound).
export const CONVERSATIONS_LIST_CAP = 10;
// Max Spaces in a device `spaces` reply (device RAM bound).
export const SPACES_LIST_CAP = 10;
// Bounds the accumulated uplink PCM while the turn is processed (~31 s of
// 16 kHz mono PCM16). The device-side PTT cap is 6 s in the baseline firmware.
export const ACCUMULATE_MAX_BYTES = 1_000_000;
export const DOWNLINK_FRAME_BYTES = 320; // 10 ms PCM16 at 16 kHz mono.
export const DOWNLINK_MP3_CHUNK_BYTES = 1024; // Compressed downlink chunk size.
export const MAX_DOWNLINK_MP3_BYTES = 3 * 1024 * 1024; // ~30 s of MP3 at 128 kbps mono, or minutes at lower bitrates.

const V2ErrorCodeSchema = z.enum([
  'BAD_MESSAGE',
  'BAD_AUDIO',
  'STATE_VIOLATION',
  'FRAME_TOO_LARGE',
  'SEQUENCE_GAP',
  'QUEUE_FULL',
  'INTERNAL',
  'CONVERSATION_NOT_FOUND',
  'UNPAIRED',
  'PAIRING_RATE_LIMITED',
  'SPACE_NOT_FOUND',
  'UPDATE_REQUIRED',
]);
export type V2ErrorCode = z.infer<typeof V2ErrorCodeSchema>;

const StatusStageSchema = z.enum(['thinking', 'speaking', 'idle']);
export type StatusStage = z.infer<typeof StatusStageSchema>;

/** hello's fw_version after Zod rejected the device's value: the hello itself stands. */
const INVALID_FW_VERSION = 'invalid' as const;
/** Capability tokens a firmware advertises in hello; unknown tokens are kept (newer firmware). */
const FW_CAPS_MAX = 16;
const FirmwareCapSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
export type FirmwareCap = 'device_control' | 'announce' | 'reply_text' | 'timers_state' | 'ota' | 'turn_conversation' | 'assistant_name' | 'express' | 'scene' | 'turn_timing' | 'wake_word' | 'end_of_turn';

const HelloDtoSchema = EnvelopeSchema.extend({
  type: z.literal('hello'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  // fw_version and caps are optional (older firmware sends neither) and never
  // fail the hello: a bad version reads as INVALID_FW_VERSION, bad caps as absent.
  // Unknown keys are stripped, not refused: a strict hello turned every newer
  // firmware field into BAD_MESSAGE with no welcome.
  payload: z.object({
    format_id: z.union([z.literal(PCM16_16K_MONO_FORMAT), z.literal(MP3_16K_MONO_FORMAT)]),
    fw_version: FirmwareVersionSchema.optional().catch(INVALID_FW_VERSION),
    caps: z.array(FirmwareCapSchema).max(FW_CAPS_MAX).optional().catch(undefined),
    board: OtaBoardSchema.optional().catch(undefined),
    last_ota: LastOtaSchema.optional().catch(undefined),
    ota_slot: z.union([z.literal(0), z.literal(1)]).optional().catch(undefined),
  }).strip(),
});
const TurnStartDtoSchema = EnvelopeSchema.extend({
  type: z.literal('turn_start'),
  turn_ref: OpaqueIdSchema,
  seq: z.undefined().optional(),
  // conversation_id: the device's active conversation (the picker's id,
  // a conversation or thread ref). Optional: older firmware omits it. It only
  // correlates the turn, and only after the server checks the account can open it.
  // Firmware sends it only after a welcome with turn_conversation: true.
  payload: z.object({
    conversation_id: OpaqueIdSchema.optional(),
    // A bounded presentation preference, only after welcome acknowledges it.
    assistant_name: z.enum(['bob']).optional(),
  }).strict(),
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
// Clears the account's active-conversation pointer; the next device turn
// creates the conversation. request_id makes a retry idempotent.
const NewConversationDtoSchema = EnvelopeSchema.extend({
  type: z.literal('new_conversation'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: z.object({ request_id: OpaqueIdSchema }).strict(),
});
// The Space picker. A Space id is the store's uuid; null clears the
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
export const PairRequestDtoSchema = EnvelopeSchema.extend({
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

// `mode` and the 0..10 volume are shared by
// device_state (device -> server) and device_control (server -> device).
export const DeviceVolumeSchema = z.number().int().min(0).max(10);
// How long a timer or alarm rings before it counts as missed, and with which built-in sound.
const RING_SECONDS_MIN = 10;
const RING_SECONDS_MAX = 120;
export const RingSecondsSchema = z.number().int().min(RING_SECONDS_MIN).max(RING_SECONDS_MAX);
// Ring firmware always sends both ring keys; older firmware sends neither.
const DeviceStatePayloadSchema = z.object({
  volume: DeviceVolumeSchema,
  muted: z.boolean(),
  mode: DeviceModeSchema,
  dnd: z.boolean(),
  ring_seconds: RingSecondsSchema.optional(),
  ring_sound: RingSoundSchema.optional(),
  // Firmware with cap 'wake_word' reports its wake word; a value outside the
  // server's two reads as absent, never costing the report.
  wake_word: WakeWordSchema.optional().catch(undefined),
  battery_pct: z.number().int().min(0).max(100).nullable(),
  charging: z.boolean().nullable(),
  fw_version: z.string().min(1).max(16),
  ...DeviceHealthSchema.shape,
}).strict().refine(
  (payload) => (payload.ring_seconds === undefined) === (payload.ring_sound === undefined),
  { message: 'device_state carries both ring keys or neither' },
);
type DeviceState = z.infer<typeof DeviceStatePayloadSchema>;
// The device's live settings, sent after welcome and on every local change.
const DeviceStateDtoSchema = EnvelopeSchema.extend({
  type: z.literal('device_state'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: DeviceStatePayloadSchema,
});
// An announce_id is at most 60 chars so `ann_<announce_id>` stays an OpaqueId.
const AnnounceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,60}$/);
// Missed = the ring ran its full ring_seconds with no dismiss.
const AnnounceActionSchema = z.enum(['played', 'dismissed', 'snoozed', 'missed']);
const AnnounceAckDtoSchema = EnvelopeSchema.extend({
  type: z.literal('announce_ack'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: z.object({ announce_id: AnnounceIdSchema, action: AnnounceActionSchema }).strict(),
});

const DeviceLogCounter = z.number().int().min(0).max(0xffff_ffff);
/** Diagnostics are enum + numbers, never the firmware's free-form journal. */
const DeviceLogDtoSchema = EnvelopeSchema.extend({
  type: z.literal('device_log'),
  seq: z.undefined().optional(),
  payload: z.object({
    event: z.enum(['welcome_accepted', 'turn_started', 'turn_ended', 'playback_started', 'turn_cancelled', 'server_error', 'capture_failed', 'downlink_stalled', 'audio_down_seq_gap']),
    uptime_ms: DeviceLogCounter,
    heap_free: DeviceLogCounter,
    heap_largest: DeviceLogCounter,
  }).strict(),
});

export const ClientControlDtoSchema = z.discriminatedUnion('type', [
  HelloDtoSchema,
  DeviceStateDtoSchema, DeviceLogDtoSchema, TurnTimingDtoSchema,
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
  CheckUpdateDtoSchema,
  OtaProgressDtoSchema,
]);
export type ClientControlDto = z.infer<typeof ClientControlDtoSchema>;

const DeviceRefSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(40) }).strict();
const ActiveConversationRefSchema = z.object({
  id: OpaqueIdSchema.nullable(),
  title: z.string().min(1).max(64).nullable(),
}).refine((payload) => (payload.id === null) === (payload.title === null), {
  message: 'id and title must both be null or both be set',
}).strict();
// A Space as the device sees it. `name` (never `title`) is the store's
// 1..60-char Space name.
const SpaceIdSchema = z.string().uuid();
const SpaceNameSchema = z.string().min(1).max(60);
const SpaceRefSchema = z.object({ id: SpaceIdSchema, name: SpaceNameSchema }).strict();
const NullableSpaceRefShape = z.object({
  id: SpaceIdSchema.nullable(),
  name: SpaceNameSchema.nullable(),
}).refine((payload) => (payload.id === null) === (payload.name === null), {
  message: 'id and name must both be null or both be set',
}).strict();
export type SpaceRef = z.infer<typeof SpaceRefSchema>;

const WelcomeDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('welcome'), id: OpaqueIdSchema,
  payload: z.object({
    protocol: z.literal(V2_PROTOCOL), format_id: z.union([z.literal(PCM16_16K_MONO_FORMAT), z.literal(MP3_16K_MONO_FORMAT)]),
    max_audio_bytes: z.literal(AUDIO_PAYLOAD_LIMIT_BYTES), credit_bytes: z.literal(INITIAL_CREDIT_BYTES),
    session_id: OpaqueIdSchema, device_log: z.literal(true).optional(),
    // Only to a device that advertised cap 'turn_conversation'; it then may send turn_start.conversation_id.
    turn_conversation: z.literal(true).optional(),
    assistant_name: z.literal(true).optional(),
    // Only to a device that advertised cap 'turn_timing'; it then may send turn_timing.
    turn_timing: z.literal(true).optional(),
    device: DeviceRefSchema.nullable().optional(),
    active_conversation: ActiveConversationRefSchema.nullable().optional(),
    active_space: SpaceRefSchema.nullable().optional(),
    // The server's minimum firmware, only when BOB_MIN_FW_VERSION is set.
    min_fw_version: FirmwareVersionSchema.optional(),
    // Only to a device that advertised cap 'ota' when an offer exists.
    update_offer: OtaOfferSchema.optional(),
  }).strict(),
}).strict();
// Sent right after welcome to a device below the minimum (or whose
// version is unknown while a minimum is set); its turns are then refused.
const UpdateRequiredReasonSchema = z.enum(['below_minimum', 'unknown_version']);
export type UpdateRequiredReason = z.infer<typeof UpdateRequiredReasonSchema>;
const UpdateRequiredDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('update_required'), id: OpaqueIdSchema,
  payload: z.object({ min_version: FirmwareVersionSchema, reason: UpdateRequiredReasonSchema }).strict(),
}).strict();
const AckDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('ack'), id: OpaqueIdSchema, turn_ref: OpaqueIdSchema,
  payload: z.object({ credit_bytes: z.number().int().min(0).max(INITIAL_CREDIT_BYTES) }).strict(),
}).strict();
const PlaybackStartDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('playback_start'), id: OpaqueIdSchema, turn_ref: OpaqueIdSchema,
  payload: z.object({}).strict(),
}).strict();
const PlaybackEndDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('playback_end'), id: OpaqueIdSchema, turn_ref: OpaqueIdSchema,
  payload: z.object({}).strict(),
}).strict();
const StatusDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('status'), id: OpaqueIdSchema, turn_ref: OpaqueIdSchema,
  payload: z.object({ stage: StatusStageSchema }).strict(),
}).strict();
const ErrorDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('error'), id: OpaqueIdSchema, turn_ref: OpaqueIdSchema.optional(),
  payload: z.object({ code: V2ErrorCodeSchema }).strict(),
}).strict();
const ConversationSummarySchema = z.object({ id: OpaqueIdSchema, title: z.string().min(1).max(200) }).strict();
const ConversationsDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('conversations'), id: OpaqueIdSchema,
  payload: z.object({ conversations: z.array(ConversationSummarySchema).max(CONVERSATIONS_LIST_CAP) }).strict(),
}).strict();
const ConversationSelectedDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('conversation_selected'), id: OpaqueIdSchema,
  payload: z.object({ conversation_id: OpaqueIdSchema, title: z.string().min(1).max(200) }).strict(),
}).strict();
// Acknowledges new_conversation. changed_at is the pointer write's stamp,
// so a later write from another surface is observably newer (last commit wins).
const ConversationClearedDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('conversation_cleared'), id: OpaqueIdSchema,
  payload: z.object({ request_id: OpaqueIdSchema, changed_at: z.number().int().positive() }).strict(),
}).strict();
// The reply to list_spaces (live, member Spaces only, capped).
const SpacesDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('spaces'), id: OpaqueIdSchema,
  payload: z.object({ spaces: z.array(SpaceRefSchema).max(SPACES_LIST_CAP) }).strict(),
}).strict();
// Acknowledges select_space; both null when the selection was cleared.
const SpaceSelectedDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('space_selected'), id: OpaqueIdSchema,
  payload: z.object({
    space_id: SpaceIdSchema.nullable(),
    name: SpaceNameSchema.nullable(),
  }).refine((payload) => (payload.space_id === null) === (payload.name === null), {
    message: 'space_id and name must both be null or both be set',
  }).strict(),
}).strict();

export const PairingRequiredDtoSchema = EnvelopeSchema.extend({
  type: z.literal('pairing_required'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: z.object({ reason: z.enum(['none', 'unknown', 'revoked']) }).strict(),
});
export const PairCodeDtoSchema = EnvelopeSchema.extend({
  type: z.literal('pair_code'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: z.object({
    pairing_id: z.string().uuid(),
    user_code: z.string().regex(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/),
    verification_uri: z.string().min(1).max(200),
    expires_in: z.literal(600),
  }).strict(),
});
export const PairedDtoSchema = EnvelopeSchema.extend({
  type: z.literal('paired'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: z.object({
    device_id: z.string().uuid(),
    device_token: z.string().regex(/^olxd_[A-Za-z0-9_-]{43}$/),
    name: z.string().min(1).max(40),
  }).strict(),
});
export const PairExpiredDtoSchema = EnvelopeSchema.extend({
  type: z.literal('pair_expired'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: z.object({ pairing_id: z.string().uuid() }).strict(),
});
export const PairDeniedDtoSchema = EnvelopeSchema.extend({
  type: z.literal('pair_denied'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: z.object({ pairing_id: z.string().uuid() }).strict(),
});
export const ActiveConversationDtoSchema = EnvelopeSchema.extend({
  type: z.literal('active_conversation'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: z.object({
    id: OpaqueIdSchema.nullable(),
    title: z.string().min(1).max(64).nullable(),
  }).refine((payload) => (payload.id === null) === (payload.title === null), {
    message: 'id and title must both be null or both be set',
  }).strict(),
});
// The account's active-Space pointer changed (pushed like
// active_conversation: immediately when ready, else held until playback_end).
export const ActiveSpaceDtoSchema = EnvelopeSchema.extend({
  type: z.literal('active_space'),
  turn_ref: z.undefined().optional(),
  seq: z.undefined().optional(),
  payload: NullableSpaceRefShape,
});
export type PairingRequiredDto = z.infer<typeof PairingRequiredDtoSchema>;
export type ActiveSpaceDto = z.infer<typeof ActiveSpaceDtoSchema>;
export type PairCodeDto = z.infer<typeof PairCodeDtoSchema>;
export type PairedDto = z.infer<typeof PairedDtoSchema>;
export type PairExpiredDto = z.infer<typeof PairExpiredDtoSchema>;
export type PairDeniedDto = z.infer<typeof PairDeniedDtoSchema>;
export type ActiveConversationDto = z.infer<typeof ActiveConversationDtoSchema>;

/** An `active_conversation` title clipped to the wire's 64-char bound. */
export function titleForDevice(title: string | null): string | null {
  if (title === null) return null;
  return title.length > 64 ? title.slice(0, 64) : title;
}

// Server -> device. Key order in every payload is the contract's
// order: the firmware parser is order-sensitive.
const REPLY_TEXT_HEARD_MAX = 200;
const REPLY_TEXT_REPLY_MAX = 700;
const DeviceControlPayloadSchema = z.object({
  volume: DeviceVolumeSchema.optional(),
  muted: z.boolean().optional(),
  mode: DeviceModeSchema.optional(),
  dnd: z.boolean().optional(),
  ring_seconds: RingSecondsSchema.optional(),
  ring_sound: RingSoundSchema.optional(),
  // Last: older firmware parses in this order and ignores what it does not know.
  // Sent only to a socket whose hello caps list 'wake_word'.
  wake_word: WakeWordSchema.optional(),
}).strict().refine(
  (payload) => Object.values(payload).some((value) => value !== undefined),
  { message: 'device_control needs at least one field' },
);
export type DeviceControlPatch = z.infer<typeof DeviceControlPayloadSchema>;
// Applied by the device (volume live, mode/dnd at Ready), which answers with device_state.
const DeviceControlDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('device_control'), id: OpaqueIdSchema,
  payload: DeviceControlPayloadSchema,
}).strict();
// The turn's transcript and reply for the screen, sent before playback_start. Never journaled.
const ReplyTextDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('reply_text'), id: OpaqueIdSchema, turn_ref: OpaqueIdSchema,
  payload: z.object({
    heard: z.string().max(REPLY_TEXT_HEARD_MAX),
    reply: z.string().max(REPLY_TEXT_REPLY_MAX),
  }).strict(),
}).strict();
const AnnounceKindSchema = z.enum(['timer', 'alarm', 'reminder', 'notice']);
const AnnouncePayloadSchema = z.object({
  announce_id: AnnounceIdSchema,
  kind: AnnounceKindSchema,
  title: z.string().min(1).max(ANNOUNCE_TITLE_MAX),
  body: z.string().max(ANNOUNCE_BODY_MAX),
  ring: z.boolean(),
  expires_at: z.number().int().positive(),
}).strict();
export type AnnouncePayload = z.infer<typeof AnnouncePayloadSchema>;
// An unsolicited card (timer/alarm ring, reminder/notice chime + optional speech).
const AnnounceDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('announce'), id: OpaqueIdSchema,
  payload: AnnouncePayloadSchema,
}).strict();
// The account's running timers and alarms for the Ready screen, soonest
// first. The device counts down locally from fires_in_ms at receipt, so this is
// sent only after welcome and when the list changes; an empty list clears it.
const TIMERS_STATE_MAX = 4;
const TIMERS_STATE_LABEL_MAX = 24;
/** setTimeout's ceiling, and the firmware's wrap-safe uint32 millis() delta. */
const TIMERS_STATE_FIRES_IN_MAX_MS = 2_147_483_647;
const TimersStateEntrySchema = z.object({
  id: OpaqueIdSchema,
  kind: z.enum(['timer', 'alarm']),
  label: z.string().max(TIMERS_STATE_LABEL_MAX),
  fires_in_ms: z.number().int().min(0).max(TIMERS_STATE_FIRES_IN_MAX_MS),
}).strict();
const TimersStateDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('timers_state'), id: OpaqueIdSchema,
  payload: z.object({ timers: z.array(TimersStateEntrySchema).max(TIMERS_STATE_MAX) }).strict(),
}).strict();

// express / scene (server -> device): Bob's feeling and the action scene of a
// succeeded tool call. Sent only to a device whose hello caps list the token.
export const SCENE_NAMES = [
  'timer_set', 'timer_done', 'alarm', 'weather_sun', 'weather_cloud', 'weather_rain', 'weather_snow', 'music',
  'task_added', 'note_added', 'reminder', 'calendar', 'search', 'message_sent', 'success', 'failed',
] as const;
export type SceneName = (typeof SCENE_NAMES)[number];
export const SCENE_LABEL_MAX = 24;
const ExpressDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('express'), id: OpaqueIdSchema,
  payload: z.object({
    emotion: z.enum(EXPRESS_EMOTIONS),
    seconds: z.number().int().min(1).max(EXPRESS_MAX_SECONDS),
  }).strict(),
}).strict();
const SceneDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('scene'), id: OpaqueIdSchema,
  payload: z.object({
    scene: z.enum(SCENE_NAMES),
    seconds: z.number().int().min(1).max(20),
    label: z.string().max(SCENE_LABEL_MAX).optional(),
    value: z.number().int().optional(),
  }).strict(),
}).strict();

// Sent only to a socket whose hello caps list 'end_of_turn'; the device closes capture as if its own end-of-speech fired (its silence timer stays the fallback).
export const EndOfTurnDtoSchema = z.object({
  v: z.literal(V2_VERSION), type: z.literal('end_of_turn'), id: OpaqueIdSchema, turn_ref: OpaqueIdSchema,
  payload: z.object({}).strict(),
}).strict();
export type EndOfTurnDto = z.infer<typeof EndOfTurnDtoSchema>;

export const ServerControlDtoSchema = z.discriminatedUnion('type', [
  WelcomeDtoSchema, AckDtoSchema, PlaybackStartDtoSchema, PlaybackEndDtoSchema, StatusDtoSchema, ErrorDtoSchema,
  ConversationsDtoSchema, ConversationSelectedDtoSchema, ConversationClearedDtoSchema,
  SpacesDtoSchema, SpaceSelectedDtoSchema,
  DeviceControlDtoSchema, ReplyTextDtoSchema, AnnounceDtoSchema, TimersStateDtoSchema,
  UpdateRequiredDtoSchema, UpdateOfferDtoSchema, ExpressDtoSchema, SceneDtoSchema, EndOfTurnDtoSchema,
]);

/** One side of a SemVer comparison: the numeric core and the pre-release ids. */
function versionParts(version: string): { core: number[]; pre: string[] } {
  const noBuild = version.split('+')[0] ?? '';
  const dash = noBuild.indexOf('-');
  const core = (dash < 0 ? noBuild : noBuild.slice(0, dash)).split('.').map(Number);
  return { core, pre: dash < 0 ? [] : noBuild.slice(dash + 1).split('.') };
}

/** SemVer precedence of two FirmwareVersionSchema strings, build metadata
 *  ignored: negative when a < b, 0 when equal, positive when a > b. A
 *  pre-release sorts below its release ("1.2.0-dev+abc" < "1.2.0"). */
export function compareFirmwareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length;
  for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i += 1) {
    const x = left.pre[i]!;
    const y = right.pre[i]!;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) - Number(y);
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return left.pre.length - right.pre.length;
}
export type DeviceControlDto = z.infer<typeof DeviceControlDtoSchema>;
export type ReplyTextDto = z.infer<typeof ReplyTextDtoSchema>;
export type AnnounceDto = z.infer<typeof AnnounceDtoSchema>;
export type ExpressDto = z.infer<typeof ExpressDtoSchema>;
export type SceneDto = z.infer<typeof SceneDtoSchema>;
export type ScenePayload = SceneDto['payload'];
export type TimersStateDto = z.infer<typeof TimersStateDtoSchema>;

/** timers_state from the account's pending timers (any order): soonest four,
 *  keys in contract order (id, kind, label, fires_in_ms); a null label is "". */
export function timersStateDto(
  timers: readonly { id: string; kind: 'timer' | 'alarm'; label: string | null; remainingMs: number }[],
): TimersStateDto {
  const soonest = [...timers].sort((a, b) => a.remainingMs - b.remainingMs).slice(0, TIMERS_STATE_MAX);
  return {
    v: V2_VERSION, type: 'timers_state', id: messageId('tmrs'),
    payload: {
      timers: soonest.map((timer) => ({
        id: timer.id,
        kind: timer.kind,
        label: clipLabel(timer.label ?? '', TIMERS_STATE_LABEL_MAX),
        fires_in_ms: Math.min(TIMERS_STATE_FIRES_IN_MAX_MS, Math.max(0, Math.round(timer.remainingMs))),
      })),
    },
  };
}

/** device_control with its payload rebuilt in contract order (volume, muted, mode, dnd, ring_seconds,
 *  ring_sound, wake_word), absent fields omitted. */
export function deviceControlDto(patch: DeviceControlPatch): DeviceControlDto {
  const payload: DeviceControlPatch = {};
  if (patch.volume !== undefined) payload.volume = patch.volume;
  if (patch.muted !== undefined) payload.muted = patch.muted;
  if (patch.mode !== undefined) payload.mode = patch.mode;
  if (patch.dnd !== undefined) payload.dnd = patch.dnd;
  if (patch.ring_seconds !== undefined) payload.ring_seconds = patch.ring_seconds;
  if (patch.ring_sound !== undefined) payload.ring_sound = patch.ring_sound;
  if (patch.wake_word !== undefined) payload.wake_word = patch.wake_word;
  return { v: V2_VERSION, type: 'device_control', id: messageId('dctl'), payload };
}

/** express: Bob shows `emotion` for `seconds` (1..15). */
export function expressDto(emotion: ExpressEmotion, seconds: number): ExpressDto {
  return { v: V2_VERSION, type: 'express', id: messageId('expr'), payload: { emotion, seconds } };
}

/** scene with its payload rebuilt in contract order (scene, seconds, label, value), absent fields omitted. */
export function sceneDto(scene: ScenePayload): SceneDto {
  const payload: ScenePayload = { scene: scene.scene, seconds: scene.seconds };
  if (scene.label !== undefined) payload.label = scene.label;
  if (scene.value !== undefined) payload.value = scene.value;
  return { v: V2_VERSION, type: 'scene', id: messageId('scne'), payload };
}

/** end_of_turn: the server's streaming-STT end of turn, with the turn_ref on the envelope and an empty payload. */
export function endOfTurnDto(turnRef: string): EndOfTurnDto {
  return { v: V2_VERSION, type: 'end_of_turn', id: messageId('eotn'), turn_ref: turnRef, payload: {} };
}

/** reply_text, clipped to the screen bounds (heard 200, reply 700). */
export function replyTextDto(turnRef: string, heard: string, reply: string): ReplyTextDto {
  return {
    v: V2_VERSION, type: 'reply_text', id: messageId('rtxt'), turn_ref: turnRef,
    payload: { heard: heard.slice(0, REPLY_TEXT_HEARD_MAX), reply: reply.slice(0, REPLY_TEXT_REPLY_MAX) },
  };
}

/** announce with its payload rebuilt in contract order. */
export function announceDto(announcement: AnnouncePayload): AnnounceDto {
  const { announce_id, kind, title, body, ring, expires_at } = announcement;
  return { v: V2_VERSION, type: 'announce', id: messageId('annc'), payload: { announce_id, kind, title, body, ring, expires_at } };
}
export type ServerControlDto = z.infer<typeof ServerControlDtoSchema>;

const SessionStageSchema = z.enum(['await_hello', 'ready', 'capturing', 'responding']);
export type SessionStage = z.infer<typeof SessionStageSchema>;
export interface SessionDto {
  id: string;
  stage: SessionStage;
  turnRef?: string;
  nextUplinkSeq: number;
  creditBytes: number;
  audioChunks: Buffer[];
  totalAudioBytes: number;
  messages: ChatMessage[];
  formatId: FormatId;
  /** The conversation this session's turns read from and append to, resolved at hello. */
  activeConversationId?: string;
  /** Best-effort downlink frames sent by the last turn, for close diagnostics. */
  downFramesSent?: number;
  /** The device's last reported (or persisted) settings. */
  deviceState?: DeviceSettingsState;
  /** Set when the device names Bob at turn_start (it picks Bob's voice); omitted keeps the default voice. */
  assistantName?: 'Bob';
  /** Aborts the in-flight turn (or announcement playback) on `cancel`. */
  turnAbort?: AbortController;
  /** Settles when the in-flight turn has fully unwound; cancel awaits it. */
  turnDone?: Promise<void>;
}

/** The persisted subset of device_state plus the live-only extras when known. */
export type DeviceSettingsState = Pick<DeviceState, 'volume' | 'muted' | 'mode' | 'dnd'>
  & Partial<Pick<DeviceState, 'ring_seconds' | 'ring_sound' | 'wake_word' | 'battery_pct' | 'charging' | 'fw_version'>>;

interface AudioFrameHeaderDto {
  magic: 'OLX2';
  version: typeof V2_VERSION;
  kind: 'audio_up' | 'audio_down';
  formatId: FormatId;
  channels: 1;
  turnHandle: number;
  sequence: number;
  payloadBytes: number;
}
export interface AudioFrameDto { header: AudioFrameHeaderDto; payload: Buffer }
export type DtoParseResult<T> = { ok: true; value: T } | { ok: false; code: V2ErrorCode };

export function messageId(prefix: string): string { return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`; }

export function parseClientControl(raw: RawData): DtoParseResult<ClientControlDto> {
  const text = Buffer.from(raw as Buffer).toString('utf8');
  if (Buffer.byteLength(text, 'utf8') > CONTROL_LIMIT_BYTES) return { ok: false, code: 'FRAME_TOO_LARGE' };
  try {
    const parsed = ClientControlDtoSchema.safeParse(JSON.parse(text));
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, code: 'BAD_MESSAGE' };
  } catch {
    return { ok: false, code: 'BAD_MESSAGE' };
  }
}

export function parseAudioUp(raw: RawData, session: SessionDto): DtoParseResult<AudioFrameDto> {
  const frame = Buffer.from(raw as Buffer);
  if (frame.length < AUDIO_HEADER_BYTES || frame.length > AUDIO_HEADER_BYTES + AUDIO_PAYLOAD_LIMIT_BYTES) return { ok: false, code: 'FRAME_TOO_LARGE' };
  if (frame.subarray(0, 4).toString('ascii') !== 'OLX2' || frame.readUInt8(4) !== V2_VERSION || frame.readUInt8(5) !== 1) return { ok: false, code: 'BAD_AUDIO' };
  const rawFormatId = frame.readUInt8(6);
  if (rawFormatId !== PCM16_16K_MONO_FORMAT && rawFormatId !== MP3_16K_MONO_FORMAT) return { ok: false, code: 'BAD_AUDIO' };
  const header: AudioFrameHeaderDto = {
    magic: 'OLX2', version: V2_VERSION, kind: 'audio_up', formatId: rawFormatId,
    channels: frame.readUInt8(7) as 1, turnHandle: frame.readUInt32BE(8), sequence: frame.readUInt32BE(12), payloadBytes: frame.readUInt32BE(16),
  };
  if (header.formatId !== PCM16_16K_MONO_FORMAT || header.channels !== 1 || header.payloadBytes !== frame.length - AUDIO_HEADER_BYTES) return { ok: false, code: 'BAD_AUDIO' };
  if (header.payloadBytes > AUDIO_PAYLOAD_LIMIT_BYTES) return { ok: false, code: 'FRAME_TOO_LARGE' };
  if (header.sequence !== session.nextUplinkSeq) return { ok: false, code: 'SEQUENCE_GAP' };
  if (header.payloadBytes > session.creditBytes) return { ok: false, code: 'QUEUE_FULL' };
  return { ok: true, value: { header, payload: frame.subarray(AUDIO_HEADER_BYTES) } };
}

/** Builds a silent 10 ms downlink PCM frame DTO with the given handle and sequence. */
export function encodeAudioDown(turnHandle: number, sequence: number): AudioFrameDto {
  const payload = Buffer.alloc(320); // 10 ms silent PCM16 at 16 kHz mono.
  return { header: { magic: 'OLX2', version: V2_VERSION, kind: 'audio_down', formatId: PCM16_16K_MONO_FORMAT, channels: 1, turnHandle, sequence, payloadBytes: payload.length }, payload };
}

/** Serializes an audio frame DTO into the 20-byte-header OLX2 binary layout. */
export function serializeAudioFrame(frame: AudioFrameDto): Buffer {
  const output = Buffer.alloc(AUDIO_HEADER_BYTES + frame.payload.length);
  output.write(frame.header.magic, 0, 'ascii'); output.writeUInt8(frame.header.version, 4);
  output.writeUInt8(frame.header.kind === 'audio_up' ? 1 : 2, 5); output.writeUInt8(frame.header.formatId, 6); output.writeUInt8(frame.header.channels, 7);
  output.writeUInt32BE(frame.header.turnHandle, 8); output.writeUInt32BE(frame.header.sequence, 12); output.writeUInt32BE(frame.header.payloadBytes, 16);
  frame.payload.copy(output, AUDIO_HEADER_BYTES);
  return output;
}
