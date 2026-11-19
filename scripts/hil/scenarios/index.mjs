import announceRing from './announce-ring.mjs';
import announceVoice from './announce-voice.mjs';
import { bargeIn, bargeInSoak, bargeInSoakWakeWord } from './barge-in.mjs';
import bootReady from './boot-ready.mjs';
import consolePacketEdge from './console-packet-edge.mjs';
import goReleaseAfterGuard from './go-release-320ms.mjs';
import goTapIgnored from './go-tap-ignored.mjs';
import heapFloor from './heap-floor.mjs';
import heapPerMode from './heap-per-mode.mjs';
import helpOverlay from './help-overlay.mjs';
import logBackpressure from './log-backpressure.mjs';
import modeCycle from './mode-cycle.mjs';
import newConversation from './new-conversation.mjs';
import factoryResetGuard from './factory-reset-guard.mjs';
import pairFromScratch from './pair-from-scratch.mjs';
import pcmReply from './pcm-reply.mjs';
import pttTurn from './ptt-turn.mjs';
import replyBurst from './reply-burst.mjs';
import replyCard from './reply-card.mjs';
import revoke4003 from './revoke-4003.mjs';
import ringDuringJoinTest from './ring-during-join-test.mjs';
import ringOverSettings from './ring-over-settings.mjs';
import ringOverSettingsTyping from './ring-over-settings-typing.mjs';
import serverDownBackoff from './server-down-backoff.mjs';
import serverRestartReconnect from './server-restart-reconnect.mjs';
import settingsFromPairing from './settings-from-pairing.mjs';
import settingsNavigation from './settings-navigation.mjs';
import settingsWifiListEnd from './settings-wifi-list-end.mjs';
import spacePicker from './space-picker.mjs';
import speakerLoopback from './speaker-loopback.mjs';
import { baseline } from './steps.mjs';
import stopAtReplyStart from './stop-at-reply-start.mjs';
import stopReply from './stop-reply.mjs';
import stopReplyLate from './stop-reply-late.mjs';
import threadPointer from './thread-pointer.mjs';
import timerRingDuration from './timer-ring-duration.mjs';
import { TOUCH_SCENARIOS } from './touch-ux.mjs';
import turnErrorRecovers from './turn-error-recovers.mjs';
import turnErrorRecoversWake from './turn-error-recovers-wake.mjs';
import turnLongSentence from './turn-long-sentence.mjs';
import volumeMute from './volume-mute.mjs';
import wakeCaptureRate from './wake-capture-rate.mjs';
import wakeDetectSpeaker from './wake-detect-speaker.mjs';
import wakeFollowup from './wake-followup.mjs';
import wakeFollowupKey from './wake-followup-key.mjs';
import wakeMode from './wake-mode.mjs';
import wakeRejectSpeaker from './wake-reject-speaker.mjs';

// Run order. boot-ready goes first and proves READY (mode=ptt, dnd=0); every
// later scenario then starts with baseline() (steps.mjs): ptt and DND off
// through the server, READY, wake word alexa, loop_max/tx_drop reset. The
// scenarios still end in ptt where they can, but a failure mid-way no longer
// fails the next one. heap-floor runs last. Add a new scenario file here
// (docs/cardputer/hil.md).
const withBaseline = (scenario) => ({ ...scenario, steps: [...baseline(), ...scenario.steps] });

export const SCENARIOS = [
  bootReady,
  ...[
    pttTurn,
    replyBurst,
    // #611: these reboot or reconnect the device, so they run early: the heap
    // minimum heap-floor checks last counts from the reboot, and should cover
    // every other scenario. Each ends READY on the owner's token (revoke-4003
    // re-pairs first), so the order among them only keeps revoke last.
    pairFromScratch,
    pcmReply,
    serverRestartReconnect,
    // #709: the server stays down ~70 s; the device backs off, then returns.
    serverDownBackoff,
    // #681: resets onto a held pairing, then reconnects from Settings.
    settingsFromPairing,
    revoke4003,
    // #709 c3: console replies at every USB packet edge (BOB_HIL_ZLP=off: A/B).
    consolePacketEdge,
    goTapIgnored,
    goReleaseAfterGuard,
    turnErrorRecovers,
    turnErrorRecoversWake,
    replyCard,
    newConversation,
    spacePicker,
    threadPointer,
    volumeMute,
    modeCycle,
    helpOverlay,
    // #1063: the Waveshare round screen's touch model (board: 'waveshare'; the Cardputer SKIPs them).
    ...TOUCH_SCENARIOS,
    settingsNavigation,
    settingsWifiListEnd,
    factoryResetGuard,
    stopReply,
    stopReplyLate,
    stopAtReplyStart,
    announceRing,
    announceVoice,
    timerRingDuration,
    ringOverSettings,
    ringOverSettingsTyping,
    ringDuringJoinTest,
    wakeMode,
    wakeCaptureRate,
    wakeDetectSpeaker,
    wakeRejectSpeaker,
    wakeFollowup,
    wakeFollowupKey,
    turnLongSentence,
    heapPerMode,
    logBackpressure,
    heapFloor,
  ].map(withBaseline),
];

// Board-only scenarios (#1063): the Waveshare's speaker loopback self-test has no Cardputer
// equivalent. They run right after boot-ready, before anything else touches the speaker.
export const WAVESHARE_SCENARIOS = [speakerLoopback, bargeIn].map(withBaseline);

// Opt-in (optIn: true): ~10 minutes, so a full run leaves it out; it is in the pool only when
// `--scenario` names it (run.mjs reads the pool from scenariosFor).
export const OPT_IN_SCENARIOS = [bargeInSoak, bargeInSoakWakeWord].map(withBaseline);

/** The run's scenarios for a hil env: the shared set, with the board's own after boot-ready. */
export function scenariosFor(hilEnv, argv = process.argv) {
  if (!String(hilEnv).startsWith('waveshare-')) return SCENARIOS;
  const named = argv[argv.indexOf('--scenario') + 1]?.split(',') ?? [];
  const optIn = argv.includes('--scenario') ? OPT_IN_SCENARIOS.filter((s) => named.includes(s.name)) : [];
  return [SCENARIOS[0], ...WAVESHARE_SCENARIOS, ...optIn, ...SCENARIOS.slice(1)];
}
