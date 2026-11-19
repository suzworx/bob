import { loopHealthy, REPLY_CANCELLED_BEFORE_START } from './steps.mjs';

export default {
  name: 'announce-voice',
  issue: '#baseline',
  title: 'reminder prelude keeps MP3 complete and cancellation responsive',
  steps: [
    { send: 'T server announce voice', expect: /^ok server$/ },
    { waitDevice: /INFO v2\.announce_shown .*kind=reminder,ring=0/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.announce_playback_started /, timeoutMs: 10000 },
    { noDevice: /INFO v2\.mp3_began /, timeoutMs: 500 },
    { waitDevice: /INFO v2\.mp3_began .*ok=1/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.playback_completed .*overflow=0,.*mp3_exit=eof,.*playraw_drops=0,/, timeoutMs: 15000 },
    { press: 'enter' },
    { assertState: { state: 'READY' }, timeoutMs: 5000 },
    { send: 'T server announce voice', expect: /^ok server$/ },
    { waitDevice: /INFO v2\.announce_playback_started /, timeoutMs: 10000 },
    { press: 'enter' },
    { waitDevice: /INFO v2\.playback_aborted /, timeoutMs: 1000 },
    { waitDevice: REPLY_CANCELLED_BEFORE_START, timeoutMs: 1000 },
    { waitDevice: /INFO v2\.announce_closed .*source=key/, timeoutMs: 1000 },
    { noDevice: /INFO v2\.(mp3_began|mp3_task_abandoned) /, timeoutMs: 500 },
    { assertState: { state: 'READY' }, timeoutMs: 1000 },
    loopHealthy(),
  ],
};
