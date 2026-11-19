#include "chrome_identity.h"
// Bob Cardputer v2 — the connection: welcome, socket events, Wi-Fi, Settings and supervision.
#include "board.h"
#include "state_internal.h"

namespace bob {

namespace fsm {

// Per connection: the hello carried fw_version/caps, and the bare-hello
// fallback for a pre-#345 server (helloFallbackNeeded) has been sent.
static bool g_helloExtended = false;
bool g_turnConversationAccepted = false;
static bool g_helloFallbackSent = false;
bool g_assistantNameSupported = false;

static uint32_t lastWifiHeartbeatAt = 0;
static wl_status_t lastWifiStatus = WL_IDLE_STATUS;
// Socket connects that failed since Wi-Fi came up; at kSocketAwayAfter the
// socket screen says the server is away (#676).
constexpr uint8_t kSocketAwayAfter = 3;
static uint8_t g_socketRetries = 0;

// The screen Settings opened from; leaving with nothing changed resumes it.
State g_settingsFrom = State::kReady;

char g_deviceName[kDeviceNameBytes] = {};   // "paired as" name from welcome.

static void drawSocketScreen(const char* title, const char* detail);

static void handleWelcome(const String& text) {
  // Re-read each connection: an older server must never get the extra field.
  g_assistantNameSupported = welcomeSupportsAssistantName(text);
  network.setSessionId(extractSessionId(text));
  const uint8_t formatId = extractWelcomeFormatId(text);
  negotiatedFormat = (formatId == config::kFormatMp3) ? AudioFormat::kMp3
                                                       : AudioFormat::kPcm16;
  welcomed = true;
  network.setWelcomed(true);
  configureDeviceLog(text);
  g_turnConversationAccepted = welcomeAcceptsTurnConversation(text);
  configureTurnTiming(text);
  updateOnWelcome(text);
  // Session-scoped RX diagnostics start counting at the welcome that opens a
  // session, so the teardown journal's counters describe one reply's delivery.
  network.resetRxCounters();
  g_pendingActiveValid = false;
  // Additive welcome fields: "paired as <name>" and the active-title line
  // (contract obligation 9). Old servers omit both; legacy sessions get
  // device:null — either way the READY screen shows no name line.
  char name[kDeviceNameBytes] = {};
  ActiveConversation conv;
  if (parseWelcomeAdditive(text, name, sizeof(name), conv)) {
    strncpy(g_deviceName, name, kDeviceNameBytes - 1);
    g_deviceName[kDeviceNameBytes - 1] = '\0';
    g_activeConversation = conv;
  } else {
    g_deviceName[0] = '\0';
    g_activeConversation = ActiveConversation();
  }
  // The server's active Space always wins over local state; an absent field
  // (old server) means no Space.
  parseWelcomeActiveSpace(text, g_activeSpace);
  g_pendingSpaceValid = false;
  g_spaceSelectPending = false;
  g_pairedName[0] = '\0';
  // The server sends the running timers right after welcome; an older server
  // never does, so no stale countdown survives a reconnect.
  timersClear(g_timers);
  // Settings stays up; leaving it lands on Ready (welcomed).
  if (state != State::kSettings) enterReady();
  journalEvent("welcome_accepted",
               String("format=") + static_cast<int>(negotiatedFormat));
  sendDeviceState();
}

// #345: the server's minimum firmware is above this build (update_required),
// or it refused a message with UPDATE_REQUIRED (`update` null). The socket
// stays up; the Error state starts no turns, says why in words, and GO
// reconnects, so a lowered minimum lets the device back in.
static void showUpdateNeeded(const UpdateRequired* update) {
  if (state == State::kCapturing) stopCapture();
  dropUplink();
  playback.abort();
  serverStage = ServerStage::kIdle;
  char detail[64];
  if (update != nullptr && update->minVersion[0] != '\0') {
    snprintf(detail, sizeof(detail), "Needs firmware %s", update->minVersion);
  } else {
    snprintf(detail, sizeof(detail), "This firmware is too old");
  }
  transitionTo(State::kError, "UPDATE NEEDED", detail, kColorYellow, "BTN GO: retry");
  journalEvent("update_required",
               String("fw=") + kFirmwareVersion + ",min=" +
                   (update != nullptr ? update->minVersion : "") + ",reason=" +
                   (update == nullptr ? "refused" : update->unknownVersion ? "unknown_version"
                                                                            : "below_minimum"));
}

static void handleUpdateRequired(const String& text) {
  UpdateRequired update;
  if (!parseUpdateRequired(text, update)) {
    journalEvent("update_required_bad");
    showUpdateNeeded(nullptr);
    return;
  }
  showUpdateNeeded(&update);
}

// Socket gone: close the mic, silence everything, and drop announcements
// that were not acked yet — the server replays those on the next connection.
static void releaseAudioForDisconnect() {
  closeFollowUp(FollowUpClose::kDisconnect);
  stopWakeListening();
  g_wakeTurn = false;
  if (state == State::kCapturing) stopCapture();
  dropUplink();  // the socket is gone: queued frames and a pending turn_end too.
  playback.abort();
  ringStop();
  g_announceActive = false;
  g_announcePlaying = false;
  g_announceInbox.dropHeld();
  g_cardShown = false;
  g_replyForTurn = false;
}

// One failed connect (a non-clean close, or an attempt that expired because
// its end event was lost): the back-off grows and runs from now, and it
// counts once toward the assistant-away screen (#709).
static void noteFailedConnect() {
  network.scheduleReconnect();
  network.markConnectAttempt();
  if (g_socketRetries < 255) ++g_socketRetries;
}

void requestSocketRetry() {
  welcomed = false;
  network.setWelcomed(false);
  network.resetReconnectDelay();
  journalEvent("socket_retry_requested");
  network.start();
}

// BOB_PCM16_HELLO forces the PCM16 path for comparison runs.
#ifdef BOB_PCM16_HELLO
constexpr AudioFormat kHelloFormat = AudioFormat::kPcm16;
constexpr const char* kHelloFormatName = "pcm16_16k_mono";
#else
constexpr AudioFormat kHelloFormat = AudioFormat::kMp3;
constexpr const char* kHelloFormatName = "mp3_16k_mono";
#endif
#ifdef BOB_TEST_CONSOLE
// `T hello pcm|mp3` (testSetHelloFormat) changes these, in RAM only.
static AudioFormat g_helloFormat = kHelloFormat;
static const char* g_helloFormatName = kHelloFormatName;
#else
constexpr AudioFormat g_helloFormat = kHelloFormat;
constexpr const char* g_helloFormatName = kHelloFormatName;
#endif

void onSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      g_socketRetries = 0;
      network.resetReconnectDelay();
      // The welcome gets a full reconnectDelayMs() from here, not from the
      // start(): a slow TLS connect must not leave it no time at all.
      network.markConnectAttempt();
      journalEvent("socket_connected");
      // MP3 is the default downlink format. It was held behind a build flag
      // while mid-stream WS 1002 disconnects were unexplained; an 8-cycle
      // on-device soak over one connection now passes 8/8 with down_frames=30,
      // seq_gaps=0, rx_drops=0, ring_avail=0 and mp3_exit=eof on every cycle.
      // The earlier failures were harness artifacts (overlapping stream cycles
      // and session-cumulative counters scored as absolutes), not transport
      // faults. BOB_PCM16_HELLO forces the PCM16 path for comparison runs.
      //
      // Note the soak exercised the device against the mock server on the LAN;
      // the real server's MP3 TTS path has not been soaked to the same depth.
      // #345: hello names this build's version and the messages it acts on.
      {
        const HelloOta ota = updateHelloFields();
        network.sendControl(buildHello(g_helloFormat, kFirmwareVersion, kFirmwareCaps,
                                       kFirmwareCapCount, &ota));
      }
      g_helloExtended = kFirmwareVersion[0] != '\0' || kFirmwareCapCount > 0;
      g_helloFallbackSent = false;
      journalEvent("hello_sent",
                   String("format=") + g_helloFormatName + ",fw=" + kFirmwareVersion +
                       ",caps=" + kFirmwareCapCount);
      break;

