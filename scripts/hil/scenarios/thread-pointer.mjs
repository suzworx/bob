import { journalMatch } from '../journal-match.mjs';
import { pttCapture, pttTurn, REPLY_PLAYED, TURN_TIMEOUT_MS } from './steps.mjs';

// #565: the Cardputer points at a space thread. The firmware only sees a
// opaque conversation id, so this proves on the real device that the
// id survives the push and the picker, that a turn saves into the thread, and
// that an archived thread falls back to a private General conversation. The
// harness (`T server thread …`) seeds a space and thread and points the device
// through the real PUT /api/devices/active-conversation route, and archives it.
//
// An archive has two paths (run 20260928-213237-c16a): BETWEEN turns the next
// turn_start finds the thread archived and clears the pointer at once
// (v2.active_changed surface=device before the turn ends, no device_thread_lost);
// DURING a turn (held in its agent stage by slow_turn) only the persist notices,
// journals v2.device_thread_lost and saves into a new General conversation.
const TURN_COMPLETED = journalMatch({ event: 'v2.turn_completed' });
const verifyGeneral = () => [
  { send: 'T server thread verify-general', expect: /^ok server$/ },
  { waitServer: journalMatch({ event: 'v2.hil_command', command: 'thread', outcome: 'general_verified' }), timeoutMs: 5000 },
];

export default {
  name: 'thread-pointer',
  issue: '#565',
  title: 'thread pointer: push → c picks the thread → turn saved there → archive between / during a turn falls back',
  requires: [
    { event: 'active_conversation_applied', feature: 'active conversation push (#492)' },
    { event: 'conversations_received', feature: 'conversation picker on c' },
  ],
  steps: [
    { assertState: { state: 'READY' } },
    // "Use on Cardputer": the pointer moves on the server, the device applies the push.
    { send: 'T server thread seed', expect: /^ok server$/ },
    { waitServer: /"event":"v2\.hil_command".*"command":"thread".*"outcome":"pointed"/, timeoutMs: 10_000 },
    { waitDevice: /INFO v2\.active_conversation_applied state=READY/, timeoutMs: 10_000 },
    // The picker lists the active space's threads first: Enter picks the seeded one.
    { press: 'c' },
    { waitDevice: /INFO v2\.picker_opened/, timeoutMs: 3000 },
    { waitServer: /"event":"v2\.conversation_listed".*"count":[1-9]/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.conversations_received .*count=[1-9]/, timeoutMs: 5000 },
    { press: 'enter' },
    { waitDevice: /INFO v2\.conversation_select_sent/, timeoutMs: 3000 },
    { waitServer: journalMatch({ event: 'v2.conversation_selected' }), timeoutMs: 6000 },
    { waitDevice: /INFO v2\.conversation_selected /, timeoutMs: 6000 },
    { send: 'T server thread verify-selected', expect: /^ok server$/ },
    { waitServer: journalMatch({ event: 'v2.hil_command', command: 'thread', outcome: 'selected_seed' }), timeoutMs: 5000 },
    { assertState: { state: 'READY' }, timeoutMs: 5000 },
    // A turn in the thread is saved there.
    ...pttTurn(),
    { waitServer: /"event":"v2\.device_thread_saved".*"outcome":"completed"/, timeoutMs: 10_000 },

    // 5a. Archived between turns: cleared at the next turn_start.
    { send: 'T server thread archive', expect: /^ok server$/ },
    { waitServer: /"event":"v2\.hil_command".*"command":"thread".*"outcome":"archived"/, timeoutMs: 10_000 },
    { send: 'T audio tone 1500', expect: /^ok$/ },
    { press: 'btn down' },
    { waitDevice: /INFO v2\.turn_started state=LISTEN/, timeoutMs: 5000 },
    { waitServer: /"event":"v2\.turn_started"/, timeoutMs: 5000 },
    { waitServer: journalMatch({ event: 'v2.active_changed', surface: 'device' }), timeoutMs: 5000 },
    { sleep: 1700 },
    { press: 'btn up' },
    { waitDevice: /INFO v2\.turn_ended state=WAIT/, timeoutMs: 5000 },
    { waitServer: TURN_COMPLETED, timeoutMs: TURN_TIMEOUT_MS, note: "archive fallback completed" },
    { waitDevice: REPLY_PLAYED, timeoutMs: TURN_TIMEOUT_MS },
    { noServer: /"event":"v2\.device_thread_(lost|saved)"/, timeoutMs: 2000 },
    ...verifyGeneral(),
    { assertState: { state: 'READY' }, timeoutMs: 5000 },

    // 5b. Archived while a turn is in flight: the persist falls back.
    { send: 'T server thread seed', expect: /^ok server$/ },
    { waitServer: /"event":"v2\.hil_command".*"command":"thread".*"outcome":"pointed"/, timeoutMs: 10_000 },
    { waitDevice: /INFO v2\.active_conversation_applied state=READY/, timeoutMs: 10_000 },
    { send: 'T server slow_turn 8000', expect: /^ok server$/ },
    { waitServer: journalMatch({ event: 'v2.hil_command', command: 'slow_turn', outcome: 'armed' }), timeoutMs: 5000 },
    ...pttCapture(),
    { waitServer: /"event":"v2\.hil_slow_turn_holding"/, timeoutMs: 15_000 },
    { send: 'T server thread archive', expect: /^ok server$/ },
    { waitServer: /"event":"v2\.hil_command".*"command":"thread".*"outcome":"archived"/, timeoutMs: 10_000 },
    { waitServer: /"event":"v2\.device_thread_lost"/, timeoutMs: TURN_TIMEOUT_MS },
    { waitServer: TURN_COMPLETED, timeoutMs: TURN_TIMEOUT_MS, note: "archive fallback completed" },
    { noServer: /"event":"v2\.device_thread_saved"/, timeoutMs: 1000 },
    { waitDevice: REPLY_PLAYED, timeoutMs: TURN_TIMEOUT_MS },
    ...verifyGeneral(),
    { assertState: { state: 'READY' }, timeoutMs: 5000 },
  ],
};
