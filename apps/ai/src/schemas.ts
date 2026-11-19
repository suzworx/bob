/**
 * Zod schemas and inferred types for the assistant tools' input/output
 * boundaries (TTS, STT, and current date/time).
 */
import { z } from 'zod';

export const audioFormatSchema = z.enum(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac']);

export const textToSpeechInputSchema = z.object({
  text: z.string().min(1).describe('The text to synthesize.'),
  model: z.string().min(1).optional().describe('Optional TTS model override.'),
  voice: z.string().min(1).optional().describe('Provider-specific voice name.'),
  format: z.enum(['mp3', 'wav']).optional().describe('Audio response format.'),
  speed: z.number().positive().optional().describe('Playback speed multiplier.'),
});

export const speechToTextInputSchema = z.object({
  audio: z
    .string()
    .min(1)
    .describe('Base64-encoded audio bytes without a data URI prefix.'),
  format: audioFormatSchema.describe('The format of the encoded audio.'),
  model: z.string().min(1).optional().describe('Optional STT model override.'),
  language: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
    .optional()
    .describe('Optional ISO-639-1 language code, such as en or ja.'),
});

export const textToSpeechOutputSchema = z.object({
  audio: z.string().describe('Base64-encoded audio bytes.'),
  format: z.string(),
  contentType: z.string(),
  generationId: z.string().optional(),
});

export const speechToTextOutputSchema = z.object({
  text: z.string(),
  model: z.string(),
  generationId: z.string().optional(),
  usage: z
    .object({
      seconds: z.number().optional(),
    })
    .optional(),
});

export const currentDateTimeInputSchema = z.object({
  timezone: z
    .string()
    .min(1)
    .optional()
    .describe('IANA timezone, such as America/Los_Angeles. Defaults to the local timezone.'),
});

export const currentDateTimeOutputSchema = z.object({
  iso: z.string(),
  timezone: z.string(),
  date: z.string(),
  time: z.string(),
});

export type TextToSpeechInput = z.infer<typeof textToSpeechInputSchema>;
export type SpeechToTextInput = z.infer<typeof speechToTextInputSchema>;
export type TextToSpeechOutput = z.infer<typeof textToSpeechOutputSchema>;
export type SpeechToTextOutput = z.infer<typeof speechToTextOutputSchema>;
export type CurrentDateTimeInput = z.infer<typeof currentDateTimeInputSchema>;
export type CurrentDateTimeOutput = z.infer<typeof currentDateTimeOutputSchema>;
