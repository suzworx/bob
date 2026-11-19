/**
 * Agent tools that drive the Cardputer itself (volume and listening modes):
 * `set_volume` and `set_mode`, built with the AI SDK
 * `tool()` style over injected callbacks, as timer-tools.ts does. apps/ai owns
 * no transport: apps/api binds the callbacks to the turn's device
 * (core/device-tools.ts), which pushes `device_control` at once -- before
 * playback_start -- so the reply already plays at the new level.
 *
 * Outputs are short spoken sentences the reply can read as-is. Every tool
 * catches its callback's rejection and returns { ok: false, reason }.
 */
import { z } from 'zod';
import { tool } from 'ai';
import type { Tool } from 'ai';
import { EXPRESS_DEFAULT_SECONDS, EXPRESS_EMOTIONS, EXPRESS_MAX_SECONDS, type ExpressEmotion } from './express.ts';

export { EXPRESS_EMOTIONS, EXPRESS_MAX_SECONDS, type ExpressEmotion };


export const DEVICE_MODES = ['ptt', 'wake', 'announce_only'] as const;
export type DeviceToolMode = (typeof DEVICE_MODES)[number];

/** set_volume input: an absolute level, a relative step, and/or mute. */
const setVolumeInputSchema = z
  .object({
    level: z.number().int().min(0).max(10).optional(),
    delta: z.number().int().min(-10).max(10).optional(),
    mute: z.boolean().optional(),
  })
  .strict();
export type SetVolumeInput = z.infer<typeof setVolumeInputSchema>;

const setModeInputSchema = z.object({ mode: z.enum(DEVICE_MODES) }).strict();
export type SetModeInput = z.infer<typeof setModeInputSchema>;

const expressInputSchema = z
  .object({
    emotion: z.enum(EXPRESS_EMOTIONS),
    seconds: z.number().int().min(1).max(EXPRESS_MAX_SECONDS).optional(),
  })
  .strict();
export type ExpressInput = { emotion: ExpressEmotion; seconds: number };

const deviceToolOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), message: z.string() }).strict(),
  z.object({ ok: z.literal(false), reason: z.string() }).strict(),
]);
export type DeviceToolOutput = z.infer<typeof deviceToolOutputSchema>;

/** The injected, device-bound operations; each resolves to the state it applied. */
export interface DeviceCallbacks {
  setVolume(input: SetVolumeInput): Promise<{ volume: number; muted: boolean }>;
  setMode(input: SetModeInput): Promise<{ mode: DeviceToolMode }>;
  /** Shows the feeling on the device's screen for `seconds`; rejects when no device can. */
  express(input: ExpressInput): Promise<void>;
}

const MODE_NAMES: Record<DeviceToolMode, string> = {
  ptt: 'push to talk',
  wake: 'always awake',
  announce_only: 'announcements only',
};

/** "Volume 7.", "Muted.", "Unmuted, volume 5." */
export function speakVolume(state: { volume: number; muted: boolean }, input: SetVolumeInput): string {
  if (state.muted) return 'Muted.';
  if (input.mute === false) return `Unmuted, volume ${state.volume}.`;
  return `Volume ${state.volume}.`;
}

function failureOf(error: unknown): DeviceToolOutput {
  return { ok: false, reason: error instanceof Error ? error.message : String(error) };
}

export function createDeviceTools(cb: DeviceCallbacks): Record<string, Tool> {
  return {
    set_volume: tool({
      description: 'Change the device speaker volume: level 0-10 ("volume 5"), delta step ("turn it up" +2, "quieter" -2), or mute true/false. Give at least one.',
      inputSchema: setVolumeInputSchema,
      outputSchema: deviceToolOutputSchema,
      execute: async (input): Promise<DeviceToolOutput> => {
        if (input.level === undefined && input.delta === undefined && input.mute === undefined) {
          return { ok: false, reason: 'say a level, up or down, or mute' };
        }
        try {
          return { ok: true, message: speakVolume(await cb.setVolume(input), input) };
        } catch (error) {
          return failureOf(error);
        }
      },
    }),
    set_mode: tool({
      description: 'Change how the device listens: "ptt" (push to talk), "wake" (wake word), or "announce_only" (mic off, announcements still spoken).',
      inputSchema: setModeInputSchema,
      outputSchema: deviceToolOutputSchema,
      execute: async (input): Promise<DeviceToolOutput> => {
        try {
          const { mode } = await cb.setMode(input);
          return { ok: true, message: `Switched to ${MODE_NAMES[mode]}.` };
        } catch (error) {
          return failureOf(error);
        }
      },
    }),
    express: tool({
      description: 'Show a Bob feeling on the device: "love" (affection), "music" (moves, dance), "celebrating", or any emotion. Not every reply. seconds 1-15, default 6.',
      inputSchema: expressInputSchema,
      outputSchema: deviceToolOutputSchema,
      execute: async (input): Promise<DeviceToolOutput> => {
        try {
          await cb.express({ emotion: input.emotion, seconds: input.seconds ?? EXPRESS_DEFAULT_SECONDS });
          return { ok: true, message: `Bob is showing ${input.emotion.replace('_', ' ')}.` };
        } catch (error) {
          return failureOf(error);
        }
      },
    }),
  };
}
