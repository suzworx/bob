import { journalMatch } from '../journal-match.mjs';
import { pttCapture, pttTurn, REPLY_PLAYED, TURN_TIMEOUT_MS } from './steps.mjs';

// The Waveshare round screen's touch model (owner UX audit 2026-10-20, #1063; the approved demo,
// docs/waveshare/device-ux-prototype.html): a tap is GO, a tap on Bob giggles and opens the info view
// (never the mic), swipe up / down on READY is the volume, the chips show only after a long press or a
// swipe, BOOT tapped is a hands-free turn. Fingers are the hil console's `T touch x y [ms]` and
// `T swipe <dir>` (a path fed to the touch poll instead of the panel). The firmware journals each
// gesture's meaning as `touch gesture=…,action=…`, never a coordinate.
//
// Points on the 360 px glass: OFF_BOB is inside the circle and outside Bob's body box (x 116-244,
// y 77-277 at full size), ON_BOB is his belly.
const OFF_BOB = 'T touch 60 200';
const ON_BOB = 'T touch 180 180';

const TOUCH_FEATURE = { event: 'touch', feature: 'round-screen touch intents (#1063)' };

export const touchTapTalk = {
  name: 'touch-tap-talk',
  issue: '#1063',
  title: 'tap off Bob: a hands-free turn ends on 700 ms of silence, the reply shows while it plays',
  board: 'waveshare',
  requires: [TOUCH_FEATURE, { event: 'reply_shown_live', feature: 'reply words while speaking (#1063)' }],
  steps: [
    { assertState: { state: 'READY', mode: 'ptt' } },
    { send: OFF_BOB, expect: /^ok$/ },
    { waitDevice: /INFO v2\.touch state=READY (?:session=\S+ )?gesture=tap,action=go/, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.turn_started state=LISTEN /, timeoutMs: 5000 },
    { waitServer: /"event":"v2\.turn_started"/, timeoutMs: 5000 },
    // The tone is the speech; the VAD ends the turn 1000 ms after it (kVadQuickEndSilenceMs).
    { send: 'T audio tone 1500', expect: /^ok$/ },
    { waitDevice: /INFO v2\.turn_ended state=WAIT .*end_reason=silence/, timeoutMs: 10_000 },
    { waitDevice: /INFO v2\.reply_shown_live state=WAIT/, timeoutMs: TURN_TIMEOUT_MS },
    { waitDevice: REPLY_PLAYED, timeoutMs: TURN_TIMEOUT_MS },
    { waitDevice: /INFO v2\.reply_card_shown state=READY/, timeoutMs: 5000 },
    { assertState: { state: 'READY' }, timeoutMs: 5000 },
  ],
};

export const touchBobInfo = {
  name: 'touch-bob-info',
  issue: '#1063',
  title: 'tap Bob: a giggle and the info view, no mic; it stays past 8 s until a tap closes it',
  board: 'waveshare',
  requires: [TOUCH_FEATURE, { event: 'info_opened', feature: 'persistent info view (#1063)' }],
  steps: [
    // The scenario before ends on the reply card (Bob small at the top): close it, Bob is big again.
    { press: '`' },
    { sleep: 1200 },
    { assertState: { state: 'READY', mode: 'ptt' } },
    { send: ON_BOB, expect: /^ok$/ },
    { waitDevice: /INFO v2\.touch state=READY (?:session=\S+ )?gesture=tap,action=bob_info/, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.info_opened state=READY (?:session=\S+ )?source=bob/, timeoutMs: 3000 },
    // The old view closed itself after 8 s and the tap also opened the mic (a listen earcon and a
    // "Hold GO to talk" toast): neither may happen now.
    { noDevice: /INFO v2\.(turn_started|turn_tap_ignored|info_closed|earcon) /, timeoutMs: 9000 },
    { assertState: { state: 'READY' } },
    { send: OFF_BOB, expect: /^ok$/ },
    { waitDevice: /INFO v2\.info_closed state=READY (?:session=\S+ )?source=tap/, timeoutMs: 3000 },
    // The closing tap only closes.
    { noDevice: /INFO v2\.turn_started /, timeoutMs: 1500 },
    { assertState: { state: 'READY' } },
  ],
};

