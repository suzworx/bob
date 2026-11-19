// Bob Cardputer v2 — wire protocol helpers.
// Builds JSON control messages and parses OLX2 binary audio frames.
#pragma once

#include <cstddef>
#include <cstdint>
#include <WString.h>
#include "ota_policy.h"
#include "types.h"

namespace bob {

// What the hello reports about firmware updates (docs/cardputer/ota-wire.md).
// Every field is optional: a null string or a slot outside 0..1 is left out.
// The strings are build-time or code values (board, result, version, reason
// code), never user text, so they are copied without escaping.
struct HelloOta {
  const char* board = nullptr;
  const char* lastResult = nullptr;  // ok | rolled_back | failed
  const char* lastTo = nullptr;
  const char* lastReason = nullptr;
  int slot = -1;
};

// Big-endian 32-bit write into an OLX2 frame header at `offset`.
void writeU32(uint8_t* output, size_t offset, uint32_t value);

// Unique control-message id: <prefix>_<uptime_ms>_v2.
String messageId(const char* prefix);

// JSON control message builders. buildHello adds fw_version and caps (#345)
// when given; without them it is the pre-#345 hello {format_id}.
String buildHello(AudioFormat format, const char* fwVersion = nullptr,
                  const char* const* caps = nullptr, size_t capCount = 0,
                  const HelloOta* ota = nullptr);
// A server older than #345 parses hello strictly and answers fw_version/caps
// with an error and no welcome. True when an error that arrived before welcome
// should be answered with a bare hello {format_id}: the hello sent on this
// connection carried extra fields, the error is BAD_MESSAGE (a strict parse
// failure; pairing errors are not hello failures) and no fallback was sent yet.
bool helloFallbackNeeded(bool welcomed, bool sentExtendedHello, bool fallbackSent,
                         const char* code);
// turn_start. conversationId (#880) is the device's active conversation; it is
// sent only when it is an opaque id the server accepts (8..64 of
// [A-Za-z0-9_-]), so null, empty or malformed leaves it out and the turn still
// starts. Older servers receive the unchanged empty payload; the selected name
// is sent only after this connection's welcome acknowledges assistant_name.
// Mirrors TurnStartDtoSchema in apps/api/src/voice/protocol.ts.
String buildTurnStart(const String& turnRef, const char* conversationId = nullptr,
                      WakeWord word = kWakeWordDefault, bool assistantNameSupported = false);
// True when the welcome answered cap turn_conversation with
// "turn_conversation":true: only then may turn_start carry conversation_id
// (a released server's strict turn_start refuses the key).
bool welcomeAcceptsTurnConversation(const String& welcome);
bool welcomeSupportsAssistantName(const String& welcome);
String buildTurnEnd(const String& turnRef, uint32_t lastSequence);

// Conversation-picker control builders (device→server).
String buildListConversations();
String buildSelectConversation(const char* conversationId);

// New-conversation control builder (#302). `requestId` is made once per
// confirmation and reused on retry so the server can deduplicate it.
String buildNewConversation(const String& requestId);

// Space-picker control builders (#301). A null or empty `spaceId` selects no
// Space (`"space_id":null`).
String buildListSpaces();
String buildSelectSpace(const char* spaceId);

// Pairing control builder (device→server). Generates nothing itself: `claim`
// is the caller's per-boot 128-bit hex secret (RAM only) and `resume` is a
// pairing_id from earlier in the same boot, omitted when empty (contract S-3).
String buildPairRequest(const char* claim, const char* resume);

// Fills `out` with a fresh 128-bit random value as 32 lowercase hex chars.
// `outSize` must be at least kClaimBytes.
void generateClaim(char* out, size_t outSize);

// Extract the negotiated format id from a welcome control message.
// Returns 0 if missing or invalid.
uint8_t extractWelcomeFormatId(const String& text);

// Extract the server-assigned session id from a welcome control message.
// Returns an empty string if missing.
String extractSessionId(const String& text);

// Control message type tests (including the additive pairing messages).
bool isWelcome(const String& text);
bool isPlaybackStart(const String& text);
bool isPlaybackEnd(const String& text);
bool isServerError(const String& text);
bool isStatus(const String& text);
bool isConversations(const String& text);
bool isConversationSelected(const String& text);
bool isConversationCleared(const String& text);
bool isPairingRequired(const String& text);
bool isPairCode(const String& text);
bool isPaired(const String& text);
bool isPairExpired(const String& text);
bool isPairDenied(const String& text);
bool isActiveConversation(const String& text);
bool isSpaces(const String& text);
bool isSpaceSelected(const String& text);
bool isActiveSpace(const String& text);

// update_required {min_version, reason} (#345): the server's minimum firmware
// is above this build (or this build's version was unknown to it). Returns
// false when min_version is missing, empty or over 32 chars.
bool isUpdateRequired(const String& text);
bool parseUpdateRequired(const String& text, UpdateRequired& out);

// Firmware update messages (OTA-4B, docs/cardputer/ota-wire.md). Builders only
// make the text; nothing here connects or downloads.
String buildCheckUpdate();
// stage is start | ok | failed; `reason` is a code of at most 24 chars, omitted
// when null or empty.
String buildOtaProgress(const char* stage, const char* to, const char* reason);

// The `update_offer` message and welcome.payload.update_offer. Both parse the
// offer fields in contract key order into `out`, which is reset first. They
// return false (out stays empty) when a field is missing, malformed or does not
// fit its buffer (never truncated), the sha256 is not 64 lowercase hex chars or
// mandatory is not a bare true/false. Unknown extra keys are ignored; `notes`
// is display text the device does not keep. parseUpdateOffer is also false for
// the `{"offer":null}` answer, so "no offer" and "bad offer" both read as none.
bool isUpdateOffer(const String& text);
bool parseUpdateOffer(const String& text, OtaOffer& out);
bool parseWelcomeUpdateOffer(const String& text, OtaOffer& out);

// Extract the server-driven turn stage from a status control message.
// Returns false if the stage is missing or unknown.
bool extractStatusStage(const String& text, ServerStage& out);

// Parses a `conversations` reply, copying up to maxEntries entries. Copies
// full ids; truncates titles at kConversationTitleBytes-1. Returns the count.
size_t parseConversations(const String& text, ListedConversation* out, size_t maxEntries);

// Extracts the selected conversation id from a `conversation_selected` reply.
bool extractSelectedConversationId(const String& text, char* out, size_t outSize);

// Extracts the payload error code from an `error` reply.
bool extractErrorCode(const String& text, char* out, size_t outSize);

// Extracts the pairing_required reason (none|unknown|revoked).
bool extractPairingRequiredReason(const String& text, char* out, size_t outSize);

// Parses a `pair_code` reply into `info`: pairing_id, user_code,
// verification_uri, and the absolute expiresAtMs deadline from expires_in.
bool parsePairCode(const String& text, PairingInfo& info);

// Parses a `paired` reply: the device token (kDeviceTokenBytes buffer) and the
// display name (kDeviceNameBytes buffer).
bool parsePaired(const String& text, char* deviceToken, size_t tokenSize,
                 char* deviceName, size_t nameSize);

// Parses an `active_conversation` push. The null form ({id:null,title:null})
// leaves out.present false.
bool parseActiveConversation(const String& text, ActiveConversation& out);

// Parses the additive welcome fields (`device` name and `active_conversation`).
// Returns true when the fields are present (new server); absent fields leave
// *deviceName empty and out.present false.
bool parseWelcomeAdditive(const String& text, char* deviceName, size_t nameSize,
                          ActiveConversation& out);

// Parses a `spaces` reply, copying up to maxEntries entries. Entries whose id
// does not fit kSpaceIdBytes are skipped; names are truncated to 28 chars.
size_t parseSpaces(const String& text, ListedSpace* out, size_t maxEntries);

// Parses an `active_space` push ({id,name} or the null form).
bool parseActiveSpace(const String& text, ActiveSpace& out);

// Parses a `space_selected` ack ({space_id,name} or the null form).
bool parseSpaceSelected(const String& text, ActiveSpace& out);

// Parses welcome.payload.active_space, anchored at `"active_space":`. Always
// resets `out`: absent or null leaves out.present false (absent == cleared).
void parseWelcomeActiveSpace(const String& text, ActiveSpace& out);

// Device control (epic #311). battery_pct / charging are null when < 0.
String buildDeviceState(const DeviceSettings& settings, int batteryPct, int charging);
String buildAnnounceAck(const char* announceId, AnnounceAction action);
// cancel {} aborts the in-flight turn; `turnRef` is omitted when empty.
String buildCancel(const String& turnRef);

bool isDeviceControl(const String& text);
bool isReplyText(const String& text);
bool isAnnounce(const String& text);

// Parses device_control {volume?, muted?, mode?, dnd?, ring_seconds?,
// ring_sound?} in contract key order.
// Returns false unless at least one valid field is present.
bool parseDeviceControl(const String& text, DeviceControl& out);

// Parses reply_text {turn_ref, heard, reply}; text is truncated to the bounds.
bool parseReplyText(const String& text, ReplyText& out);

// Whether a parsed reply_text belongs on the card (#318). Only the reply for
// the turn in flight is kept; one for a stopped turn, an earlier turn, or
// arriving outside a turn is ignored, so a late reply never overwrites the
// current card.
enum class ReplyTextFate : uint8_t { kKeep, kCancelledTurn, kNotInTurn, kOtherTurn };
ReplyTextFate replyTextFate(bool turnInFlight, const char* replyTurnRef,
                            const char* currentTurnRef, const char* cancelledTurnRef);
const char* replyTextFateName(ReplyTextFate fate);  // "kept", "cancelled_turn", ...

// Parses announce {announce_id, kind, title, body, ring, expires_at}.
bool parseAnnounce(const String& text, Announcement& out);

// timers_state (#457). Parses {timers:[{id, kind, label, fires_in_ms}]} in
// contract key order. Rejects the whole message (returns false, out.count 0)
// on more than kMaxTimers entries, an unknown kind, a label over 24 chars, a
// fires_in_ms outside 0..2^31-1, or any malformed entry. Labels are folded to
// the ASCII font.
bool isTimersState(const String& text);
bool parseTimersState(const String& text, TimersMessage& out);

// scene {scene, seconds?, label?, value?} (BOB-SCENES): the server shows one of Bob's action scenes, chosen by the
// agent's tool, never by a phrase. `seconds` 0 = the scene's default; `value` is a number the scene shows (a timer's
// seconds). Unknown scene names parse fine; the caller ignores them and journals scene_unknown.
constexpr size_t kSceneNameBytes = 24, kSceneLabelBytes = 25;
struct SceneMessage {
  char scene[kSceneNameBytes] = "";
  uint32_t seconds = 0;
  char label[kSceneLabelBytes] = "";
  bool hasValue = false;
  int32_t value = 0;
};
bool isScene(const String& text);
bool parseScene(const String& text, SceneMessage& out);

// Copies the envelope's top-level turn_ref (playback_start, status).
bool extractTurnRef(const String& text, char* out, size_t outSize);

// end_of_turn {} (#1365): true only for that type with a non-empty turn_ref
// that fits turnRefSize (a longer one is refused, never cut).
bool parseEndOfTurn(const String& text, char* turnRef, size_t turnRefSize);

// Wire names for the enums ("ptt" | "wake" | "announce_only", ...).
const char* deviceModeName(DeviceMode mode);
const char* announceKindName(AnnounceKind kind);
const char* announceActionName(AnnounceAction action);

// Human-readable name for a ServerStage, used by journal().
const char* serverStageName(ServerStage value);

// Parses a 20-byte OLX2 header from `payload`. Returns true if the magic and
// version match and the format id is recognized.
bool parseOlx2Header(const uint8_t* payload, size_t length, Olx2Header* out);

}  // namespace bob
