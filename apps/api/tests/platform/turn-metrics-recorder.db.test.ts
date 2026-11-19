/**
 * createTurnMetricRecorder against a real local Postgres (#898 RCA): proves a
 * row lands for the device, failed-stt and web paths the way production
 * builds them (toTurnMetricRow over realistic TurnMetricInput, then the
 * fire-and-forget recorder), reading the count back through the
 * already-granted bob_private.operator_metrics_voice aggregate so this file
 * needs no new grant and no admin connection. Uses test-db.ts's per-file
 * template copy (same postgres.js adapter, same prepare:true, as production)
 * rather than db-harness.ts's shared-stack path: the latter runs `supabase
 * migration up --local` against the one Postgres container every worktree on
 * the machine shares, which fails here on migration drift from a sibling
 * worktree's newer migration -- unrelated to this fix (see pg-template.ts's
 * own comment on why it avoids that path).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTurnMetricRecorder, toTurnMetricRow, type TurnMetricInput } from '../../src/platform/observability/turn-metrics.ts';
import { asServer, type Db } from '../../src/platform/db/db.ts';
import { SCHEMAS } from '../../src/platform/observability/operator-metrics-schemas.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

describe('createTurnMetricRecorder (real database)', () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await createTestDb();
    db = asDb(testDb);
  });

  afterAll(async () => {
    await closeTestDb(testDb);
  });

  /** The database's own clock, not the test runner host's: Docker Desktop's
   *  container clock can drift seconds from the Windows host, which would
   *  otherwise put `from` after `occurred_at` and hide every row. */
  async function dbNow(): Promise<Date> {
    const rows = await db.query<{ t: string }>('select now() as t');
    return new Date(rows[0]!.t);
  }

  async function readVoice(from: Date, to: Date): Promise<ReturnType<typeof SCHEMAS.voice.parse>> {
    const rows = await asServer(db, (s) =>
      s.query<{ doc: unknown }>(
        'SELECT bob_private.operator_metrics_voice($1::timestamptz, $2::timestamptz, $3::text) AS doc',
        [from.toISOString(), to.toISOString(), 'day'],
      ),
    );
    return SCHEMAS.voice.parse(rows[0]?.doc);
  }

  it('lands a device turn with called_tools, a failed stt turn, and a web turn', async () => {
    const from = new Date((await dbNow()).getTime() - 60_000);
    const record = createTurnMetricRecorder(() => Promise.resolve(db));

    const deviceInput: TurnMetricInput = {
      surface: 'device', outcome: 'completed', intent: 'timer_reminder', fw_version: '1.4.2',
      usage: {
        model: 'google/gemini-2.5-flash', provider: 'google', input_tokens: 120, output_tokens: 45,
        steps: 2, tool_calls: 1, called_tools: 'set_timer',
      },
      streamed: true, stt_ms: 120, model_ms: 300, tts_ms: 200, first_audio_ms: 450, total_ms: 900,
    };
    const failedInput: TurnMetricInput = {
      surface: 'device', outcome: 'failed', failed_stage: 'stt', failure_kind: 'internal', stt_ms: 50,
    };
    const webInput: TurnMetricInput = {
      surface: 'web_text', outcome: 'completed', intent: 'chat',
      usage: { model: 'openai/gpt-5', provider: 'openai', input_tokens: 50, output_tokens: 20 }, total_ms: 400,
    };

    record(toTurnMetricRow(deviceInput));
    record(toTurnMetricRow(failedInput));
    record(toTurnMetricRow(webInput));

    const to = new Date(from.getTime() + 24 * 60 * 60_000);
    await vi.waitFor(
      async () => {
        const voice = await readVoice(from, to);
        expect(voice.by_surface.device.turns).toBeGreaterThanOrEqual(1);
        expect(voice.by_surface.web_text.turns).toBeGreaterThanOrEqual(1);
        expect(voice.failed_by_stage.stt).toBeGreaterThanOrEqual(1);
      },
      { timeout: 5000, interval: 100 },
    );
  });
});
