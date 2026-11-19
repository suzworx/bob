import { loopHealthy, pttCapture, TURN_TIMEOUT_MS } from './steps.mjs';

// turn-error-recovers in Always awake (PR #391 review): after a failed turn
// the device used to block its loop up to 300 ms waiting for the error tone
// before the wake mic re-opened (shared GPIO 43). It now waits for the tone
// on later loops instead, so the slowest loop across the capture, the error
// and the wake re-arm stays under 300 ms. `T state reset` just before the
// turn keeps the wake model's start out of loop_max. Wake word or fallback,
// both pass; the scenario ends back in push-to-talk.
export default {
  name: 'turn-error-recovers-wake',
  issue: '#311',
  title: 'server fails a turn in Always awake → READY, no loop over 300 ms',
  requires: [{ event: 'wake_listening', feature: 'Always awake mode (#313)' }],
  steps: [
    { send: 'T server control mode=wake', expect: /^ok server$/ },
    { waitDevice: /INFO v2\.mode_changed .*mode=wake,.*source=server/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.(wake_listening|wake_unavailable) /, timeoutMs: 5000 },
    { send: 'T server fail_next_turn INTERNAL', expect: /^ok server$/ },
    { waitServer: /"event":"v2\.hil_command".*"command":"fail_next_turn".*"outcome":"armed"/, timeoutMs: 5000 },
    { send: 'T state reset', expect: /^ok$/ },
    ...pttCapture({ toneMs: 1000 }),
    { waitServer: /"event":"v2\.turn_failed".*"error_name":"HilInjectedTurnFailure"/, timeoutMs: TURN_TIMEOUT_MS },
    { waitDevice: /INFO v2\.server_error state=READY .*code=INTERNAL/, timeoutMs: 3000 },
    { assertState: { state: 'READY', mode: 'wake' }, timeoutMs: 3000 },
    // Give the error tone time to end and the wake mic time to re-open.
    { sleep: 1000 },
    loopHealthy(),
    { send: 'T server control mode=ptt', expect: /^ok server$/ },
    { waitDevice: /INFO v2\.mode_changed .*mode=ptt,.*source=server/, timeoutMs: 5000 },
    { assertState: { state: 'READY', mode: 'ptt' } },
    { cleanSerial: true },
  ],
};