    case WStype_DISCONNECTED: {
      // A clean server-initiated close (e.g. the 4003 revoke) arrives with no
      // reason string; a network-level drop carries one. On a clean close the
      // device reconnects immediately with its stored token. The token is
      // never erased here — only pairing_required {unknown|revoked} erases
      // (contract S-4/S-8, obligation 12).
      const bool cleanClose = payload == nullptr || length == 0;
      const bool wasWelcomed = welcomed;
      welcomed = false;
      network.setWelcomed(false);
      network.setSessionId(String());
      releaseAudioForDisconnect();
      // One cue for a lost established session, never for retry attempts.
      if (wasWelcomed) playEarcon(Earcon::kDisconnect);
      g_pendingActiveValid = false;
      g_newConversationPending = false;
      g_pendingSpaceValid = false;
      g_spaceSelectPending = false;
      // Every start() is one attempt, and the library reports each failed or
      // lost socket here exactly once, so this is the one place that counts
      // toward the assistant-away screen (superviseConnections only starts attempts).
      // The back-off runs from now: superviseConnections starts the next
      // attempt retry_ms after this close (#709).
      if (cleanClose) {
        network.resetReconnectDelay();
      } else {
        noteFailedConnect();
      }
      drawSocketScreen("WS RECONNECT", "Reconnecting...");
      journal("socket_closed", state, "",
              String("clean=") + (cleanClose ? "1" : "0") +
                  ",retry_ms=" + network.reconnectDelayMs());
      break;
    }

