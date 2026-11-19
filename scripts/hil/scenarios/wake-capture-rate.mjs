import { loopHealthy, pttTurn } from './steps.mjs';

// The mic delivers every 10 ms frame (CP-WAKE-MIC). Before the fix the loop
// queued one frame per 12 ms timer and read it before M5Unified's async
// record() had filled it: 82-88 frames/s of torn audio, and the wake word
// never fired. Now capture keeps both mic slots queued and takes every
// finished frame, so wake listening (wake_stats, one line per 5 s) and a
// push-to-talk turn (turn_ended) both report 97-103 frames/s.
const FPS_OK = '(9[7-9]|10[0-3])\\b';

export default {
  name: 'wake-capture-rate',
  issue: '#313',
  title: 'wake listening and a PTT turn both capture 97-103 frames/s (no gaps)',
  requires: [{ event: 'wake_stats', feature: 'gap-free capture telemetry (CP-WAKE-MIC)' }],
  steps: [
    { assertState: { state: 'READY', mode: 'ptt' } },
    { press: 'k' },
    { waitDevice: /INFO v2\.wake_listening /, timeoutMs: 5000 },
    // The first window closes 5 s after listening starts.
    { waitDevice: new RegExp(`INFO v2\\.wake_stats .*fps=${FPS_OK}`), timeoutMs: 12_000 },
    { send: 'T server control mode=ptt', expect: /^ok server$/ },
    { waitDevice: /INFO v2\.mode_changed .*mode=ptt,.*source=server/, timeoutMs: 5000 },
    { assertState: { state: 'READY', mode: 'ptt' } },
    ...pttTurn(),
    // Matches from the GO release on: the turn's capture rate.
    { waitDevice: new RegExp(`INFO v2\\.turn_ended .*fps=${FPS_OK}`), timeoutMs: 1000 },
    loopHealthy(),
  ],
};
