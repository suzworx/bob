import { loopHealthy, pttTurn } from './steps.mjs';

// Hold GO with a generated tone as the mic, release, the server runs the stub
// pipeline, and the device plays the reply to the end. Every serial line of
// the turn is a journal or console line: no raw print (2026-09-24: a
// patched library's `[BOB-DIAG] readCb …` lines flooded the log).
export default {
  name: 'ptt-turn',
  issue: '#baseline',
  title: 'push-to-talk turn with an injected tone → thinking → playback_completed',
  steps: [
    { assertState: { state: 'READY' } },
    ...pttTurn(),
    { waitServer: /"event":"v2\.device_log".*"turn_id":"turn_[0-9]+_v2".*"device_event":"(?:turn_started|turn_ended|playback_started)"/, since: 'run', timeoutMs: 5000 },
    loopHealthy(),
    { cleanSerial: true },
  ],
};
