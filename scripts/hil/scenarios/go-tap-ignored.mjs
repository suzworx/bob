// A GO tap is not a turn (2026-09-24: a tap sent turn_start, one 10 ms frame
// and turn_end, and the server failed it with INTERNAL). GO down for 100 ms,
// well under the firmware's 300 ms minimum hold (config::kGoMinHoldMs): the
// server must never see the turn, before or after the release, and the
// device is back on READY with a "Hold GO to talk" toast. No raw serial
// print may appear. Cardputer only: on the Waveshare a BOOT tap is a
// hands-free turn (boot-tap-hands-free, #1063).
export default {
  name: 'go-tap-ignored',
  issue: '#311',
  title: 'GO tapped for 100 ms → no turn on the server, device READY',
  board: 'cardputer',
  steps: [
    { assertState: { state: 'READY', mode: 'ptt' } },
    { press: 'btn down' },
    // Doubles as the 100 ms hold: no turn may open while GO is down.
    { noServer: /"event":"v2\.turn_started"/, timeoutMs: 100 },
    { press: 'btn up' },
    { waitDevice: /INFO v2\.turn_tap_ignored state=READY .*held_ms=\d+/, timeoutMs: 3000 },
    { noServer: /"event":"v2\.(turn_started|turn_ended|error)"/, timeoutMs: 1500 },
    { assertState: { state: 'READY' } },
    { cleanSerial: true },
  ],
};
