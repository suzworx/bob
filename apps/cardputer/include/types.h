// Bob Cardputer v2 — strongly-typed shared types and enums.
#pragma once

#include <cstddef>
#include <cstdint>
#include "ring_policy.h"
#include "wake_models.h"

namespace bob {

// Device lifecycle states, driven by Wi-Fi, WebSocket, and PTT events.
enum class State {
  kBoot,
  kWifi,
  kSocket,
  kReady,
  kCapturing,
  kAwaiting,
  kSelecting,  // browsing/selecting a conversation (on-device picker).
  kNewConversation,  // confirming/awaiting a new_conversation (#302).
  kPairing,    // unpaired: showing a pairing code and waiting for approval.
  kError,
  kHelp,       // on-device shortcut list (h / ?).
  kAnnounce,   // an announcement card, ringing or playing its message (#319-#321).
  kSettings,   // on-device Settings: Wi-Fi networks, About (#677). Voice is paused.
  kUpdating,   // firmware update countdown and install (#343).
};

// Listening mode (#330), persisted in NVS and reported in device_state.
enum class DeviceMode : uint8_t {
  kPtt = 0,
  kWake = 1,
  kAnnounceOnly = 2,
};

// User settings persisted in NVS (never the token namespace). Volume is the
// contract's 0..10 level; the speaker gain comes from a lookup table.
constexpr uint8_t kVolumeMax = 10;
constexpr uint8_t kVolumeDefault = 4;  // CP-QUIET: a fresh device starts quiet.

// Level -> Speaker master gain. Loudness is roughly logarithmic in gain, so
// the low steps are closer together. Levels 0..5 are unchanged since #314;
// the top is flattened so 10 (212) is no louder than the old 8 (CP-QUIET).
constexpr uint8_t kGainTable[kVolumeMax + 1] = {0,   20,  40,  64,  92, 124,
                                                148, 168, 184, 200, 212};
constexpr uint8_t gainForLevel(uint8_t level) {
  return kGainTable[level > kVolumeMax ? kVolumeMax : level];
}

// Cabin PCM already has a decaying envelope. Keep 98% of the reply channel's
// setting: M5 squares channel gain, so the former 50% removed about 12 dB.
// 249/255 at full channel leaves digital headroom for the loudest cabin note
// with Cardputer magnification 16 and the unchanged maximum master gain 212.
// Never 0 while speech is audible, so the ring still sounds at level 1.
constexpr uint8_t kTonePercent = 98;
constexpr uint8_t toneChannelVolume(uint8_t speechChannelVolume) {
  return speechChannelVolume == 0
             ? 0
             : (speechChannelVolume * kTonePercent / 100 > 0
                    ? static_cast<uint8_t>(speechChannelVolume * kTonePercent / 100)
                    : 1);
}
struct DeviceSettings {
  uint8_t volume = kVolumeDefault;
  bool muted = false;
  DeviceMode mode = DeviceMode::kPtt;
  bool dnd = false;
  // The word Always awake listens for. Cardputer: device-local; Waveshare: also in device_state (wake_word).
  WakeWord wakeWord = kWakeWordDefault;
  uint8_t ringSeconds = kRingSecondsDefault;  // #389: how long a timer/alarm rings.
  RingSound ringSound = RingSound::kClassic;
};

// A parsed device_control push: only the has* fields are applied.
struct DeviceControl {
  bool hasVolume = false;
  bool hasMuted = false;
  bool hasMode = false;
  bool hasDnd = false;
  bool hasRingSeconds = false;
  bool hasRingSound = false;
  bool hasWakeWord = false;
  uint8_t volume = 0;
  bool muted = false;
  DeviceMode mode = DeviceMode::kPtt;
  bool dnd = false;
  uint8_t ringSeconds = kRingSecondsDefault;
  RingSound ringSound = RingSound::kClassic;
  WakeWord wakeWord = kWakeWordDefault;
};

// reply_text bounds (contract: heard 0..200, reply 0..700 chars) + NUL. The
// text is shown on the reply card only; never journaled or printed.
constexpr size_t kTurnRefBytes = 65;
constexpr size_t kReplyHeardBytes = 201;
constexpr size_t kReplyTextBytes = 701;
struct ReplyText {
  char turnRef[kTurnRefBytes];
  char heard[kReplyHeardBytes];
  char reply[kReplyTextBytes];
};

// announce bounds (contract: title 1..28, body 0..200) + NUL.
constexpr size_t kAnnounceIdBytes = 65;
constexpr size_t kAnnounceTitleBytes = 29;
constexpr size_t kAnnounceBodyBytes = 201;

enum class AnnounceKind : uint8_t {
  kTimer,
  kAlarm,
  kReminder,
  kNotice,
};

enum class AnnounceAction : uint8_t {
  kPlayed,
  kDismissed,
  kSnoozed,
  kMissed,  // #389: the ring ran its full ring_seconds with no dismiss.
};

struct Announcement {
  char id[kAnnounceIdBytes];
  AnnounceKind kind = AnnounceKind::kNotice;
  bool ring = false;
  char title[kAnnounceTitleBytes];
  char body[kAnnounceBodyBytes];
};

// timers_state bounds (#457, contract: at most 4 timers, label 0..24 chars,
// fires_in_ms 0..2^31-1) + NUL. The device counts down locally from receipt.
constexpr size_t kMaxTimers = 4;
constexpr size_t kTimerLabelBytes = 25;
constexpr uint32_t kTimerFiresInMaxMs = 2147483647u;

enum class TimerKind : uint8_t {
  kTimer,
  kAlarm,
};

struct TimerEntry {
  TimerKind kind = TimerKind::kTimer;
  char label[kTimerLabelBytes] = {};
  uint32_t firesInMs = 0;  // at receipt.
};

// A parsed timers_state push: `count` entries, soonest first as sent.
struct TimersMessage {
  size_t count = 0;
  TimerEntry entries[kMaxTimers];
};

// Audio format negotiated with the server.
enum class AudioFormat {
  kPcm16 = 1,
  kMp3 = 2,
};

// Server-driven turn stage, pushed by status control messages.
enum class ServerStage : uint8_t {
  kIdle = 0,
  kThinking = 1,
  kSpeaking = 2,
};

// Human-readable name for a State, used by journal() and the status display.
const char* stateName(State value);

// Parsed OLX2 binary audio frame header.
struct Olx2Header {
  uint8_t version;
  uint8_t kind;       // 1 = audio_up, 2 = audio_down.
  uint8_t formatId;   // matches AudioFormat values.
  uint8_t channels;
  uint32_t turnHandle;
  uint32_t sequence;
  uint32_t payloadBytes;
};

// Connection status reported on the status screen.
struct ConnectionStatus {
  bool wifiConnected;
  bool websocketConnected;
};

// On-device conversation picker bounds (mirror the server CONVERSATIONS_LIST_CAP
// and OpaqueIdSchema/title limits).
constexpr size_t kMaxListedConversations = 10;  // == CONVERSATIONS_LIST_CAP.
constexpr size_t kConversationIdBytes = 65;     // 64 + NUL (OpaqueIdSchema max).
constexpr size_t kConversationTitleBytes = 29;  // 28 chars + NUL display bound.

// One conversation as listed by the server. `id` holds the full opaque id;
// `title` is truncated by the parser to the display bound.
struct ListedConversation {
  char id[kConversationIdBytes];
  char title[kConversationTitleBytes];
};

// Pairing wire-field bounds (contract "Field formats"): uuid 36 + NUL, code
// 9 + NUL, uri 200 + NUL, claim 32 + NUL, token 48 + NUL, name 40 + NUL.
constexpr size_t kPairingIdBytes = 37;
constexpr size_t kUserCodeBytes = 10;
constexpr size_t kPairingUriBytes = 201;
constexpr size_t kClaimBytes = 33;
constexpr size_t kDeviceTokenBytes = 49;
constexpr size_t kDeviceNameBytes = 41;

// Device identity sent in every pair_request (contract example values).
constexpr char kDeviceModel[] = "M5Stack Cardputer";

// #345: the firmware version comes from the build (platformio.ini runs
// scripts/release/fw-version.mjs), as bare tokens. A release build gets
// BOB_FW_VERSION=x.y.z and reports "x.y.z"; a local build gets
// BOB_FW_DEV_VERSION=x.y.z plus BOB_FW_BUILD=<short sha> and reports
// "x.y.z-dev+<sha>". A build with neither (the host tests) is "0.0.0-dev".
#define BOB_FW_STR_(x) #x
#define BOB_FW_STR(x) BOB_FW_STR_(x)
#if defined(BOB_FW_VERSION)
#define BOB_FW_SHORT_TEXT BOB_FW_STR(BOB_FW_VERSION)
#define BOB_FW_VERSION_TEXT BOB_FW_SHORT_TEXT
#elif defined(BOB_FW_DEV_VERSION)
#define BOB_FW_SHORT_TEXT BOB_FW_STR(BOB_FW_DEV_VERSION) "-dev"
#ifdef BOB_FW_BUILD
#define BOB_FW_VERSION_TEXT BOB_FW_SHORT_TEXT "+" BOB_FW_STR(BOB_FW_BUILD)
#else
#define BOB_FW_VERSION_TEXT BOB_FW_SHORT_TEXT
#endif
#else
#define BOB_FW_SHORT_TEXT "0.0.0-dev"
#define BOB_FW_VERSION_TEXT BOB_FW_SHORT_TEXT
#endif

// Sent in hello and pair_request (server bound: 32 chars).
// Numeric build version comes from the same release/dev-base flags as the wire version.
#if defined(BOB_FW_VERSION)
constexpr char kFirmwareNumericVersion[] = BOB_FW_STR(BOB_FW_VERSION);
#elif defined(BOB_FW_DEV_VERSION)
constexpr char kFirmwareNumericVersion[] = BOB_FW_STR(BOB_FW_DEV_VERSION);
#else
constexpr char kFirmwareNumericVersion[] = "0.0.0";
#endif
constexpr char kFirmwareVersion[] = BOB_FW_VERSION_TEXT;
// device_state's fw_version: no build suffix, because servers before #345
// reject a device_state whose fw_version is over 16 chars.
constexpr char kFirmwareShortVersion[] = BOB_FW_SHORT_TEXT;
static_assert(sizeof(kFirmwareVersion) - 1 <= 32, "hello fw_version bound");
static_assert(sizeof(kFirmwareShortVersion) - 1 <= 16, "device_state fw_version bound");

// hello caps (#345): the server-to-device messages this firmware acts on.
constexpr const char* kFirmwareCaps[] = {"device_control", "announce", "reply_text", "timers_state", "ota", "device_log", "turn_conversation", "assistant_name", "scene", "turn_timing", "end_of_turn"
#if defined(BOB_BOARD_WAVESHARE_185C)
                                             , "wake_word"  // the Waveshare takes a wake word ("bob") from the server
#endif
};
constexpr size_t kFirmwareCapCount = sizeof(kFirmwareCaps) / sizeof(kFirmwareCaps[0]);

// update_required (#345): min_version is bounded like fw_version (32) + NUL;
// reason is "below_minimum" | "unknown_version".
constexpr size_t kFwVersionBytes = 33;
struct UpdateRequired {
  char minVersion[kFwVersionBytes] = {};
  bool unknownVersion = false;  // reason unknown_version, else below_minimum.
};

// Pairing state kept in RAM only (contract § sequences S-1..S-3): the claim is
// the per-boot secret and never touches NVS; resumePairingId lets a same-boot
// reconnect deliver an already-approved pairing (S-3).
struct PairingInfo {
  bool active = false;               // a pair_code is currently displayed.
  bool denied = false;               // pair_denied received; waiting for a key.
  char pairingId[kPairingIdBytes];   // current pairing_id ("" when none).
  char userCode[kUserCodeBytes];     // "XXXX-XXXX" to display.
  char verificationUri[kPairingUriBytes];
  char claim[kClaimBytes];           // fresh 128-bit hex claim, RAM only.
  char resumePairingId[kPairingIdBytes];  // same-boot resume target.
  uint32_t expiresAtMs = 0;          // absolute countdown deadline.
};

// Active-conversation pointer from the welcome additive fields or an
// active_conversation push. present=false when the fields are absent or the
// id/title null form arrives (both null together, contract § active_conversation).
struct ActiveConversation {
  bool present = false;
  char id[kConversationIdBytes];
  char title[kConversationTitleBytes];
};

// Space picker bounds (#301): the server lists at most 10 Spaces; ids are
// uuids (36 + NUL); names (1..60 on the wire) are truncated to 28 chars.
constexpr size_t kMaxListedSpaces = 10;
constexpr size_t kSpaceIdBytes = 37;
constexpr size_t kSpaceNameBytes = 29;

// One Space as listed by the server; `name` is truncated by the parser.
struct ListedSpace {
  char id[kSpaceIdBytes];
  char name[kSpaceNameBytes];
};

// Active-Space pointer from welcome.payload.active_space, an active_space push
// or a space_selected ack. present=false means no Space (null or absent).
// Held in RAM only; the server is the source of truth on every welcome.
struct ActiveSpace {
  bool present = false;
  char id[kSpaceIdBytes];
  char name[kSpaceNameBytes];
};

// Which list State::kSelecting is browsing. Row 0 of the Space picker is
// "No space", so it holds up to kMaxListedSpaces + 1 rows.
enum class PickerKind : uint8_t {
  kConversations,
  kSpaces,
};
constexpr size_t kMaxPickerRows = kMaxListedSpaces + 1;
constexpr size_t kPickerLabelBytes = 29;  // 28 chars + NUL display bound.
static_assert(kConversationTitleBytes == kPickerLabelBytes, "picker label bound");
static_assert(kSpaceNameBytes == kPickerLabelBytes, "picker label bound");

}  // namespace bob
