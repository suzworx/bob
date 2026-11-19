import { journalMatch } from '../journal-match.mjs';
import { pttCapture, pttTurn } from './steps.mjs';

// x while the SERVER is still working on the turn: the device stops at once
// (turn_cancelled, source=key, back to READY) and the server cancels the turn
// in flight (v2.turn_cancelled). The stub AI answers in ~100 ms, so the
// harness holds this turn in its agent stage (`slow_turn`) until the stop has
// landed. The stub agent itself ignores the abort, so the server notices at
// its next check, the TTS stage: expect stage=tts (agent with a real model).
// stop-reply-late covers a stop after the server has already finished.
//
// The hold sits on the agent stage's history read, which only happens when
// the device has an active conversation. new-conversation just cleared it, so
// one ordinary turn comes first (run 20260923-230913-b440 held the post-stream
// persist instead, after the reply had gone out).
export default {
  name: 'stop-reply',
  issue: '#315',
  title: 'stop x mid-turn: device READY at once, server cancels the turn in flight',
  requires: [{ event: 'turn_cancelled', feature: 'stop key x (#315)' }],
  steps: [
    { assertState: { state: 'READY' } },
    ...pttTurn(),
    { send: 'T server slow_turn 8000', expect: /^ok server$/ },
    { waitServer: journalMatch({ event: 'v2.hil_command', command: 'slow_turn', outcome: 'armed' }), timeoutMs: 5000 },
    ...pttCapture(),
    { waitServer: /"event":"v2\.hil_slow_turn_holding"/, timeoutMs: 15_000 },
    { assertState: { state: 'WAIT' } },
    { press: 'x' },
    { waitDevice: /INFO v2\.turn_cancelled state=READY .*source=key/, timeoutMs: 2000 },
    { waitServer: /"event":"v2\.cancelled".*"stage":"responding"/, timeoutMs: 5000 },
    { assertState: { state: 'READY' }, timeoutMs: 3000 },
    // The hold ends and the server stops the turn it was still running; the
    // turn's reply_text only reaches the device after its stop, so it is
    // ignored. (down_frames on the device's turn_cancelled is not per turn:
    // it keeps the previous reply's count when no playback started.)
    { waitServer: /"event":"v2\.turn_cancelled".*"stage":"(agent|tts)"/, timeoutMs: 15_000 },
    { waitDevice: /INFO v2\.reply_text_ignored state=READY .*reason=cancelled_turn/, timeoutMs: 5000 },
    // Late frames for the stopped turn must not move the device.
    { sleep: 1000 },
    { assertState: { state: 'READY' } },
    { send: 'T ping', expect: /^pong / },
  ],
};
