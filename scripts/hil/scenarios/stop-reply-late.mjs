import { pttTurnStart } from './steps.mjs';

// x while the reply is playing, after the server has already finished the
// turn (the stub AI answers in ~100 ms and the downlink is sent ahead of the
// speaker). The device stops the speaker at once and returns to READY; the
// server has nothing in flight, so it journals only v2.cancelled (stage
// ready). stop-reply covers the cancel that lands mid-turn.
export default {
  name: 'stop-reply-late',
  issue: '#315',
  title: 'stop x mid-playback, after the server finished the turn',
  requires: [{ event: 'turn_cancelled', feature: 'stop key x (#315)' }],
  steps: [
    { assertState: { state: 'READY' } },
    ...pttTurnStart(),
    { press: 'x' },
    { waitDevice: /INFO v2\.turn_cancelled state=READY .*source=key/, timeoutMs: 2000 },
    { waitServer: /"event":"v2\.cancelled"/, timeoutMs: 5000 },
    { assertState: { state: 'READY' }, timeoutMs: 3000 },
    // A stopped reply must leave the device able to take the next turn.
    { sleep: 1000 },
    { send: 'T ping', expect: /^pong / },
  ],
};
