/**
 * Per-turn metrics (ANL-REC1): a privacy-safe row for bob.turn_metrics, the
 * sanitising mapper writers go through, and a fire-and-forget recorder. A row
 * holds counts, timings, enums and tool names only, never text, ids or the
 * account. Every limit below mirrors a CHECK in 20261004100000_turn_metrics.sql.
 */
import { recordObservationMetrics, type ObservationMetricSample, type TurnIntent } from '@bob/ai';
import { asServer, type Db } from '../db/db.ts';
import { jsonbParam } from '../db/jsonb.ts';
import { moduleJournal } from '../logger.ts';

const journal = moduleJournal('platform');

type TurnSurface = 'device' | 'web_text' | 'web_voice' | 'analytics';
type TurnOutcome = 'completed' | 'failed' | 'cancelled' | 'empty';
type TurnFailedStage = 'input' | 'stt' | 'agent' | 'tts';
type TurnFailureKind = 'invalid_input' | 'upstream_error' | 'internal';

interface TurnMetricFields {
  surface: TurnSurface;
  upstream_status?: number;
  intent?: TurnIntent;
  model?: string;
  provider?: string;
  fw_version?: string;
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  steps?: number;
  tool_calls?: number;
  called_tools?: string[];
  streamed?: boolean;
  interrupted?: boolean;
  tts_cache_hit?: boolean;
  stt_ms?: number;
  prep_ms?: number;
  model_ms?: number;
  first_token_ms?: number;
  tts_ms?: number;
  first_audio_ms?: number;
  total_ms?: number;
  /** Web turns: request receipt to model start (20261107000000_turn_metrics_arrival). */
  arrival_ms?: number;
  user_bucket?: number;
}

export type TurnMetricRow = TurnMetricFields &
  (
    | { outcome: 'failed'; failed_stage: TurnFailedStage; failure_kind?: TurnFailureKind }
    | { outcome: Exclude<TurnOutcome, 'failed'>; failed_stage?: never; failure_kind?: never }
  );

interface TurnMetricUsage {
  model?: string;
  provider?: string;
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  steps?: number;
  tool_calls?: number;
  /** Comma-joined, as agentUsageFields returns it. */
  called_tools?: string;
}

export interface TurnMetricInput extends Omit<TurnMetricFields, 'called_tools'> {
  outcome: TurnOutcome;
  failed_stage?: TurnFailedStage;
  failure_kind?: TurnFailureKind;
  called_tools?: readonly string[];
  usage?: TurnMetricUsage;
}

const SURFACES: readonly string[] = ['device', 'web_text', 'web_voice', 'analytics'];
const OUTCOMES: readonly string[] = ['completed', 'failed', 'cancelled', 'empty'];
const STAGES: readonly string[] = ['input', 'stt', 'agent', 'tts'];
const KINDS: readonly string[] = ['invalid_input', 'upstream_error', 'internal'];
const INTENTS: readonly string[] = ['timer_reminder', 'calendar', 'task_note', 'memory', 'game', 'device_control', 'search_info', 'space_collab', 'chat', 'other'];
const MODEL_RE = /^[A-Za-z0-9._:/@-]{1,128}$/;
const PROVIDER_RE = /^[A-Za-z0-9._-]{1,64}$/;
const FW_RE = /^[0-9A-Za-z._+-]{1,32}$/;
const TOOL_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_MS = 600_000;
const MAX_TOKENS = 2_147_483_647;

const oneOf = (allowed: readonly string[], v: unknown): string | undefined => (typeof v === 'string' && allowed.includes(v) ? v : undefined);
const matching = (re: RegExp, v: unknown): string | undefined => (typeof v === 'string' && re.test(v) ? v : undefined);
function num(v: unknown, max: number, min = 0, round = false): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  const n = round ? Math.round(v) : v;
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}
function tools(list: unknown): string[] | undefined {
  const names = typeof list === 'string' ? list.split(',') : Array.isArray(list) ? list : [];
  const kept = names.filter((n): n is string => typeof n === 'string' && TOOL_RE.test(n)).slice(0, 64);
  return kept.length > 0 ? kept : undefined;
}

const flag = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

function tokenFields(u: TurnMetricUsage, input: TurnMetricInput): Record<string, unknown> {
  return {
    input_tokens: num(u.input_tokens ?? input.input_tokens, MAX_TOKENS, 0, true),
    output_tokens: num(u.output_tokens ?? input.output_tokens, MAX_TOKENS, 0, true),
    cached_input_tokens: num(u.cached_input_tokens ?? input.cached_input_tokens, MAX_TOKENS, 0, true),
    cache_write_tokens: num(u.cache_write_tokens ?? input.cache_write_tokens, MAX_TOKENS, 0, true),
    reasoning_tokens: num(u.reasoning_tokens ?? input.reasoning_tokens, MAX_TOKENS, 0, true),
  };
}

function limitFields(u: TurnMetricUsage, input: TurnMetricInput): Record<string, unknown> {
  return {
    steps: num(u.steps ?? input.steps, 100),
    tool_calls: num(u.tool_calls ?? input.tool_calls, 500),
  };
}

