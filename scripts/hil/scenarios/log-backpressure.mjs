import { REPLY_PLAYED, TURN_TIMEOUT_MS } from './steps.mjs';

// Logging must never stall the device (HIL run 20260924-045753-ec6f: a
// 1230 ms main-loop stall mid-capture sent 74 frames instead of ~150). The
// bridge closes the serial port for 2.5 s while GO is held, so the host stops
// reading while the device journals an audio_up line per frame. The capture
// must not notice: the device captures every 10 ms frame (~100 frames/s since
// CP-WAKE-MIC; 82-88 before, when a ~1.7 s hold sent 146-151), so a GO held
// just over 3 s sends ~300 frames when nothing stalls; the 1230 ms stall lost
// ~100 of them. The server must receive >= 230, and the turn must complete.
// The `T state` readback after it shows log_drop (lines dropped instead of
// blocking) and loop_max.
export default {
  name: 'log-backpressure',
  issue: '#340',
  title: 'host stops reading mid-capture: no stall, every frame still sent',
  requires: [{ event: 'log_dropped', feature: 'non-blocking journal (#340)' }],
  steps: [
    { assertState: { state: 'READY' } },
    { send: 'T audio tone 3000', expect: /^ok$/ },
    { press: 'btn down' },
    { waitDevice: /INFO v2\.turn_started state=LISTEN/, timeoutMs: 5000 },
    { send: 'T bridge pause 2500', expect: /^ok bridge$/ },
    // The port reopens after 2.5 s; GO is released once it is back.
    { sleep: 3000 },
    { press: 'btn up' },
    { waitServer: /"event":"v2\.turn_ended".*"frames":(2[3-9]\d|[3-9]\d\d)\b/, timeoutMs: 5000 },
    { waitServer: /"event":"v2\.turn_completed"/, timeoutMs: TURN_TIMEOUT_MS },
    { waitDevice: REPLY_PLAYED, timeoutMs: TURN_TIMEOUT_MS },
    { assertState: { state: 'READY' }, timeoutMs: 5000 },
    // tx_drop: uplink frames the socket was too busy to take (none expected).
    { send: 'T state', expect: /log_drop=\d+ loop_max=\d+ tx_drop=0$/ },
  ],
};
