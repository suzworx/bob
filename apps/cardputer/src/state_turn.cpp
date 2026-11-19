// Bob Cardputer v2 — a voice turn: uplink queue, GO, playback, stop and errors.
#include "state_internal.h"
#include "audio_hang.h"
#include "capture_stall.h"
#if defined(BOB_BOARD_WAVESHARE_185C)
#include "round_feedback.h"
#include "round_touch.h"
#include "turn_trouble.h"
#endif

namespace bob {
namespace fsm {

static bool downlinkStalledLogged = false;
__attribute__((weak)) void touchTurnEnded(bool) {}  // round_touch.cpp: the GO loop breaker counts empty tap turns
// Downlink sequence gap diagnostics: expected next audio_down sequence for the
// active reply and whether a gap has already been logged for this reply.
uint32_t downlinkExpectedSeq_ = 0;
bool downlinkSeqGapLogged_ = false;

// The turn's uplink (uplink_queue.h). Every framed audio_up frame waits in
// this heap FIFO, in order, until the socket takes it; pumpUplink() sends
// from its head within a per-loop budget, so a busy socket delays frames but
// never skips one (a skipped frame is a server SEQUENCE_GAP) and never holds
// the loop. After the mic closes, turn_end waits for the last frame.
uint8_t* g_uplinkBuf = nullptr;
UplinkQueue g_uplink(kUplinkQueueFrames);
static uint32_t g_uplinkSent = 0;       // frames the socket took this turn.
static uint32_t g_uplinkMessages = 0;   // audio_up messages sent (batches): the wire sequence.
// One batch, packed (packUplinkBatch), lives past the frames in the queue's own
// heap block: no static RAM (memory-budget.json), freed with the queue.
static constexpr size_t kUplinkQueueBytes = kUplinkQueueFrames * config::kPcmFrameBytes;
static bool g_uplinkOverflow = false;   // the queue filled: the turn ends (end_reason=uplink).
bool g_turnEndPending = false;   // the mic closed; turn_end waits for the queue.
static uint32_t g_turnEndedAt = 0;

// GO tap guard (config::kGoMinHoldMs). A GO press opens the mic at once but
// holds turn_start back until GO has been down kGoMinHoldMs; the frames
// captured meanwhile wait in the uplink queue and follow turn_start, paced
// with the live ones. A release before kGoMinHoldMs is a tap: nothing is sent.
bool g_goTurnHeld = false;
CaptureStall g_stall;  // wall-clock guard: the mic stopped delivering, or the turn ran too long.
static uint32_t g_goPressedAt = 0;
// How long the press took, step by step (speaker install + tone, the tone
// wait, mic start), for the turn_started journal line.
static String g_pressTiming;

// A stop (x / BtnA) ends the turn locally at once; playback and status frames
// still in flight for that turn_ref are then ignored.
String g_cancelledTurnRef;
bool g_audioIgnoredLogged = false;

// Set by the first status for the current turn. Until then serverStage's
// idle is the previous turn's, so AWAITING must not read it as "done".
static bool g_turnStatusSeen = false;

// Forgets the turn's queued frames and its pending turn_end: a GO turn that
// never reached the server, or a turn stopped, failed or cut by a disconnect.
void dropUplink() {
  free(g_uplinkBuf);
  g_uplinkBuf = nullptr;
  g_uplink.clear();
  g_goTurnHeld = false;
  g_uplinkOverflow = false;
  g_turnEndPending = false;
}

// A fresh, empty queue for a turn (or the follow-up pre-roll). False: no heap.
bool allocUplink() {
  dropUplink();
  g_uplinkBuf = static_cast<uint8_t*>(malloc(kUplinkQueueBytes + kUplinkBatchBytes));
  g_uplinkSent = 0;
  g_uplinkMessages = 0;
  return g_uplinkBuf != nullptr;
}

// The i-th oldest queued frame (0 = the next to send).
uint8_t* uplinkFrameAt(size_t i) {
  return g_uplinkBuf + g_uplink.slotAt(i) * config::kPcmFrameBytes;
}

// Every framed frame of a turn lands here (capture.sendFrame's callback). A
// full queue refuses it and every later one; the capture loop then ends the
// turn cleanly with what was queued, so the uplink stays gap-free.
void enqueueUplink(const uint8_t* frame, size_t length) {
  size_t slot = 0;
  if (g_uplinkBuf == nullptr || length != config::kPcmFrameBytes || g_uplinkOverflow) return;
  if (!g_uplink.push(&slot)) {
    g_uplinkOverflow = true;
    return;
  }
  memcpy(g_uplinkBuf + slot * config::kPcmFrameBytes, frame, length);
}

// Sends from the queue's head within this pass's budget (uplink_queue.h): the
// frames captured this pass plus kUplinkCatchUpPerLoop, or the whole queue once
// the mic has closed, and never past kUplinkLoopBudgetMs. Frames go in batches
// of 40-80 ms per audio_up (any tail once the mic closed), numbered per message.
// A busy socket (sendBinary false) leaves the batch for the next pass. With the
// mic closed and the queue empty, turn_end goes out, after every frame of the turn.
void pumpUplink(size_t liveTaken) {
  if (g_uplinkBuf == nullptr || g_goTurnHeld) return;  // never ahead of turn_start.
  const size_t allowance = uplinkAllowance(liveTaken, g_turnEndPending);
  const uint32_t start = millis();
  for (size_t sent = 0; uplinkMaySend(sent, allowance, millis() - start);) {
    const size_t n = uplinkBatchFrames(g_uplink.size(), allowance - sent, g_turnEndPending);
    if (n == 0) break;
    uint8_t* const batch = g_uplinkBuf + kUplinkQueueBytes;
    const size_t bytes = packUplinkBatch(uplinkFrameAt, n, g_uplinkMessages, batch);
    if (!network.sendBinary(batch, bytes)) break;
    for (size_t i = 0; i < n; ++i) g_uplink.pop();
    sent += n;
    g_uplinkSent += n;
    ++g_uplinkMessages;
    timingUplinkSent(g_uplinkSent);
  }
  TxSlowWrite slow;
  if (network.takeTxSlowWrite(slow)) {
    // A write that still took long although the socket was writable: the
    // evidence for whatever blocks inside lwIP besides a full send buffer.
    journalEvent("tx_write_slow",
                 String("ms=") + slow.ms + ",bytes=" + slow.bytes + ",queued=" + g_uplink.size() +
                     ",rssi=" + WiFi.RSSI());
  }
  if (!g_turnEndPending) return;
  if (!g_uplink.empty()) {
    if (!uplinkDrainExpired(g_turnEndedAt, millis())) return;
    // The socket took nothing for kUplinkDrainTimeoutMs: give up on the tail
    // only, so what the server got is still gap-free, and say so.
    network.noteAudioDropped(g_uplink.size());
    journalEvent("uplink_drain_timeout",
                 String("dropped=") + g_uplink.size() + ",sent=" + g_uplinkSent);
  }
  network.sendControl(buildTurnEnd(turnRef, g_uplinkMessages));  // seq: the last message's.
  timingMark(Milestone::kTurnEnd);
  journalEvent("turn_end_sent", String("frames=") + g_uplinkSent + ",msgs=" + g_uplinkMessages);
  dropUplink();
}

// The mic takes over GPIO 43 from the speaker; the next earcon re-installs it.
// A turn abandoned with the capture (a tap, a failure, a stop) sends nothing
// more: its queue goes too. endTurn() closes the mic but keeps the queue.
void stopCapture() {
  g_stall.disarm();
  capture.end();
  markSpeakerPinsStale();
  dropUplink();
}

// The one turn_start for PTT, wake and follow-up turns: the active
// conversation (#880) plus one preference snapshot.
void sendTurnStart() {
  network.sendControl(
      buildTurnStart(turnRef, activeConversationRef(), settings().wakeWord, g_assistantNameSupported));
}

// GO has been held long enough: turn_start goes out now; the frames captured
// so far follow from the queue, paced with the live ones (pumpUplink).
static void openHeldTurn() {
  if (!g_goTurnHeld) return;
  sendTurnStart();
  g_goTurnHeld = false;
  journalEvent("turn_started",
               String("mode=") + deviceModeName(settings().mode) + ",held_frames=" + g_uplink.size() +
                   "," + g_pressTiming);
}

#if defined(BOB_BOARD_WAVESHARE_185C)
// The round board: a short BOOT press is a hands-free turn like a tap on the screen. The mic is
// already open: turn_start goes out with the frames held so far, and the VAD ends the turn.
static void goTapToHandsFree(uint32_t heldMs) {
  openHeldTurn();
  g_wakeTurn = true;
  chromeSetShortcuts(kStripWakeCapturing, millis());
  journalEvent("turn_tap_hands_free", String("held_ms=") + heldMs);
}
#endif

#if !defined(BOB_BOARD_WAVESHARE_185C)
// GO released before kGoMinHoldMs: a tap, not a turn. Nothing was sent.
static void ignoreGoTap(uint32_t heldMs) {
  timingDrop();  // a tap never reached the server.
  stopCapture();
  chromeToast("Hold GO to talk", millis());
  enterReady();
  journalEvent("turn_tap_ignored", String("held_ms=") + heldMs);
}
#endif

// Fresh per-turn state: a new turn_ref, sequence 0, no card, no stale status.
void resetTurn() {
  g_wakeTurn = false;
  g_followUpTurn = false;
  g_replyDrained = false;
  vadReset();
  playback.abort();
  playback.clearStamps();  // this turn's summary never reads an earlier reply's.
  g_cardShown = false;
  g_replyForTurn = false;
  g_replyLive = false;
  g_audioIgnoredLogged = false;
  serverStage = ServerStage::kIdle;
  g_turnStatusSeen = false;
  turnRef = messageId("turn");
  capture.resetSequence();
  g_txDropsAtTurnStart = network.txAudioDrops();
  network.resetTxTiming();
  g_goPressedAt = millis();
}

// holdForGo: a GO press, which only becomes a turn once GO has been held
// config::kGoMinHoldMs (openHeldTurn); a wake word opens the turn at once.
void beginTurn(bool holdForGo) {
  g_allSetPending = false;
  if (!welcomed || state != State::kReady) return;
  if (settings().mode == DeviceMode::kAnnounceOnly) {
    chromeToast(boardText("Announcements only. k changes mode", "Announcements only. Mic off"), millis());
    journalEvent("turn_blocked", "mode=announce_only");
    return;
  }
  stopWakeListening();  // GO while listening: the turn takes the mic.
  resetTurn();
  if (!allocUplink()) {
    // No heap for the uplink queue: no turn rather than one with gaps.
    playEarcon(Earcon::kError);
    chromeToast("Out of memory. Try again.", millis());
    journalEvent("turn_blocked", String("reason=heap,") + heapNow());
    return;
  }
  g_chain.beginChain();  // a wake or GO turn starts a new conversation.
  g_goTurnHeld = holdForGo;
  if (!holdForGo) {
    // turn_start goes out before the earcon so the tone never delays the
    // server.
    sendTurnStart();
  }
  // The mic opens once the ~100 ms tone ends (shared GPIO 43).
  const uint32_t earconAt = millis();
  playEarcon(Earcon::kListenStart);  // (re)installs the speaker first.
  const uint32_t waitAt = millis();
  waitForEarcon(150);
  const uint32_t micAt = millis();
  journalEvent("earcon", String("earcon=listen_start played_ms=") + (micAt - earconAt) + ",still_playing=" + (earconPlaying() ? 1 : 0));
  releaseSpeakerForMic();  // however the mic closes, the speaker re-installs.
  const bool micOpen = capture.begin();
  g_pressTiming = String("spk_ms=") + (waitAt - earconAt) + ",tone_wait_ms=" + (micAt - waitAt) +
                  ",mic_ms=" + (millis() - micAt);
  if (!micOpen) {
    if (!g_goTurnHeld) {
      network.sendControl(buildCancel(turnRef));
      g_cancelledTurnRef = turnRef;
    }
    dropUplink();
    playEarcon(Earcon::kError);
    transitionTo(State::kError, "MIC ERROR", "Microphone did not start",
                 kColorRed, kStripRetry);
    journalEvent("mic_begin_failed");
    return;
  }
  timingBegin(holdForGo ? TimingSource::kPtt : TimingSource::kWake);
  transitionTo(State::kCapturing, "LISTENING", "Speak now", kColorGreen, "");
  g_stall.arm(millis());
  if (!g_goTurnHeld) {
    journalEvent("turn_started",
                 String("mode=") + deviceModeName(settings().mode) + "," + g_pressTiming);
  }
}

// endReason: silence|max (the VAD ended a hands-free turn), key (GO ended
// one), release (GO let go), uplink (the uplink queue filled). speech_ms is
// the VAD's onset to last speech; the VAD hears push-to-talk turns too, but
// never ends them. The mic closes now; turn_end follows the turn's last
// queued frame (pumpUplink), so the loop never waits for the socket here.
static void endTurn(const char* endReason) {
  if (state != State::kCapturing) return;
  AudioCall endTurnGuard(AudioStage::kEndTurn, millis());
  g_stall.disarm();
  const uint32_t speechMs = vadSpeechMs();
  // fps: frames the mic delivered per second from its first frame (100 when
  // capture is gap-free).
  const uint32_t fps = capture.framesPerSecond(millis());
  capture.end();
  timingCaptureEnded(timingEndFromName(endReason));
  markSpeakerPinsStale();
  playEarcon(Earcon::kListenStop);
  journalEvent("earcon", "earcon=listen_stop");
  const size_t backlog = g_uplink.size();
  timingCaptureStats(backlog, fps);
  g_turnEndPending = true, g_turnEndedAt = millis();
  touchTurnEnded(speechMs > 0);
  transitionTo(State::kAwaiting, "WAITING...", "Waiting for reply...",
               kColorCyan, "");
  downlinkStalledLogged = false;
  journalEvent("turn_ended",
               String("frames=") + (g_uplinkSent + backlog) + ",fps=" + fps +
                   ",tx_wait_max_ms=" + network.txWaitMaxMs() + ",tx_send_max_ms=" + network.txSendMaxMs() +
                   ",end_reason=" + endReason + ",speech_ms=" + speechMs + ",backlog=" + backlog +
                   ",tx_busy=" + network.txBusy().count() +
                   ",tx_busy_max_ms=" + network.txBusy().maxMsIncludingOpen(millis()));
  pumpUplink(0);  // often the queue is already empty: turn_end goes out now.
}

// The server's end_of_turn (#1365): closes a hands-free capture exactly like the VAD's own
// end of speech (endTurn), with end reason "server". The VAD's 1000 ms silence stays the
// fallback; a stale or unknown turn_ref, or a push-to-talk hold, is ignored.
void handleEndOfTurn(const String& text) {
  char ref[kTurnRefBytes] = "";
  if (!parseEndOfTurn(text, ref, sizeof(ref))) return;
  if (!serverEndOfTurnCloses(state == State::kCapturing, g_wakeTurn, turnRef.c_str(), ref)) {
    journalEvent("end_of_turn_ignored");
    return;
  }
  g_wakeTurn = false;
  endTurn("server");
}

// True when a message's turn_ref names a turn this device already stopped.
// Messages without a turn_ref are never treated as stale.
static bool isCancelledTurn(const String& text) {
  char ref[kTurnRefBytes];
  return g_cancelledTurnRef.length() > 0 && extractTurnRef(text, ref, sizeof(ref)) &&
         g_cancelledTurnRef == ref;
}

// An announcement's message (turn_ref "ann_<announce_id>") is accepted only
// right after that announce, only once, and never over a device turn.
static void beginAnnouncementPlayback(const char* ref) {
  const bool expected = state == State::kAnnounce && g_announceActive &&
                        !g_announce.ring && !g_announcePlaying && !g_announceAcked &&
                        strcmp(ref + 4, g_announce.id) == 0;
  if (!expected || playback.active()) {
    journalEvent("announce_playback_ignored");
    return;
  }
  playback.beginPlayback(negotiatedFormat, true);
  g_announcePlaying = playback.active();
  g_audioIgnoredLogged = false;
  downlinkExpectedSeq_ = 0;
  downlinkSeqGapLogged_ = false;
  journalEvent("announce_playback_started",
               String("announce_id=") + g_announce.id);
}

void handlePlaybackStart(const String& text) {
  char ref[kTurnRefBytes] = "";
  extractTurnRef(text, ref, sizeof(ref));
  if (strncmp(ref, "ann_", 4) == 0) {
    beginAnnouncementPlayback(ref);
    return;
  }
  // A turn reply is only accepted while this device awaits that turn; one
  // for a stopped turn is dropped, and its audio_down frames with it.
  if (state != State::kAwaiting || (ref[0] != '\0' && turnRef != ref)) {
    journalEvent("playback_start_ignored");
    return;
  }
  if (playback.active()) {
    journalEvent("playback_start_duplicated");
    return;
  }
  playback.beginPlayback(negotiatedFormat);  // stamps playback_start receipt.
  timingPlaybackStarted();
  downlinkExpectedSeq_ = 0;
  downlinkSeqGapLogged_ = false;
  if (serverStage == ServerStage::kSpeaking) {
    transitionTo(State::kAwaiting, "REPLY", "Playing reply...", kColorMagenta,
                 "");
  } else if (serverStage == ServerStage::kThinking) {
    transitionTo(State::kAwaiting, "THINKING", "Thinking...", kColorCyan, "");
  } else {
    transitionTo(State::kAwaiting, "WAITING...", "Waiting for reply...",
                 kColorCyan, "");
  }
  journalEvent("playback_started",
               String("format=") + static_cast<int>(negotiatedFormat));
}

void handlePlaybackEnd(const String& text) {
  journalEvent("playback_end_received");
  // A stopped turn's playback_end must not end the next turn's stream.
  if (isCancelledTurn(text)) return;
  playback.finishStream();
  // Apply any push held while the reply was in flight; the display itself
  // only repaints on the next READY transition (contract R10).
  applyHeldPushes();
}

void handleStatus(const String& text, ServerStage stage) {
  if (isCancelledTurn(text)) return;  // late status for a stopped turn.
  char ref[kTurnRefBytes] = "";
  if (!extractTurnRef(text, ref, sizeof(ref)) || turnRef == ref) g_turnStatusSeen = true;
  serverStage = stage;
  // Only a turn in flight changes screens; a status can never pull the
  // device out of READY, HELP or an announcement.
  if (state == State::kAwaiting && stage == ServerStage::kSpeaking) {
    transitionTo(State::kAwaiting, "REPLY", "Playing reply...", kColorMagenta,
                 "");
  } else if (state == State::kAwaiting && stage == ServerStage::kThinking) {
    transitionTo(State::kAwaiting, "THINKING", "Thinking...", kColorCyan, "");
  }
  journalEvent("server_status",
               String("stage=") + serverStageName(stage));
}

// A generic server error fails the turn in flight, and only that turn
// (INTERNAL from a failed STT/agent/TTS stage, SEQUENCE_GAP, ...): the
// connection and the session are still good, so the device says so briefly
// and is READY again, with its keys, modes and Always-awake listening. It
// used to go to State::kError, where only GO worked (2026-09-24: minutes
// stuck after one INTERNAL). Pairing codes never get here (onSocketEvent
// routes UNPAIRED / PAIRING_RATE_LIMITED first) and a lost connection is a
// socket event, so the Error state stays for connection, config and mic
// faults. With no turn in flight (e.g. a server that does not know
// device_state yet) the error is journaled only.
void handleServerError(const char* code) {
  if (state != State::kCapturing && state != State::kAwaiting) {
    journalEvent("server_error_ignored",
                 String("code=") + code);
    return;
  }
  // Mid-capture the server may still hold the turn open: cancel resets it.
  // A turn still held back by the GO guard never reached the server.
  if (state == State::kCapturing && !g_goTurnHeld) network.sendControl(buildCancel(turnRef));
  if (state == State::kCapturing) timingCaptureEnded(TimingEnd::kError);
  if (g_goTurnHeld) timingDrop();  // turn_start never went out.
  if (state == State::kCapturing) stopCapture();
  dropUplink();  // a turn_end still waiting for its queue goes too.
  g_chain.end();  // no follow-up after a failed turn.
  g_cancelledTurnRef = turnRef;  // late status/audio for it is ignored.
  playback.abort();
  timingFinish(TimingFinish::kFailed);
  serverStage = ServerStage::kIdle;
  g_wakeTurn = false;
  g_replyForTurn = false;
  playEarcon(Earcon::kError);
#if defined(BOB_BOARD_WAVESHARE_185C)
  // The round board names why under a confused Bob for a few seconds (owner UX audit 2026-10-20).
  const TurnTrouble trouble = troubleForServerError(code, network.wifiStatus() == WL_CONNECTED);
  enterReady();
  roundUiTrouble(troubleCaption(trouble), millis());
  journalEvent("turn_trouble", String("kind=") + troubleName(trouble));
#else
  chromeToast("Something went wrong. Try again.", millis());
  enterReady();
#endif
  // Always awake re-opens the mic (shared GPIO 43) only once the ~270 ms
  // error tone has ended: wakeTick() waits for it without blocking the loop.
  journalEvent("server_error", String("code=") + code);
  journalTurnHeap();
  applyHeldPushes();
}

// --- Stop (#315) ---

// x / BtnA while awaiting or playing: tell the server, silence the speaker
// and flush the MP3 ring now, and go straight back to READY. A stopped reply
// leaves no card; late frames for this turn_ref are ignored.
// The reply has played and the device waits kFollowUpGuardMs before the
// follow-up window: the turn is complete, nothing is left to stop.
static bool inFollowUpGuard() { return state == State::kAwaiting && g_replyDrained; }

void stopReply(const char* source) {
  if (state != State::kAwaiting) return;
  if (inFollowUpGuard()) {
    // x or GO in the guard: skip the window, never cancel a finished turn.
    finishTurn(false);
    journalEvent("followup_skipped", String("reason=") + source);
    return;
  }
  dropUplink();  // frames still queued for this turn, and its turn_end, never go.
  network.sendControl(buildCancel(turnRef));
  g_cancelledTurnRef = turnRef;
  const uint32_t frames = playback.downFrameCount();
  playback.abort();
  timingFinish(TimingFinish::kStopped);
  serverStage = ServerStage::kIdle;
  g_replyForTurn = false;
  enterReady();
  journalEvent("turn_cancelled",
               String("source=") + source + ",down_frames=" + frames);
  journalTurnHeap();
  applyHeldPushes();
}

#ifdef BOB_AUTO_TURN
// Automated end-to-end test seam (built with -DBOB_AUTO_TURN): while READY
// and welcomed, start a turn every BOB_AUTO_TURN_GAP_MS through the same
// beginTurn()/endTurn() path the push-to-talk button uses, capturing
// BOB_AUTO_TURN_CAPTURE_MS of mic frames in between. Turns only ever begin
// in kReady, so a reply still playing (or the awaiting state) simply delays the
// next turn past the nominal gap — cycles can never overlap. Compiled out when
// the flag is undefined, leaving the default binary's behaviour unchanged.
static uint32_t autoTurnNextAt = 0;
static bool autoTurnCapturing = false;

void handleAutoTurn() {
  if (!welcomed) {
    autoTurnCapturing = false;
    return;
  }
  if (state == State::kReady && !autoTurnCapturing) {
    if (millis() - autoTurnNextAt >= BOB_AUTO_TURN_GAP_MS) {
      autoTurnNextAt = millis();
      autoTurnCapturing = true;
      journalEvent("auto_turn_started");
      beginTurn(false);
    }
  } else if (state == State::kCapturing && autoTurnCapturing) {
    // The push-to-talk capture loop is gated on BtnA, which nothing presses
    // here, so drive the frames for the fixed auto-turn window ourselves.
    size_t taken = 0;
    while (capture.nextFrame()) {
      capture.sendFrame(enqueueUplink);
      ++taken;
      journalEvent("audio_up",
                   String("seq=") + capture.nextSequence());
    }
    pumpUplink(taken);
    if (capture.failed()) {
      stopCapture();
      transitionTo(State::kError, "MIC ERROR", boardText("Press BTN GO to retry", "Tap to retry"),
                   kColorRed, "BTN GO: retry");
      journalEvent("capture_failed");
      autoTurnCapturing = false;
      return;
    }
    if (millis() - autoTurnNextAt >= BOB_AUTO_TURN_CAPTURE_MS) {
      autoTurnCapturing = false;
      endTurn("release");
    }
  } else if (state != State::kCapturing) {
    autoTurnCapturing = false;
  }
}
#endif

// GO (BtnA) for this loop: the press and release edges and whether it is held.
struct GoButton {
  bool pressed;
  bool held;
  bool released;
};

#ifdef BOB_TEST_CONSOLE
static GoButton g_testGo = {false, false, false};  // `T btn down|up` (test_console.cpp).
#endif

// The one GO reader: the real button and, in the HIL build, the console's
// injected presses feed the same handler below.
static GoButton readGoButton() {
  GoButton go = {M5Cardputer.BtnA.wasPressed(), M5Cardputer.BtnA.isPressed(),
                 M5Cardputer.BtnA.wasReleased()};
#ifdef BOB_TEST_CONSOLE
  go.pressed = go.pressed || g_testGo.pressed;
  go.held = go.held || g_testGo.held;
  go.released = go.released || g_testGo.released;
  g_testGo.pressed = false;
  g_testGo.released = false;
#endif
  return go;
}

void handlePttAndReply() {
  // One action per press: BtnA talks on READY, stops a reply, closes HELP,
  // dismisses an announcement, or retries a failed connection.
  const GoButton go = readGoButton();
  const bool pressed = go.pressed;
  if (pressed && state == State::kReady) {
    closeFollowUp(FollowUpClose::kKey);  // GO closes the window, then talks.
    beginTurn(true);
  } else if (pressed && state == State::kAwaiting) {
    const bool guard = inFollowUpGuard();
    stopReply("btn");
    if (guard) beginTurn(true);  // GO in the guard: a normal turn, no window.
  } else if (pressed && state == State::kHelp) {
    closeHelp();
  } else if (pressed && state == State::kAnnounce) {
    dismissAnnouncement("btn");
  } else if (pressed && (state == State::kError || state == State::kSocket)) {
    requestSocketRetry();
  }
  // The turn is over once the server said so (a status for this turn, now
  // idle) and the reply has finished playing out: playback is inactive only
  // once the speaker has drained (playback_completed). Before a follow-up
  // window the device stays in WAIT kFollowUpGuardMs longer, so the mic never
  // opens on the reply's tail.
  if (state == State::kAwaiting && g_turnStatusSeen &&
      serverStage == ServerStage::kIdle && !playback.active()) {
    if (!g_replyDrained) {
      g_replyDrained = true;
      g_replyDrainedAt = millis();
      timingFinish(TimingFinish::kPlayed);  // after the drain, never before it.
    }
    const char* why = "";
    if (!followUpWanted(&why) || followUpGuardPassed(g_replyDrainedAt, millis())) {
      finishTurn();
    }
  }
  if (playback.active() && !downlinkStalledLogged &&
      playback.isStalled(millis())) {
    downlinkStalledLogged = true;
    journalEvent("downlink_stalled",
                 String("frames=") + playback.downFrameCount() +
                     " free=" + heap_caps_get_free_size(MALLOC_CAP_8BIT) +
                     " largest=" + heap_caps_get_largest_free_block(MALLOC_CAP_8BIT) +
                     " stack=" + uxTaskGetStackHighWaterMark(nullptr));
  }
  // A GO turn streams while GO is held; a wake-word turn streams hands-free
  // until the VAD hears the speaker stop (or GO is pressed). Every frame the
  // mic has finished is queued, in order (a memcpy: this loop never waits on
  // the socket), then one budgeted pass sends from the queue (pumpUplink).
  if (state == State::kCapturing && (g_wakeTurn || go.held)) {
    size_t taken = 0;
    while (capture.nextFrame()) {
      capture.sendFrame(enqueueUplink);
      ++taken;
      journalEvent("audio_up",
                   String("seq=") + capture.nextSequence());
      // Every turn feeds the VAD (speech_ms); only a hands-free turn ends on it.
      vadFeed(capture.frame(), config::kSamplesPerFrame);
    }
    if (taken > 0) g_stall.frame(millis());
    const CaptureStallReason stall = g_stall.check(millis());
    if (capture.failed() || stall != CaptureStallReason::kNone) {
      g_wakeTurn = false;
      timingDrop();  // no summary: the turn is abandoned without a cancel or turn_end.
      stopCapture();
      playEarcon(Earcon::kError);
      transitionTo(State::kError, "MIC ERROR", boardText("Press BTN GO to retry", "Tap to retry"),
                   kColorRed, "BTN GO: retry");
      if (stall != CaptureStallReason::kNone) {
        journalEvent("capture_stalled", String("reason=") + CaptureStall::name(stall));
      } else {
        journalEvent("capture_failed");
      }
    } else {
      pumpUplink(taken);
      if (g_uplinkOverflow) {
        // The socket took nothing for ~1.6 s (kUplinkQueueFrames): end the
        // turn cleanly with every frame queued so far, never with a gap.
        journalEvent("uplink_backlog_full",
                     String("queued=") + g_uplink.size() + ",sent=" + g_uplinkSent);
        openHeldTurn();  // only if still held: turn_start always comes first.
        g_wakeTurn = false;
        endTurn("uplink");
      }
    }
  }
  if (state == State::kCapturing && g_wakeTurn && vadSpeechEnded() && !vadHeardSpeech()) {
    // Woken, then nothing said: drop the turn instead of sending silence.
    g_wakeTurn = false;
    network.sendControl(buildCancel(turnRef));
    g_cancelledTurnRef = turnRef;
    timingCaptureEnded(TimingEnd::kNoSpeech);
    stopCapture();
    timingFinish(TimingFinish::kCancelled);
    enterReady();
#if defined(BOB_BOARD_WAVESHARE_185C)
    roundUiTrouble(troubleCaption(TurnTrouble::kNotHeard), millis());  // woken or tapped, then nothing said.
#endif
    journalEvent("wake_rejected",
                 String("frames=") + capture.nextSequence());
  }
  // A GO press becomes a turn once held config::kGoMinHoldMs; released
  // sooner, it was a tap.
  if (state == State::kCapturing && g_goTurnHeld) {
    const uint32_t heldMs = millis() - g_goPressedAt;
    if (heldMs >= config::kGoMinHoldMs) {
      openHeldTurn();
    } else if (go.released) {
#if defined(BOB_BOARD_WAVESHARE_185C)
      goTapToHandsFree(heldMs);
      return;
#else
      ignoreGoTap(heldMs);
      return;
#endif
    }
  }
  const bool ended = g_wakeTurn ? (vadSpeechEnded() || pressed) : go.released;
  if (state == State::kCapturing && ended) {
    const char* reason = !g_wakeTurn        ? "release"
                         : vadSpeechEnded() ? vadEndName(vadEndReason())
                                            : "key";
    g_wakeTurn = false;
    endTurn(reason);
  }
}

#if defined(BOB_BOARD_WAVESHARE_185C)
// A hands-free turn opened by a tap (the round screen) or a short BOOT press: like a wake word
// turn, it streams until the VAD hears the speaker stop.
static void beginHandsFreeTurn() {
  beginTurn(false);
  g_wakeTurn = state == State::kCapturing;
  if (g_wakeTurn) chromeSetShortcuts(kStripWakeCapturing, millis());
}

// A tap that means GO on the round screen (round_touch.cpp, touch::intentFor), one action per
// screen: Ready talks hands-free; listening sends now (a push-to-talk hold on BOOT ignores it);
// thinking or speaking stops the reply and listens again; HELP and announcements close; the
// error and server screens retry.
void touchGo() {
  switch (state) {
    case State::kReady:
      closeFollowUp(FollowUpClose::kKey);  // the window closes, then the tap talks.
      beginHandsFreeTurn();
      break;
    case State::kCapturing:
      if (g_wakeTurn) {
        g_wakeTurn = false;
        endTurn("key");
      }
      break;
    case State::kAwaiting:
      stopReply("touch");
      if (state == State::kReady) beginHandsFreeTurn();
      break;
    case State::kHelp: closeHelp(); break;
    case State::kAnnounce: dismissAnnouncement("touch"); break;
    case State::kError:
    case State::kSocket: requestSocketRetry(); break;
    default: break;
  }
}

// A wake word over the reply or an announcement (BARGE-WAKE, state_wake.cpp): the same as a tap
// that means GO, so the reply stops (or the announcement is dismissed) and a hands-free turn opens.
// The wake's peak score and the ms since playback began are journaled; any other state ignores it.
void bargeIn(uint32_t nowMs, float maxP) {
  if (state != State::kAwaiting && state != State::kAnnounce) {
    journalEvent("barge_ignored", String("state=") + stateName(state));
    return;
  }
  const bool reply = state == State::kAwaiting;
  const TimingStamp& start = playback.stamps().start;
  String detail = String("stage=") + (reply ? "reply" : "announce");
  if (start.set) detail += String(",ms_into=") + (nowMs - start.at);
  detail += String(",max_p=") + String(maxP, 2);
  journalEvent("barge_in", detail);
  if (reply) {
    stopReply("wake");
  } else {
    dismissAnnouncement("wake");
  }
  if (state == State::kReady) beginHandsFreeTurn();
}
#else
void bargeIn(uint32_t, float) {}  // no wake model on this board (BARGE-WAKE is Waveshare only).
#endif

}  // namespace fsm

using namespace fsm;

#ifdef BOB_TEST_CONSOLE
void testSetGo(bool down) {
  if (down) {
    g_testGo.pressed = true;
  } else {
    g_testGo.released = true;
  }
  g_testGo.held = down;
}
bool testStateReady() { return state == State::kReady && settings().mode != DeviceMode::kWake; }
#endif

}  // namespace bob
