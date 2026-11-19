/**
 * Strict response schemas for GET /api/operator/metrics/:page, one per
 * bob_private.operator_metrics_<page> document. Every object is .strict(), so
 * a field the SQL grows by accident is rejected before it can be sent.
 */
import { z } from 'zod';

const count = z.number().int().nonnegative();
const nullableCount = count.nullable();
const ratio = z.number().min(0).max(1).nullable();
const average = z.number().nonnegative().nullable();
const iso = z.string().min(1);
const label = (max: number): z.ZodString => z.string().min(1).max(max);
const WindowSchema = z.object({ from: iso, to: iso, bucket: z.enum(['hour', 'day', 'week']) }).strict();
const Percentiles = z.object({ p50: nullableCount, p95: nullableCount }).strict();

const SurfaceSchema = z
  .object({
    turns: count,
    outcomes: z.object({ completed: count, failed: count, cancelled: count, empty: count }).strict(),
    success_rate: ratio,
    latency_ms: z
      .object({ first_audio: Percentiles, stt: Percentiles, model: Percentiles, tts: Percentiles, total: Percentiles })
      .strict(),
  })
  .strict();

const INTENTS = [
  'timer_reminder', 'calendar', 'task_note', 'memory', 'game', 'device_control', 'search_info', 'space_collab', 'chat', 'other', 'unknown',
] as const;
const tokenTotals = { input: count, output: count, cached_input: count };

export const SCHEMAS = {
  users: z.object({
    window: WindowSchema,
    accounts: z.object({ total: count, enabled: count, disabled: count, awaitingConfirmation: count }).strict(),
    signups: count,
    signups_by_bucket: z.array(z.object({ t: iso, count }).strict()),
    active_users: z.object({ day: nullableCount, week: nullableCount, month: nullableCount, in_window: nullableCount }).strict(),
    activated_users: nullableCount,
    waitlist: z.object({ total: count, verified: count, pending: count, withAccount: count, waitingVerified: count }).strict(),
  }).strict(),
  usage: z
    .object({
      window: WindowSchema,
      turns_by_bucket: z.array(z.object({ t: iso, device: count, web_voice: count, web_text: count }).strict()),
      turns_total: count,
      conversations_created: count,
      signups: count,
      active_users: z.object({ day: nullableCount, week: nullableCount, month: nullableCount, in_window: nullableCount }).strict(),
    })
    .strict(),
  voice: z
    .object({
      window: WindowSchema,
      by_surface: z
        .object({ device: SurfaceSchema, web_voice: SurfaceSchema, web_text: SurfaceSchema, analytics: SurfaceSchema.optional() })
        .strict(),
      failed_by_stage: z.object({ input: count, stt: count, agent: count, tts: count }).strict(),
      first_audio_p95_by_bucket: z.array(z.object({ t: iso, device: nullableCount, web_voice: nullableCount }).strict()),
    })
    .strict(),
  platform: z
    .object({
      window: WindowSchema,
      backlog: count,
      oldest_pending_seconds: nullableCount,
      retried: count,
      failed_by_event_type: z.array(z.object({ event_type: label(64), count }).strict()),
    })
    .strict(),
  ai: z
    .object({
      window: WindowSchema,
      turns: count,
      tokens: z.object({ ...tokenTotals, cache_write: count, reasoning: count }).strict(),
      cache_hit_ratio: ratio,
      avg_steps: average,
      avg_output_tokens: average,
      interrupted_rate: ratio,
      by_model: z.array(z.object({ model: label(128), turns: count, ...tokenTotals }).strict()),
      tools: z.array(z.object({ tool: label(64), count }).strict()),
      intents: z.array(z.object({ intent: z.enum(INTENTS), turns: count, success_rate: ratio, p95_total_ms: nullableCount }).strict()),
      tokens_by_bucket: z.array(z.object({ t: iso, ...tokenTotals }).strict()),
    })
    .strict(),
  devices: z
    .object({
      window: WindowSchema,
      devices: z.object({ paired: count, active_in_window: count, revoked: count }).strict(),
      by_fw_version: z.array(z.object({ fw_version: label(40), count }).strict()),
      by_model: z.array(z.object({ model: label(40), count }).strict()),
      freshness: z.object({ under_1h: count, under_24h: count, under_7d: count, older: count, never: count }).strict(),
      pairing: z.object({ requested: count, approved: count, expired: count, other: count }).strict(),
    })
    .strict(),
  features: z
    .object({
      window: WindowSchema,
      created_by_bucket: z.array(z.object({ t: iso, tasks: count, notes: count, reminders: count }).strict()),
      tasks: z.object({ created: count, completed: count }).strict(),
      reminders: z.object({ created: count, delivered: count, acknowledged: count, snoozed: count }).strict(),
      notifications: z
        .object({ created: count, read: count, by_type: z.array(z.object({ type: label(48), count }).strict()) })
        .strict(),
      calendar: z.object({ events_created: count, by_origin: z.array(z.never()) }).strict(),
      spaces: z.object({ created: count, by_kind: z.object({ private: count, pair: count, group: count }).strict() }).strict(),
      game_minutes: count,
    })
    .strict(),
} as const;

export type Page = keyof typeof SCHEMAS;
