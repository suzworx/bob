import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { formatFindings, METADATA_KEYS, RULES, scanJournal, scanJournalFile } from './journal-privacy.mjs';

// The pattern validate-non-device passed to `rg -i` before it imported RULES.
// Kept here only as the regression anchor for "V11 keeps its terms".
const V11_BEFORE = /transcript|prompt|bearer|test-token|hello from validation|System test response|system test transcript|assistant/i;

const clean = [
  '{"ts":"2026-09-26T10:00:00.000Z","event":"ai.stt_response","elapsed_ms":412,"bytes":18432}',
  '{"ts":"2026-09-26T10:00:00.500Z","event":"ai.tts_response","elapsed_ms":230,"chars":42,"bytes":9600}',
  '{"ts":"2026-09-26T10:00:01.000Z","event":"v2.turn_done","turn":"t_1","frames":61}',
  '',
];
// The pre-#501 fixtures: each leak is named by its KEY (or role value).
const leakyKeys = [
  '{"event":"ai.stt_response","transcript":"what is the weather"}',
  '{"event":"ai.request","system_prompt":"You are Bob"}',
  '{"event":"auth","header":"Bearer sk-secret-123"}',
  '{"event":"auth","token":"test-token"}',
  '{"event":"text","body":"Hello from validation"}',
  '{"event":"reply","text":"System test response"}',
  '{"event":"stt","text":"System Test Transcript"}',
  '{"event":"message","role":"assistant","content":"sure"}',
];
// Each leak is in a VALUE: the payload the server must never journal.
const leaky = [
  '{"event":"ai.stt_response","text":"here is the transcript: what is the weather"}',
  '{"event":"ai.request","system":"You are Bob. Follow this prompt exactly"}',
  '{"event":"auth","header":"Bearer sk-secret-123"}',
  '{"event":"auth","token":"test-token"}',
  '{"event":"text","body":"Hello from validation"}',
  '{"event":"reply","text":"System test response"}',
  '{"event":"stt","nested":{"parts":["System Test Transcript"]}}',
  '{"event":"message","role":"assistant","content":"sure"}',
];

