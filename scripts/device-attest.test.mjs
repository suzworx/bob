import { describe, expect, it } from 'vitest';

import {
  attestDecision,
  deviceIdFromMac,
  makePassRecord,
  PASS_RECORD,
  recordVerdict,
  STATUS_CONTEXT,
  statusArgs,
  statusDescription,
} from './device-attest.mjs';

const FW = 'f'.repeat(64);
const OTHER_FW = 'e'.repeat(64);
const TREE = 'a'.repeat(40);

const scenarios = (...statuses) =>
  statuses.map((status, i) => ({ name: `s${i}`, issue: '#baseline', status, ...(status === 'skip' ? { reason: 'not built' } : {}) }));

const record = (overrides = {}) =>
  makePassRecord({
    firmwareHash: FW,
    tree: TREE,
    runId: '20260923-120000-ab12',
    scenarios: scenarios('pass', 'pass', 'skip'),
    deviceId: deviceIdFromMac('AA:BB:CC:DD:EE:FF'),
    ts: '2026-09-23T12:00:00.000Z',
    runnerVersion: '1',
    ...overrides,
  });

describe('HIL pass record', () => {
  it('lives in data/ and posts as local/device-hil', () => {
    expect(PASS_RECORD).toBe('data/hil-pass.json');
    expect(STATUS_CONTEXT).toBe('local/device-hil');
  });

  it('stores the device id T ping reports, never the MAC itself', () => {
    const r = record();
    expect(r.device_id_hash).toBe('c1799564f2ee');
    expect(JSON.stringify(r)).not.toMatch(/aa:?bb/i);
    expect(record({ deviceId: '0D7B41FAA5BE' }).device_id_hash).toBe('0d7b41faa5be');
    expect(record({ deviceId: undefined }).device_id_hash).toBeNull();
    expect(record({ deviceId: 'D0:CF:13:0C:90:30' }).device_id_hash).toBeNull();
  });

  it('derives the id the firmware prints: sha256 of the bare lowercase MAC, 12 hex digits', () => {
    // The same device gets the same id whatever the MAC's case or separator.
    expect(deviceIdFromMac('AA:BB:CC:DD:EE:FF')).toBe('c1799564f2ee');
    expect(deviceIdFromMac('aa-bb-cc-dd-ee-ff')).toBe('c1799564f2ee');
    expect(deviceIdFromMac('not a mac')).toBeNull();
  });

  it('carries every field the gate and the PR evidence read', () => {
    expect(Object.keys(record()).sort()).toEqual(
      ['device_id_hash', 'firmware_hash', 'run_id', 'runner_version', 'scenarios', 'tree', 'ts'].sort(),
    );
  });
});

describe('recordVerdict', () => {
  it('passes a run with passes and skips but no failures', () => {
    expect(recordVerdict(record())).toEqual({ ok: true, pass: 2, fail: 0, skip: 1 });
  });

  it('fails a run with any failed scenario', () => {
    expect(recordVerdict(record({ scenarios: scenarios('pass', 'fail') })).ok).toBe(false);
  });

  it('fails a run where nothing actually ran (all skipped, or empty)', () => {
    expect(recordVerdict(record({ scenarios: scenarios('skip', 'skip') })).ok).toBe(false);
    expect(recordVerdict(record({ scenarios: [] })).ok).toBe(false);
  });

  it('fails an unknown status, a malformed hash and no record', () => {
    expect(recordVerdict(record({ scenarios: scenarios('pass', 'maybe') })).ok).toBe(false);
    expect(recordVerdict({ ...record(), firmware_hash: 'nope' }).ok).toBe(false);
    expect(recordVerdict(null).ok).toBe(false);
  });
});

describe('attestDecision', () => {
  it('attests a passing record for exactly HEAD firmware', () => {
    expect(attestDecision(record(), FW)).toEqual({ ok: true });
  });

  it('refuses a record for other firmware and says which', () => {
    const decision = attestDecision(record(), OTHER_FW);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/firmware/);
  });

  it('refuses a failing record even when the firmware matches', () => {
    const decision = attestDecision(record({ scenarios: scenarios('pass', 'fail') }), FW);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/1 failed/);
  });

  it('refuses when there is no record', () => {
    expect(attestDecision(null, FW).ok).toBe(false);
  });
});

describe('status', () => {
  it('describes the run id, the counts and the firmware hash within GitHub’s 140 chars', () => {
    const description = statusDescription(record());
    expect(description).toBe(`run=20260923-120000-ab12 pass=2 fail=0 skip=1 fw=${FW}`);
    expect(description.length).toBeLessThanOrEqual(140);
  });

  it('posts success under local/device-hil on the given commit', () => {
    const args = statusArgs('suzworx/Bob', 'c'.repeat(40), record());
    expect(args).toContain(`repos/suzworx/Bob/statuses/${'c'.repeat(40)}`);
    expect(args).toContain(`context=${STATUS_CONTEXT}`);
    expect(args).toContain('state=success');
    expect(args).toContain(`description=${statusDescription(record())}`);
  });
});
