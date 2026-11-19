import { TURN_TIMEOUT_MS } from './steps.mjs';

// End to end through the air (CP-WAKE-MIC, CP-WAKE-BOB): recordings play
// from the PC's default speaker, up to three times each, while the device
// listens in Always awake. "Alexa" must wake the default model; then `w`
// switches to the "Hey Bob" model, which is scored rather than required to
// fire: the backup model was trained on Piper voices and the local clip is a
// Windows SAPI voice, which reached max_p 167/248/222 against its cutoff 251
// (run 20260924-202048-b051), so tuning to that clip would be overfitting. It
// passes on a detection or on a wake_stats window with max_p >= 200 (the model
// clearly answers the phrase); the evidence line says which. Each
// wake_listening line must carry the model it loaded and the arena it planned
// (arena_used=, the measured tensor arena need). The recordings are local test
// media, never committed (data/ is git-ignored): without them on this PC the
// scenario SKIPs. Put the device within ~1 m of the speaker, at a normal
// listening volume.
//
// A detection opens a hands-free turn: the VAD ends it (wake_rejected when
// only the tail of the phrase was heard, else the stub reply plays) and the
// device returns to READY. The scenario switches back to Alexa (the persisted
// default the later scenarios expect) and leaves Always awake.
const ALEXA = 'data/wake-test/alexa.wav';
const BOB = 'data/wake-test/hey_bob.wav';

// Detects `wav` in the listening model, then waits out the turn it opens.
function detects(wav, word) {
  return [
    // The model ignores its first ~1 s (cooldown while the frontend's noise
    // estimate settles).
    { sleep: 1500 },
    { playAudio: wav, repeat: 3, until: /INFO v2\.wake_detected /, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.(wake_rejected|playback_completed) /, timeoutMs: TURN_TIMEOUT_MS },
    // After a played reply the follow-up window opens (READY, but a key there
    // only closes the window: run 20260924-195519-54b4's `w` did that). Wait
    // until the model listens again: at once after wake_rejected, or when the
    // window times out (6 s).
    { waitDevice: new RegExp(`INFO v2\\.wake_listening .*word=${word},.*arena_used=\\d+`), timeoutMs: 15_000 },
    { assertState: { state: 'READY', mode: 'wake' }, timeoutMs: 10_000 },
  ];
}

// A detection of `wav`, or a wake_stats window whose largest model output
// reached 200 of 255 (the model responds to the phrase without firing). Only
// a detection opens a turn, so only then is it waited out (onlyIf).
const DETECTED = /INFO v2\.wake_detected /;
function scores(wav, word) {
  return [
    { sleep: 1500 },
    // wake_stats closes a window every 5 s: 6 s after each play catches it.
    { playAudio: wav, repeat: 3, until: /INFO v2\.(wake_detected |wake_stats .*max_p=2\d\d\b)/, timeoutMs: 6000 },
    // A high wake_stats window can land just before the detection it leads to.
    { sleep: 1500 },
    { waitDevice: /INFO v2\.(wake_rejected|playback_completed) /, onlyIf: DETECTED, timeoutMs: TURN_TIMEOUT_MS },
    { waitDevice: new RegExp(`INFO v2\\.wake_listening .*word=${word},.*arena_used=\\d+`), onlyIf: DETECTED, timeoutMs: 15_000 },
    { assertState: { state: 'READY', mode: 'wake' }, timeoutMs: 10_000 },
  ];
}

export default {
  name: 'wake-detect-speaker',
  issue: '#313',
  title: '"Alexa" from the PC speaker wakes the device; "Hey Bob" after w is detected or scores max_p >= 200 (>= 1 of 3 plays each)',
  requires: [
    { event: 'wake_stats', feature: 'gap-free capture telemetry (CP-WAKE-MIC)' },
    { event: 'wake_word_changed', feature: 'wake word switch on w (CP-WAKE-BOB)' },
  ],
  requiresFiles: [ALEXA, BOB],
  steps: [
    { assertState: { state: 'READY', mode: 'ptt' } },
    { press: 'k' },
    { waitDevice: /INFO v2\.wake_listening .*word=alexa,.*arena_used=\d+/, timeoutMs: 5000 },
    ...detects(ALEXA, 'alexa'),
    { press: 'w' },
    { waitDevice: /INFO v2\.wake_word_changed .*word=bob,source=key/, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.wake_listening .*word=bob,.*arena_used=\d+/, timeoutMs: 5000 },
    ...scores(BOB, 'bob'),
    // Bob builds (BOB_WAKE_MODEL_BOB) toggle bob <-> bob on w, so the second
    // w lands on bob there, not alexa.
    { press: 'w' },
    { waitDevice: /INFO v2\.wake_word_changed .*word=(alexa|bob),source=key/, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.wake_listening .*word=(alexa|bob),.*arena_used=\d+/, timeoutMs: 5000 },
    // Restore alexa explicitly (a no-op on a non-Bob build, where w already did it).
    { send: 'T wake word alexa', expect: /^ok$/ },
    { send: 'T server control mode=ptt', expect: /^ok server$/ },
    { waitDevice: /INFO v2\.mode_changed .*mode=ptt,.*source=server/, timeoutMs: 5000 },
    { assertState: { state: 'READY', mode: 'ptt' } },
  ],
};