describe('journal privacy scan', () => {
  it('passes a journal of bounded byte/count fields', () => {
    expect(scanJournal(clean)).toEqual([]);
    expect(scanJournal(clean.join('\n'))).toEqual([]);
  });

  it('passes trace correlation ids and milestone fields (LF-OBS-1: turn_id joins traces, carries no content)', () => {
    const correlated = [
      '{"ts":"2026-10-05T10:00:00.000Z","event":"v2.turn_stage_agent_completed","interface":"cardputer","turn_id":"9f3c7a2e1b4d4f8a9c0d1e2f3a4b5c6","stage":"agent","outcome":"completed","duration_ms":812}',
      '{"ts":"2026-10-05T10:00:01.000Z","event":"v2.welcome","session":"sess-9f3c7a2e","stage":"ready","format_id":2}',
      '{"ts":"2026-10-05T10:00:02.000Z","event":"v2.device_presence","session":"sess-9f3c7a2e","state":"online"}',
      '{"ts":"2026-10-05T10:00:03.000Z","event":"v2.announce_acked","session":"sess-9f3c7a2e","action":"played","known":true}',
      '{"ts":"2026-10-05T10:00:04.000Z","event":"v2.ota.result","result":"ok","board":"m5stack-cardputer","to":"1.4.0"}',
    ];
    expect(scanJournal(correlated)).toEqual([]);
    expect(scanJournal(correlated.join('\n'))).toEqual([]);
  });

  it('flags every leak with its 1-based line number and rule', () => {
    const findings = scanJournal([...clean, ...leaky]);
    const first = clean.length + 1;
    expect([...new Set(findings.map((f) => f.line))]).toEqual(leaky.map((_, i) => first + i));
    expect(findings).toContainEqual({ line: first, rule: 'transcript' });
    expect(findings).toContainEqual({ line: first + 1, rule: 'prompt' });
    expect(findings).toContainEqual({ line: first + 2, rule: 'bearer-credential' });
    expect(findings).toContainEqual({ line: first + 6, rule: 'stub-transcript-text' });
    expect(findings).toContainEqual({ line: first + 7, rule: 'assistant-text' });
  });

  it('flags a leak carried under a rule-term KEY, as before #501', () => {
    const findings = scanJournal(leakyKeys);
    expect([...new Set(findings.map((f) => f.line))]).toEqual(leakyKeys.map((_, i) => i + 1));
    expect(findings).toContainEqual({ line: 1, rule: 'transcript' });
    expect(findings).toContainEqual({ line: 2, rule: 'prompt' });
    expect(scanJournal(['{"transcript":"call my mom"}'])).toEqual([{ line: 1, rule: 'transcript' }]);
    expect(scanJournal(['{"prompt":"You are..."}'])).toEqual([{ line: 1, rule: 'prompt' }]);
    expect(scanJournal(['{"event":"x","nested":{"system_prompt":null}}'])).toEqual([{ line: 1, rule: 'prompt' }]);
  });

  it('passes the allowlisted prompt_layout key (first HIL run with #501)', () => {
    const line =
      '{"ts":"2026-09-26T09:35:38.000Z","event":"v2.turn_stage_agent_completed","turn":"t_7","prompt_layout":"legacy","elapsed_ms":812}';
    expect(scanJournal([line])).toEqual([]);
    expect([...METADATA_KEYS]).toEqual(['prompt_layout', 'assistant_name']);
    // Only the exact allowlisted key: a rule term in any other key is a finding.
    expect(scanJournal(['{"prompt_layout_text":"legacy"}'])).toEqual([{ line: 1, rule: 'prompt' }]);
    expect(scanJournal(['{"transcript_chars":12}'])).toEqual([{ line: 1, rule: 'transcript' }]);
  });

  it('passes the allowlisted assistant_name key (the display name a turn runs under, #880)', () => {
    expect(scanJournal(['{"event":"v2.turn_started","turn_id":"t_1","assistant_name":"bob"}'])).toEqual([]);
    expect(scanJournal(['{"assistant_text":"hello"}'])).toEqual([{ line: 1, rule: 'assistant-text' }]);
  });

  it('still scans the value of an allowlisted key', () => {
    expect(scanJournal(['{"prompt_layout":"You are Bob, the assistant"}'])).toEqual([{ line: 1, rule: 'assistant-text' }]);
  });

  it('passes enum-like values such as prompt_layout "cache-v1" and "legacy"', () => {
    for (const layout of ['cache-v1', 'legacy']) {
      expect(scanJournal([JSON.stringify({ event: 'v2.turn_stage_agent_completed', prompt_layout: layout })])).toEqual([]);
    }
  });

  it('still flags a value that carries prompt text or a transcript', () => {
    expect(scanJournal(['{"prompt_layout":"legacy","body":"the full prompt was ..."}'])).toEqual([{ line: 1, rule: 'prompt' }]);
    const extra = [{ name: 'hil-transcript', term: 'hardware in the loop test' }];
    expect(scanJournal(['{"chars":25,"text":"Hardware in the loop test"}'], { extra })).toEqual([
      { line: 1, rule: 'hil-transcript' },
    ]);
  });

  it('scans a non-JSON line as text, keys and all', () => {
    expect(scanJournal(['ok', 'prompt_layout=legacy', '{"broken":"json"'])).toEqual([{ line: 2, rule: 'prompt' }]);
  });

  it('matches case-insensitively and reads CRLF journals', () => {
    expect(scanJournal('ok\r\nTRANSCRIPT=x\r\n{"a":"PrOmPt"}\r\n')).toEqual([
      { line: 2, rule: 'transcript' },
      { line: 3, rule: 'prompt' },
    ]);
  });

  it('applies run-specific extra rules', () => {
    const extra = [{ name: 'hil-transcript', term: 'hardware in the loop test' }];
    const lines = ['{"event":"stt","text":"Hardware in the loop test"}'];
    expect(scanJournal(lines)).toEqual([]);
    expect(scanJournal(lines, { extra })).toEqual([{ line: 1, rule: 'hil-transcript' }]);
  });

  it('reports line and rule only, never the offending text', () => {
    const out = formatFindings(scanJournal(leaky));
    expect(out).toContain('line 3: bearer-credential');
    for (const secret of ['sk-secret-123', 'what is the weather', 'You are Bob', 'sure']) expect(out).not.toContain(secret);
  });

  it('keeps V11 behaviour: flags exactly the lines the old rg pattern flagged', () => {
    const fixtures = [...clean, ...leakyKeys, ...leaky, 'prompted', 'assistants', 'transcripts=0', 'bear', 'token', 'hello'];
    for (const line of fixtures) expect(scanJournal([line]).length > 0).toBe(V11_BEFORE.test(line));
    expect(RULES.map((r) => r.term).join('|')).toBe(V11_BEFORE.source);
  });
});

describe('scanJournalFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-privacy-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('scans a journal file', () => {
    const path = join(dir, 'server-journal.log');
    writeFileSync(path, `${clean.join('\n')}\n{"prompt_layout":"cache-v1"}\n{"text":"a prompt"}\n{"prompt":"x"}\n`);
    expect(scanJournalFile(path)).toEqual([
      { line: clean.length + 2, rule: 'prompt' },
      { line: clean.length + 3, rule: 'prompt' },
    ]);
  });

  it('treats a missing journal as clean, as rg exiting non-zero did', () => {
    expect(scanJournalFile(join(dir, 'absent.log'))).toEqual([]);
  });
});
