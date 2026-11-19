// The false-accept side of wake-detect-speaker (CP-WAKE-BOB): "Hey Google"
// plays once from the PC's default speaker while the device listens for
// "Alexa" in Always awake, and no wake_detected may arrive during the
// playback or the 10 s after it. The recording is local test media, never
// committed (data/ is git-ignored): without data/wake-test/hey_google.wav on
// this PC the scenario SKIPs. Same placement as wake-detect-speaker (~1 m).
const GOOGLE = 'data/wake-test/hey_google.wav';

export default {
  name: 'wake-reject-speaker',
  issue: '#313',
  title: '"Hey Google" from the PC speaker does not wake the device (10 s)',
  requires: [{ event: 'wake_word_changed', feature: 'wake word switch on w (CP-WAKE-BOB)' }],
  requiresFiles: [GOOGLE],
  steps: [
    { assertState: { state: 'READY', mode: 'ptt' } },
    { press: 'k' },
    { waitDevice: /INFO v2\.wake_listening .*word=alexa,.*arena_used=\d+/, timeoutMs: 5000 },
    // Past the model's ~1 s start-up cooldown, so a false accept could show.
    { sleep: 1500 },
    { playAudio: GOOGLE },
    // The window starts at the playback (playAudio marks), and lasts 10 s after it.
    { noDevice: /INFO v2\.wake_detected /, timeoutMs: 10_000 },
    { assertState: { state: 'READY', mode: 'wake' } },
    { send: 'T server control mode=ptt', expect: /^ok server$/ },
    { waitDevice: /INFO v2\.mode_changed .*mode=ptt,.*source=server/, timeoutMs: 5000 },
    { assertState: { state: 'READY', mode: 'ptt' } },
  ],
};