    case WStype_TEXT: {
      const String text(reinterpret_cast<char*>(payload), length);
      if (isWelcome(text)) {
        handleWelcome(text);
      } else if (isPairingRequired(text)) {
        handlePairingRequired(text);
      } else if (isPairCode(text)) {
        handlePairCode(text);
      } else if (isPaired(text)) {
        handlePaired(text);
      } else if (isPairExpired(text)) {
        onPairExpired();
      } else if (isPairDenied(text)) {
        onPairDenied();
      } else if (isActiveConversation(text)) {
        handleActiveConversation(text);
      } else if (isActiveSpace(text)) {
        handleActiveSpace(text);
      } else if (isSpaces(text)) {
        handleSpaces(text);
      } else if (isSpaceSelected(text)) {
        handleSpaceSelected(text);
      } else if (isDeviceControl(text)) {
        handleDeviceControl(text);
      } else if (isReplyText(text)) {
        handleReplyText(text);
      } else if (isAnnounce(text)) {
        handleAnnounce(text);
      } else if (isTimersState(text)) {
        handleTimersState(text);
      } else if (isScene(text)) {
        handleScene(text);
      } else if (isPlaybackStart(text)) {
        handlePlaybackStart(text);
      } else if (text.indexOf("\"type\":\"end_of_turn\"") >= 0) {
        handleEndOfTurn(text);
      } else if (isPlaybackEnd(text)) {
        handlePlaybackEnd(text);
      } else if (isStatus(text)) {
        ServerStage s;
        if (extractStatusStage(text, s)) handleStatus(text, s);
      } else if (isConversations(text)) {
        handleConversations(text);
      } else if (isConversationSelected(text)) {
        handleConversationSelected(text);
      } else if (isConversationCleared(text)) {
        handleConversationCleared();
      } else if (isUpdateOffer(text)) {
        handleUpdateOffer(text);
      } else if (isUpdateRequired(text)) {
        handleUpdateRequired(text);
      } else if (isServerError(text)) {
        char code[32];
        const bool hasCode = extractErrorCode(text, code, sizeof(code));
        if (helloFallbackNeeded(welcomed, g_helloExtended, g_helloFallbackSent,
                                hasCode ? code : nullptr)) {
          // A pre-#345 server rejects fw_version/caps: resend the bare hello
          // once on this connection; that server just lacks the new features.
          g_helloFallbackSent = true;
          network.sendControl(buildHello(g_helloFormat));
          journalEvent("hello_fallback_sent",
                       String("format=") + g_helloFormatName);
        } else if (hasCode && strcmp(code, "UPDATE_REQUIRED") == 0) {
          showUpdateNeeded(nullptr);
        } else if (hasCode && strcmp(code, "UNPAIRED") == 0) {
          // An unpaired session attempted a restricted message; stay in the
          // pairing flow (contract obligation 10).
          journalEvent("unpaired_error");
          // A turn in flight dies here: close the mic and free its uplink queue.
          if (state == State::kCapturing) stopCapture();
          if (state != State::kPairing) enterPairing();
        } else if (hasCode && strcmp(code, "PAIRING_RATE_LIMITED") == 0) {
          onPairingRateLimited();
        } else if (state == State::kNewConversation) {
          failNewConversation("new_conversation_failed");
        } else if (state == State::kSelecting && g_pickerKind == PickerKind::kSpaces) {
          handleSpacePickerError(hasCode ? code : "");
        } else if (state == State::kSelecting) {
          if (hasCode && strcmp(code, "CONVERSATION_NOT_FOUND") == 0) {
            journalEvent("conversation_not_found");
            drawConversationPickerHint("CONVERSATION NOT FOUND", kColorRed);
          } else {
            journalEvent("picker_unavailable");
            cancelPicker();
          }
        } else {
          handleServerError(hasCode ? code : "");
        }
      }
      break;
    }

