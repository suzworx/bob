// Bob Cardputer v2 — Always awake (#313) and the follow-up window (follow_up.h).
#include "state_internal.h"
#include "ota_ui.h"
#include "audio_duplex.h"
#include "barge_policy.h"

namespace bob {

namespace fsm {

static void followUpTick(uint32_t nowMs);

// Always-awake mode (#313, wake_word.h). While READY the mic runs and every
// frame goes to wakeWordFeed() only: nothing is sent before a detection. The
// ~33 KB arena is freed before any turn, so it never overlaps the MP3 decoder,
// and taken again on the next READY. g_wakeFailed (wakeWordBegin() or the mic
// failed) falls back to push-to-talk until the mode is entered again.
static bool g_wakeListening = false;
bool g_wakeFailed = false;
bool g_wakeTurn = false;  // this turn was opened by the wake word: VAD ends it.
#ifdef BOB_TEST_CONSOLE
static bool g_testWakeFire = false;  // `T wake fire`: the next wake tick is a detection.
#endif

// Follow-up window (follow_up.h): after a reply in Always awake the mic stays
// open on READY, without the wake arena. Every frame feeds the VAD and the
// newest kFollowUpPreRollFrames wait in the uplink queue (below); speech
// opens a turn that sends them first, silence closes the window.
FollowUpWindow g_followUp;
// When this turn's reply finished draining from the speaker; the window opens
// kFollowUpGuardMs later (research D1, #392).
bool g_replyDrained = false;
uint32_t g_replyDrainedAt = 0;
// This wake's conversation (follow_up.h): a wake or GO turn begins it, each
// follow-up turn counts, and a follow-up heard as nothing or a failed turn
// ends it, so a TV cannot keep the device talking to itself.
FollowUpChain g_chain;
bool g_followUpTurn = false;  // the turn in flight was opened by the window.

// --- Always awake (#313) ---

String heapNow() {
  return String("free=") + heap_caps_get_free_size(MALLOC_CAP_8BIT) +
         ",largest=" + heap_caps_get_largest_free_block(MALLOC_CAP_8BIT);
}

void stopWakeListening() {
#ifdef BOB_TEST_CONSOLE
  g_testWakeFire = false;  // a `T wake fire` never outlives the listening it was for.
#endif
  if (!g_wakeListening) return;
  stopCapture();
  wakeWordEnd();
  g_wakeListening = false;
  journalEvent("wake_stopped",
               String("max_invoke_us=") + wakeWordMaxInvokeUs() + "," + heapNow());
}

// Push-to-talk takes over, with a notice; the next entry into the mode
// tries again. `error` details a "begin" failure (wakeWordLastError()).
static void failWake(const char* reason, const char* error = "") {
  g_wakeFailed = true;
  markDeviceStateDirty(millis());  // the server now hears mode=ptt.
  chromeToast(boardText("Wake word failed. Hold GO to talk", "Wake word off. Tap to talk"), millis());
  if (state == State::kReady) { enterReady(); chromeSetShortcuts(readyStrip(), millis()); }
  journalEvent("wake_unavailable",
               String("reason=") + reason + (error[0] != '\0' ? String(",error=") + error : String()) +
                   "," + heapNow());
}

void startWakeListening() {
  if (g_wakeListening || g_wakeFailed) return;
  if (!wakeWordBegin(settings().wakeWord)) {
    failWake("begin", wakeWordLastError());
    return;
  }
  releaseSpeakerForMic();
  if (!capture.begin()) {
    wakeWordEnd();
    failWake("mic");
    return;
  }
  g_wakeListening = true;
  journalEvent("wake_listening",
               String("word=") + wakeModelSpec(settings().wakeWord).name +
                   ",held=" + wakeWordArenaBytes() + ",arena_used=" + wakeWordArenaUsedBytes() +
                   ",arena_in=" + wakeWordArenaRegion() + "," + heapNow());
}

// The follow-up window holds the mic without the model, so it is not wanted then.
bool wakeWanted() {
  return welcomed && state == State::kReady && settings().mode == DeviceMode::kWake &&
         !g_wakeFailed && !g_followUp.isOpen() && !updateBusy();
}

// Every 5 s of listening: frames that reached the model and their rate, the
// largest model output, the loudest frame and the noise floor. No audio.
static void journalWakeStats(uint32_t nowMs) {
  if (!wakeWordStatsDue(nowMs)) return;
  const WakeStats stats = wakeWordTakeStats(nowMs);
  const WakeFeedStats feed = wakeWordTakeFeedStats();
  journalEvent("wake_stats",
               String("frames=") + stats.frames + ",fps=" + stats.fps + ",max_p=" +
                   stats.maxProbability + ",peak_db=" + static_cast<int>(stats.peakDb + 0.5f) +
                   ",floor_db=" + static_cast<int>(wakeWordNoiseFloorDb() + 0.5f) +
                   ",feed_avg_us=" + feed.avgUs + ",feed_max_us=" + feed.maxUs + ",dropped=" + feed.dropped);
}

// --- Barge-in (#1364) ---

// While Bob speaks the wake model listens to the echo-cancelled duplex mic. It
// never touches the speaker or capture (that would kill the reply): only the
// model's arena is taken and freed.
static bool g_bargeListening = false;
static bool g_bargeBeginFailed = false;  // no retry every loop; cleared when barge is not wanted.
static NearEndGate g_nearEndGate;        // diagnostic: near-end frames in the window, logged in barge_stats.

static bool bargeNow() {
  BargeInputs in;
  in.welcomed = welcomed;
  in.wakeMode = settings().mode == DeviceMode::kWake;
  in.wakeFailed = g_wakeFailed;
  in.followUpOpen = g_followUp.isOpen();
  in.updateBusy = updateBusy();
  in.playingState = state == State::kAwaiting || state == State::kAnnounce;
#if defined(BOB_BOARD_WAVESHARE_185C)
  in.duplexActive = duplex::active();
  in.waveshare = true;
#endif
  return bargeWanted(in);
}

static void stopBargeListening() {
  g_bargeBeginFailed = false;
  if (!g_bargeListening) return;
  wakeWordEnd();
  wakeWordSetPlaybackGuard(false);
  g_bargeListening = false;
}

// True when barge listening owns this tick (the Ready path must not run).
static bool bargeTick(uint32_t nowMs) {
  if (!bargeNow()) {
    stopBargeListening();
    return false;
  }
  if (g_bargeBeginFailed) return true;
  if (!g_bargeListening) {
    stopWakeListening();
    if (!wakeWordBegin(settings().wakeWord)) {
      g_bargeBeginFailed = true;
      journalEvent("barge_unavailable", String("error=") + wakeWordLastError() + "," + heapNow());
      return true;
    }
    wakeWordSetPlaybackGuard(true);
    g_nearEndGate = NearEndGate();
    g_bargeListening = true;
    journalEvent("barge_listening",
                 String("stage=") + (state == State::kAnnounce ? "announce" : "reply") +
                     ",word=" + wakeModelSpec(settings().wakeWord).name +
                     ",arena_in=" + wakeWordArenaRegion());
  }
  int16_t frame[config::kSamplesPerFrame];
  bool heard = false;
  bool nearEnd = false;
  while (!heard && duplex::nextFrame(frame, &nearEnd)) {
    g_nearEndGate.push(nearEnd);
    wakeWordFeed(frame, config::kSamplesPerFrame);
    if (wakeWordDetected()) heard = true;
  }
  if (heard) {
    const float maxP = wakeWordTakeStats(nowMs).maxProbability;
    stopBargeListening();
    bargeIn(nowMs, maxP);
    return true;
  }
  if (wakeWordStatsDue(nowMs)) {
    const WakeStats stats = wakeWordTakeStats(nowMs);
    const duplex::Stats echo = duplex::takeStats();
    journalEvent("barge_stats",
                 String("erle_db=") + echo.erleDb + ",mic_db=" + echo.micDb + ",ref_db=" + echo.refDb +
                     ",max_p=" + stats.maxProbability + ",frames=" + echo.frames +
                     ",underruns=" + echo.underruns + ",near_end=" + g_nearEndGate.nearEndFrames());
  }
  return true;
}

// Listens exactly while wanted: every 10 ms frame the mic has finished goes
// to the model and nowhere else. A detection frees the arena, then opens a
// turn the same way GO does (listening earcon, turn_start, mic).
void wakeTick(uint32_t nowMs) {
  if (g_followUp.isOpen()) {
    followUpTick(nowMs);
    return;
  }
  if (bargeTick(nowMs)) return;
  if (!wakeWanted()) {
    stopWakeListening();
    return;
  }
  // An earcon still sounding (e.g. the error tone after a failed turn) keeps
  // the shared GPIO 43 until it ends: listening starts on a later loop rather
  // than blocking this one.
  if (!g_wakeListening && earconPlaying()) return;
  startWakeListening();
  if (!g_wakeListening) return;
  bool heard = false;
#ifdef BOB_TEST_CONSOLE
  heard = g_testWakeFire;
  g_testWakeFire = false;
#endif
  while (!heard && capture.nextFrame()) {
    wakeWordFeed(capture.frame(), config::kSamplesPerFrame);
    heard = wakeWordDetected();
  }
  if (capture.failed()) {
    g_wakeListening = false;
    stopCapture();
    wakeWordEnd();
    failWake("record");
    return;
  }
  journalWakeStats(nowMs);
  if (!heard) return;
  stopWakeListening();
  journalEvent("wake_detected",
               String("max_invoke_us=") + wakeWordMaxInvokeUs());
  beginTurn(false);
  g_wakeTurn = state == State::kCapturing;
  if (g_wakeTurn) chromeSetShortcuts(kStripWakeCapturing, nowMs);
}

// --- Follow-up window (follow_up.h) ---

static_assert(kFollowUpPreRollFrames < kUplinkQueueFrames,
              "the pre-roll fits the uplink queue with room for live frames");

static bool followUpAllowed() {
  return welcomed && state == State::kReady &&
         followUpAfterReply(settings().mode, g_wakeFailed, settings().dnd);
}

// Whether a finished reply may open a window: Always awake (followUpAfterReply),
// the chain allows another follow-up, and no announcement is waiting (it
// takes priority, so no earcon or mic first). `why` says what said no.
bool followUpWanted(const char** why) {
  *why = "";
  if (!welcomed || !followUpAfterReply(settings().mode, g_wakeFailed, settings().dnd)) {
    *why = "mode";
    return false;
  }
  if (!g_chain.allowsWindow()) {
    *why = g_chain.followUps() >= kMaxFollowUpsPerWake ? "limit" : "ended";
    return false;
  }
  if (g_announceInbox.held() > 0) {
    *why = "announce";
    return false;
  }
  return true;
}

// A reply finished playing in Always awake: listen on without the wake word.
// The listen earcon says so before the mic opens (shared GPIO 43). The wake
// arena stays free; the mic ring and the uplink queue (the pre-roll now, the
// turn's frames if speech follows) are held. False: no window (the mic or the
// queue's heap failed), so the caller draws READY itself.
bool openFollowUp() {
  const char* why = "";
  if (!followUpWanted(&why)) {
    // Only worth a line when Always awake would otherwise have listened on.
    if (strcmp(why, "mode") != 0) {
      journalEvent("followup_skipped", String("reason=") + why);
    }
    return false;
  }
  stopWakeListening();
  // The mic cannot open before the earcon (they share GPIO 43), so the heap
  // is checked first and a mic failure follows the earcon.
  if (!allocUplink()) {
    journalEvent("followup_failed", String("reason=heap,") + heapNow());
    return false;
  }
  playEarcon(Earcon::kListenStart);
  waitForEarcon(150);
  releaseSpeakerForMic();
  if (!capture.begin()) {
    dropUplink();
    journalEvent("followup_failed", "reason=mic");
    return false;
  }
  // The mic has been open since here: how long after the speaker drained.
  const uint32_t sinceDrainMs = millis() - g_replyDrainedAt;
  capture.resetSequence();
  vadReset(kFollowUpOnsetMs, VadOnset::kFollowUp);  // strict evidence before opening a turn.
  g_followUp.open(millis());
  enterReady();
  journalEvent("followup_opened",
               String("window_ms=") + g_followUp.windowMs() + ",guard_ms=" + kFollowUpGuardMs +
                   ",since_drain_ms=" + sinceDrainMs +
                   ",pre_roll=" + (g_uplinkBuf != nullptr ? 1 : 0) + "," + heapNow());
  return true;
}

// Ends the window. Speech keeps the mic and the pre-roll for its turn; any
// other reason closes the mic, and wake listening takes it on the next loop.
void closeFollowUp(FollowUpClose reason) {
  if (!g_followUp.isOpen()) return;
  g_followUp.close();
  const bool speech = reason == FollowUpClose::kSpeech;
  if (!speech) stopCapture();
  if (reason == FollowUpClose::kTimeout) {
    playEarcon(Earcon::kFollowupClose);  // quietly: no toast.
    waitForEarcon(150);               // before wake listening takes the pin.
  }
  journalEvent("followup_closed",
               String("reason=") + followUpCloseName(reason));
  if (!speech && state == State::kReady) {
    enterReady();  // the card or READY again.
    if (g_cardShown) {
      journalEvent("reply_card_shown", String("lines=") + g_cardLines);
    }
  }
}

// Keeps the newest kFollowUpPreRollFrames framed frames in the uplink queue,
// dropping the oldest.
static void holdPreRollFrame(const uint8_t* frame, size_t length) {
  if (g_uplink.size() == kFollowUpPreRollFrames) g_uplink.dropOldest();
  enqueueUplink(frame, length);
}

// Speech in the window: a turn opens without the wake word and without an
// earcon (the user is already talking; the mic stays open). The pre-roll
// frames go out behind turn_start ahead of the live ones, in messages numbered from 0
// (pumpUplink), and the VAD hears them again, so the turn ends on silence
// like a wake turn.
static void beginFollowUpTurn() {
  const size_t preRoll = g_uplink.size();
  closeFollowUp(FollowUpClose::kSpeech);
  resetTurn();
  // Capture start is the speech onset that opened the turn (the mic was already open).
  timingBegin(TimingSource::kFollowUp, static_cast<uint32_t>(preRoll) * kVadFrameMs);  // the VAD re-hears the pre-roll.
  g_followUpTurn = true;
  g_chain.followUpTurn();
  g_goTurnHeld = false;
  for (size_t i = 0; i < preRoll; ++i) {
    const uint8_t* frame = uplinkFrameAt(i);  // packUplinkBatch numbers the messages.
    vadFeed(reinterpret_cast<const int16_t*>(frame + config::kHeaderBytes),
            config::kSamplesPerFrame);
  }
  capture.setSequence(preRoll);
  sendTurnStart();
  g_wakeTurn = true;
  transitionTo(State::kCapturing, "LISTENING", "Speak now", kColorGreen, "");
  pumpUplink(0);
  journalEvent("turn_started",
               String("mode=followup,pre_roll_frames=") + preRoll);
}

// Every finished frame is pre-roll and goes to the VAD; its onset opens a
// turn, the deadline closes the window.
static void followUpTick(uint32_t nowMs) {
  if (!followUpAllowed()) {
    closeFollowUp(FollowUpClose::kMode);
    return;
  }
  bool speech = false;
  while (!speech && capture.nextFrame()) {
    capture.sendFrame(holdPreRollFrame);
    vadFeed(capture.frame(), config::kSamplesPerFrame);
    speech = vadHeardSpeech();
  }
  if (capture.failed()) {
    closeFollowUp(FollowUpClose::kMic);
    return;
  }
  switch (g_followUp.decide(nowMs, speech, vadVoicedRun())) {
    case FollowUpDecision::kSpeech: beginFollowUpTurn(); break;
    case FollowUpDecision::kTimeout: closeFollowUp(FollowUpClose::kTimeout); break;
    case FollowUpDecision::kNone: break;
  }
}

}  // namespace fsm

using namespace fsm;

// A wake word set from outside the keyboard (device_control wake_word, `T wake`): persisted, the running model freed so wakeTick()
// starts the new one, the screen redrawn. False when this build does not have the word.
bool fsm::applyWakeWord(WakeWord word, const char* source) {
  if (static_cast<uint8_t>(word) >= kWakeModelCount) return false;
  if (settings().wakeWord == word) return true;
  if (!settingsSetWakeWord(word)) return false;
  stopWakeListening();
  g_wakeFailed = false;
  markDeviceStateDirty(millis());
  if (state == State::kReady) { enterReady(); chromeSetShortcuts(readyStrip(), millis()); }
  journalEvent("wake_word_changed", String("word=") + wakeModelSpec(word).name + ",source=" + source);
  return true;
}

#ifdef BOB_TEST_CONSOLE
// `T wake word <name>`: sets the wake word outright (HIL scenarios must not
// depend on what an earlier run left in NVS). The same effect as `w` when it
// changes the word; nothing when it is already set.
bool testSetWakeWord(const char* name) {
  for (uint8_t i = 0; i < sizeof(kWakeModels) / sizeof(kWakeModels[0]); ++i) {
    const WakeWord word = static_cast<WakeWord>(i);
    if (strcmp(wakeModelSpec(word).name, name) != 0) continue;
    if (settings().wakeWord == word) return true;
    settingsSetWakeWord(word);
    stopWakeListening();  // wakeTick() starts the new model on the next loop.
    g_wakeFailed = false;
    if (state == State::kReady) { enterReady(); chromeSetShortcuts(readyStrip(), millis()); }
    journalEvent("wake_word_changed",
                 String("word=") + wakeModelSpec(word).name + ",source=test");
    return true;
  }
  return false;
}

bool testSetWakeWire(const char* name) {
  WakeWord word;
  return parseWakeWordWire(name, word) && applyWakeWord(word, "test");
}

bool testFireWake() {
  if (!g_wakeListening) return false;
  g_testWakeFire = true;
  return true;
}
#endif

}  // namespace bob
