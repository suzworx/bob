import { journalMatch } from '../journal-match.mjs';
import { REPLY_PLAYED, TURN_TIMEOUT_MS, backToPtt } from './steps.mjs';

// Barge-in (#1364): while Bob plays a long reply the wake model listens
// (v2.barge_listening), his own voice must not trigger it, and "Hey Bob"
// spoken from the PC (System.Speech, volume 30: people sleep) cancels the
// reply (v2.barge_in, v2.turn_cancelled source=wake) and opens a hands-free
// turn. Waveshare only: the Cardputer's mic and speaker share GPIO 43.

/** Wake mode, one wake turn whose reply plays for `seconds`, up to playback_started. */
const wakeTurnPlaying = (seconds, ttsArgs = '') => [
  { send: `T server tts_next ${seconds}${ttsArgs}`, expect: /^ok server$/ },
  { waitServer: journalMatch({ event: 'v2.hil_command', command: 'tts_next', outcome: 'armed' }), timeoutMs: 5000 },
  { send: 'T wake fire', expect: /^ok$/ },
  { waitDevice: /INFO v2\.wake_detected /, timeoutMs: 5000 },
  { waitDevice: /INFO v2\.turn_started state=LISTEN .*mode=wake/, timeoutMs: 5000 },
  { send: 'T audio tone 1500', expect: /^ok$/ },
  { waitDevice: /INFO v2\.turn_ended state=WAIT/, timeoutMs: 10_000 },
  { waitDevice: /INFO v2\.playback_started/, timeoutMs: TURN_TIMEOUT_MS },
];

const enterWake = () => [
  { assertState: { state: 'READY', mode: 'ptt' } },
  { send: 'T wake word bob', expect: /^ok$/ }, // the HIL baseline picks alexa; the PC says "Hey Bob"
  { send: 'T aec cal', expect: /^ok delay=\d+/ }, // evidence: the measured speaker-to-mic lag (aec_cal)
  { press: 'k' },
  { waitDevice: /INFO v2\.wake_listening /, timeoutMs: 5000 },
];

export const bargeIn = {
  name: 'barge-in',
  issue: '#1364',
  title: 'Hey Bob over a playing reply cancels it (barge_in, turn_cancelled source=wake) and opens a new turn',
  board: 'waveshare',
  requires: [
    { event: 'barge_listening', feature: 'wake model on during playback (#1364)' },
    { event: 'barge_in', feature: 'barge-in (#1364)' },
  ],
  steps: [
    ...enterWake(),
    ...wakeTurnPlaying(20),
    { waitDevice: /INFO v2\.barge_listening /, timeoutMs: 5000 },
    // Bob's own sine through his speaker must not wake him.
    { noDevice: /INFO v2\.barge_in /, timeoutMs: 3000 },
    // Up to 3 tries, 2.5 s apart, until the device journals barge_in (rig.mjs speakRigCommand).
    { send: 'T rig speak 30 3 Hey Bob', expect: /^ok rig$/, timeoutMs: 30_000 },
    { waitDevice: /INFO v2\.barge_in .*stage=reply/, since: 'run', timeoutMs: 3000 },
    { waitDevice: /INFO v2\.turn_cancelled .*source=wake/, timeoutMs: 5000 },
    // The server logs v2.turn_cancelled (heard portion saved) while it still streams the reply, else v2.cancelled (a stub reply streams in well under its length).
    { waitServer: /"event":"v2.(turn_)?cancelled"/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.turn_started state=LISTEN .*mode=/, timeoutMs: 5000 },
    // Nothing more is said: the hands-free turn ends and the device is READY again.
    { assertState: { state: 'READY' }, timeoutMs: 40_000 },
    ...backToPtt(),
  ],
  finally: [
    { send: 'T server control mode=ptt', expect: /^ok server$/ },
    { waitDevice: /INFO v2\.mode_changed .*mode=ptt/, timeoutMs: 5000 },
  ],
};

// Opt-in (scenarios/index.mjs): 18 turns of ~35 s is the 10 minute talking loop. Each reply
// plays one clip, and Bob's own speaker must never trigger him: zero v2.barge_in since the run
// began. The evidence lists every barge_stats line (erle_db), whose minimum the run report quotes.
export const SOAK_TURNS = 18;
export const SOAK_CLIP = 'data/wake-test/long_sentence.wav';
export const WAKE_WORD_CLIP = 'data/wake-test/sapi-bob-bdaae7a5ff6643079615e87f828d83b6/hey_bob.wav';

const soakScenario = ({ name, clip, title }) => ({
  name,
  issue: '#1364',
  title,
  board: 'waveshare',
  optIn: true,
  requires: [
    { event: 'barge_listening', feature: 'wake model on during playback (#1364)' },
    { event: 'barge_stats', feature: 'echo canceller stats (#1364)' },
  ],
  requiresFiles: [clip],
  steps: [
    ...enterWake(),
    ...Array.from({ length: SOAK_TURNS }, () => [
      ...wakeTurnPlaying(20, ` ${clip}`),
      { waitDevice: /INFO v2\.barge_listening /, timeoutMs: 5000 },
      { waitDevice: REPLY_PLAYED, timeoutMs: TURN_TIMEOUT_MS },
      { waitDevice: /INFO v2\.barge_stats .*erle_db=/, timeoutMs: 5000 },
      { waitDevice: /INFO v2\.followup_closed /, timeoutMs: 15_000 },
      { waitDevice: /INFO v2\.wake_listening /, timeoutMs: 5000 }, // the model is back before the next `T wake fire`
    ]).flat(),
    { noDevice: /INFO v2\.barge_in /, since: 'run', timeoutMs: 500 },
    { assertState: { state: 'READY', mode: 'wake' } },
    ...backToPtt(),
  ],
  finally: bargeIn.finally,
});

// Ordinary speech (commit f34df6b6 moved the soak off the wake word).
export const bargeInSoak = soakScenario({
  name: 'barge-in-soak',
  clip: SOAK_CLIP,
  title: `${SOAK_TURNS} spoken replies (~10 min): Bob's own voice never triggers barge-in`,
});

// The replies say "hey bob" (SAPI, the wake word itself): Bob's own speaker must never wake him.
export const bargeInSoakWakeWord = soakScenario({
  name: 'barge-in-soak-wake-word',
  clip: WAKE_WORD_CLIP,
  title: `${SOAK_TURNS} replies that say "hey bob" (~10 min): Bob's own voice never triggers barge-in`,
});