    case WStype_BIN: {
      Olx2Header header;
      if (!parseOlx2Header(payload, length, &header)) {
        journalEvent("audio_down_bad",
                     String("bytes=") + length);
        break;
      }
      if (header.kind != config::kKindAudioDown) break;
      // Nothing playing (a stopped turn's stream still arriving, maybe during
      // the next turn's capture): drop it here, before any bookkeeping, with
      // one journal line per reply. It must not touch the next reply's
      // sequence tracking or cost the capture loop anything.
      if (!playback.active()) {
        if (!g_audioIgnoredLogged) {
          g_audioIgnoredLogged = true;
          journalEvent("audio_down_ignored",
                       String("bytes=") + header.payloadBytes);
        }
        break;
      }
      // One-shot sequence-gap journal per reply (session-scoped, unlike the
      // per-reply counters on the playback_completed line): a mismatch against
      // the expected +1 increment means frames vanished between the WS library
      // and this handler (event-queue drops), not inside the decode pipeline.
      if (playback.downFrameCount() == 0) {
        downlinkExpectedSeq_ = header.sequence;
      } else if (header.sequence != downlinkExpectedSeq_) {
        if (!downlinkSeqGapLogged_) {
          downlinkSeqGapLogged_ = true;
          journalEvent("audio_down_seq_gap",
                       String("seq=") + header.sequence +
                           ",expected=" + downlinkExpectedSeq_);
        }
      }
      downlinkExpectedSeq_ = header.sequence + 1;
      playback.pushDownlink(header, payload + config::kHeaderBytes);
      // Dense cadence while debugging the downlink stall.
      const uint32_t downFrames = playback.downFrameCount();
      if ((downFrames <= 100 && downFrames % 25 == 0) ||
          (downFrames > 100 && downFrames % 100 == 0)) {
        journalEvent("audio_down",
                     String("frames=") + downFrames);
      }
      break;
    }

    case WStype_ERROR:
      welcomed = false;
      network.setWelcomed(false);
      network.setSessionId(String());
      releaseAudioForDisconnect();
      transitionTo(State::kError, "WS ERROR", boardText("Press BTN GO to retry", "Tap to retry"),
                   kColorRed, "BTN GO: retry");
      journal("socket_error", state, "",
              String("code=") +
                  (length > 0 ? String(static_cast<int>(payload[0])) : "-1"));
      break;

    default:
      break;
  }
}