export const touchSwipeVolume = {
  name: 'touch-swipe-volume',
  issue: '#1063',
  title: 'swipe up / down on READY steps the volume, with state readback',
  board: 'waveshare',
  requires: [TOUCH_FEATURE, { event: 'volume_changed', feature: 'volume keys (#314)' }],
  steps: [
    { press: '`' }, // closes a reply card an earlier scenario left (the swipe would page it, not change the volume)
    { sleep: 1200 },
    { assertState: { state: 'READY' } },
    { saveState: 'before' },
    { send: 'T swipe up', expect: /^ok$/ },
    { waitDevice: /INFO v2\.touch state=READY (?:session=\S+ )?gesture=swipe_up,action=volume/, timeoutMs: 3000 },
    { assertState: { vol: { delta: 1, of: 'before' }, muted: 0 }, timeoutMs: 3000 },
    { saveState: 'raised' },
    { send: 'T swipe down', expect: /^ok$/ },
    { waitDevice: /INFO v2\.touch state=READY (?:session=\S+ )?gesture=swipe_down,action=volume/, timeoutMs: 3000 },
    { assertState: { vol: { delta: -1, of: 'raised' } }, timeoutMs: 3000 },
    { noDevice: /INFO v2\.turn_started /, timeoutMs: 500 },
    { assertState: { state: 'READY' } },
  ],
};

export const touchLongPressChips = {
  name: 'touch-long-press-chips',
  issue: '#1063',
  title: 'a long press shows the chips and is not push-to-talk',
  board: 'waveshare',
  requires: [TOUCH_FEATURE],
  steps: [
    { assertState: { state: 'READY', mode: 'ptt' } },
    { send: 'T touch 60 200 900', expect: /^ok$/ },
    { waitDevice: /INFO v2\.touch state=READY (?:session=\S+ )?gesture=long_press,action=chips/, timeoutMs: 3000 },
    { noDevice: /INFO v2\.(turn_started|turn_tap_ignored|earcon) /, timeoutMs: 1500 },
    { assertState: { state: 'READY' } },
  ],
};

// A tap while the server still works on the turn stops it and listens again (the demo's thinking ->
// listening); a tap while listening hands-free sends at once. The harness holds the turn in its agent
// stage (`slow_turn`, as stop-reply does), after one ordinary turn so there is a conversation to hold.
export const touchStopAndTalk = {
  name: 'touch-stop-and-talk',
  issue: '#1063',
  title: 'tap while thinking: stop and listen again; tap while listening: send now',
  board: 'waveshare',
  requires: [TOUCH_FEATURE, { event: 'turn_cancelled', feature: 'stop (#315)' }],
  steps: [
    { assertState: { state: 'READY' } },
    ...pttTurn(),
    { send: 'T server slow_turn 8000', expect: /^ok server$/ },
    { waitServer: journalMatch({ event: 'v2.hil_command', command: 'slow_turn', outcome: 'armed' }), timeoutMs: 5000 },
    ...pttCapture(),
    { waitServer: /"event":"v2\.hil_slow_turn_holding"/, timeoutMs: 15_000 },
    { assertState: { state: 'WAIT' } },
    { send: OFF_BOB, expect: /^ok$/ },
    { waitDevice: /INFO v2\.touch state=WAIT (?:session=\S+ )?gesture=tap,action=go/, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.turn_cancelled state=READY .*source=touch/, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.turn_started state=LISTEN /, timeoutMs: 5000 },
    { send: OFF_BOB, expect: /^ok$/ },
    { waitDevice: /INFO v2\.touch state=LISTEN (?:session=\S+ )?gesture=tap,action=go/, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.turn_ended state=WAIT .*end_reason=key/, timeoutMs: 5000 },
    { assertState: { state: 'READY' }, timeoutMs: TURN_TIMEOUT_MS },
    { send: 'T ping', expect: /^pong / },
  ],
};

// BOOT released before the 300 ms hold guard: no "Hold GO to talk" toast any more on this board, the
// tap is a hands-free turn that the VAD ends.
export const bootTapHandsFree = {
  name: 'boot-tap-hands-free',
  issue: '#1063',
  title: 'BOOT tapped: a hands-free turn that ends on silence, not a toast',
  board: 'waveshare',
  requires: [{ event: 'turn_tap_hands_free', feature: 'BOOT tap = hands-free turn (#1063)' }],
  steps: [
    { assertState: { state: 'READY', mode: 'ptt' } },
    { send: 'T audio tone 1500', expect: /^ok$/ },
    { press: 'btn down' },
    { press: 'btn up' },
    // turn_start goes out before the listen earcon, so the server has it before the device journals the tap.
    { waitServer: /"event":"v2\.turn_started"/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.turn_tap_hands_free state=LISTEN (?:session=\S+ )?held_ms=\d+/, timeoutMs: 3000 },
    { noDevice: /INFO v2\.turn_tap_ignored /, timeoutMs: 500 },
    { waitDevice: /INFO v2\.turn_ended state=WAIT .*end_reason=silence/, timeoutMs: 10_000 },
    { waitDevice: REPLY_PLAYED, timeoutMs: TURN_TIMEOUT_MS },
    { assertState: { state: 'READY' }, timeoutMs: 5000 },
  ],
};

export const TOUCH_SCENARIOS = [touchTapTalk, touchBobInfo, touchSwipeVolume, touchLongPressChips, touchStopAndTalk, bootTapHandsFree];
