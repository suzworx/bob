#include "chrome_identity.h"
// Bob Cardputer v2 — main state machine: module wiring, screens, keys, setup and loop.
#include "board.h"
#include "state_internal.h"
#include "audio_hang.h"
#if defined(BOB_BOARD_WAVESHARE_185C)
#include "bob_tokens.h"
#include "round_feedback.h"
#endif

namespace bob {

// Global callback pointer used by Network's static callback trampoline.
WebSocketEventCallback g_wsCallback = nullptr;

namespace fsm {

// Global module instances.
Network network;
AudioCapture capture;
AudioPlayback playback;

static struct Initializer {
  Initializer();
} initializer;

// Runtime state.
State state = State::kBoot;
ServerStage serverStage = ServerStage::kIdle;
AudioFormat negotiatedFormat = AudioFormat::kPcm16;
String turnRef;
bool welcomed = false;

// Fn+` held at power-on (#678).
static bool g_rescueChord = false;
// Ready shows ALL SET! once after a pairing, until a key or a turn (#678).
bool g_allSetPending = false;

// --- Alexa-class device features (epic #311) ---

// Shortcut strip texts, one per state; [ ] marks a key (chrome.h). The round
// touch board has no GO key on screen (a tap is GO, BOOT is push-to-talk), so
// its strips name the tap instead (owner UX audit 2026-10-20, #1063); the
// Cardputer's are unchanged.
#if defined(BOB_BOARD_WAVESHARE_185C)
constexpr char kStripReady[] =
    "[-][=] volume  [m] mute  [k] mode  [c] chats  "
    "[n] new chat  [s] spaces  [,] settings  [h] help";
constexpr char kStripReplyCard[] = "[;][.] page  [any key] close";
constexpr char kStripCapturing[] = "Let go to send";
constexpr char kStripWakeCapturing[] = "Listening. Pause or tap to send";
constexpr char kStripRetry[] = "Tap to try again";
#else
constexpr char kStripReady[] =
    "[GO] hold to talk  [-][=] volume  [m] mute  [k] mode  [c] chats  "
    "[n] new chat  [s] spaces  [,] settings  [h] help";
constexpr char kStripReplyCard[] = "[;][.] scroll  [any key] close  [GO] talk";
constexpr char kStripCapturing[] = "Let go of [GO] to send";
constexpr char kStripWakeCapturing[] = "Listening. Pause to send  [GO] send now";
constexpr char kStripRetry[] = "[GO] try again";
#endif
constexpr char kStripAnnounceOnly[] =
    "Announcements only  [k] mode  [-][=] volume  [m] mute  [c] chats  "
    "[s] spaces  [h] help";
constexpr char kStripAwaiting[] = "[x] stop  [-][=] volume  [m] mute";
constexpr char kStripPicker[] = "[;] up  [.] down  [Enter] select  [`] back";
constexpr char kStripNewChat[] = "[Enter] start a new chat  [`] cancel";
constexpr char kStripNewChatRetry[] = "[Enter] try again  [`] cancel";
constexpr char kStripNewChatPending[] = "[`] cancel";
constexpr char kStripHelp[] = "[;][.] scroll  [`] back";
constexpr char kStripAnnounce[] = "[Any key] dismiss";
constexpr char kStripRinging[] = "[Any key] stop ringing";
constexpr char kStripConnecting[] = "Connecting...";
constexpr char kStripRetryNow[] = "[Enter] try now  [,] settings";
constexpr char kStripCheckAgain[] = "[Enter] check again  [,] settings";
constexpr char kStripAddWifi[] = "[,] add Wi-Fi";

constexpr char kStripFollowUp[] = "Listening... just talk";

// The active wake word's phrase (wake_models.h), for the strip, toast and HELP.
const char* wakePhrase() { return wakeModelSpec(settings().wakeWord).phrase; }

// Always awake's strip, led by the active phrase ("Say Alexa ...").
static const char* wakeStrip() {
  static char strip[160];  // chrome.cpp kShortcutBytes.
#if defined(BOB_BOARD_WAVESHARE_185C)
  snprintf(strip, sizeof(strip),
           "Say %s  [-][=] volume  [m] mute  [k] mode  "
           "[w] wake word  [c] chats  [n] new chat  [s] spaces  [h] help",
           wakePhrase());
#else
  snprintf(strip, sizeof(strip),
           "Say %s  [GO] hold to talk  [-][=] volume  [m] mute  [k] mode  "
           "[w] wake word  [c] chats  [n] new chat  [s] spaces  [h] help",
           wakePhrase());
#endif
  return strip;
}

// The reply card while Always awake is listening again behind it: the strip
// says so first, so the card does not read as a hang (owner photo 2026-09-24).
static const char* replyCardWakeStrip() {
  static char strip[96];
  snprintf(strip, sizeof(strip), "Say %s to talk  [;][.] scroll  [any key] close", wakePhrase());
  return strip;
}

// The slowest main-loop iteration since boot (ms), for `T state` loop_max.
static uint32_t g_loopMaxMs = 0;

// Uplink frames sendBinary could not send: the count at this turn's start,
// and whether the last loop was capturing, so the turn's drops are journaled
// once when its capture ends, whichever way it ends.
uint32_t g_txDropsAtTurnStart = 0;
static bool g_wasCapturing = false;

// rx_text_dropped reports lost to a full report queue, already journaled.
static uint32_t g_rxReportsLostJournaled = 0;

bool wakeFallback() {
  return settings().mode == DeviceMode::kWake && g_wakeFailed;
}

// HELP's phrase line: the phrase while Always awake listens, else nullptr.
static const char* helpWakePhrase() {
  return settings().mode == DeviceMode::kWake && !g_wakeFailed ? wakePhrase() : nullptr;
}

const char* readyStrip() {
  if (g_followUp.isOpen()) return kStripFollowUp;
  const bool wakeOn = settings().mode == DeviceMode::kWake && !g_wakeFailed;
  if (g_cardShown) return wakeOn ? replyCardWakeStrip() : kStripReplyCard;
  switch (settings().mode) {
    case DeviceMode::kAnnounceOnly: return kStripAnnounceOnly;
    case DeviceMode::kWake: return g_wakeFailed ? kStripReady : wakeStrip();
    case DeviceMode::kPtt: break;
  }
  return kStripReady;
}

// The shortcut strip follows the state; `hint` only speaks for the screens
// with no shortcuts of their own (missing config, pairing).
static const char* stripFor(const char* hint) {
  switch (state) {
    case State::kReady: return readyStrip();
    case State::kCapturing: return g_wakeTurn ? kStripWakeCapturing : kStripCapturing;
    case State::kAwaiting: return kStripAwaiting;
    case State::kSelecting: return kStripPicker;
    case State::kHelp: return kStripHelp;
    case State::kAnnounce: return ringing() ? kStripRinging : kStripAnnounce;
    case State::kSettings: return settingsStrip();
    case State::kWifi: return hint != nullptr && hint[0] != '\0' ? hint : kStripConnecting;
    case State::kSocket: return kStripRetry;
    case State::kError: return configured() ? kStripRetry : hint;
    case State::kNewConversation:
      if (g_newConversationPending) return kStripNewChatPending;
      return g_newConversationRequestId.length() > 0 ? kStripNewChatRetry : kStripNewChat;
    default: return hint != nullptr ? hint : "";
  }
}

void refreshStatusLine() {
  StatusLineView view;
  view.mode = settings().mode;
  view.wakeFallback = wakeFallback();
  view.micOpen = capture.active();
  view.muted = settings().muted;
  view.volume = settings().volume;
  view.dnd = settings().dnd;
  view.batteryPct = batteryPct();
  view.charging = batteryCharging();
  view.wifiOk = network.wifiStatus() == WL_CONNECTED;
  switch (activeProfile()) {
    case Profile::kDev: view.serverBadge = "DEV"; break;
    case Profile::kCustom: view.serverBadge = "CUSTOM"; break;
    case Profile::kProd: view.serverBadge = nullptr; break;
  }
  chromeSetStatus(view);
}

#if defined(BOB_BOARD_WAVESHARE_185C)
// The round board's joining screens say one token word (design/bob/tokens.json): "Connecting" with
// a hello Bob while Wi-Fi and the server come up, "Offline" with a drooping Bob when the Wi-Fi
// dropped or the server stays away. The screens that need the person (no Wi-Fi saved, every
// network failed, a sign-in page, no internet) keep their own words. A green colour asks the
// round UI for the hello pose, yellow for the offline one.
static void roundJoinCaption(const char** title, uint32_t* color) {
  bool connecting = false, offline = false;
  if (state == State::kWifi) {
    switch (wifiManagerView().phase) {
      case WifiPhase::kScanning:
      case WifiPhase::kTrying:
      case WifiPhase::kProbing:
      case WifiPhase::kOnline: connecting = true; break;
      case WifiPhase::kDropped: offline = true; break;
      default: break;
    }
  } else if (state == State::kSocket) {
    offline = strcmp(*title, assistantDisplay(AssistantLabel::kAway)) == 0;
    connecting = !offline;
  }
  if (connecting) {
    *title = bobtok::kCaptionConnecting;
    *color = kColorGreen;
  } else if (offline) {
    *title = bobtok::kCaptionOffline;
    *color = kColorYellow;
  }
}
#endif

static void drawCurrentState(const char* title, const char* detail, uint32_t color,
                      const char* hint) {
  const bool wifiOk = network.wifiStatus() == WL_CONNECTED;
  chromeSetVisible(state != State::kPairing);
  chromeSetShortcuts(stripFor(hint), millis());
  if (state == State::kHelp) {
    drawHelp(g_helpScroll, helpWakePhrase());
    return;
  }
  if (state == State::kAnnounce) {
    drawAnnouncementCard(g_announce, ringing(), g_announceMissed);
    return;
  }
  if (state == State::kSettings) {
    settingsDraw(millis());
    return;
  }
#if defined(BOB_BOARD_WAVESHARE_185C)
  // The round board keeps the reply's words up while the follow-up window listens (the ring and
  // the mic chip say it listens), and shows them over the speaking Bob while the reply plays.
  if (state == State::kReady && g_followUp.isOpen() && g_cardShown) {
    drawReplyCard(g_reply, g_cardScroll);
    return;
  }
  if (state == State::kAwaiting && g_replyLive) {
    drawSpeakingReply(g_reply, g_cardScroll);
    return;
  }
#endif
  if (state == State::kReady && g_followUp.isOpen()) {
    drawStatus("Listening...", "(say more, or wait)", kColorGreen, wifiOk, welcomed);
    return;
  }
  if (state == State::kReady && g_cardShown) {
    drawReplyCard(g_reply, g_cardScroll);
    return;
  }
  if (state == State::kPairing && g_pairing.active) {
    drawPairingScreen(g_pairing, millis());
    return;
  }
  if (state == State::kSocket && g_pairedName[0] != '\0') {
    drawPairedAs(g_pairedName);
    return;
  }
  if (state == State::kReady && g_allSetPending) {
#if defined(BOB_BOARD_WAVESHARE_185C)
    const char* lines[] = {"Try it: tap and ask", "\"What's the weather?\"", "",
                           "Hold the screen for shortcuts."};
#else
    const char* lines[] = {"Try it: hold GO and ask", "\"What's the weather?\"", "",
                           "Press , any time for settings."};
#endif
    drawLinesScreen("ALL SET!", kColorGreen, lines, 4);
    return;
  }
  if (state == State::kReady) {
    drawReadyScreen(g_deviceName,
                    g_activeConversation.present ? g_activeConversation.title : nullptr,
                    g_activeSpace.present ? g_activeSpace.name : nullptr,
                    wifiOk, welcomed,
                    activeProfile() == Profile::kProd ? nullptr : profileDisplayName(activeProfile()),
                    assistantDisplay(AssistantLabel::kReady));
    return;
  }
#if defined(BOB_BOARD_WAVESHARE_185C)
  roundJoinCaption(&title, &color);
#endif
  drawStatus(title, detail, color, wifiOk, welcomed);
  // Boot and connecting: which firmware is flashed, small and dim.
  if (state == State::kBoot || state == State::kWifi || state == State::kSocket) {
    drawBuildTag(kFirmwareNumericVersion);
  }
}

void transitionTo(State next, const char* title, const char* detail,
                  uint32_t color, const char* hint) {
  const State prev = state;
  state = next;
  if (prev == State::kSelecting && next != State::kSelecting) {
    endConversationList();
  }
#if defined(BOB_BOARD_WAVESHARE_185C)
  // A status (thinking, speaking) while the reply's words are up changes nothing on screen:
  // redrawing would blank the text and Bob for a frame.
  if (prev == State::kAwaiting && next == State::kAwaiting && g_replyLive && replyOnScreen()) return;
#endif
  drawCurrentState(title, detail, color, hint);
}

void enterReady() {
  transitionTo(State::kReady, assistantDisplay(AssistantLabel::kReady),
               boardText("Hold BTN GO to talk", "Tap to talk"), kColorGreen, kStripReady);
}

// journal() with the current state and session: one call instead of the
// same four arguments at every event.
void journalEvent(const char* event) { journal(event, state, network.sessionId()); sendDeviceLog(event); }

void journalEvent(const char* event, const String& detail) {
  journal(event, state, network.sessionId(), detail);
  sendDeviceLog(event);
}

// Once per turn (numbers only): internal heap now, its low-water mark since
// boot, and the largest block the next MP3 decoder could get.
void journalTurnHeap() {
  journalEvent("turn_heap",
               String("free=") + heap_caps_get_free_size(MALLOC_CAP_8BIT) +
                   ",min=" + heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT) +
                   ",largest=" + heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
}

// Pushes held while a turn was in flight (contract R10).
void applyHeldPushes() {
  if (g_pendingActiveValid) {
    g_pendingActiveValid = false;
    applyActiveConversation(g_pendingActive);
  }
  if (g_pendingSpaceValid) {
    g_pendingSpaceValid = false;
    applyActiveSpace(g_pendingSpace);
  }
}

// The one key dispatcher: real key changes and the HIL console's injected
// keys (BOB_TEST_CONSOLE) both land here.
static void dispatchKeys(const Keyboard_Class::KeysState& keys) {
  const bool anyKey =
      !keys.word.empty() || keys.enter || keys.del || keys.space || keys.tab;

  if (state == State::kAnnounce) {
    if (anyKey) dismissAnnouncement("key");
    return;
  }
  if (state == State::kSettings) {
    if (settingsKeys(keys, millis()) == SettingsExit::kClose) leaveSettings();
    return;
  }
  // [,] opens Settings from the Wi-Fi screens to add or fix a network (#677),
  // and from the pairing and server-away screens to switch server (#679).
  if (state == State::kWifi || state == State::kPairing || state == State::kSocket) {
    for (char c : keys.word) {
      if (c == ',') {
        enterSettings();
        return;
      }
    }
  }
  // The Wi-Fi screens: [Enter] skips the wait and tries again now (#676).
  if (state == State::kWifi) {
    if (keys.enter) wifiManagerRetryNow();
    return;
  }
#if defined(BOB_BOARD_WAVESHARE_185C)
  // ; and . (a swipe) page the reply on screen, while it plays and through the
  // follow-up window, which they leave open.
  const bool pageKey = keys.word.size() == 1 && (keys.word[0] == ';' || keys.word[0] == '.');
  if (pageKey && ((state == State::kAwaiting && g_replyLive) || (state == State::kReady && g_cardShown))) {
    pageReply(keys.word[0] == ';' ? -1 : 1);
    return;
  }
#endif
  // Any key closes the follow-up window at once and does nothing else; x is
  // the stop key.
  if (g_followUp.isOpen() && anyKey) {
    const bool stop = keys.word.size() == 1 && keys.word[0] == 'x';
    closeFollowUp(stop ? FollowUpClose::kStop : FollowUpClose::kKey);
    return;
  }
  if (state == State::kReady && g_allSetPending && anyKey) {
    g_allSetPending = false;
    enterReady();
    return;
  }
  if (state == State::kReady && g_cardShown && anyKey) {
    // ; and . scroll the card; any other key closes it and then does its
    // usual job (` only closes).
    bool scrolled = false;
    for (char c : keys.word) {
      if (c != ';' && c != '.') continue;
      scrolled = true;
      if (stepWithin(&g_cardScroll, cardMaxFirstLine(g_cardLines), c == ';' ? -1 : 1)) {
        drawReplyCard(g_reply, g_cardScroll);
      }
    }
    if (scrolled) return;
    closeReplyCard();
    if (keys.word.size() == 1 && keys.word[0] == '`') return;
  }
  if (state == State::kReady || state == State::kAwaiting) {
    for (char c : keys.word) {
      if (c == '-' || c == '_') {
        onVolumeKey(-1);
        return;
      }
      if (c == '=' || c == '+') {
        onVolumeKey(1);
        return;
      }
      if (c == 'm') {
        onMuteKey();
        return;
      }
      if (c == 'x' && state == State::kAwaiting) {
        stopReply("key");
        return;
      }
    }
  }

  if (state == State::kHelp) {
    for (char c : keys.word) {
      if (c == ';' || c == '.') {
        if (stepWithin(&g_helpScroll, cardMaxFirstLine(helpLineCount()), c == ';' ? -1 : 1)) {
          drawHelp(g_helpScroll, helpWakePhrase());
        }
      } else if (c == '`') {
        closeHelp();
        return;
      }
    }
  } else if (state == State::kReady) {
    for (char c : keys.word) {
      if (c == 'c') {
        enterPicker();
        break;
      }
      if (c == 'n') {
        enterNewConversation();
        break;
      }
      if (c == 's') {
        enterSpacePicker();
        break;
      }
      if (c == 'k') {
        onModeKey();
        break;
      }
      if (c == 'w') {
        onWakeWordKey();
        break;
      }
      if (c == 'h' || c == '?') {
        openHelp();
        break;
      }
      if (c == ',') {
        enterSettings();
        break;
      }
    }
  } else if (state == State::kNewConversation) {
    newConversationKeys(keys);
  } else if (state == State::kPairing) {
    pairingKeys(keys);
  } else if (state == State::kSelecting) {
    pickerKeys(keys);
  }
}

static void handleKeyboard() {
  if (!board::keysChanged()) return;
  dispatchKeys(board::keys());
}

Initializer::Initializer() {
  network.setCallback(onSocketEvent);
  g_wsCallback = onSocketEvent;
}

}  // namespace fsm

using namespace fsm;

#ifdef BOB_TEST_CONSOLE
// HIL test console hooks (test_console.cpp). Injected input goes through the
// same dispatchers as the real keyboard and GO button.
// Each injected key is a press followed by its release, as on the keyboard:
// Settings counts a key on its press edge (#677), so two presses of the same
// key must be two presses.
static void testPressAndRelease(const Keyboard_Class::KeysState& keys) {
  dispatchKeys(keys);
  dispatchKeys(Keyboard_Class::KeysState());
}

void testPressKey(char c) {
  Keyboard_Class::KeysState keys;
  keys.word.push_back(c);
  testPressAndRelease(keys);
}

void testPressEnter() {
  Keyboard_Class::KeysState keys;
  keys.enter = true;
  testPressAndRelease(keys);
}

void testPressDel() {
  Keyboard_Class::KeysState keys;
  keys.del = true;
  testPressAndRelease(keys);
}

void testPressTab() {
  Keyboard_Class::KeysState keys;
  keys.tab = true;
  testPressAndRelease(keys);
}

void testPressFn(char c) {
  Keyboard_Class::KeysState keys;
  keys.fn = true;
  keys.word.push_back(c);
  testPressAndRelease(keys);
}

String testStateLine() {
  return String("state=") + stateName(state) + " mode=" + deviceModeName(settings().mode) +
         " vol=" + settings().volume + " muted=" + (settings().muted ? 1 : 0) +
         " dnd=" + (settings().dnd ? 1 : 0) + " rssi=" + WiFi.RSSI() +
         // Reliability counters since boot: receive-queue high-water mark,
         // text messages received / dropped, journal lines dropped, the
         // slowest main-loop iteration, and uplink frames not sent. att_drop:
         // connect attempts whose end event the queue lost (#709,
         // expireAttempt); not last, since HIL checks end on tx_drop=0$.
         // ws_loop_max: the slowest client_.loop() pass on ws_net (a TLS
         // handshake, #710), so a loop_max stall can be told apart from it.
         // Before log_drop: HIL matches "log_drop=N loop_max=N tx_drop=0$".
         " rxq_max=" + network.rxQueueHighWater() + " rxt=" + network.rxTextFrames() +
         " rxt_drop=" + network.rxTextDrops() + " att_drop=" + network.attemptEndDrops() +
         " ws_loop_max=" + network.wsLoopMaxMs() + " log_drop=" + journalDroppedLines() +
         " loop_max=" + g_loopMaxMs + " tx_drop=" + network.txAudioDrops();
}

void testArmTone(uint32_t ms) { capture.armTestTone(ms); }

// `T state reset`: loop_max, ws_loop_max and tx_drop start again, so one
// scenario's stall does not fail the next.
void testResetCounters() {
  g_loopMaxMs = 0;
  network.resetWsLoopMax();
  network.resetTxAudioDrops();
  g_txDropsAtTurnStart = 0;
}
#endif

void stateSetup() {
  journalBegin();  // non-blocking Serial; config.serial_baudrate stays 0.
  board::begin();
  settingsLoad();  // applies the saved speaker level before any sound.
  g_rescueChord = rescueChordHeld();
  deviceSettingsBegin();  // networks, server profile, per-profile token (#675).
  chromeBegin();
  journal("settings_loaded", state, "",
          String("volume=") + settings().volume + ",muted=" + (settings().muted ? 1 : 0) +
              ",mode=" + deviceModeName(settings().mode) +
              ",dnd=" + (settings().dnd ? 1 : 0));

  // Which board M5Unified actually detected, and the speaker gain it derived
  // from that. This matters for audibility, not curiosity: the Cardputer ADV
  // carries an ES8311 codec and M5Unified only installs its amplifier-enable
  // callback when it detects board_M5CardputerADV (24 == ADV, 14 == original;
  // see the Cardputer branch of M5Unified's speaker config). Detect the
  // original on ADV hardware and the amp is never switched on, so playback
  // runs to completion with perfect counters and no sound — a failure mode no
  // digital measurement in this firmware can see.
  {
    auto spk = M5Cardputer.Speaker.config();
    journal("board_detected", state, "",
            String("board=") + static_cast<int>(M5.getBoard()) +
                ",spk_mag=" + spk.magnification +
                ",spk_rate=" + spk.sample_rate +
                ",i2s_port=" + static_cast<int>(spk.i2s_port) +
                ",dma_len=" + spk.dma_buf_len +
                ",dma_count=" + spk.dma_buf_count);
  }

  startAudioHangWatch();  // a stuck audio-driver call restarts the device instead of hanging it.
  network.setup();

  // No saved network is not a dead end any more (#677): the Wi-Fi screen says
  // NO WI-FI SAVED and [,] opens Settings to add one.
  if (!configured()) journal("config_missing", state, "");

  // Scan, then join the saved networks in priority order (#676).
  // The probe runs on its own task; never while a socket connect (its own
  // TLS handshake) is open (#710).
  wifiManagerBegin([]() { return network.probeInternet(); },
                   []() { return network.connecting(); });
  // Modem sleep (the Arduino-ESP32 default) lets the radio nap between DTIM
  // beacons. During an MP3 reply the sender keeps streaming while the device
  // sleeps, so lwIP's receive window fills and delivery collapses into
  // multi-second gaps — measured on-device as ~2.3 s readCb stalls and 21/30
  // ACCEPTED TRADEOFF: this is unconditional and never re-enabled, so the
  // radio stays awake through long idles on a battery-powered device. Keeping
  // it always-on is deliberate for now because the alternative — toggling per
  // turn — risks reintroducing the stall at the exact moment a reply streams,
  // and reply reliability outranks idle current draw for this device. Revisit
  // by disabling sleep on turn_start and restoring it after playback_end, and
  // re-assert it on the got-IP event, since some Arduino-ESP32 versions reset
  // the sleep policy on reassociation.
  // frame truncation. Keep the radio awake for the whole session.
  WiFi.setSleep(false);
  drawWifiScreen();
  if (g_rescueChord) {
    enterSettings(SettingsEntry::kWifiList, "rescue_chord");
  } else if (!configured()) {
    enterSettings(SettingsEntry::kSetup, "first_boot");  // guided Setup (#678)
  }
  updateBoot();
  journal("boot", state, "", String("fw=") + kFirmwareVersion + " build=" + BOB_BUILD_ID_TEXT);
#ifdef BOB_TONE_TEST
  // Speaker-clock calibration probe (M6): plays 1 s of 1 kHz and journals the
  // wall time. Build with -DBOB_TONE_TEST; see AudioPlayback::toneTest().
  playback.toneTest();
#endif
}

// Per-phase breadcrumb: a loop pass phase that runs over 50 ms journals loop_slow_phase.
static const char* g_phaseName = nullptr;
static uint32_t g_phaseAt = 0;
static void loopPhase(const char* name) {
  const uint32_t now = micros();
  if (g_phaseName != nullptr && now - g_phaseAt > 30000) {
    journalEvent("loop_slow_phase", String("phase=") + g_phaseName + ",ms=" + (now - g_phaseAt) / 1000);
  }
  g_phaseName = name;
  g_phaseAt = micros();
}

void stateLoop() {
  const uint32_t loopStart = millis();
  loopPhase("board_update");
  board::update();
  loopPhase("network_poll");
  network.pollEvents();
  ControlDrop drop;
  while (network.takeControlDrop(drop)) {
    journalEvent("control_dropped",
                 String("reason=") + controlDropReasonName(drop.reason) + ",type=" + drop.type);
  }
  RxTextDrop rxDrop;
  while (network.takeRxTextDrop(rxDrop)) {
    journalEvent("rx_text_dropped",
                 String("reason=") + rxTextDropReasonName(rxDrop.reason) + ",type=" + rxDrop.type);
  }
  // Drops whose report did not fit the report queue: still counted, and the
  // loss of their lines is journaled here.
  const uint32_t reportsLost = network.rxDropReportsLost();
  if (reportsLost != g_rxReportsLostJournaled) {
    journalEvent("rx_text_dropped",
                 String("rx_drop_reports_lost=") + (reportsLost - g_rxReportsLostJournaled));
    g_rxReportsLostJournaled = reportsLost;
  }
  loopPhase("playback");
  playback.loop();

  loopPhase("wifi");
  updateWifiStatus();
  if (wifiManagerLoop(millis()) && state == State::kWifi) drawWifiScreen();
  superviseConnections();
  loopPhase("ptt_reply");
  handlePttAndReply();
  // A turn whose mic has closed drains its queue a batch per loop, then sends turn_end.
  if (g_turnEndPending) pumpUplink(0);
  loopPhase("keyboard");
  handleKeyboard();
  if (state == State::kSettings &&
      settingsTick(millis(), board::keys(), board::anyKeyPressed()) == SettingsExit::kClose) {
    leaveSettings();
  }
#ifdef BOB_TEST_CONSOLE
  testConsolePoll();
#endif
  loopPhase("wake");
  wakeTick(millis());
  loopPhase("pickers_pairing_update");
#ifdef BOB_AUTO_TURN
  handleAutoTurn();
#endif

  pickerTick();
  pairingTick(loopStart);
  updateTick(loopStart);
#if defined(BOB_BOARD_WAVESHARE_185C)
  replyPageTick(loopStart);
#endif

  // Cheap, throttled, partial-redraw activity indicators so listening vs.
  // playback are unmistakable at a glance even with no button correlation
  // (e.g. during the automated device-test.mjs downlink run).
  if (state == State::kCapturing || g_followUp.isOpen()) {
    updateListeningIndicator(loopStart);
  } else if (state == State::kAwaiting) {
#if defined(BOB_BOARD_WAVESHARE_185C)
    // The count is only this reply's while playback runs: before playback_start it still holds the last
    // reply's, which posed a thinking Bob as speaking (and froze him) from the second turn on.
    updatePlaybackIndicator(loopStart, playback.active() ? playback.downFrameCount() : 0);
#else
    updatePlaybackIndicator(loopStart, playback.downFrameCount());
#endif
  }

  // Device features (epic #311): announcement card housekeeping, mode/DND
  // held during a turn, queued announcements, battery, the debounced
  // device_state, NVS (never mid-turn: a flash write stalls the cache), and
  // the chrome, which only repaints what changed.
  loopPhase("announce_timers");
  tickAnnouncement(loopStart);
  if (state == State::kReady) applyHeldControl();
  if (state == State::kReady) presentNextAnnouncement();
  // #457: the running-timer countdown, only on the plain Ready screen (never
  // over a turn, playback, the reply card, follow-up or a ring card). It
  // repaints only when its text changes; anything else on screen invalidates it.
  if (state == State::kReady && !g_cardShown && !g_followUp.isOpen() && !playback.active()) {
    timersBandUpdate(g_timers, loopStart);
  } else {
    timersBandInvalidate();
  }
  loopPhase("battery");
  if (batteryPoll(loopStart)) {
    markDeviceStateDirty(loopStart);
    journalEvent("battery",
                 String("pct=") + batteryPct() + ",charging=" + batteryCharging());
  }
  loopPhase("device_state");
  if (welcomed && deviceStateDue(loopStart)) sendDeviceState();
  if (state != State::kCapturing && state != State::kAwaiting && !playback.active()) {
    const uint8_t saved = settingsPersistIfDue(loopStart);
    if (saved != 0) {
      journalEvent("settings_saved",
                   String("fields=") + settingsFieldNames(saved) + ",volume=" + settings().volume);
    }
  }
  loopPhase("status_line");
  refreshStatusLine();
  loopPhase("chrome");
  static uint8_t chromeSkips = 0;
  if (millis() - loopStart < 120 || chromeSkips >= 2) {  // a pass that already ran long leaves the redraw to the next one (at most twice in a row)
    chromeSkips = 0;
    chromeTick(millis());
  } else {
    ++chromeSkips;
  }
  loopPhase("tail");

  // The socket itself is now serviced continuously by network.cpp's own
  // FreeRTOS task; pollEvents() just drains events that task already parsed
  // off a queue, so a second aggressive call during playback is no longer
  // needed the way client_.loop() used to require.

  if (g_wasCapturing && state != State::kCapturing) {
    const uint32_t dropped = network.txAudioDrops() - g_txDropsAtTurnStart;
    if (dropped > 0) {
      journalEvent("tx_audio_dropped", String("count=") + dropped);
    }
  }
  g_wasCapturing = state == State::kCapturing;

  loopPhase(nullptr);
  const uint32_t loopMs = millis() - loopStart;
  if (loopMs > g_loopMaxMs) g_loopMaxMs = loopMs;
  if (loopMs > 100) {
    journalEvent("loop_slow",
                 String("ms=") + loopMs + " free=" +
                     heap_caps_get_free_size(MALLOC_CAP_8BIT));
  }
  delay(1);
}

bool isWelcomed() { return welcomed; }

String networkRxJournalDetail() {
  return String("rx_bin_frames=") + network.rxBinFrames() +
         ",rx_bin_bytes=" + network.rxBinBytes() +
         ",rx_drops=" + network.rxDrops();
}

uint32_t wsNetStackWatermark() { return network.stackWatermark(); }

}  // namespace bob
