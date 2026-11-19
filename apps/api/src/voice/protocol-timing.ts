/**
 * turn_timing: the device's once-per-turn capture and playback timing
 * summary, sent only after a welcome acknowledged cap 'turn_timing', after the
 * turn's playback drained, was interrupted or failed. Every milestone is a
 * whole number of milliseconds on the DEVICE's monotonic clock (millis()),
 * measured from that turn's capture start; it is never comparable with a
 * server timestamp. Per milestone:
 *   a number  measured (0 is a real measurement);
 *   null      skipped: the step did not happen this turn (no reply audio,
 *             PCM has no decoder, a stop before the first frame, ...);
 *   absent    unknown: the firmware has no measurement for it.
 * The payload keys are in the firmware's emit order (apps/cardputer/include/turn_timing.h).
 */
import { z } from 'zod';
import { EnvelopeSchema, OpaqueIdSchema } from './protocol-base.ts';

/** Bound on every offset: a turn longer than ten minutes reports the milestone as unknown. */
const DEVICE_TIMING_MAX_MS = 600_000;
/** Bound on the frame counts (a ten-minute reply is ~60,000 PCM frames). */
const DEVICE_TIMING_MAX_FRAMES = 100_000;

const OffsetSchema = z.number().int().min(0).max(DEVICE_TIMING_MAX_MS).nullable().optional();
const FramesSchema = z.number().int().min(0).max(DEVICE_TIMING_MAX_FRAMES);
/** A later firmware's counter or duration: absent from an older firmware, never null. */
const CountSchema = FramesSchema.optional();
const DurationSchema = z.number().int().min(0).max(DEVICE_TIMING_MAX_MS).optional();

/** The milestones, in device order: capture, then uplink, then playback. */
export const TURN_TIMING_MILESTONES = [
  'capture_end_ms', 'first_up_ms', 'turn_end_ms', 'playback_start_ms',
  'first_down_ms', 'decoder_ready_ms', 'speaker_submission_ms', 'playback_end_ms',
] as const;
export type TurnTimingMilestone = (typeof TURN_TIMING_MILESTONES)[number];

/** How the turn was opened: GO held, the wake word, or speech in a follow-up window. */
const TURN_TIMING_SOURCES = ['ptt', 'wake', 'follow_up'] as const;
/** Why capture stopped: GO released, endpointer silence or cap, GO pressed in a hands-free turn,
 *  the uplink queue filled, a woken turn with no speech, or a server error during capture. */
const TURN_TIMING_END_REASONS = ['release', 'silence', 'max', 'key', 'uplink', 'no_speech', 'error'] as const;
/** How the turn's playback ended: played out, no reply audio, a local stop, a server error or
 *  failed decoder/buffer, or the turn was dropped before turn_end (no_speech). */
const TURN_TIMING_OUTCOMES = ['drained', 'empty', 'interrupted', 'failed', 'cancelled'] as const;

export const TurnTimingDtoSchema = EnvelopeSchema.extend({
  type: z.literal('turn_timing'),
  turn_ref: OpaqueIdSchema,
  seq: z.undefined().optional(),
  payload: z.object({
    version: z.literal(1),
    source: z.enum(TURN_TIMING_SOURCES),
    end_reason: z.enum(TURN_TIMING_END_REASONS),
    outcome: z.enum(TURN_TIMING_OUTCOMES),
    // The speaker gain was 0 while the reply played: speaker_submission is not audible.
    muted: z.boolean(),
    capture_end_ms: OffsetSchema,
    first_up_ms: OffsetSchema,
    turn_end_ms: OffsetSchema,
    playback_start_ms: OffsetSchema,
    first_down_ms: OffsetSchema,
    decoder_ready_ms: OffsetSchema,
    speaker_submission_ms: OffsetSchema,
    playback_end_ms: OffsetSchema,
    up_frames: FramesSchema,
    down_frames: FramesSchema,
    // Appended by a later firmware; an older one omits them. speech_end_ms is the offset of the
    // last voiced frame (null: no speech), so speaker_submission - speech_end is the felt wait.
    speech_end_ms: OffsetSchema,
    // Uplink frames still queued when capture ended, mic frames per second over the capture, and
    // socket back-pressure: audio writes refused for a full send buffer, and the longest such streak in ms.
    uplink_backlog: CountSchema,
    mic_fps: CountSchema,
    tx_busy: CountSchema,
    tx_busy_max_ms: DurationSchema,
  }).strict(),
});
export type TurnTimingDto = z.infer<typeof TurnTimingDtoSchema>;
export type TurnTimingPayload = TurnTimingDto['payload'];
