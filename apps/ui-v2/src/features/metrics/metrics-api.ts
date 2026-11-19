// Typed client for the operator metrics endpoints (/api/operator/*). The types
// mirror the API's three documents by hand; they hold aggregates only, never a
// person. Every call goes through fetchWithAuth, so a 401 refreshes the session once.

import { fetchWithAuth } from '@/lib/auth/use-session';
import { z } from 'zod';

export type MetricsRange = '24h' | '7d' | '30d' | '90d';
export type MetricsPage = 'usage' | 'voice' | 'platform' | 'ai' | 'devices' | 'features' | 'users';
export type MetricsSurface = 'device' | 'web_voice' | 'web_text';

export type MetricsWindow = { from: string; to: string; bucket: 'hour' | 'day' | 'week' };
type Percentiles = { p50: number | null; p95: number | null };

type SurfaceStats = {
  turns: number;
  outcomes: { completed: number; failed: number; cancelled: number; empty: number };
  success_rate: number | null;
  latency_ms: { first_audio: Percentiles; stt: Percentiles; model: Percentiles; tts: Percentiles; total: Percentiles };
};

type UsageMetrics = {
  window: MetricsWindow;
  turns_by_bucket: Array<{ t: string } & Record<MetricsSurface, number>>;
  turns_total: number;
  conversations_created: number;
  signups: number;
  active_users: { day: number | null; week: number | null; month: number | null; in_window: number | null };
};

type VoiceMetrics = {
  window: MetricsWindow;
  by_surface: Record<MetricsSurface, SurfaceStats> & { analytics?: SurfaceStats };
  failed_by_stage: { input: number; stt: number; agent: number; tts: number };
  first_audio_p95_by_bucket: Array<{ t: string; device: number | null; web_voice: number | null }>;
};

type PlatformMetrics = {
  window: MetricsWindow;
  backlog: number;
  oldest_pending_seconds: number | null;
  retried: number;
  failed_by_event_type: Array<{ event_type: string; count: number }>;
};

type TokenTotals = { input: number; output: number; cached_input: number };

type AiMetrics = {
  window: MetricsWindow;
  turns: number;
  tokens: TokenTotals & { cache_write: number; reasoning: number };
  cache_hit_ratio: number | null;
  avg_steps: number | null;
  avg_output_tokens: number | null;
  interrupted_rate: number | null;
  by_model: Array<{ model: string; turns: number } & TokenTotals>;
  tools: Array<{ tool: string; count: number }>;
  intents: Array<{ intent: string; turns: number; success_rate: number | null; p95_total_ms: number | null }>;
  tokens_by_bucket: Array<{ t: string } & TokenTotals>;
};

type DevicesMetrics = {
  window: MetricsWindow;
  devices: { paired: number; active_in_window: number; revoked: number };
  by_fw_version: Array<{ fw_version: string; count: number }>;
  by_model: Array<{ model: string; count: number }>;
  freshness: { under_1h: number; under_24h: number; under_7d: number; older: number; never: number };
  pairing: { requested: number; approved: number; expired: number; other: number };
};

type FeaturesMetrics = {
  window: MetricsWindow;
  created_by_bucket: Array<{ t: string; tasks: number; notes: number; reminders: number }>;
  tasks: { created: number; completed: number };
  reminders: { created: number; delivered: number; acknowledged: number; snoozed: number };
  notifications: { created: number; read: number; by_type: Array<{ type: string; count: number }> };
  calendar: { events_created: number; by_origin: never[] };
  spaces: { created: number; by_kind: { private: number; pair: number; group: number } };
  game_minutes: number;
};

export type MetricsDocuments = {
  usage: UsageMetrics;
  voice: VoiceMetrics;
  platform: PlatformMetrics;
  ai: AiMetrics;
  devices: DevicesMetrics;
  features: FeaturesMetrics;
  users: z.infer<typeof UsersMetricsSchema>;
};

const CountSchema = z.number().int().nonnegative();
const UsersMetricsSchema = z.object({
  window: z.object({ from: z.string(), to: z.string(), bucket: z.enum(['hour', 'day', 'week']) }).strict(),
  accounts: z.object({ total: CountSchema, enabled: CountSchema, disabled: CountSchema, awaitingConfirmation: CountSchema }).strict(),
  signups: CountSchema,
  signups_by_bucket: z.array(z.object({ t: z.string(), count: CountSchema }).strict()),
  active_users: z.object({ day: CountSchema.nullable(), week: CountSchema.nullable(), month: CountSchema.nullable(), in_window: CountSchema.nullable() }).strict(),
  activated_users: CountSchema.nullable(),
  waitlist: z.object({ total: CountSchema, verified: CountSchema, pending: CountSchema, withAccount: CountSchema, waitingVerified: CountSchema }).strict(),
}).strict();

export async function fetchOperatorMetrics<P extends MetricsPage>(page: P, range: MetricsRange): Promise<MetricsDocuments[P]> {
  const response = await fetchWithAuth(`/api/operator/metrics/${page}?range=${range}`);
  if (!response.ok) throw new Error('metrics_failed');
  const data: unknown = await response.json();
  return (page === 'users' ? UsersMetricsSchema.parse(data) : data) as MetricsDocuments[P];
}

// The server answers 404 to everyone who is not an operator, so the page and
// its menu item stay hidden from them.
export async function probeOperatorAccess(): Promise<boolean> {
  const response = await fetchWithAuth('/api/operator/access');
  if (response.status === 204) return true;
  if (response.status === 404) return false;
  throw new Error('access_probe_failed');
}
