// P0 #1063: the Waveshare played every reply its whole length in silence while every digital counter
// (frames, decode, playback_completed) looked healthy, and the microphone still worked. `T spk test`
// plays a 1 kHz tone through the ES8311 + amplifier and hears it back through the onboard ES7210 on
// the same full-duplex I2S port (include/speaker_test.h): pass only when the tone stands
// kMinRiseDb (12 dB) above the quiet phase. Waveshare runs only (run.mjs): the Cardputer has no
// loopback path. Silence can never pass HIL again.
export default {
  name: 'speaker-loopback',
  issue: '#1063',
  title: 'T spk test: the speaker is heard by the mic (tone 12 dB over quiet), the DAC path reads back',
  requires: [{ event: 'spk_test', feature: 'speaker loopback self-test (#1063)' }],
  steps: [
    { assertState: { state: 'READY', mode: 'ptt' }, timeoutMs: 10_000 },
    { send: 'T spk test', expect: /^spk_test pass=1,stage=ok,.*\bcodec_ok=1\b/, timeoutMs: 10_000 },
    { waitDevice: /INFO v2\.spk_test .*\bpass=1\b/, since: 'run' },
    // The speaker re-installs for the next tone: the device is still READY afterwards.
    { assertState: { state: 'READY' }, timeoutMs: 5000 },
  ],
};