void updateWifiStatus() {
  const wl_status_t wifiStatus = network.wifiStatus();
  if (wifiStatus != lastWifiStatus) {
    lastWifiStatus = wifiStatus;
    if (wifiStatus == WL_CONNECTED) {
      journalEvent("wifi_connected",
                   String("rssi=") + WiFi.RSSI() + " channel=" + WiFi.channel());
    } else {
      journalEvent("wifi_state",
                   String("status=") + static_cast<int>(wifiStatus));
    }
  }
  if (millis() - lastWifiHeartbeatAt >= config::kWifiHeartbeatMs) {
    lastWifiHeartbeatAt = millis();
    journalEvent("wifi_heartbeat",
                 String("status=") + static_cast<int>(wifiStatus) + " rssi=" +
                     WiFi.RSSI());
  }
}

// Settings (#677): Wi-Fi networks and About, from Ready, any Wi-Fi screen, the
// pairing screen or the socket screen (#679). Voice is off while it is open
// (the wake word listens on Ready only, GO acts on no Settings screen) and the
// Wi-Fi manager, pairing housekeeping and socket retries stand still.
void enterSettings(SettingsEntry entry, const char* setupReason) {
  if (!settingsOpen(millis(), g_deviceName, welcomed, entry)) {
    chromeToast("Not enough memory for Settings", millis());
    return;
  }
  stopWakeListening();
  wifiManagerPause(true);
  g_settingsFrom = state;
  transitionTo(State::kSettings, "", "", kColorWhite, "");
  if (setupReason) {
    journalEvent("setup_entered", String("reason=") + setupReason);
  } else {
    journalEvent("settings_opened");
  }
}

// The rescue chord (#678): Fn + ` (Esc) held while the device powers on opens
// Settings on the Wi-Fi list, erasing nothing. Never GO: GO is GPIO0, and
// holding it at power-on enters the chip's download mode.
bool rescueChordHeld() {
  for (int i = 0; i < 3; ++i) {
    board::update();
    const Keyboard_Class::KeysState& keys = board::keys();
    if (keys.fn) {
      for (char c : keys.word) {
        if (c == '`') return true;
      }
    }
    delay(20);
  }
  return false;
}


void leaveSettings() {
  const String changed = settingsChangedName();
  const SettingsOutcome outcome = settingsClose();
  if (outcome.wakeWordChanged) {
    g_wakeFailed = false;
    markDeviceStateDirty(millis());
    refreshStatusLine();
  }
  if (outcome.reset && outcome.scope == ResetScope::kFactory) {
    // Factory reset (#680): everything goes, then the device starts as new.
    // The firmware's only restart.
    journalEvent("reset", "scope=factory");
    const char* lines[] = {"Erasing Wi-Fi, pairing and", "settings..."};
    drawLinesScreen("RESETTING", kColorRed, lines, 2);
    resetApply(deviceStore(), ResetScope::kFactory, activeProfile());
    delay(500);
    ESP.restart();
    return;
  }
  wifiManagerPause(false);
  if (outcome.replan) wifiManagerReload();
  journalEvent("settings_closed", String("changed=") + changed);
  if (outcome.reset && outcome.scope == ResetScope::kWifi) {
    enterSettings(SettingsEntry::kSetup, "forgot_all_wifi");  // straight into Setup
    return;
  }
  if (outcome.serverChanged) {
    // Another server (#679), or its token was cleared (#680): the next connect
    // uses its endpoint and its own token; the other profiles' pairings stay.
    deviceSettingsReloadProfile();
    refreshStatusLine();
    // The new profile's token decides pair or connect: the old server's code,
    // denial and backoff never resume, whatever screen Settings came from.
    g_pairing = PairingInfo();
    g_pairingRetryAtMs = 0;
    welcomed = false;
    if (!outcome.replan && wifiManagerOnline()) {
      g_socketRetries = 0;
      network.resetReconnectDelay();
      network.start();
      transitionTo(State::kSocket, assistantDisplay(AssistantLabel::kTitle), "Connecting to the server...", kColorYellow, "");
      return;
    }
    drawWifiScreen();  // the Wi-Fi manager connects once it is online
    return;
  }
  if (!outcome.replan && welcomed) {
    enterReady();
    return;
  }
  if (!outcome.replan && g_settingsFrom == State::kPairing) {
    resumePairing();
    return;
  }
  if (!outcome.replan && g_settingsFrom == State::kSocket) {
    drawSocketScreen(assistantDisplay(AssistantLabel::kTitle), "Connecting WebSocket...");
    requestSocketRetry();  // reconnect now, not after the backoff.
    return;
  }
  drawWifiScreen();
}

