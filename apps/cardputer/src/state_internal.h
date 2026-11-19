// Bob Cardputer v2 — the state machine's shared state (src/state_*.cpp only).
// Not included outside src/. Each name is defined in the file noted above it;
// everything here was the anonymous namespace of the former state.cpp (#628).
#pragma once

#include <M5Cardputer.h>
#include <WebSocketsClient.h>
#include <cstring>
#include "audio_capture.h"
#include "audio_playback.h"
#include "build_id.h"
#include "card_policy.h"
#include "cards.h"
#include "chrome.h"
#include "config.h"
#include "device_settings.h"
#include "device_token.h"
#include "display.h"
#include "earcons.h"
#include "follow_up.h"
#include "journal.h"
#include "network.h"
#include "protocol.h"
#include "settings.h"
#include "reset_actions.h"
#include "settings_ui.h"
#include "state.h"
#include "test_console.h"
#include "timers_view.h"
#include "types.h"
#include "uplink_queue.h"
#include "wake_word.h"
#include "wifi_manager.h"

namespace bob {
namespace fsm {

// A line of copy on this board: the Cardputer's keyboard words, or the round touch
// screen's (a tap is GO; there is no GO, , or k key on the glass).
constexpr const char* boardText(const char* cardputer, const char* round) {
#if defined(BOB_BOARD_WAVESHARE_185C)
  return (void)cardputer, round;
#else
  return (void)round, cardputer;
#endif
}

// --- state_core.cpp: modules, the state, screens and keys ---
extern Network network;
extern AudioCapture capture;
extern AudioPlayback playback;
extern State state;
extern ServerStage serverStage;
extern AudioFormat negotiatedFormat;
extern String turnRef;
extern bool welcomed;
extern bool g_assistantNameSupported;
extern bool g_allSetPending;
extern uint32_t g_txDropsAtTurnStart;
extern const char kStripWakeCapturing[];
extern const char kStripRetry[];
extern const char kStripRetryNow[];
extern const char kStripCheckAgain[];
extern const char kStripAddWifi[];
const char* wakePhrase();
bool wakeFallback();
const char* readyStrip();
void refreshStatusLine();
void transitionTo(State next, const char* title, const char* detail,
                  uint32_t color, const char* hint);
void enterReady();
void journalEvent(const char* event);
void journalEvent(const char* event, const String& detail);
void sendDeviceLog(const char* event);
void configureDeviceLog(const String& welcome);
void journalTurnHeap();
void applyHeldPushes();

// --- state_turn.cpp: a voice turn ---
extern uint32_t downlinkExpectedSeq_;
extern bool downlinkSeqGapLogged_;
extern uint8_t* g_uplinkBuf;
extern UplinkQueue g_uplink;
extern bool g_turnEndPending;
extern bool g_goTurnHeld;
extern String g_cancelledTurnRef;
extern bool g_audioIgnoredLogged;
void dropUplink();
bool allocUplink();
uint8_t* uplinkFrameAt(size_t i);
void enqueueUplink(const uint8_t* frame, size_t length);
void pumpUplink(size_t liveTaken);
void stopCapture();
void resetTurn();
void beginTurn(bool holdForGo);
void sendTurnStart();
void handlePlaybackStart(const String& text);
void handleEndOfTurn(const String& text);
void handlePlaybackEnd(const String& text);
void handleStatus(const String& text, ServerStage stage);
void handleServerError(const char* code);
void stopReply(const char* source);
void handlePttAndReply();
void bargeIn(uint32_t nowMs, float maxP);  // a wake word over the reply or an announcement (BARGE-WAKE): stop it, listen.
#ifdef BOB_AUTO_TURN
void handleAutoTurn();
#endif

// --- state_turn_timing.cpp: the turn's timing summary (turn_timing.h, #1004) ---
// How the turn ended for its summary: kPlayed derives the outcome from playback.
enum class TimingFinish : uint8_t { kPlayed, kStopped, kFailed, kCancelled };
void configureTurnTiming(const String& welcome);
// Capture start: the mic is open. audioLeadMs: audio the VAD hears from before it (follow-up pre-roll).
void timingBegin(TimingSource source, uint32_t audioLeadMs = 0);
void timingMark(Milestone milestone);
void timingCaptureEnded(TimingEnd reason);
void timingUplinkSent(uint32_t framesSent);
void timingCaptureStats(size_t backlog, uint32_t fps);  // endTurn: VAD speech end, backlog, fps, tx busy.
void timingPlaybackStarted();
void timingDrop();  // no summary (a GO tap, a capture failure); a new welcome also resets it.
void timingFinish(TimingFinish how);  // closes the record; sends it when negotiated.

// --- state_wake.cpp: Always awake and the follow-up window ---
extern bool g_wakeFailed;
extern bool g_wakeTurn;
extern FollowUpWindow g_followUp;
extern bool g_replyDrained;
extern uint32_t g_replyDrainedAt;
extern FollowUpChain g_chain;
extern bool g_followUpTurn;
String heapNow();
void stopWakeListening();
void startWakeListening();
bool wakeWanted();
void wakeTick(uint32_t nowMs);
bool followUpWanted(const char** why);
bool openFollowUp();
void closeFollowUp(FollowUpClose reason);

// --- state_volume.cpp: volume, mute, mode, device_control ---
void sendDeviceState();
void onVolumeKey(int delta);
void onMuteKey();
void onModeKey();
void onWakeWordKey();
void handleDeviceControl(const String& text);
void applyHeldControl();
bool applyWakeWord(WakeWord word, const char* source);  // state_wake.cpp: persists, restarts the model, redraws

// --- state_cards.cpp: reply card, HELP, announcements, timers ---
extern ReplyText g_reply;
extern bool g_replyForTurn;
extern bool g_cardShown;
extern size_t g_cardLines;
extern size_t g_cardScroll;
extern bool g_replyLive;  // round board: the reply's words show while it plays (AWAITING)
extern size_t g_helpScroll;
extern Announcement g_announce;
extern bool g_announceActive;
extern bool g_announcePlaying;
extern bool g_announceAcked;
extern bool g_announceMissed;
extern AnnounceInbox g_announceInbox;
extern TimersModel g_timers;
void handleReplyText(const String& text);
void finishTurn(bool allowFollowUp = true);
void closeReplyCard();
#if defined(BOB_BOARD_WAVESHARE_185C)
// The reply on screen (speaking or the card) turns its page: `delta` pages by hand, or the auto-pager.
void pageReply(int delta);
void replyPageTick(uint32_t nowMs);
#endif
void openHelp();
void closeHelp();
void handleAnnounce(const String& text);
void handleTimersState(const String& text);
void handleScene(const String& text);  // state_scene.cpp
void presentNextAnnouncement();
void dismissAnnouncement(const char* source);
void tickAnnouncement(uint32_t nowMs);

// --- state_pickers.cpp: conversations, Spaces, new chat ---
extern String g_newConversationRequestId;
extern bool g_newConversationPending;
extern PickerKind g_pickerKind;
extern bool g_spaceSelectPending;
extern ActiveSpace g_activeSpace;
extern ActiveSpace g_pendingSpace;
extern bool g_pendingSpaceValid;
extern ActiveConversation g_activeConversation;
// Set from each welcome (welcomeAcceptsTurnConversation).
extern bool g_turnConversationAccepted;
// The conversation the device shows, for turn_start's conversation_id (#880);
// null when none or the server did not accept the key (buildTurnStart omits it).
inline const char* activeConversationRef() {
  return g_turnConversationAccepted && g_activeConversation.present ? g_activeConversation.id : nullptr;
}
extern ActiveConversation g_pendingActive;
extern bool g_pendingActiveValid;
void applyActiveConversation(const ActiveConversation& conv);
void handleActiveConversation(const String& text);
void applyActiveSpace(const ActiveSpace& space);
void handleActiveSpace(const String& text);
void enterPicker();
void cancelPicker();
void enterSpacePicker();
void handleSpaces(const String& text);
void handleSpaceSelected(const String& text);
void handleSpacePickerError(const char* code);
void enterNewConversation();
void failNewConversation(const char* event);
void handleConversationCleared();
void handleConversations(const String& text);
void handleConversationSelected(const String& text);
void pickerKeys(const Keyboard_Class::KeysState& keys);
void newConversationKeys(const Keyboard_Class::KeysState& keys);
void pickerTick();

// --- state_pairing.cpp: pairing ---
extern PairingInfo g_pairing;
extern char g_pairedName[kDeviceNameBytes];
extern uint32_t g_pairingRetryAtMs;
void enterPairing();
void handlePairingRequired(const String& text);
void handlePairCode(const String& text);
void handlePaired(const String& text);
void onPairExpired();
void onPairDenied();
void onPairingRateLimited();
void resumePairing();
void pairingKeys(const Keyboard_Class::KeysState& keys);
void pairingTick(uint32_t loopStart);

// --- state_connection.cpp: welcome, socket, Wi-Fi, Settings ---
extern State g_settingsFrom;
extern char g_deviceName[kDeviceNameBytes];
void onSocketEvent(WStype_t type, uint8_t* payload, size_t length);
void requestSocketRetry();
void updateWifiStatus();
void enterSettings(SettingsEntry entry = SettingsEntry::kHome, const char* setupReason = nullptr);
void leaveSettings();
bool rescueChordHeld();
void drawWifiScreen();
void superviseConnections();

// --- state_update.cpp: firmware updates (#343) ---
void updateBoot();
HelloOta updateHelloFields();
void updateOnWelcome(const String& text);
void handleUpdateOffer(const String& text);
void updateTick(uint32_t nowMs);

}  // namespace fsm
}  // namespace bob
