import { pttTurn, pttTurnStart } from './steps.mjs';

// x as the MP3 reply starts, before the decoder has begun (CP-MP3-ABORT, HIL
// run 20260924-152435-04ca): the abort closed the source, begin() failed, and
// the teardown's generator->stop() freed pointers begin() never set, so the
// device asserted in heap_caps_free and rebooted. `T mp3 abort_at_begin` holds
// the decode task before begin() until the stop lands, which makes that race
// happen on every run. The device must survive it, be READY, and play the
// next turn.
export default {
  name: 'stop-at-reply-start',
  issue: '#315',
  title: 'stop x between playback_started and MP3 begin → no reset, READY, next turn plays',
  requires: [
    { event: 'turn_cancelled', feature: 'stop key x (#315)' },
    { event: 'test_mp3_hold', feature: 'MP3 abort-at-begin test hook (CP-MP3-ABORT)' },
  ],
  steps: [
    { assertState: { state: 'READY' } },
    { send: 'T mp3 abort_at_begin', expect: /^ok$/ },
    ...pttTurnStart(),
    { waitDevice: /INFO v2\.test_mp3_hold /, timeoutMs: 5000 },
    { press: 'x' },
    { waitDevice: /INFO v2\.playback_aborted /, timeoutMs: 2000 },
    { waitDevice: /INFO v2\.mp3_began .*ok=0/, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.mp3_begin_failed /, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.turn_cancelled .*source=key/, timeoutMs: 3000 },
    // The crash rebooted within milliseconds; give a reset time to show.
    { noDevice: /INFO v2\.boot |Rebooting|assert failed|Guru Meditation/, timeoutMs: 3000 },
    { assertState: { state: 'READY' }, timeoutMs: 3000 },
    // The stopped reply must leave the device able to play the next one.
    ...pttTurn(),
    { cleanSerial: true },
  ],
};
