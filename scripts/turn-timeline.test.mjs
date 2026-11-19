import { describe, expect, it } from 'vitest';
import { buildTurns, buildTurnsFromEvents, hitToFields, parseLine, renderHtml, SLOW_WAIT_MS, summarize } from './turn-timeline.mjs';

/** One synthetic journal line in the journal shape: `<ts> [INFO] v2.<event> key="v" key=1 ...`. */
function line(event, ts, fields) {
  const kv = Object.entries(fields).map(([key, value]) => (typeof value === 'number' ? `${key}=${value}` : `${key}="${value}"`));
  return `${ts} [INFO] v2.${event} ts="${ts}" event="v2.${event}" ${kv.join(' ')}`;
}

/**
 * A full turn: STT ends at `sttEnd` after 500 ms, the agent and TTS follow, and
 * the device reports turn_end at 3000 ms and playback from `playStart`.
 */
function turnLines(turn, { sttEnd = '2026-01-01T00:00:10.000Z', playStart = 7000, endReason = 'silence', playEnd = 9000 } = {}) {
  const base = Date.parse(sttEnd);
  const iso = (offset) => new Date(base + offset).toISOString();
  return [
    line('turn_stage_stt_completed', iso(0), { turn_id: turn, duration_ms: 500, seconds: 2.9, board: 'cardputer', transcript: 'a private sentence' }),
    line('turn_stage_agent_completed', iso(2000), { turn_id: turn, duration_ms: 1900, prep_ms: 400, model_ms: 1500, steps: 1, called_tools: '', retrieval_ms: 120, model: 'google/gemini-2.5-flash', user_id: 'user-secret' }),
    line('turn_stage_tts_completed', iso(2600), { turn_id: turn, duration_ms: 600 }),
    line('turn_completed', iso(3000), { turn_id: turn, tts_ms_per_sentence: '300,300', conversation_id: 'conv_secret' }),
    line('device_turn_timing', iso(9000), { turn_id: turn, end_reason: endReason, capture_end_ms: 2950, turn_end_ms: 3000, playback_start_ms: playStart, playback_end_ms: playEnd }),
  ];
}

describe('parseLine', () => {
  it('reads the event and its quoted and numeric fields', () => {
    const fields = parseLine('2026-01-01T00:00:00.123456Z [INFO] v2.turn_completed ts="2026-01-01T00:00:00.120Z" turn_id="t1" steps=2 seconds=1.5');
    expect(fields).toMatchObject({ event: 'v2.turn_completed', ts: '2026-01-01T00:00:00.120Z', turn_id: 't1', steps: '2', seconds: '1.5' });
  });

  it('ignores lines that are not v2 events', () => {
    expect(parseLine('2026-01-01T00:00:00Z [INFO] Starting Container')).toBeNull();
  });
});

describe('buildTurns', () => {
  it('places the device turn_end at the server STT start', () => {
    const [turn] = buildTurns(turnLines('t1').join('\n'));
    const row = (name) => turn.rows.find((r) => r.name === name);
    // STT started 500 ms before its completion; the device turn_end (3000) is that instant.
    expect(row('Speech-to-text')).toMatchObject({ start: 3000, end: 3500 });
    // Agent ended 2000 ms after STT ended, after 1900 ms: 400 ms prep then the model.
    expect(row('Preparation')).toMatchObject({ start: 3600, end: 4000 });
    expect(row('AI model')).toMatchObject({ start: 4000, end: 5500 });
    expect(row('Speech generation')).toMatchObject({ start: 5500, end: 6100 });
    expect(row('Bob speaking')).toMatchObject({ start: 7000, end: 9000 });
    expect(turn.wait).toBe(4000);
  });

  it('skips a turn whose device offsets were not measured', () => {
    const lines = turnLines('t1');
    lines[4] = lines[4].replace('playback_start_ms=7000', 'playback_start_ms="skipped"');
    expect(buildTurns(lines.join('\n'))).toEqual([]);
  });

  it('skips a turn without a device timing', () => {
    expect(buildTurns(turnLines('t1').slice(0, 4).join('\n'))).toEqual([]);
  });

  it('marks a recording that ran to the max length', () => {
    const [turn] = buildTurns(turnLines('t1', { endReason: 'max' }).join('\n'));
    expect(turn.stuck).toBe(true);
    expect(turn.rows[0].kind).toBe('device-bad');
  });
});

describe('hitToFields', () => {
  /** The synthetic turn as log-store search hits: flat columns, numbers unquoted, `_timestamp` in µs. */
  function turnHits(turn) {
    return turnLines(turn).map((text) => {
      const { ts, line_ts: _lineTs, ...fields } = parseLine(text);
      const hit = { _timestamp: Date.parse(ts) * 1000, source: 'api', empty: null };
      for (const [key, value] of Object.entries(fields)) hit[key] = /^-?[0-9.]+$/u.test(value) ? Number(value) : value;
      return hit;
    });
  }

  it('maps a hit to the parsed-line shape, ts from _timestamp', () => {
    const fields = hitToFields({ _timestamp: 1_767_225_610_000_123, event: 'v2.turn_completed', turn_id: 't1', steps: 2, seconds: 1.5, empty: null });
    expect(fields).toEqual({ event: 'v2.turn_completed', turn_id: 't1', steps: '2', seconds: '1.5', ts: '2026-01-01T00:00:10.000Z' });
  });

  it('renders the same turns from search hits as from journal lines', () => {
    const fromHits = buildTurnsFromEvents(turnHits('t1').map(hitToFields));
    expect(fromHits).toEqual(buildTurns(turnLines('t1').join('\n')));
    expect(fromHits[0].wait).toBe(4000);
  });
});

describe('summarize', () => {
  it('reports the median wait and the waits over the slow threshold', () => {
    const text = [
      ...turnLines('t1', { sttEnd: '2026-01-01T00:00:10.000Z', playStart: 5000 }),
      ...turnLines('t2', { sttEnd: '2026-01-01T00:01:10.000Z', playStart: 9000, playEnd: 11000 }),
      ...turnLines('t3', { sttEnd: '2026-01-01T00:02:10.000Z', playStart: 12000, playEnd: 14000 }),
    ].join('\n');
    expect(summarize(buildTurns(text))).toEqual({ turns: 3, medianWaitMs: 6000, overSlow: 2 });
    expect(SLOW_WAIT_MS).toBe(5000);
  });
});

describe('renderHtml', () => {
  const html = renderHtml(buildTurns(turnLines('turn_private_1', { endReason: 'max', playStart: 9000, playEnd: 10000 }).join('\n')));

  it('draws the waterfall, its markers and the pills', () => {
    expect(html).toContain('<svg');
    expect(html).toContain('class="mark"');
    expect(html).toContain('you stop → Bob speaks 6.0s');
    expect(html).toContain('recording hit the max length');
    expect(html).toContain('google/gemini-2.5-flash');
    expect(html).toContain('prefers-color-scheme:dark');
  });

  // Privacy: numbers, enums and model ids only — no ids or text from the source lines.
  it('carries no transcript, user, conversation or turn ids', () => {
    for (const secret of ['a private sentence', 'user-secret', 'conv_secret', 'turn_private_1']) {
      expect(html).not.toContain(secret);
    }
  });
});
