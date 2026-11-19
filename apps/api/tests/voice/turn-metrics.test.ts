/**
 * ANL-DEV1: every device voice turn records exactly one metrics row at its end,
 * with timings, tokens, outcome and tool names, and never any text. The
 * recorder cannot change what the device receives. The agent is the real-SDK
 * harness (tests/support/agent-harness.ts), handed to the turn through the port.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { setJournalSink } from '../../src/platform/logger.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import type { AgentImpl, AgentPort } from '../../src/voice/agent-port.ts';
import type { TurnMetricRow } from '../../src/platform/observability/turn-metrics.ts';
import { createAgentHarness, words, type ScriptStep } from '../support/agent-harness.ts';

vi.mock('../../src/voice/audio/stt-tts.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/voice/audio/stt-tts.ts')>();
  return { ...actual, transcribePcm: vi.fn(), synthesizePcm: vi.fn(), synthesizeMp3: vi.fn(), downlinkFrames: vi.fn(), downlinkMp3Frames: vi.fn() };
});

import { downlinkFrames, synthesizePcm, transcribePcm } from '../../src/voice/audio/stt-tts.ts';
import { createAppDeps } from '../../src/app-deps.ts';

const appDeps = createAppDeps();
const SECRET = 'SECRET TRANSCRIPT TEXT';
const ROW_KEYS = new Set([
  'surface', 'outcome', 'failed_stage', 'failure_kind', 'upstream_status', 'intent', 'model', 'provider', 'fw_version',
  'input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_tokens', 'reasoning_tokens', 'steps', 'tool_calls',
  'called_tools', 'streamed', 'interrupted', 'tts_cache_hit', 'stt_ms', 'prep_ms', 'model_ms', 'first_token_ms', 'tts_ms',
  'first_audio_ms', 'total_ms', 'user_bucket',
]);
/** One tool call, then the answer. */
const TIMER_TURN: ScriptStep[] = [[{ type: 'tool', name: 'set_timer' }], words('done')];

const rows: TurnMetricRow[] = [];
const collect = (row: TurnMetricRow): void => { rows.push(row); };

function respondingSession(): DeviceSession {
  const session = createSession();
  Object.assign(session, { stage: 'responding', turnRef: 'turn_m1', audioChunks: [Buffer.alloc(32_000)], totalAudioBytes: 32_000 });
  return session;
}

/** A port whose agent is the harness's; an unpaired turn only asks it for base(). */
function harnessPort(agent: AgentImpl): AgentPort {
  return { kind: 'real', base: () => agent, create: () => agent, createInvocation: () => agent as never, withOfferedTools: (given) => given };
}

/** Runs one turn on a fresh harness agent; returns what the device received, as message types (audio_down for binary frames). */
async function drive(steps: readonly ScriptStep[], recordTurnMetric?: (row: TurnMetricRow) => void): Promise<string[]> {
  const session = respondingSession();
  session.turnAbort = new AbortController();
  const harness = createAgentHarness(steps, { abort: session.turnAbort });
  const turn = { ...appDeps.turn, agent: harnessPort(harness.agent as unknown as AgentImpl), recordTurnMetric };
  const send = vi.fn();
  await runTurn(turn, { readyState: 1, send } as unknown as WebSocket, session, 'turn_m1');
  return send.mock.calls.map(([data]) => (typeof data === 'string' ? (JSON.parse(data) as { type: string }).type : 'audio_down'));
}

beforeEach(() => {
  rows.length = 0;
  setJournalSink(() => undefined);
  vi.mocked(transcribePcm).mockResolvedValue({ text: 'set a timer', model: 'stt-1', seconds: 1 });
  vi.mocked(synthesizePcm).mockResolvedValue({ pcm: Buffer.alloc(3200), sourceRateHz: 16_000 });
  vi.mocked(downlinkFrames).mockReturnValue([Buffer.alloc(340)]);
});
afterEach(() => { setJournalSink(null); vi.clearAllMocks(); });

describe('device turn metrics: exactly one row per turn', () => {
  it('a completed turn records timings, tokens, tools and intent', async () => {
    await drive(TIMER_TURN, collect);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: 'device', outcome: 'completed', intent: 'timer_reminder', called_tools: ['set_timer'], steps: 2 });
    for (const key of ['stt_ms', 'total_ms', 'first_audio_ms', 'tts_ms', 'prep_ms', 'model_ms', 'input_tokens', 'output_tokens'] as const) {
      expect(rows[0]?.[key]).toBeGreaterThanOrEqual(0);
    }
  });

  it('a blank transcript is an empty turn', async () => {
    vi.mocked(transcribePcm).mockResolvedValue({ text: '  ', model: 'stt-1', seconds: 1 });
    await drive(TIMER_TURN, collect);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: 'device', outcome: 'empty' });
    expect(rows[0]?.intent).toBeUndefined();
  });

  const failures: Array<[string, ScriptStep[], () => void]> = [
    ['stt', TIMER_TURN, (): void => { vi.mocked(transcribePcm).mockRejectedValue(new Error('boom')); }],
    ['agent', [[{ type: 'error', message: 'model broke' }]], (): void => undefined],
    ['tts', TIMER_TURN, (): void => { vi.mocked(synthesizePcm).mockRejectedValue(new Error('boom')); }],
  ];
  it.each(failures)('a %s failure records failed with that stage', async (stage, steps, arrange) => {
    arrange();
    await drive(steps, collect);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'failed', failed_stage: stage, failure_kind: 'internal' });
  });

  it('an abort during the agent stage records cancelled', async () => {
    await drive([[{ type: 'abort' }]], collect);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'cancelled' });
    expect(rows[0]?.interrupted).toBeUndefined();
  });

  it('a recorder that throws changes nothing the device receives', async () => {
    const baseline = await drive(TIMER_TURN);
    const throwing = vi.fn(() => { throw new Error('recorder down'); });
    expect(await drive(TIMER_TURN, throwing)).toEqual(baseline);
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(baseline.at(-1)).toBe('status');
  });

  it('never carries the transcript or the reply, or any key outside the row', async () => {
    vi.mocked(transcribePcm).mockResolvedValue({ text: SECRET, model: 'stt-1', seconds: 1 });
    await drive([words(SECRET)], collect);
    vi.mocked(synthesizePcm).mockRejectedValue(new Error(SECRET));
    await drive([words(SECRET)], collect);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    for (const row of rows) expect(Object.keys(row).filter((key) => !ROW_KEYS.has(key))).toEqual([]);
  });
});
