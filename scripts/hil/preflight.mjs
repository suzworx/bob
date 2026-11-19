/*
 * preflight.mjs — checks the rig itself before and while the scenarios run.
 *
 * WiFi: after boot-ready the device's `T state` carries `rssi=<dBm>`. A weak
 * link fails scenarios for reasons that are not the firmware's, so below
 * MIN_RSSI_DBM the run stops with an environment result instead of a column
 * of scenario FAILs. Healthy runs sit at -55..-63; failing runs at -70..-80
 * (20260924-172308-5a8c: -74..-80; 20260925-205858-29cd passed the old -70
 * floor at exactly -70, sat at -70..-75, and the socket closed mid-reply).
 *
 * Transport: a device that reconnects mid-scenario (its journal lines carry a
 * new session id) lost the socket, so whatever the scenario then fails on is
 * the link, not the product (docs/investigations/hil-wake-followup-2026-09-25.md).
 */

import { parseFields } from './engine.mjs';

export const MIN_RSSI_DBM = -65;

/** From a `T state` reply: { ok, rssi, reason? , note? }. */
export function rssiVerdict(stateReply) {
  if (!stateReply) return { ok: true, rssi: null, note: 'no T state reply; WiFi not checked' };
  const { rssi } = parseFields(stateReply);
  if (typeof rssi !== 'number') return { ok: true, rssi: null, note: 'firmware reports no rssi= in T state; WiFi not checked' };
  if (rssi === 0) {
    // WiFi.RSSI() is 0 when the station is not associated.
    return { ok: false, rssi, reason: 'environment: WiFi not associated (RSSI 0), check the access point' };
  }
  if (rssi < MIN_RSSI_DBM) {
    return {
      ok: false,
      rssi,
      reason: `environment: WiFi RSSI ${rssi} dBm is below the ${MIN_RSSI_DBM} dBm floor; move the device or the access point until \`T state\` shows rssi=${MIN_RSSI_DBM} or stronger`,
    };
  }
  return { ok: true, rssi };
}

const SESSION_LINE = /^\d+ INFO v2\.[a-z0-9_]+ state=[A-Z_]+ session=(\S+)/;
const BOOT_LINE = /^\d+ INFO v2\.boot /;

/** Feed it the device lines of one scenario, in order; `see` returns the
 *  fault once a line carries a session id other than the first one seen:
 *  `transport: reconnect (session a → b)`. A boot line stops the watch: a
 *  reboot is the firmware's own failure, never blamed on the link. */
export function transportWatch() {
  let session = null;
  let fault = null;
  let rebooted = false;
  return {
    get fault() {
      return fault;
    },
    see(line) {
      if (fault || rebooted) return fault;
      if (BOOT_LINE.test(line)) {
        rebooted = true;
        return null;
      }
      const id = (SESSION_LINE.exec(line) ?? [])[1];
      if (!id) return null;
      if (session !== null && id !== session) fault = `transport: reconnect (session ${session} → ${id})`;
      session ??= id;
      return fault;
    },
  };
}
