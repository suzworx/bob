import { TURN_TIMEOUT_MS, backToPtt, wakeTurnToFollowUp } from './steps.mjs';

// Follow-up listening (CP-WAKE-FOLLOWUP, owner report 2026-09-24: after "Hey
// Jarvis" and its reply, a follow-up spoken without the wake word did
// nothing). A wake turn's reply opens the 6 s follow-up window; a tone in it,
// with no wake word, opens a `mode=followup` turn that completes, and its
// reply opens the window again. Then nothing is said: the window closes on
// its own after 6 s (±1) and wake listening resumes.
export default {
  name: 'wake-followup',
  issue: '#313',
  title: 'follow-up window: a tone without the wake word opens a turn; silence closes it after 6 s',
  requires: [{ event: 'followup_opened', feature: 'follow-up listening (CP-WAKE-FOLLOWUP)' }],
  steps: [
    { assertState: { state: 'READY', mode: 'ptt' } },
    ...wakeTurnToFollowUp(),
    // No wake word: the tone alone is the next turn.
    { send: 'T audio tone 1500', expect: /^ok$/ },
    { waitDevice: /INFO v2\.followup_closed state=READY .*reason=speech/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.turn_started state=LISTEN .*mode=followup/, timeoutMs: 5000 },
    { waitServer: /"event":"v2\.turn_started"/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.turn_ended state=WAIT/, timeoutMs: 10_000 },
    { waitServer: /"event":"v2\.turn_completed"/, timeoutMs: TURN_TIMEOUT_MS },
    // Played to the end: mp3_exit=stopped is a socket that closed mid-reply
    // (run 20260925-205858-29cd, RSSI -70..-75). Its reconnect then fails
    // this step at once as `transport: reconnect` (run.mjs), instead of a 60 s
    // timeout on the window below, which rightly never reopens after one.
    { waitDevice: /INFO v2\.playback_completed .*mp3_exit=eof\b/, timeoutMs: TURN_TIMEOUT_MS },
    // The conversation continues: its reply opens the window again.
    { waitDevice: /INFO v2\.followup_opened state=READY .*window_ms=6000,guard_ms=250,since_drain_ms=\d+,/, timeoutMs: TURN_TIMEOUT_MS },
    // A fresh mark right after the window opened; nothing is said now. The
    // window must hold for 5 s and close by 7 s.
    { send: 'T state', expect: /^state=READY mode=wake / },
    { noDevice: /INFO v2\.followup_closed /, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.followup_closed state=READY .*reason=timeout/, timeoutMs: 2000 },
    { waitDevice: /INFO v2\.wake_listening /, timeoutMs: 5000 },
    { assertState: { state: 'READY', mode: 'wake' } },
    ...backToPtt(),
  ],
};
