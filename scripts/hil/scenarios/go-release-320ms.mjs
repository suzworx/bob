import { loopHealthy, TURN_TIMEOUT_MS } from './steps.mjs';

// GO released just after the 300 ms tap guard (PR #391 review): turn_start
// has only just gone out and everything captured before it still waits in
// the uplink queue (uplink_queue.h). The device must keep sending from the
// queue, paced, and send turn_end only after the last frame: the server gets
// every frame and no sequence gap, the loop never stalls, and no uplink frame
// is dropped. Releasing on the turn_started line lands the release ~320 ms
// after the press (the device journals it at 300 ms; serial adds a few ms).
// The frame bound is 10-59: the queued frames plus the few captured before
// the release (HIL run 20260924-112645-f46a: 15 frames on both sides).
// baseline() has reset loop_max and tx_drop.
export default {
  name: 'go-release-320ms',
  issue: '#311',
  title: 'GO released ~320 ms after the press: queued frames drain paced, then turn_end',
  board: 'cardputer', // on the round board a short BOOT press is a hands-free tap (boot-tap-hands-free covers it)
  steps: [
    { send: 'T audio tone 1000', expect: /^ok$/ },
    { press: 'btn down' },
    { waitDevice: /INFO v2\.turn_started state=LISTEN .*held_frames=\d+/, timeoutMs: 3000 },
    { press: 'btn up' },
    { waitDevice: /INFO v2\.turn_ended state=WAIT .*frames=\d+/, timeoutMs: 3000 },
    { waitServer: /"event":"v2\.turn_ended".*"frames":([1-5]\d)\b/, timeoutMs: 5000 },
    { noServer: /"code":"SEQUENCE_GAP"/, timeoutMs: 2000 },
    { assertState: { state: 'READY' }, timeoutMs: TURN_TIMEOUT_MS },
    loopHealthy(),
    { cleanSerial: true },
  ],
};
