import { REPLY_PLAYED, TURN_TIMEOUT_MS, backToPtt } from './steps.mjs';

// A long spoken sentence is not cut off (#392, owner 2026-09-24: "after hey
// Jarvis it finishes before I am done saying the sentence"; wake turns ended
// ~2.5 s in). A wake turn (`T wake fire`, no wake phrase needed) hears
// data/wake-test/long_sentence.wav from the PC speaker: a sentence of 5 s or
// more with pauses. The VAD must end the turn on the silence after it
// (end_reason=silence) with speech_ms >= 5000. The recording is local test
// media, never committed; without it this scenario SKIPs. Put the device
// within ~1 m of the speaker.
const WAV = 'data/wake-test/long_sentence.wav';

export default {
  name: 'turn-long-sentence',
  issue: '#392',
  title: 'a 5 s+ sentence with pauses ends on silence, not mid-sentence (speech_ms >= 5000)',
  requires: [{ event: 'followup_opened', feature: 'follow-up listening and end-of-turn tuning (#392)' }],
  requiresFiles: [WAV],
  steps: [
    { assertState: { state: 'READY', mode: 'ptt' } },
    { press: 'k' },
    { waitDevice: /INFO v2\.wake_listening /, timeoutMs: 5000 },
    { send: 'T wake fire', expect: /^ok$/ },
    { waitDevice: /INFO v2\.turn_started state=LISTEN .*mode=wake/, timeoutMs: 5000 },
    { playAudio: WAV, timeoutMs: 30_000 },
    { waitDevice: /INFO v2\.turn_ended state=WAIT .*end_reason=silence,speech_ms=([5-9]\d{3}|[1-9]\d{4,})\b/, timeoutMs: 5000 },
    { waitDevice: REPLY_PLAYED, timeoutMs: TURN_TIMEOUT_MS },
    // Its reply opens the follow-up window; a key closes it.
    { waitDevice: /INFO v2\.followup_opened /, timeoutMs: TURN_TIMEOUT_MS },
    { press: 'h' },
    { waitDevice: /INFO v2\.followup_closed .*reason=key/, timeoutMs: 2000 },
    { waitDevice: /INFO v2\.wake_listening /, timeoutMs: 5000 },
    ...backToPtt(),
  ],
};
