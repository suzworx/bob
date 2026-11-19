/*
 * Step fragments shared by several scenarios. Each returns plain step data
 * (scripts/hil/schema.mjs), so a scenario stays a readable list.
 */

/** Waits the server's stub pipeline (BOB_SYSTEM_TEST=1) is allowed per turn:
 *  stub STT + agent + a few seconds of stub TTS, with slack for a loaded PC. */
export const TURN_TIMEOUT_MS = 60_000;

/** The reply actually played to its end. A bare playback_completed also
 *  matches a dropped reply (mp3_exit=n/a after mp3_begin_failed: 9 HIL runs of
 *  silent turns passed, run 20260929-064635-40fc) and a socket that closed
 *  mid-reply (mp3_exit=stopped). Every turn that expects its reply heard waits
 *  on this. */
/** Cancellation before decoder startup: explicitly proves no speaker output. */
export const REPLY_CANCELLED_BEFORE_START = /INFO v2\.playback_completed (?=.*\bmp3_exit=n\/a(?:,|$))(?=.*\bout_frames=0(?:,|$))/;

export const REPLY_PLAYED = /INFO v2\.playback_completed .*mp3_exit=eof\b/;

/** The same proof for a PCM16 reply (streamed since PCM-BUFFER-674), which has
 *  no mp3_exit: format=pcm16 with samples > 0 (something reached the
 *  speaker), dropped_bytes=0 (nothing overflowed) and seq_gaps=0 (no frame
 *  lost on the way), in whatever order the fields come. Run 20260929-110910-342e
 *  had a silent PCM reply end in READY with no playback_completed at all. */
const PCM_REPLY_PLAYED =
  /INFO v2\.playback_completed (?=.*\bformat=pcm16\b)(?=.*\bsamples=[1-9]\d*\b)(?=.*\bdropped_bytes=0\b)(?=.*\bseq_gaps=0\b)/;

/** "The reply played to its end" for a reply in `format` ('mp3' or 'pcm16'):
 *  the one wait every turn that expects its reply heard uses. */
export function replyPlayed(format = 'mp3') {
  if (format === 'mp3') return REPLY_PLAYED;
  if (format === 'pcm16') return PCM_REPLY_PLAYED;
  throw new Error(`replyPlayed: unknown format ${format}`);
}

/** The known start every scenario after boot-ready gets (scenarios/index.mjs
 *  prepends it): push-to-talk and DND off through the server, READY, the
 *  default wake word, and loop_max/tx_drop back to 0. So a scenario that
 *  failed mid-way (left in wake mode, a word from an earlier run in NVS, one
 *  stalled loop) cannot fail the next one's first step (HIL run
 *  20260924-165003-c15f: four scenarios failed only on that). */
export function baseline() {
  return [
    { send: 'T server control mode=ptt dnd=0', expect: /^ok server$/ },
    // The push must have landed before the scenario starts: a readback of a
    // device already in ptt passes at once, and a late device_control then
    // undid the scenario's own `k` (run 20260924-195519-54b4, wake-mode). The
    // device journals mode_changed for every applied mode, even an unchanged one.
    { waitDevice: /INFO v2\.mode_changed .*mode=ptt,.*source=server/, timeoutMs: 15_000 },
    { assertState: { state: 'READY', mode: 'ptt', dnd: 0 }, timeoutMs: 15_000 },
    { send: 'T wake word alexa', expect: /^ok$/ },
    { send: 'T state reset', expect: /^ok$/ },
  ];
}

/** GO held over a generated tone instead of the mic (so every run sends the
 *  same audio), then released: ends with the device in WAIT ("thinking") and
 *  the server holding the whole uplink. */
export function pttCapture({ toneMs = 1500 } = {}) {
  return [
    { send: `T audio tone ${toneMs}`, expect: /^ok$/ },
    { press: 'btn down' },
    { waitDevice: /INFO v2\.turn_started state=LISTEN/, timeoutMs: 5000 },
    { waitServer: /"event":"v2\.turn_started"/, timeoutMs: 5000 },
    { sleep: toneMs + 200 },
    { press: 'btn up' },
    // WAIT is the device's "thinking" state: the uplink is closed and the
    // reply has not started yet.
    { waitDevice: /INFO v2\.turn_ended state=WAIT/, timeoutMs: 5000 },
    { waitServer: /"event":"v2\.turn_ended"/, timeoutMs: 5000 },
  ];
}

/** The main loop never stalled and no uplink frame was dropped since boot:
 *  `T state` loop_max < 300 ms (a healthy run peaks ~140-160 ms, the listen
 *  earcon) and tx_drop=0. A socket write that blocked the loop (HIL run
 *  20260924-101805-5c90: loop_max=1953, 71 frames dropped) fails it. */
export function loopHealthy() {
  return { send: 'T state', expect: /loop_max=([0-9]|[1-9]\d|[12]\d\d) tx_drop=0$/ };
}

/** A push-to-talk turn up to the reply starting to play on the device. */
export function pttTurnStart(options) {
  return [
    ...pttCapture(options),
    { waitServer: /"event":"v2\.downlink_started"/, timeoutMs: TURN_TIMEOUT_MS },
    { waitDevice: /INFO v2\.playback_started/, timeoutMs: TURN_TIMEOUT_MS },
  ];
}

/** From push-to-talk: `k` enters Always awake, `T wake fire` stands in for a
 *  detection (no speaker needed), a generated tone is the speech (armed once
 *  the turn's mic is open, so the turn hears it, not wake listening), the
 *  VAD ends the turn, the reply plays, and the follow-up window opens. */
export function wakeTurnToFollowUp({ toneMs = 1500 } = {}) {
  return [
    { press: 'k' },
    { waitDevice: /INFO v2\.wake_listening /, timeoutMs: 5000 },
    { send: 'T wake fire', expect: /^ok$/ },
    { waitDevice: /INFO v2\.wake_detected /, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.turn_started state=LISTEN .*mode=wake/, timeoutMs: 5000 },
    { send: `T audio tone ${toneMs}`, expect: /^ok$/ },
    // The VAD ends it 1.2 s after the tone, or at its 15 s cap in a noisy room.
    { waitDevice: /INFO v2\.turn_ended state=WAIT/, timeoutMs: 10_000 },
    { waitDevice: REPLY_PLAYED, timeoutMs: TURN_TIMEOUT_MS },
    { waitDevice: /INFO v2\.followup_opened state=READY .*window_ms=6000,guard_ms=250,since_drain_ms=\d+,/, timeoutMs: TURN_TIMEOUT_MS },
  ];
}

/** Leaves Always awake through the server, back to the push-to-talk baseline. */
export function backToPtt() {
  return [
    { send: 'T server control mode=ptt', expect: /^ok server$/ },
    { waitDevice: /INFO v2\.mode_changed .*mode=ptt,.*source=server/, timeoutMs: 5000 },
    { assertState: { state: 'READY', mode: 'ptt' } },
  ];
}

/** A full turn: capture, thinking, reply played to the end, back to READY. */
export function pttTurn(options) {
  return [
    ...pttTurnStart(options),
    { waitServer: /"event":"v2\.turn_completed"/, timeoutMs: TURN_TIMEOUT_MS },
    { waitDevice: REPLY_PLAYED, timeoutMs: TURN_TIMEOUT_MS },
    { assertState: { state: 'READY' }, timeoutMs: 5000 },
  ];
}