// The Wi-Fi screens (#676): what the connection manager is doing, in plain
// words, with the network's name on screen only (never in the journal).
void drawWifiScreen() {
  const WifiView view = wifiManagerView();
  char name[21];
  if (!savedNetworkName(view.slot, name, sizeof(name))) name[0] = '\0';
  String detail;
  switch (view.phase) {
    case WifiPhase::kIdle:
      transitionTo(State::kWifi, "NO WI-FI SAVED", "Press , to add your Wi-Fi", kColorRed,
                   kStripAddWifi);
      return;
    case WifiPhase::kScanning:
      transitionTo(State::kWifi, assistantDisplay(AssistantLabel::kTitle), "Looking for Wi-Fi...", kColorYellow, "");
      return;
    case WifiPhase::kTrying:
      detail = String("Joining ") + name;
      if (view.planLen > 1) detail += String(" (") + (view.rank + 1) + " of " + view.planLen + ")";
      transitionTo(State::kWifi, assistantDisplay(AssistantLabel::kTitle), detail.c_str(), kColorYellow, "");
      return;
    case WifiPhase::kProbing:
      transitionTo(State::kWifi, assistantDisplay(AssistantLabel::kTitle), "Checking internet...", kColorYellow, "");
      return;
    case WifiPhase::kDropped:
      transitionTo(State::kWifi, assistantDisplay(AssistantLabel::kTitle), "Wi-Fi lost. Reconnecting...", kColorYellow, "");
      return;
    case WifiPhase::kAllFailed:
      detail = view.planLen == 0 ? String("No saved network in range")
                                 : String("Tried ") + view.planLen + " saved network" +
                                       (view.planLen == 1 ? "" : "s");
      if (view.lastResult == JoinResult::kAuth) detail += ". Check the password";
      transitionTo(State::kWifi, "NO WI-FI", detail.c_str(), kColorRed, kStripRetryNow);
      return;
    case WifiPhase::kCaptive:
      detail = String(name) + " needs a sign-in page";
      transitionTo(State::kWifi, "NEEDS SIGN-IN", detail.c_str(), kColorYellow, kStripCheckAgain);
      return;
    case WifiPhase::kNoInternet:
      detail = String("On ") + name + ", but no internet";
      transitionTo(State::kWifi, "NO INTERNET", detail.c_str(), kColorYellow, kStripRetryNow);
      return;
    case WifiPhase::kOnline:
      transitionTo(State::kWifi, assistantDisplay(AssistantLabel::kTitle), "Wi-Fi connected", kColorYellow, "");
      return;
  }
}

// The socket screen: after kSocketAwayAfter failed connects on a working
// Wi-Fi, the server is the likely problem, and the screen says so (#676 E4).
static void drawSocketScreen(const char* title, const char* detail) {
  // Settings stays up; the socket waits and leaving Settings reconnects it.
  if (settingsIsOpen()) {
    g_settingsFrom = State::kSocket;
    return;
  }
  if (g_socketRetries >= kSocketAwayAfter) {
    transitionTo(State::kSocket, assistantDisplay(AssistantLabel::kAway), "We'll keep trying", kColorYellow, "");
  } else {
    transitionTo(State::kSocket, title, detail, kColorYellow, "");
  }
}

