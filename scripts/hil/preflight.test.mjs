import { describe, expect, it } from 'vitest';

import { MIN_RSSI_DBM, rssiVerdict, transportWatch } from './preflight.mjs';

const state = (rssi) =>
  `state=READY mode=ptt vol=6 muted=0 dnd=0${rssi === undefined ? '' : ` rssi=${rssi}`} rxq_max=3 rxt=41 rxt_drop=0 log_drop=0 loop_max=151 tx_drop=0`;

describe('rssiVerdict (HIL pre-flight after boot-ready)', () => {
  it('passes at -65 dBm or stronger (healthy runs: -55..-63)', () => {
    expect(MIN_RSSI_DBM).toBe(-65);
    expect(rssiVerdict(state(-56))).toEqual({ ok: true, rssi: -56 });
    expect(rssiVerdict(state(-63))).toEqual({ ok: true, rssi: -63 });
    expect(rssiVerdict(state(-65))).toEqual({ ok: true, rssi: -65 });
  });

  it('stops the run at -70 dBm, the reading run 20260925-205858-29cd let through', () => {
    const verdict = rssiVerdict(state(-70));
    expect(verdict.ok).toBe(false);
    expect(verdict.rssi).toBe(-70);
    expect(verdict.reason).toBe(
      'environment: WiFi RSSI -70 dBm is below the -65 dBm floor; move the device or the access point until `T state` shows rssi=-65 or stronger',
    );
    expect(rssiVerdict(state(-66)).ok).toBe(false);
  });

  it('stops the run on a weak link, as an environment problem (run 20260924-172308-5a8c: -74..-80)', () => {
    const verdict = rssiVerdict(state(-74));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/^environment: WiFi RSSI -74 dBm .*move the device or the access point/);
  });

  it('does not block firmware that reports no rssi, but says it could not check', () => {
    expect(rssiVerdict(state(undefined))).toEqual({ ok: true, rssi: null, note: 'firmware reports no rssi= in T state; WiFi not checked' });
    expect(rssiVerdict(null)).toEqual({ ok: true, rssi: null, note: 'no T state reply; WiFi not checked' });
  });

  it('treats a disconnected radio (rssi 0) as unknown, not as a strong link', () => {
    expect(rssiVerdict(state(0)).ok).toBe(false);
  });
});

describe('transportWatch (a reconnect mid-scenario is the link, not the product)', () => {
  const line = (ms, event, session, detail = '') =>
    `${ms} INFO v2.${event} state=READY${session ? ` session=${session}` : ''}${detail ? ` ${detail}` : ''}`;

  it('stays quiet while every line carries the same session', () => {
    const watch = transportWatch();
    for (const l of [line(1, 'mode_changed', 'session_9567', 'mode=ptt'), 'T> ok', line(2, 'wifi_heartbeat', null), line(3, 'playback_completed', 'session_9567', 'mp3_exit=eof')]) {
      expect(watch.see(l)).toBe(null);
    }
    expect(watch.fault).toBe(null);
  });

  it('names the reconnect once a new session id shows (run 20260925-205858-29cd)', () => {
    const watch = transportWatch();
    watch.see(line(111860, 'playback_aborted', 'session_9567'));
    watch.see(line(111884, 'socket_closed', 'session_9567', 'clean=1'));
    expect(watch.see(line(113337, 'welcome_accepted', 'session_4627'))).toBe('transport: reconnect (session session_9567 → session_4627)');
    expect(watch.see(line(113400, 'mode_changed', 'session_9567'))).toMatch(/^transport: reconnect /);
  });

  it('does not blame the link for a reboot (a crash is the firmware\'s)', () => {
    const watch = transportWatch();
    watch.see(line(5000, 'playback_started', 'session_1'));
    watch.see('120 INFO v2.boot state=WIFI fw=0.1.0 build=dev');
    expect(watch.see(line(4000, 'welcome_accepted', 'session_2'))).toBe(null);
    expect(watch.fault).toBe(null);
  });
});