function timingFields(input: TurnMetricInput): Record<string, unknown> {
  return {
    stt_ms: num(input.stt_ms, MAX_MS, 0, true),
    prep_ms: num(input.prep_ms, MAX_MS, 0, true),
    model_ms: num(input.model_ms, MAX_MS, 0, true),
    first_token_ms: num(input.first_token_ms, MAX_MS, 0, true),
    tts_ms: num(input.tts_ms, MAX_MS, 0, true),
    first_audio_ms: num(input.first_audio_ms, MAX_MS, 0, true),
    total_ms: num(input.total_ms, MAX_MS, 0, true),
    arrival_ms: num(input.arrival_ms, MAX_MS, 0, true),
  };
}

function failureFields(outcome: string, input: TurnMetricInput): Record<string, unknown> {
  if (outcome !== 'failed') return {};
  // The table requires a stage on a failed row; TurnMetricRow makes writers supply one, so 'agent' is only a defensive fallback.
  return {
    failed_stage: oneOf(STAGES, input.failed_stage) ?? 'agent',
    failure_kind: oneOf(KINDS, input.failure_kind),
  };
}

/** Copies only known, validated fields; the text of any other value never leaves this function. */
export function toTurnMetricRow(input: TurnMetricInput): TurnMetricRow {
  const u: TurnMetricUsage = input.usage ?? {};
  const outcome = oneOf(OUTCOMES, input.outcome) ?? 'failed';
  const out: Record<string, unknown> = {
    surface: oneOf(SURFACES, input.surface) ?? 'analytics',
    outcome,
    upstream_status: num(input.upstream_status, 599, 100),
    intent: oneOf(INTENTS, input.intent),
    model: matching(MODEL_RE, u.model ?? input.model),
    provider: matching(PROVIDER_RE, u.provider ?? input.provider),
    fw_version: matching(FW_RE, input.fw_version),
    ...tokenFields(u, input),
    ...limitFields(u, input),
    called_tools: tools(input.called_tools ?? u.called_tools),
    streamed: flag(input.streamed),
    interrupted: flag(input.interrupted),
    tts_cache_hit: flag(input.tts_cache_hit),
    user_bucket: num(input.user_bucket, 1023),
    ...timingFields(input),
    ...failureFields(outcome, input),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as unknown as TurnMetricRow;
}

/** The Postgres SQLSTATE off a thrown driver error (postgres.js puts it
 *  directly on the error, e.g. '22023'), or undefined when the error has none. */
function sqlstate(error: unknown): string | undefined {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

// arrival_ms (20261107000000_turn_metrics_arrival) reaches production only when CI applies it after merge.
// pg_attribute, not information_schema.columns: the latter lists only columns the role holds a privilege
// on, and bob_server holds none on this table, so it would always say absent.
const ARRIVAL_PROBE = `select exists (select 1 from pg_catalog.pg_attribute where attrelid = to_regclass('bob.turn_metrics') and attname = 'arrival_ms' and attnum > 0 and not attisdropped) as present`;

/** Fire-and-forget: never throws or rejects into a turn; a failure journals the
 *  error name and its SQLSTATE only, never the message or the row. The
 *  arrival_ms column is probed once per recorder (one per process) and the
 *  answer cached; a failed probe omits the column and asks again next row. */
export function createTurnMetricRecorder(getDb: () => Promise<Db>): (row: TurnMetricRow) => void {
  let hasArrival: Promise<boolean> | null = null;
  const probeArrival = (db: Db): Promise<boolean> =>
    (hasArrival ??= db.query<{ present?: boolean }>(ARRIVAL_PROBE).then((rows) => rows[0]?.present === true).catch(() => {
      hasArrival = null;
      return false;
    }));
  return (row) => {
    const safeRow = toTurnMetricRow(row);
    recordObservationMetrics(turnScores(safeRow));
    void (async () => {
      try {
        const db = await getDb();
        const { arrival_ms, ...rest } = safeRow;
        const written = arrival_ms !== undefined && await probeArrival(db) ? safeRow : rest;
        // jsonb_populate_record requires an object, not the double-encoded
        // string a bare $1::jsonb would store (jsonbParam's doc comment).
        await asServer(db, (s) => s.query(`SELECT bob_private.record_turn_metric(${jsonbParam('$1')})`, [JSON.stringify(written)]));
      } catch (error) {
        journal('v2.turn_metric_failed', { error: error instanceof Error ? error.name : 'unknown', code: sqlstate(error) });
      }
    })();
  };
}

function turnScores(row: TurnMetricRow): ObservationMetricSample[] {
  const samples: ObservationMetricSample[] = [
    { name: 'turn.failed', value: Number(row.outcome === 'failed') },
    { name: 'turn.cancelled', value: Number(row.outcome === 'cancelled') },
    { name: 'turn.empty', value: Number(row.outcome === 'empty') },
    { name: 'turn.completed', value: Number(row.outcome === 'completed') },
  ];
  // first_token_ms is relative to turn start on both web and device rows.
  const timings = ['stt_ms', 'prep_ms', 'model_ms', 'first_token_ms', 'tts_ms', 'first_audio_ms', 'total_ms'] as const;
  for (const key of timings) {
    const value = row[key];
    if (value !== undefined) samples.push({ name: `turn.${key}`, value, attributes: { surface: row.surface } });
  }
  return samples;
}