void superviseConnections() {
  const bool online = wifiManagerOnline();
  if (state == State::kWifi && online) {
    g_socketRetries = 0;
    network.start();
    drawSocketScreen(assistantDisplay(AssistantLabel::kTitle), "Connecting WebSocket...");
  }

  if (state == State::kSocket && !online) {
    drawWifiScreen();
  }

  // An attempt whose CONNECTED/DISCONNECTED never arrived (the event queue
  // was full) would hold connecting() true, and so every reconnect, forever.
  // Past the library's worst case it counts as one failed connect instead;
  // any late event from it is dropped as stale (Network::pollEvents).
  uint32_t attemptMs = 0;
  if (network.expireAttempt(millis(), attemptMs)) {
    journalEvent("socket_attempt_expired",
                 String("attempt_ms=") + attemptMs);
    noteFailedConnect();
    if (state == State::kSocket) drawSocketScreen("WS RECONNECT", "Reconnecting...");
  }

  // The only reconnect path (#709): the library's own is off, so nothing
  // retries while Settings is open (state is not kSocket) and a server that
  // stays down is tried at 2, 4, 8, 16, then every 30 s. A start() the
  // network task was too busy to take is re-issued here on the same timer.
  if (state == State::kSocket && online && !network.connecting() &&
      reconnectDue(millis(), network.lastConnectAttemptAt(), network.reconnectDelayMs())) {
    network.start();
    journalEvent("socket_retry",
                 String("delay_ms=") + network.reconnectDelayMs());
  }
}

}  // namespace fsm

using namespace fsm;

#ifdef BOB_TEST_CONSOLE
// `T token forget`: erases the active profile's device token and reconnects
// now, so the server asks this device to pair (a HIL start on PAIR).
void testForgetToken() {
  eraseDeviceToken();
  journalEvent("device_token_erased",
               String("reason=test profile=") + profileName(activeProfile()));
  requestSocketRetry();
}

// `T srv set dev <host> <port>` / `T srv set prod` (the Waveshare HIL run): selects the server profile and reconnects now. The HIL harness
// points the device at its throwaway server for the run (plain ws://, developer builds only) and back at Production before the product
// firmware is flashed again, so a run never leaves the owner's device on a test server. Never prints the host.
String testSetServerProfile(const char* args) {
  if (strcmp(args, "prod") == 0) {
    if (profileSave(deviceStore(), Profile::kProd, nullptr, kDevOptions) != ProfileError::kOk) return "err profile";
  } else if (strncmp(args, "dev ", 4) == 0) {
    Endpoint endpoint{};
    const char* host = args + 4;
    const char* space = strchr(host, ' ');
    if (space == nullptr) return "err args";
    const size_t length = static_cast<size_t>(space - host);
    if (length == 0 || length > kHostMaxBytes) return "err host";
    memcpy(endpoint.host, host, length);
    endpoint.host[length] = '\0';
    const long port = strtol(space + 1, nullptr, 10);
    if (port < 1 || port > 65535) return "err port";
    endpoint.port = static_cast<uint16_t>(port);
    endpoint.tls = false;
    if (profileSave(deviceStore(), Profile::kDev, &endpoint, kDevOptions) != ProfileError::kOk) return "err profile";
  } else {
    return "err args";
  }
  deviceSettingsReloadProfile();
  g_pairing = PairingInfo();
  g_pairingRetryAtMs = 0;
  welcomed = false;
  journalEvent("srv_profile_set", String("profile=") + profileName(activeProfile()));
  requestSocketRetry();
  return "ok srv";
}

// `T hello pcm|mp3` (HIL pcm-reply): the downlink format every later hello
// asks for, in RAM only (a reboot asks for the build's default again). The
// socket reconnects at once so the next hello uses it; the server keeps the
// format for the session and the device plays in the welcome's format_id.
// False for an unknown name.
bool testSetHelloFormat(const char* name) {
  if (strcmp(name, "pcm") == 0) {
    g_helloFormat = AudioFormat::kPcm16;
    g_helloFormatName = "pcm16_16k_mono";
  } else if (strcmp(name, "mp3") == 0) {
    g_helloFormat = AudioFormat::kMp3;
    g_helloFormatName = "mp3_16k_mono";
  } else {
    return false;
  }
  journalEvent("hello_format_forced",
               String("format=") + g_helloFormatName);
  requestSocketRetry();
  return true;
}
#endif

}  // namespace bob
