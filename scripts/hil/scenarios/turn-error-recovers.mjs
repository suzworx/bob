import { pttCapture, TURN_TIMEOUT_MS } from './steps.mjs';

// A turn the server fails must not strand the device (2026-09-24: one
// error {code:"INTERNAL"} left it in ERROR for minutes, where only GO
// worked). The harness fails the next turn the way a real provider failure
// does (v2.turn_failed, then INTERNAL); within 3 s the device must be READY,
// with a toast, and its keys must work again: k cycles the mode through
// wake and announce_only and back to ptt. No raw serial print may appear.
export default {
  name: 'turn-error-recovers',
  issue: '#311',
  title: 'server fails the turn (INTERNAL) → READY within 3 s, k still works',
  steps: [
    { assertState: { state: 'READY', mode: 'ptt' } },
    { send: 'T server fail_next_turn INTERNAL', expect: /^ok server$/ },
    { waitServer: /"event":"v2\.hil_command".*"command":"fail_next_turn".*"outcome":"armed"/, timeoutMs: 5000 },
    ...pttCapture({ toneMs: 1000 }),
    { waitServer: /"event":"v2\.turn_failed".*"error_name":"HilInjectedTurnFailure"/, timeoutMs: TURN_TIMEOUT_MS },
    { waitServer: /"event":"v2\.error".*"code":"INTERNAL"/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.server_error state=READY .*code=INTERNAL/, timeoutMs: 3000 },
    { assertState: { state: 'READY' }, timeoutMs: 3000 },
    { saveState: 'recovered' },
    { press: 'k' },
    { waitDevice: /INFO v2\.mode_changed .*mode=wake,wake_fallback=[01],source=key/, timeoutMs: 3000 },
    { assertState: { state: 'READY', mode: 'wake' } },
    { press: 'k' },
    { waitDevice: /INFO v2\.mode_changed .*mode=announce_only/, timeoutMs: 3000 },
    { press: 'k' },
    { waitDevice: /INFO v2\.mode_changed .*mode=ptt/, timeoutMs: 3000 },
    { assertState: { state: 'READY', mode: { same: 'recovered' } } },
    { cleanSerial: true },
  ],
};
