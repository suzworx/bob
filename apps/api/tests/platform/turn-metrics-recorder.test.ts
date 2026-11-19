/**
 * Turn metrics plumbing (ANL-REC1): the account bucket, the sanitising row
 * mapper and the fire-and-forget recorder. Privacy is the contract: no text,
 * id or account ever reaches the row or the journal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTurnMetricRecorder, toTurnMetricRow, type TurnMetricInput } from '../../src/platform/observability/turn-metrics.ts';
import { userBucket } from '../../src/platform/observability/user-bucket.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { recordObservationMetrics } from '@bob/ai';

vi.mock('@bob/ai', async (orig) => ({
  ...(await orig<typeof import('@bob/ai')>()), recordObservationMetrics: vi.fn(),
}));

// Spaces, not hyphens: the hyphenated form is a valid model, provider and tool name, so the mapper rightly keeps it.
const SENTINEL = 'SECRET TRANSCRIPT TEXT';

describe('userBucket', () => {
  it('is deterministic and within 0..1023', () => {
    const ids = ['a', 'b', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', 'x'.repeat(200)];
    for (const id of ids) {
      const bucket = userBucket(id);
      expect(bucket).toBe(userBucket(id));
      expect(Number.isInteger(bucket)).toBe(true);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThanOrEqual(1023);
    }
  });

  it('is null for a missing or empty account', () => {
    expect(userBucket(undefined)).toBeNull();
    expect(userBucket('')).toBeNull();
  });
});

describe('toTurnMetricRow', () => {
  const base: TurnMetricInput = { surface: 'device', outcome: 'completed' };

  it('drops unknown keys', () => {
    const row = toTurnMetricRow({ ...base, transcript: 'hello', user_id: 'u1' } as unknown as TurnMetricInput);
    expect(row).toEqual({ surface: 'device', outcome: 'completed' });
  });

  it('drops a model or provider that fails its pattern and keeps a valid one', () => {
    const bad = toTurnMetricRow({ ...base, usage: { model: 'has space', provider: 'bad/provider' } });
    expect(bad.model).toBeUndefined();
    expect(bad.provider).toBeUndefined();
    const good = toTurnMetricRow({ ...base, usage: { model: 'google/gemini-2.5-flash', provider: 'google' } });
    expect(good.model).toBe('google/gemini-2.5-flash');
    expect(good.provider).toBe('google');
  });

  it('drops fw_version only when it fails the pattern', () => {
    expect(toTurnMetricRow({ ...base, fw_version: '1.2.3+abc' }).fw_version).toBe('1.2.3+abc');
    expect(toTurnMetricRow({ ...base, fw_version: 'unknown' }).fw_version).toBe('unknown');
    expect(toTurnMetricRow({ ...base, fw_version: 'v 1' }).fw_version).toBeUndefined();
    expect(toTurnMetricRow({ ...base, fw_version: 'x'.repeat(33) }).fw_version).toBeUndefined();
  });

  it('sanitises called_tools from the usage string', () => {
    const row = toTurnMetricRow({ ...base, usage: { called_tools: `set_timer,bad name,${'x'.repeat(65)},search,,read-note` } });
    expect(row.called_tools).toEqual(['set_timer', 'search', 'read-note']);
  });

  it('caps called_tools at 64 names', () => {
    const names = Array.from({ length: 80 }, (_, i) => `tool_${i}`).join(',');
    expect(toTurnMetricRow({ ...base, usage: { called_tools: names } }).called_tools).toHaveLength(64);
  });

  it('rounds ms and token values to integers', () => {
    const row = toTurnMetricRow({ ...base, total_ms: 1234.6, stt_ms: 10.4, usage: { input_tokens: 99.5, output_tokens: 7.2 } });
    expect(row.total_ms).toBe(1235);
    expect(row.stt_ms).toBe(10);
    expect(row.input_tokens).toBe(100);
    expect(row.output_tokens).toBe(7);
  });

  it('drops out-of-range, negative and non-finite numbers', () => {
    const row = toTurnMetricRow({
      ...base,
      total_ms: 600001,
      stt_ms: -1,
      model_ms: Number.NaN,
      tts_ms: 600000,
      user_bucket: 1024,
      usage: { steps: 101, tool_calls: 501, input_tokens: -5, output_tokens: Number.POSITIVE_INFINITY },
    });
    expect(row.total_ms).toBeUndefined();
    expect(row.stt_ms).toBeUndefined();
    expect(row.model_ms).toBeUndefined();
    expect(row.tts_ms).toBe(600000);
    expect(row.user_bucket).toBeUndefined();
    expect(row.steps).toBeUndefined();
    expect(row.tool_calls).toBeUndefined();
    expect(row.input_tokens).toBeUndefined();
    expect(row.output_tokens).toBeUndefined();
  });

  it('keeps failed_stage and failure_kind only on a failed row', () => {
    const ok = toTurnMetricRow({ ...base, failed_stage: 'stt', failure_kind: 'internal' } as unknown as TurnMetricInput);
    expect(ok).not.toHaveProperty('failed_stage');
    expect(ok).not.toHaveProperty('failure_kind');
    const failed = toTurnMetricRow({ surface: 'device', outcome: 'failed', failed_stage: 'stt', failure_kind: 'upstream_error', upstream_status: 502 });
    expect(failed).toMatchObject({ outcome: 'failed', failed_stage: 'stt', failure_kind: 'upstream_error', upstream_status: 502 });
  });

  it('falls back to the agent stage when a failed row has no valid stage', () => {
    expect(toTurnMetricRow({ surface: 'web_text', outcome: 'failed' } as unknown as TurnMetricInput).failed_stage).toBe('agent');
    expect(toTurnMetricRow({ surface: 'web_text', outcome: 'failed', failed_stage: 'bogus' } as unknown as TurnMetricInput).failed_stage).toBe('agent');
  });

  it('never carries a text value: the sentinel in every string field stays out of the row', () => {
    const input = {
      surface: SENTINEL,
      outcome: SENTINEL,
      failed_stage: SENTINEL,
      failure_kind: SENTINEL,
      intent: SENTINEL,
      model: SENTINEL,
      provider: SENTINEL,
      fw_version: SENTINEL,
      called_tools: SENTINEL,
      secret: SENTINEL,
      usage: { model: SENTINEL, provider: SENTINEL, called_tools: SENTINEL, extra: SENTINEL },
    } as unknown as TurnMetricInput;
    expect(JSON.stringify(toTurnMetricRow(input))).not.toContain(SENTINEL);
    const failed = { ...input, outcome: 'failed' } as unknown as TurnMetricInput;
    expect(JSON.stringify(toTurnMetricRow(failed))).not.toContain(SENTINEL);
  });
});

describe('createTurnMetricRecorder', () => {
  afterEach(() => {
    setJournalSink(null);
    vi.restoreAllMocks();
  });

  const row = { surface: 'device', outcome: 'completed', total_ms: 900 } as const;

  it('scores sanitized outcomes before database access without waiting for persistence', () => {
    vi.mocked(recordObservationMetrics).mockClear();
    const getDb = vi.fn(() => new Promise<Db>(() => {}));
    const record = createTurnMetricRecorder(getDb);
    record({ surface: 'device', outcome: 'failed', failed_stage: 'stt', stt_ms: 30, first_token_ms: 100, total_ms: 150, model_ms: Infinity });
    expect(recordObservationMetrics).toHaveBeenCalledExactlyOnceWith([
      { name: 'turn.failed', value: 1 }, { name: 'turn.cancelled', value: 0 },
      { name: 'turn.empty', value: 0 }, { name: 'turn.completed', value: 0 },
      { name: 'turn.stt_ms', value: 30, attributes: { surface: 'device' } },
      { name: 'turn.first_token_ms', value: 100, attributes: { surface: 'device' } },
      { name: 'turn.total_ms', value: 150, attributes: { surface: 'device' } },
    ]);
    expect(vi.mocked(recordObservationMetrics).mock.invocationCallOrder[0]).toBeLessThan(getDb.mock.invocationCallOrder[0] ?? 0);
  });

  it('calls the definer once with a JSON string and returns synchronously', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const db = {
      query: (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return Promise.resolve([]); },
      tx: () => Promise.reject(new Error('unused')),
    } as unknown as Db;
    const record = createTurnMetricRecorder(() => Promise.resolve(db));
    expect(record(row)).toBeUndefined();
    const inserts = (): typeof calls => calls.filter((call) => call.sql.includes('bob_private.record_turn_metric'));
    await vi.waitFor(() => expect(inserts()).toHaveLength(1));
    expect(inserts()[0]!.params).toEqual([JSON.stringify(row)]);
  });

  // SIMPLIFY-U0B: production applies migrations only after merge, so arrival_ms is written only where the column exists.
  const probingDb = (present: boolean | 'throws', calls: Array<{ sql: string; params?: unknown[] }>): Db => ({
    query: (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('bob_private.record_turn_metric')) return Promise.resolve([]);
      return present === 'throws' ? Promise.reject(new Error('probe down')) : Promise.resolve([{ present }]);
    },
    tx: () => Promise.reject(new Error('unused')),
  }) as unknown as Db;
  const timed = { surface: 'web_text', outcome: 'completed', prep_ms: 20, arrival_ms: 45 } as const;

  it('omits arrival_ms when the probe says the column is absent, and the insert still runs', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const record = createTurnMetricRecorder(() => Promise.resolve(probingDb(false, calls)));
    record(timed);
    record(timed);
    const inserts = (): typeof calls => calls.filter((call) => call.sql.includes('bob_private.record_turn_metric'));
    await vi.waitFor(() => expect(inserts()).toHaveLength(2));
    for (const insert of inserts()) expect(JSON.parse(String(insert.params![0]))).toEqual({ surface: 'web_text', outcome: 'completed', prep_ms: 20 });
    // Probed once, then cached for the process.
    expect(calls.filter((call) => call.sql.includes('arrival_ms'))).toHaveLength(1);
  });

  it('writes arrival_ms when the column exists', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const record = createTurnMetricRecorder(() => Promise.resolve(probingDb(true, calls)));
    record(timed);
    await vi.waitFor(() => expect(calls.filter((call) => call.sql.includes('bob_private.record_turn_metric'))).toHaveLength(1));
    expect(JSON.parse(String(calls.at(-1)!.params![0]))).toMatchObject({ arrival_ms: 45 });
  });

  it('a failed probe omits arrival_ms and still records the row', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const record = createTurnMetricRecorder(() => Promise.resolve(probingDb('throws', calls)));
    record(timed);
    await vi.waitFor(() => expect(calls.filter((call) => call.sql.includes('bob_private.record_turn_metric'))).toHaveLength(1));
    expect(JSON.parse(String(calls.at(-1)!.params![0]))).not.toHaveProperty('arrival_ms');
  });

  it('never rejects and journals only the error name when the write fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const lines: string[] = [];
    setJournalSink((line) => lines.push(line));
    const db = {
      query: () => Promise.reject(new TypeError(`boom ${SENTINEL}`)),
      tx: () => Promise.reject(new Error('unused')),
    } as unknown as Db;
    const record = createTurnMetricRecorder(() => Promise.resolve(db));
    expect(() => record(row)).not.toThrow();
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.event).toBe('v2.turn_metric_failed');
    expect(entry.error).toBe('TypeError');
    expect(entry.code).toBeUndefined();
    expect(lines[0]).not.toContain(SENTINEL);
    // The row's values (total_ms: 900) never reach the journal. Check fields, not the raw line:
    // the line's own timestamp can end in .900Z.
    expect(entry.total_ms).toBeUndefined();
    expect(Object.values(entry).filter((value) => value === 900 || value === '900')).toEqual([]);
  });

  it('journals the Postgres SQLSTATE code, never the message', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const lines: string[] = [];
    setJournalSink((line) => lines.push(line));
    class FakePostgresError extends Error {
      code: string;
      constructor(code: string, message: string) {
        super(message);
        this.name = 'PostgresError';
        this.code = code;
      }
    }
    const db = {
      query: () => Promise.reject(new FakePostgresError('22023', `cannot call jsonb_populate_record ${SENTINEL}`)),
      tx: () => Promise.reject(new Error('unused')),
    } as unknown as Db;
    const record = createTurnMetricRecorder(() => Promise.resolve(db));
    expect(() => record(row)).not.toThrow();
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.event).toBe('v2.turn_metric_failed');
    expect(entry.error).toBe('PostgresError');
    expect(entry.code).toBe('22023');
    expect(lines[0]).not.toContain(SENTINEL);
    // The row's values (total_ms: 900) never reach the journal. Check fields, not the raw line:
    // the line's own timestamp can end in .900Z.
    expect(entry.total_ms).toBeUndefined();
    expect(Object.values(entry).filter((value) => value === 900 || value === '900')).toEqual([]);
  });

  it('survives getDb itself failing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const lines: string[] = [];
    setJournalSink((line) => lines.push(line));
    const record = createTurnMetricRecorder(() => Promise.reject(new Error('no db')));
    expect(() => record(row)).not.toThrow();
    await vi.waitFor(() => expect(lines).toHaveLength(1));
  });
});
