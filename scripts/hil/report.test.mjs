import { describe, expect, it } from 'vitest';

import { newRunId, recordable, redactMacs, renderReport, scenarioTable } from './report.mjs';

describe('redactMacs', () => {
  it('removes every MAC from flash output, whatever its case or separator', () => {
    const esptool = 'Chip is ESP32-S3 (QFN56) (revision v0.2)\nMAC: d0:cf:13:0c:90:30\nUploading stub...\nD0-CF-13-0C-90-30';
    const out = redactMacs(esptool);
    expect(out).not.toMatch(/d0.?cf.?13/i);
    expect(out).toContain('MAC: <mac>');
    expect(out).toContain('Chip is ESP32-S3 (QFN56) (revision v0.2)');
  });

  it('leaves times, versions and hashes alone', () => {
    const text = 'Took 00:00:29.311 esptool.py v4.11.0 fw=f262557 id=0d7b41faa5be';
    expect(redactMacs(text)).toBe(text);
  });
});

const HASH = '7'.repeat(64);
const HEAD = 'abc1234def5678'.padEnd(40, '0');
const ok = [
  { name: 'boot-ready', issue: '#baseline', status: 'pass', ms: 900, evidence: ['> T ping  < pong fw=0.1.0 build=abc1234'] },
  { name: 'mode-cycle', issue: '#330', status: 'skip', reason: 'firmware does not implement: mode cycle on k (#330)', evidence: [] },
];
const base = { results: ok, fullSet: true, diskHash: HASH, headHash: HASH, flashed: true, pingBuild: 'abc1234', headSha: HEAD };

describe('recordable', () => {
  it('records a full, flashed run with passes and skips only', () => {
    expect(recordable(base)).toEqual({ ok: true });
  });

  it('never records a single-scenario run', () => {
    expect(recordable({ ...base, fullSet: false }).reason).toMatch(/subset/);
  });

  it('never records a run with a failure or with nothing passed', () => {
    expect(recordable({ ...base, results: [...ok, { name: 'x', issue: '#1', status: 'fail' }] }).ok).toBe(false);
    expect(recordable({ ...base, results: [ok[1]] }).ok).toBe(false);
  });

  it('refuses uncommitted firmware edits: the run tested something HEAD is not', () => {
    expect(recordable({ ...base, diskHash: '8'.repeat(64) }).reason).toMatch(/differs from HEAD/);
  });

  it('with --no-flash, records only when the device reports HEAD’s build', () => {
    expect(recordable({ ...base, flashed: false }).ok).toBe(true);
    expect(recordable({ ...base, flashed: false, pingBuild: 'fff0000' }).ok).toBe(false);
    expect(recordable({ ...base, flashed: false, pingBuild: 'dev' }).ok).toBe(false);
    expect(recordable({ ...base, flashed: false, pingBuild: undefined }).ok).toBe(false);
  });
});

describe('report', () => {
  it('makes run ids that sort by time and fit the status description', () => {
    const id = newRunId(new Date(2026, 8, 23, 7, 5, 9), () => 0.5);
    expect(id).toBe('20260923-070509-7fff');
  });

  it('renders a scenario table with every result and its reason', () => {
    const table = scenarioTable(ok);
    expect(table).toMatch(/\| boot-ready \| #baseline \| PASS \| 900 \|/);
    expect(table).toMatch(/\| mode-cycle \| #330 \| SKIP \| 0 \| firmware does not implement/);
  });

  it('says in the report whether the run was attested and why not', () => {
    const md = renderReport({ runId: 'r', firmwareHash: HASH, head: HEAD, flashed: true, ping: 'pong', results: ok, attested: false, notAttestedReason: 'because' });
    expect(md).toMatch(/1 passed, 0 failed, 1 skipped/);
    expect(md).toMatch(/attested: no — because/);
    expect(md).toMatch(/pong fw=0\.1\.0/);
    expect(md).toMatch(/flashed this run: yes \(m5stack-cardputer-hil\)/);
  });

  it('prints the env that was actually flashed', () => {
    const md = renderReport({ runId: 'r', firmwareHash: HASH, head: HEAD, flashed: true, hilEnv: 'waveshare-s3-185c-hil', ping: 'pong', results: ok, attested: false, notAttestedReason: 'x' });
    expect(md).toMatch(/yes \(waveshare-s3-185c-hil\)/);
  });
});
