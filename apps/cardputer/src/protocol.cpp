// Bob Cardputer v2 — wire protocol helpers.
#include "protocol.h"

#include <Arduino.h>
#include <cstdio>
#include <cstring>
#include <esp_system.h>
#include "config.h"

namespace bob {

// Declared here, not via board.h: the host tests compile this file without M5Cardputer
// (test/host/shim/board_model.cpp defines it there).
namespace board {
const char* model();
}

namespace {

constexpr size_t kControlBufferBytes = 512;

// Copies the double-quoted value following `key` (e.g. "\"user_code\":\"")
// into `out`, NUL-terminated and truncated to outSize-1. Returns false when
// the key or the closing quote is missing.
bool copyQuotedValue(const String& text, const char* key, char* out, size_t outSize) {
  if (!out || outSize == 0) return false;
  const int keyPos = text.indexOf(key);
  if (keyPos < 0) return false;
  const int valueStart = keyPos + static_cast<int>(strlen(key));
  const int valueEnd = text.indexOf('"', valueStart);
  if (valueEnd <= valueStart) return false;
  const size_t len = static_cast<size_t>(valueEnd - valueStart);
  const size_t copyLen = len < outSize - 1 ? len : outSize - 1;
  memcpy(out, text.c_str() + valueStart, copyLen);
  out[copyLen] = '\0';
  return true;
}

// Copies the digit sequence following `key` (e.g. "\"expires_in\":") into
// `out`. Returns false when the key is missing or no digit follows it.
bool copyNumberValue(const String& text, const char* key, char* out, size_t outSize) {
  if (!out || outSize == 0) return false;
  const int keyPos = text.indexOf(key);
  if (keyPos < 0) return false;
  const int valueStart = keyPos + static_cast<int>(strlen(key));
  int valueEnd = valueStart;
  while (valueEnd < static_cast<int>(text.length()) && text[valueEnd] >= '0' &&
         text[valueEnd] <= '9') {
    ++valueEnd;
  }
  if (valueEnd == valueStart) return false;
  const size_t len = static_cast<size_t>(valueEnd - valueStart);
  const size_t copyLen = len < outSize - 1 ? len : outSize - 1;
  memcpy(out, text.c_str() + valueStart, copyLen);
  out[copyLen] = '\0';
  return true;
}

// Parses an active_conversation object body starting at `bracePos` (the '{').
// Handles the null form {id:null,title:null} (present=false) and the set form
// {id:"...",title:"..."} (present=true). Returns false on malformed input.
bool parseActiveBody(const String& text, int bracePos, ActiveConversation& out) {
  const int idKey = text.indexOf("\"id\":", bracePos + 1);
  if (idKey < 0) return false;
  const int valueStart = idKey + static_cast<int>(strlen("\"id\":"));
  if (text.startsWith("null", valueStart)) {
    out.present = false;
    out.id[0] = '\0';
    out.title[0] = '\0';
    return true;
  }
  if (text[valueStart] != '"') return false;
  const int idEnd = text.indexOf('"', valueStart + 1);
  if (idEnd <= valueStart) return false;
  const size_t idLen = static_cast<size_t>(idEnd - (valueStart + 1));
  const size_t idCopy = idLen < kConversationIdBytes - 1 ? idLen : kConversationIdBytes - 1;
  memcpy(out.id, text.c_str() + valueStart + 1, idCopy);
  out.id[idCopy] = '\0';

  const int titleKey = text.indexOf("\"title\":\"", idEnd);
  if (titleKey < 0) return false;
  const int titleStart = titleKey + static_cast<int>(strlen("\"title\":\""));
  const int titleEnd = text.indexOf('"', titleStart);
  if (titleEnd <= titleStart) return false;
  const size_t titleLen = static_cast<size_t>(titleEnd - titleStart);
  const size_t titleCopy = titleLen < kConversationTitleBytes - 1 ? titleLen
                                                                   : kConversationTitleBytes - 1;
  memcpy(out.title, text.c_str() + titleStart, titleCopy);
  out.title[titleCopy] = '\0';
  out.present = true;
  return true;
}

// Index of the closing quote of a JSON string whose body starts at `start`,
// skipping backslash escapes. Returns -1 when the string is unterminated.
int findStringEnd(const String& text, int start) {
  const int length = static_cast<int>(text.length());
  for (int i = start; i < length; ++i) {
    if (text[i] == '\\') {
      ++i;
    } else if (text[i] == '"') {
      return i;
    }
  }
  return -1;
}

// Copies the JSON string body text[start, end) into `out`, truncated to
// outSize-1. \" \\ \/ are unescaped; \uXXXX becomes '?', other escapes ' '.
void copyJsonString(const String& text, int start, int end, char* out, size_t outSize) {
  size_t n = 0;
  for (int i = start; i < end && n + 1 < outSize; ++i) {
    char c = text[i];
    if (c == '\\' && i + 1 < end) {
      const char escaped = text[++i];
      if (escaped == 'u') {
        c = '?';
        i += 4;
      } else if (escaped == '"' || escaped == '\\' || escaped == '/') {
        c = escaped;
      } else {
        c = ' ';
      }
    }
    out[n++] = c;
  }
  out[n] = '\0';
}

// Parses `<idKey>null` or `<idKey>"<uuid>"` then `"name":"<name>"`, searching
// from `from`. Ids that do not fit kSpaceIdBytes are rejected, never
// truncated. Returns the index just past the parsed value, or -1.
int parseSpaceRef(const String& text, int from, const char* idKey, ActiveSpace& out) {
  out = ActiveSpace();
  const int keyPos = text.indexOf(idKey, from);
  if (keyPos < 0) return -1;
  const int valueStart = keyPos + static_cast<int>(strlen(idKey));
  if (text.startsWith("null", valueStart)) return valueStart + 4;
  if (text[valueStart] != '"') return -1;
  const int idEnd = text.indexOf('"', valueStart + 1);
  if (idEnd < 0) return -1;
  const size_t idLen = static_cast<size_t>(idEnd - (valueStart + 1));
  if (idLen == 0 || idLen >= kSpaceIdBytes) return -1;
  const int nameKey = text.indexOf("\"name\":\"", idEnd);
  if (nameKey < 0) return -1;
  const int nameStart = nameKey + static_cast<int>(strlen("\"name\":\""));
  const int nameEnd = findStringEnd(text, nameStart);
  if (nameEnd <= nameStart) return -1;
  memcpy(out.id, text.c_str() + valueStart + 1, idLen);
  out.id[idLen] = '\0';
  copyJsonString(text, nameStart, nameEnd, out.name, sizeof(out.name));
  out.present = true;
  return nameEnd + 1;
}

}  // namespace

void writeU32(uint8_t* output, size_t offset, uint32_t value) {
  output[offset] = static_cast<uint8_t>((value >> 24) & 0xff);
  output[offset + 1] = static_cast<uint8_t>((value >> 16) & 0xff);
  output[offset + 2] = static_cast<uint8_t>((value >> 8) & 0xff);
  output[offset + 3] = static_cast<uint8_t>(value & 0xff);
}

String messageId(const char* prefix) {
  return String(prefix) + "_" + String(millis()) + "_v2";
}

// fwVersion and the caps are build-time constants (types.h), never user text,
// so they are copied without escaping.
String buildHello(AudioFormat format, const char* fwVersion, const char* const* caps,
                  size_t capCount, const HelloOta* ota) {
  const String id = messageId("hello");
  const uint8_t formatId = static_cast<uint8_t>(format);
  String out = String("{\"v\":1,\"type\":\"hello\",\"id\":\"") + id +
               "\",\"payload\":{\"format_id\":" + String(static_cast<unsigned int>(formatId));
  if (fwVersion != nullptr && fwVersion[0] != '\0') {
    out += String(",\"fw_version\":\"") + fwVersion + "\"";
  }
  if (caps != nullptr && capCount > 0) {
    out += ",\"caps\":[";
    for (size_t i = 0; i < capCount; ++i) {
      if (i > 0) out += ",";
      out += String("\"") + caps[i] + "\"";
    }
    out += "]";
  }
  if (ota != nullptr) {
    if (ota->board != nullptr && ota->board[0] != '\0') {
      out += String(",\"board\":\"") + ota->board + "\"";
    }
    if (ota->lastResult != nullptr && ota->lastResult[0] != '\0' && ota->lastTo != nullptr &&
        ota->lastTo[0] != '\0') {
      out += String(",\"last_ota\":{\"result\":\"") + ota->lastResult + "\",\"to\":\"" +
             ota->lastTo + "\"";
      if (ota->lastReason != nullptr && ota->lastReason[0] != '\0') {
        out += String(",\"reason\":\"") + ota->lastReason + "\"";
      }
      out += "}";
    }
    if (ota->slot == 0 || ota->slot == 1) out += String(",\"ota_slot\":") + String(ota->slot);
  }
  out += "}}";
  return out;
}

String buildCheckUpdate() {
  const String id = messageId("chk");
  return String("{\"v\":1,\"type\":\"check_update\",\"id\":\"") + id + "\",\"payload\":{}}";
}

String buildOtaProgress(const char* stage, const char* to, const char* reason) {
  const String id = messageId("otap");
  String out = String("{\"v\":1,\"type\":\"ota_progress\",\"id\":\"") + id +
               "\",\"payload\":{\"stage\":\"" + stage + "\",\"to\":\"" + to + "\"";
  if (reason != nullptr && reason[0] != '\0') out += String(",\"reason\":\"") + reason + "\"";
  out += "}}";
  return out;
}

bool helloFallbackNeeded(bool welcomed, bool sentExtendedHello, bool fallbackSent,
                         const char* code) {
  return !welcomed && sentExtendedHello && !fallbackSent && code != nullptr &&
         strcmp(code, "BAD_MESSAGE") == 0;
}

namespace {
// The server's OpaqueIdSchema: 8..64 of [A-Za-z0-9_-]. Also keeps the id
// JSON-safe, since it is copied without escaping.
bool isOpaqueId(const char* value) {
  if (value == nullptr) return false;
  size_t length = 0;
  for (; value[length] != '\0'; ++length) {
    const char c = value[length];
    const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
    if (!ok || length >= 64) return false;
  }
  return length >= 8;
}
}  // namespace

bool welcomeSupportsAssistantName(const String& welcome) {
  return welcome.indexOf("\"assistant_name\":true") >= 0;
}

String buildTurnStart(const String& turnRef, const char* conversationId, WakeWord word,
                      bool assistantNameSupported) {
  const String id = messageId("start");
  // Each key is optional; joined with a comma when both are present.
  char conversation[96] = "";
  if (isOpaqueId(conversationId)) {
    snprintf(conversation, sizeof(conversation), "\"conversation_id\":\"%s\"", conversationId);
  }
  (void)word;  // the assistant is Bob whichever wake word is listening.
  const char* name = assistantNameSupported ? "\"assistant_name\":\"bob\"" : "";
  char buffer[kControlBufferBytes];
  snprintf(buffer, sizeof(buffer),
           "{\"v\":1,\"type\":\"turn_start\",\"id\":\"%s\",\"turn_ref\":\"%s\",\"payload\":{%s%s%s}}",
           id.c_str(), turnRef.c_str(), conversation, conversation[0] && name[0] ? "," : "", name);
  return String(buffer);
}

bool welcomeAcceptsTurnConversation(const String& welcome) {
  return welcome.indexOf("\"turn_conversation\":true") >= 0;
}

String buildTurnEnd(const String& turnRef, uint32_t lastSequence) {
  const String id = messageId("end");
  const uint32_t seq = lastSequence == 0 ? 0 : lastSequence - 1;
  char buffer[kControlBufferBytes];
  snprintf(buffer, sizeof(buffer),
           "{\"v\":1,\"type\":\"turn_end\",\"id\":\"%s\",\"turn_ref\":\"%s\",\"seq\":%lu,\"payload\":{}}",
           id.c_str(), turnRef.c_str(), static_cast<unsigned long>(seq));
  return String(buffer);
}

String buildListConversations() {
  const String id = messageId("list");
  char buffer[kControlBufferBytes];
  snprintf(buffer, sizeof(buffer),
           "{\"v\":1,\"type\":\"list_conversations\",\"id\":\"%s\",\"payload\":{}}",
           id.c_str());
  return String(buffer);
}

String buildSelectConversation(const char* conversationId) {
  const String id = messageId("sel");
  char buffer[kControlBufferBytes];
  snprintf(buffer, sizeof(buffer),
           "{\"v\":1,\"type\":\"select_conversation\",\"id\":\"%s\",\"payload\":{\"conversation_id\":\"%s\"}}",
           id.c_str(), conversationId);
  return String(buffer);
}

String buildNewConversation(const String& requestId) {
  const String id = messageId("ncnv");
  char buffer[kControlBufferBytes];
  snprintf(buffer, sizeof(buffer),
           "{\"v\":1,\"type\":\"new_conversation\",\"id\":\"%s\",\"payload\":{\"request_id\":\"%s\"}}",
           id.c_str(), requestId.c_str());
  return String(buffer);
}

String buildListSpaces() {
  const String id = messageId("lspc");
  char buffer[kControlBufferBytes];
  snprintf(buffer, sizeof(buffer),
           "{\"v\":1,\"type\":\"list_spaces\",\"id\":\"%s\",\"payload\":{}}",
           id.c_str());
  return String(buffer);
}

String buildSelectSpace(const char* spaceId) {
  const String id = messageId("sspc");
  char buffer[kControlBufferBytes];
  if (spaceId && spaceId[0] != '\0') {
    snprintf(buffer, sizeof(buffer),
             "{\"v\":1,\"type\":\"select_space\",\"id\":\"%s\",\"payload\":{\"space_id\":\"%s\"}}",
             id.c_str(), spaceId);
  } else {
    snprintf(buffer, sizeof(buffer),
             "{\"v\":1,\"type\":\"select_space\",\"id\":\"%s\",\"payload\":{\"space_id\":null}}",
             id.c_str());
  }
  return String(buffer);
}

String buildPairRequest(const char* claim, const char* resume) {
  const String id = messageId("preq");
  char buffer[kControlBufferBytes];
  if (resume && resume[0] != '\0') {
    snprintf(buffer, sizeof(buffer),
             "{\"v\":1,\"type\":\"pair_request\",\"id\":\"%s\",\"payload\":{\"model\":\"%s\",\"fw_version\":\"%s\",\"claim\":\"%s\",\"resume\":\"%s\"}}",
             id.c_str(), board::model(), kFirmwareVersion, claim, resume);
  } else {
    snprintf(buffer, sizeof(buffer),
             "{\"v\":1,\"type\":\"pair_request\",\"id\":\"%s\",\"payload\":{\"model\":\"%s\",\"fw_version\":\"%s\",\"claim\":\"%s\"}}",
             id.c_str(), board::model(), kFirmwareVersion, claim);
  }
  return String(buffer);
}

void generateClaim(char* out, size_t outSize) {
  if (!out || outSize < kClaimBytes) return;
  const char* hex = "0123456789abcdef";
  for (size_t i = 0; i < 16; ++i) {
    const uint8_t b = static_cast<uint8_t>(esp_random());
    out[i * 2] = hex[(b >> 4) & 0x0f];
    out[i * 2 + 1] = hex[b & 0x0f];
  }
  out[32] = '\0';
}

uint8_t extractWelcomeFormatId(const String& text) {
  const int keyPos = text.indexOf("\"format_id\":");
  if (keyPos < 0) return 0;
  const int valueStart = keyPos + static_cast<int>(strlen("\"format_id\":"));
  const int valueEnd = text.indexOf(',', valueStart);
  const int valueEnd2 = text.indexOf('}', valueStart);
  const int valueEnd3 = text.indexOf(' ', valueStart);
  int end = valueEnd;
  if (end < 0 || (valueEnd2 >= 0 && valueEnd2 < end)) end = valueEnd2;
  if (end < 0 || (valueEnd3 >= 0 && valueEnd3 < end)) end = valueEnd3;
  if (end < 0) return 0;
  const String value = text.substring(valueStart, end);
  return static_cast<uint8_t>(value.toInt());
}

String extractSessionId(const String& text) {
  const int keyPos = text.indexOf("\"session_id\":\"");
  if (keyPos < 0) return String();
  const int valueStart = keyPos + static_cast<int>(strlen("\"session_id\":\""));
  const int valueEnd = text.indexOf('"', valueStart);
  if (valueEnd <= valueStart) return String();
  return text.substring(valueStart, valueEnd);
}

bool isWelcome(const String& text) {
  return text.indexOf("\"type\":\"welcome\"") >= 0;
}

bool isPlaybackStart(const String& text) {
  return text.indexOf("\"type\":\"playback_start\"") >= 0;
}

bool isPlaybackEnd(const String& text) {
  return text.indexOf("\"type\":\"playback_end\"") >= 0;
}

bool isServerError(const String& text) {
  return text.indexOf("\"type\":\"error\"") >= 0;
}

bool isStatus(const String& text) {
  return text.indexOf("\"type\":\"status\"") >= 0;
}

bool isConversations(const String& text) {
  return text.indexOf("\"type\":\"conversations\"") >= 0;
}

bool isConversationSelected(const String& text) {
  return text.indexOf("\"type\":\"conversation_selected\"") >= 0;
}

bool isConversationCleared(const String& text) {
  return text.indexOf("\"type\":\"conversation_cleared\"") >= 0;
}

bool isUpdateRequired(const String& text) {
  return text.indexOf("\"type\":\"update_required\"") >= 0;
}

bool parseUpdateRequired(const String& text, UpdateRequired& out) {
  out = UpdateRequired();
  const char* key = "\"min_version\":\"";
  const int keyPos = text.indexOf(key);
  if (keyPos < 0) return false;
  const int valueStart = keyPos + static_cast<int>(strlen(key));
  const int valueEnd = text.indexOf('"', valueStart);
  // Bounded like the server's FirmwareVersionSchema: never truncated.
  if (valueEnd <= valueStart || valueEnd - valueStart >= static_cast<int>(kFwVersionBytes)) {
    return false;
  }
  if (!copyQuotedValue(text, key, out.minVersion, sizeof(out.minVersion))) return false;
  out.unknownVersion = text.indexOf("\"reason\":\"unknown_version\"") >= 0;
  return true;
}

namespace {

// Like copyQuotedValue, but a value that does not fit is a failure, not a cut.
bool copyQuotedWhole(const String& text, const char* key, char* out, size_t outSize) {
  const int keyPos = text.indexOf(key);
  if (keyPos < 0) return false;
  const int valueStart = keyPos + static_cast<int>(strlen(key));
  const int valueEnd = text.indexOf('"', valueStart);
  if (valueEnd <= valueStart || valueEnd - valueStart >= static_cast<int>(outSize)) return false;
  return copyQuotedValue(text, key, out, outSize);
}

bool copyU32(const String& text, const char* key, uint32_t& out) {
  char digits[12];
  if (!copyNumberValue(text, key, digits, sizeof(digits)) || strlen(digits) > 10) return false;
  const unsigned long long value = strtoull(digits, nullptr, 10);
  if (value > UINT32_MAX) return false;
  out = static_cast<uint32_t>(value);
  return true;
}

// Reads the offer object that starts at `anchor` (ending in its '{'). The body
// ends at the first '}': a message cut short has none and is refused.
bool parseOfferAt(const String& text, const char* anchor, OtaOffer& out) {
  const int start = text.indexOf(anchor);
  if (start < 0) return false;
  const int end = text.indexOf('}', start);
  if (end < 0) return false;
  const String body = text.substring(start, end);
  OtaOffer parsed;
  if (!copyQuotedWhole(body, "\"version\":\"", parsed.version, sizeof(parsed.version)) ||
      !copyU32(body, "\"size\":", parsed.size) || parsed.size == 0 ||
      !copyQuotedWhole(body, "\"sha256\":\"", parsed.sha256, sizeof(parsed.sha256)) ||
      strlen(parsed.sha256) != sizeof(parsed.sha256) - 1 ||
      !copyQuotedWhole(body, "\"key_id\":\"", parsed.keyId, sizeof(parsed.keyId)) ||
      !copyU32(body, "\"apply_after_s\":", parsed.applyAfterS)) {
    return false;
  }
  for (const char* c = parsed.sha256; *c != '\0'; ++c) {
    if (!((*c >= '0' && *c <= '9') || (*c >= 'a' && *c <= 'f'))) return false;
  }
  if (body.indexOf("\"mandatory\":true") >= 0) {
    parsed.mandatory = true;
  } else if (body.indexOf("\"mandatory\":false") < 0) {
    return false;
  }
  out = parsed;
  return true;
}

}  // namespace

bool isUpdateOffer(const String& text) {
  return text.indexOf("\"type\":\"update_offer\"") >= 0;
}

bool parseUpdateOffer(const String& text, OtaOffer& out) {
  out = OtaOffer();
  return isUpdateOffer(text) && parseOfferAt(text, "\"payload\":{", out);
}

bool parseWelcomeUpdateOffer(const String& text, OtaOffer& out) {
  out = OtaOffer();
  return parseOfferAt(text, "\"update_offer\":{", out);
}

bool isPairingRequired(const String& text) {
  return text.indexOf("\"type\":\"pairing_required\"") >= 0;
}

bool isPairCode(const String& text) {
  return text.indexOf("\"type\":\"pair_code\"") >= 0;
}

bool isPaired(const String& text) {
  return text.indexOf("\"type\":\"paired\"") >= 0;
}

bool isPairExpired(const String& text) {
  return text.indexOf("\"type\":\"pair_expired\"") >= 0;
}

bool isPairDenied(const String& text) {
  return text.indexOf("\"type\":\"pair_denied\"") >= 0;
}

bool isActiveConversation(const String& text) {
  return text.indexOf("\"type\":\"active_conversation\"") >= 0;
}

// The closing quote keeps each match exact: "spaces" never matches
// "space_selected", and "active_space" never matches "active_conversation".
bool isSpaces(const String& text) {
  return text.indexOf("\"type\":\"spaces\"") >= 0;
}

bool isSpaceSelected(const String& text) {
  return text.indexOf("\"type\":\"space_selected\"") >= 0;
}

bool isActiveSpace(const String& text) {
  return text.indexOf("\"type\":\"active_space\"") >= 0;
}

bool extractStatusStage(const String& text, ServerStage& out) {
  const int keyPos = text.indexOf("\"payload\":{\"stage\":\"");
  if (keyPos < 0) return false;
  const int valueStart = keyPos + static_cast<int>(strlen("\"payload\":{\"stage\":\""));
  const int valueEnd = text.indexOf('"', valueStart);
  if (valueEnd <= valueStart) return false;
  const String value = text.substring(valueStart, valueEnd);
  if (value == "thinking") out = ServerStage::kThinking;
  else if (value == "speaking") out = ServerStage::kSpeaking;
  else if (value == "idle") out = ServerStage::kIdle;
  else return false;
  return true;
}

const char* serverStageName(ServerStage value) {
  switch (value) {
    case ServerStage::kIdle: return "idle";
    case ServerStage::kThinking: return "thinking";
    case ServerStage::kSpeaking: return "speaking";
  }
  return "unknown";
}

size_t parseConversations(const String& text, ListedConversation* out, size_t maxEntries) {
  if (!out || maxEntries == 0) return 0;
  const int listKey = text.indexOf("\"conversations\":[");
  if (listKey < 0) return 0;

  size_t count = 0;
  int pos = listKey;
  while (count < maxEntries) {
    const int idKey = text.indexOf("\"id\":\"", pos);
    if (idKey < 0) break;
    const int idStart = idKey + static_cast<int>(strlen("\"id\":\""));
    const int idEnd = text.indexOf('"', idStart);
    if (idEnd <= idStart) break;

    const int titleKey = text.indexOf("\"title\":\"", idEnd);
    if (titleKey < 0) break;
    const int titleStart = titleKey + static_cast<int>(strlen("\"title\":\""));
    const int titleEnd = text.indexOf('"', titleStart);
    if (titleEnd <= titleStart) break;

    const size_t idLen = static_cast<size_t>(idEnd - idStart);
    const size_t idCopy = idLen < kConversationIdBytes - 1 ? idLen : kConversationIdBytes - 1;
    memcpy(out[count].id, text.c_str() + idStart, idCopy);
    out[count].id[idCopy] = '\0';

    const size_t titleLen = static_cast<size_t>(titleEnd - titleStart);
    const size_t titleCopy = titleLen < kConversationTitleBytes - 1 ? titleLen
                                                                     : kConversationTitleBytes - 1;
    memcpy(out[count].title, text.c_str() + titleStart, titleCopy);
    out[count].title[titleCopy] = '\0';

    ++count;
    pos = titleEnd;
  }
  return count;
}

bool extractSelectedConversationId(const String& text, char* out, size_t outSize) {
  if (!out || outSize == 0) return false;
  const int keyPos = text.indexOf("\"conversation_id\":\"");
  if (keyPos < 0) return false;
  const int valueStart = keyPos + static_cast<int>(strlen("\"conversation_id\":\""));
  const int valueEnd = text.indexOf('"', valueStart);
  if (valueEnd <= valueStart) return false;
  const size_t len = static_cast<size_t>(valueEnd - valueStart);
  const size_t copyLen = len < outSize - 1 ? len : outSize - 1;
  memcpy(out, text.c_str() + valueStart, copyLen);
  out[copyLen] = '\0';
  return true;
}

bool extractErrorCode(const String& text, char* out, size_t outSize) {
  if (!out || outSize == 0) return false;
  const int keyPos = text.indexOf("\"payload\":{\"code\":\"");
  if (keyPos < 0) return false;
  const int valueStart = keyPos + static_cast<int>(strlen("\"payload\":{\"code\":\""));
  const int valueEnd = text.indexOf('"', valueStart);
  if (valueEnd <= valueStart) return false;
  const size_t len = static_cast<size_t>(valueEnd - valueStart);
  const size_t copyLen = len < outSize - 1 ? len : outSize - 1;
  memcpy(out, text.c_str() + valueStart, copyLen);
  out[copyLen] = '\0';
  return true;
}

bool extractPairingRequiredReason(const String& text, char* out, size_t outSize) {
  return copyQuotedValue(text, "\"payload\":{\"reason\":\"", out, outSize);
}

bool parsePairCode(const String& text, PairingInfo& info) {
  char expiresStr[8];
  if (!copyQuotedValue(text, "\"pairing_id\":\"", info.pairingId, sizeof(info.pairingId)) ||
      !copyQuotedValue(text, "\"user_code\":\"", info.userCode, sizeof(info.userCode)) ||
      !copyQuotedValue(text, "\"verification_uri\":\"", info.verificationUri,
                       sizeof(info.verificationUri)) ||
      !copyNumberValue(text, "\"expires_in\":", expiresStr, sizeof(expiresStr))) {
    return false;
  }
  const long expiresIn = strtol(expiresStr, nullptr, 10);
  info.expiresAtMs =
      expiresIn > 0 ? millis() + static_cast<uint32_t>(expiresIn) * 1000u : 0;
  info.active = true;
  return true;
}

bool parsePaired(const String& text, char* deviceToken, size_t tokenSize,
                 char* deviceName, size_t nameSize) {
  return copyQuotedValue(text, "\"device_token\":\"", deviceToken, tokenSize) &&
         copyQuotedValue(text, "\"name\":\"", deviceName, nameSize);
}

bool parseActiveConversation(const String& text, ActiveConversation& out) {
  out = ActiveConversation();
  const int payloadKey = text.indexOf("\"payload\":{");
  if (payloadKey < 0) return false;
  return parseActiveBody(text, payloadKey + static_cast<int>(strlen("\"payload\":")), out);
}

bool parseWelcomeAdditive(const String& text, char* deviceName, size_t nameSize,
                          ActiveConversation& out) {
  if (!deviceName || nameSize == 0) return false;
  deviceName[0] = '\0';
  out = ActiveConversation();

  const int deviceKey = text.indexOf("\"device\":");
  if (deviceKey < 0) return false;
  const int afterDevice = deviceKey + static_cast<int>(strlen("\"device\":"));
  if (!text.startsWith("null", afterDevice)) {
    const int nameKey = text.indexOf("\"name\":\"", afterDevice);
    if (nameKey < 0) return false;
    const int nameStart = nameKey + static_cast<int>(strlen("\"name\":\""));
    const int nameEnd = text.indexOf('"', nameStart);
    if (nameEnd <= nameStart) return false;
    const size_t len = static_cast<size_t>(nameEnd - nameStart);
    const size_t copyLen = len < nameSize - 1 ? len : nameSize - 1;
    memcpy(deviceName, text.c_str() + nameStart, copyLen);
    deviceName[copyLen] = '\0';
  }

  const int acKey = text.indexOf("\"active_conversation\":", afterDevice);
  if (acKey >= 0) {
    const int afterAc = acKey + static_cast<int>(strlen("\"active_conversation\":"));
    if (!text.startsWith("null", afterAc) && text[afterAc] == '{') {
      parseActiveBody(text, afterAc, out);
    }
  }
  return true;
}

size_t parseSpaces(const String& text, ListedSpace* out, size_t maxEntries) {
  if (!out || maxEntries == 0) return 0;
  const int listKey = text.indexOf("\"spaces\":[");
  if (listKey < 0) return 0;

  size_t count = 0;
  int pos = listKey;
  while (count < maxEntries) {
    const int idKey = text.indexOf("\"id\":\"", pos);
    if (idKey < 0) break;
    ActiveSpace entry;
    const int next = parseSpaceRef(text, idKey, "\"id\":", entry);
    if (next < 0 || !entry.present) {
      pos = idKey + 1;  // skip an entry whose id does not fit.
      continue;
    }
    memcpy(out[count].id, entry.id, kSpaceIdBytes);
    memcpy(out[count].name, entry.name, kSpaceNameBytes);
    ++count;
    pos = next;
  }
  return count;
}

bool parseActiveSpace(const String& text, ActiveSpace& out) {
  out = ActiveSpace();
  const int payloadKey = text.indexOf("\"payload\":{");
  if (payloadKey < 0) return false;
  return parseSpaceRef(text, payloadKey, "\"id\":", out) >= 0;
}

bool parseSpaceSelected(const String& text, ActiveSpace& out) {
  out = ActiveSpace();
  const int payloadKey = text.indexOf("\"payload\":{");
  if (payloadKey < 0) return false;
  return parseSpaceRef(text, payloadKey, "\"space_id\":", out) >= 0;
}

void parseWelcomeActiveSpace(const String& text, ActiveSpace& out) {
  out = ActiveSpace();
  const int key = text.indexOf("\"active_space\":");
  if (key < 0) return;
  const int valueStart = key + static_cast<int>(strlen("\"active_space\":"));
  if (text[valueStart] != '{') return;  // null (or malformed) == no Space.
  if (parseSpaceRef(text, valueStart, "\"id\":", out) < 0) out = ActiveSpace();
}

// --- Device control (epic #311) ---

namespace {

// Index just past `"payload":{`, or -1.
int payloadStart(const String& text) {
  const int key = text.indexOf("\"payload\":{");
  return key < 0 ? -1 : key + static_cast<int>(strlen("\"payload\":{"));
}

// Reads the JSON string after `key` (e.g. "\"heard\":\""), searching from
// `from`, into `out`. Returns the index just past its closing quote, or -1.
// Fields are read in contract order, so text inside an earlier string (whose
// quotes are escaped) can never be mistaken for a later key.
int readStringField(const String& text, int from, const char* key, char* out,
                    size_t outSize) {
  const int keyPos = text.indexOf(key, from);
  if (keyPos < 0) return -1;
  const int start = keyPos + static_cast<int>(strlen(key));
  const int end = findStringEnd(text, start);
  if (end < 0) return -1;
  copyJsonString(text, start, end, out, outSize);
  return end + 1;
}

// Reads `key` followed by true|false. Returns the index past the value, or -1.
int readBoolField(const String& text, int from, const char* key, bool& out) {
  const int keyPos = text.indexOf(key, from);
  if (keyPos < 0) return -1;
  const int start = keyPos + static_cast<int>(strlen(key));
  if (text.startsWith("true", start)) {
    out = true;
    return start + 4;
  }
  if (text.startsWith("false", start)) {
    out = false;
    return start + 5;
  }
  return -1;
}

// Folds UTF-8 in place to what the built-in ASCII font can draw: curly
// quotes and dashes become their ASCII forms, anything else becomes '?'.
void foldToAscii(char* text) {
  const uint8_t* in = reinterpret_cast<const uint8_t*>(text);
  char* out = text;
  while (*in != 0) {
    if (*in < 0x80) {
      *out++ = static_cast<char>(*in++);
      continue;
    }
    if (in[0] == 0xE2 && in[1] == 0x80 && in[2] != 0) {
      const uint8_t c = in[2];
      *out++ = (c == 0x98 || c == 0x99) ? '\''
               : (c == 0x9C || c == 0x9D) ? '"'
               : (c == 0x93 || c == 0x94) ? '-'
               : (c == 0xA6) ? '.' : '?';
      in += 3;
      continue;
    }
    *out++ = '?';
    ++in;
    while ((*in & 0xC0) == 0x80) ++in;  // skip continuation bytes.
  }
  *out = '\0';
}

bool parseDeviceMode(const char* name, DeviceMode& out) {
  if (strcmp(name, "ptt") == 0) out = DeviceMode::kPtt;
  else if (strcmp(name, "wake") == 0) out = DeviceMode::kWake;
  else if (strcmp(name, "announce_only") == 0) out = DeviceMode::kAnnounceOnly;
  else return false;
  return true;
}

bool parseAnnounceKind(const char* name, AnnounceKind& out) {
  if (strcmp(name, "timer") == 0) out = AnnounceKind::kTimer;
  else if (strcmp(name, "alarm") == 0) out = AnnounceKind::kAlarm;
  else if (strcmp(name, "reminder") == 0) out = AnnounceKind::kReminder;
  else if (strcmp(name, "notice") == 0) out = AnnounceKind::kNotice;
  else return false;
  return true;
}

}  // namespace

String buildDeviceState(const DeviceSettings& settings, int batteryPct, int charging) {
  const String id = messageId("dstate");
  char battery[8] = "null";
  if (batteryPct >= 0) snprintf(battery, sizeof(battery), "%d", batteryPct > 100 ? 100 : batteryPct);
  const char* chargingText = charging < 0 ? "null" : charging ? "true" : "false";
  char buffer[kControlBufferBytes];
#if defined(BOB_BOARD_WAVESHARE_185C)
  // The Waveshare also reports its wake word, after ring_sound (the server's contract order).
  char wake[32];
  snprintf(wake, sizeof(wake), ",\"wake_word\":\"%s\"", wakeWordWireName(settings.wakeWord));
#else
  const char* wake = "";
#endif
  snprintf(buffer, sizeof(buffer),
           "{\"v\":1,\"type\":\"device_state\",\"id\":\"%s\",\"payload\":{\"volume\":%u,\"muted\":%s,\"mode\":\"%s\",\"dnd\":%s,\"ring_seconds\":%u,\"ring_sound\":\"%s\"%s,\"battery_pct\":%s,\"charging\":%s,\"fw_version\":\"%s\"}}",
           id.c_str(), static_cast<unsigned int>(settings.volume),
           settings.muted ? "true" : "false", deviceModeName(settings.mode),
           settings.dnd ? "true" : "false", static_cast<unsigned int>(settings.ringSeconds),
           ringSoundName(settings.ringSound), wake, battery, chargingText, kFirmwareShortVersion);
  return String(buffer);
}

String buildAnnounceAck(const char* announceId, AnnounceAction action) {
  const String id = messageId("annack");
  char buffer[kControlBufferBytes];
  snprintf(buffer, sizeof(buffer),
           "{\"v\":1,\"type\":\"announce_ack\",\"id\":\"%s\",\"payload\":{\"announce_id\":\"%s\",\"action\":\"%s\"}}",
           id.c_str(), announceId, announceActionName(action));
  return String(buffer);
}

String buildCancel(const String& turnRef) {
  const String id = messageId("cancel");
  char buffer[kControlBufferBytes];
  if (turnRef.length() > 0) {
    snprintf(buffer, sizeof(buffer),
             "{\"v\":1,\"type\":\"cancel\",\"id\":\"%s\",\"turn_ref\":\"%s\",\"payload\":{}}",
             id.c_str(), turnRef.c_str());
  } else {
    snprintf(buffer, sizeof(buffer),
             "{\"v\":1,\"type\":\"cancel\",\"id\":\"%s\",\"payload\":{}}", id.c_str());
  }
  return String(buffer);
}

bool isDeviceControl(const String& text) {
  return text.indexOf("\"type\":\"device_control\"") >= 0;
}

bool isReplyText(const String& text) {
  return text.indexOf("\"type\":\"reply_text\"") >= 0;
}

bool isAnnounce(const String& text) {
  return text.indexOf("\"type\":\"announce\"") >= 0;
}

bool parseDeviceControl(const String& text, DeviceControl& out) {
  out = DeviceControl();
  int pos = payloadStart(text);
  if (pos < 0) return false;
  const int volumeKey = text.indexOf("\"volume\":", pos);
  if (volumeKey >= 0) {
    int i = volumeKey + static_cast<int>(strlen("\"volume\":"));
    const int start = i;
    unsigned int value = 0;
    while (i < static_cast<int>(text.length()) && i - start < 3 && text[i] >= '0' &&
           text[i] <= '9') {
      value = value * 10 + static_cast<unsigned int>(text[i] - '0');
      ++i;
    }
    if (i > start && value <= kVolumeMax) {
      out.hasVolume = true;
      out.volume = static_cast<uint8_t>(value);
      pos = i;
    }
  }
  bool flag = false;
  int next = readBoolField(text, pos, "\"muted\":", flag);
  if (next >= 0) {
    out.hasMuted = true;
    out.muted = flag;
    pos = next;
  }
  char mode[16];
  next = readStringField(text, pos, "\"mode\":\"", mode, sizeof(mode));
  if (next >= 0 && parseDeviceMode(mode, out.mode)) {
    out.hasMode = true;
    pos = next;
  }
  next = readBoolField(text, pos, "\"dnd\":", flag);
  if (next >= 0) {
    out.hasDnd = true;
    out.dnd = flag;
    pos = next;
  }
  // #389: an integer 10..120 (a fraction or a longer number is ignored).
  const int ringKey = text.indexOf("\"ring_seconds\":", pos);
  if (ringKey >= 0) {
    int i = ringKey + static_cast<int>(strlen("\"ring_seconds\":"));
    const int start = i;
    unsigned int value = 0;
    while (i < static_cast<int>(text.length()) && i - start < 4 && text[i] >= '0' &&
           text[i] <= '9') {
      value = value * 10 + static_cast<unsigned int>(text[i] - '0');
      ++i;
    }
    const bool ends = i < static_cast<int>(text.length()) && (text[i] == ',' || text[i] == '}');
    if (i > start && ends && ringSecondsValid(value)) {
      out.hasRingSeconds = true;
      out.ringSeconds = static_cast<uint8_t>(value);
      pos = i;
    }
  }
  char sound[12];
  if (readStringField(text, pos, "\"ring_sound\":\"", sound, sizeof(sound)) >= 0 &&
      parseRingSound(sound, out.ringSound)) {
    out.hasRingSound = true;
  }
  char word[12];
  if (readStringField(text, pos, "\"wake_word\":\"", word, sizeof(word)) >= 0 &&
      parseWakeWordWire(word, out.wakeWord)) {
    out.hasWakeWord = true;
  }
  return out.hasVolume || out.hasMuted || out.hasMode || out.hasDnd || out.hasRingSeconds ||
         out.hasRingSound || out.hasWakeWord;
}

// turn_ref is an envelope field, before "payload"; heard and reply are the
// payload's (either may be empty).
bool parseReplyText(const String& text, ReplyText& out) {
  out.turnRef[0] = out.heard[0] = out.reply[0] = '\0';
  const int pos = payloadStart(text);
  if (pos < 0) return false;
  const int refKey = text.indexOf("\"turn_ref\":\"");
  if (refKey < 0 || refKey >= pos) return false;
  const int refEnd = readStringField(text, refKey, "\"turn_ref\":\"", out.turnRef, sizeof(out.turnRef));
  if (refEnd < 0 || refEnd > pos || out.turnRef[0] == '\0') return false;
  int next = readStringField(text, pos, "\"heard\":\"", out.heard, sizeof(out.heard));
  if (next >= 0) next = readStringField(text, next, "\"reply\":\"", out.reply, sizeof(out.reply));
  if (next < 0) return false;
  foldToAscii(out.heard);
  foldToAscii(out.reply);
  return true;
}

ReplyTextFate replyTextFate(bool turnInFlight, const char* replyTurnRef,
                            const char* currentTurnRef, const char* cancelledTurnRef) {
  const auto same = [](const char* a, const char* b) {
    return a != nullptr && b != nullptr && a[0] != '\0' && strcmp(a, b) == 0;
  };
  if (same(replyTurnRef, cancelledTurnRef)) return ReplyTextFate::kCancelledTurn;
  if (!turnInFlight) return ReplyTextFate::kNotInTurn;
  if (!same(replyTurnRef, currentTurnRef)) return ReplyTextFate::kOtherTurn;
  return ReplyTextFate::kKeep;
}

const char* replyTextFateName(ReplyTextFate fate) {
  switch (fate) {
    case ReplyTextFate::kKeep: return "kept";
    case ReplyTextFate::kCancelledTurn: return "cancelled_turn";
    case ReplyTextFate::kNotInTurn: return "not_in_turn";
    case ReplyTextFate::kOtherTurn: return "other_turn";
  }
  return "other_turn";
}

bool parseAnnounce(const String& text, Announcement& out) {
  out = Announcement();
  out.id[0] = out.title[0] = out.body[0] = '\0';
  char kind[12];
  int next = payloadStart(text);
  if (next >= 0) next = readStringField(text, next, "\"announce_id\":\"", out.id, sizeof(out.id));
  if (next >= 0) next = readStringField(text, next, "\"kind\":\"", kind, sizeof(kind));
  if (next < 0 || out.id[0] == '\0' || !parseAnnounceKind(kind, out.kind)) return false;
  next = readStringField(text, next, "\"title\":\"", out.title, sizeof(out.title));
  if (next >= 0) next = readStringField(text, next, "\"body\":\"", out.body, sizeof(out.body));
  if (next < 0 || readBoolField(text, next, "\"ring\":", out.ring) < 0) return false;
  foldToAscii(out.title);
  foldToAscii(out.body);
  return true;
}

// --- timers_state (#457) ---

namespace {

// Consumes `literal` at `pos`; false (pos unchanged) when it is not there.
bool take(const String& text, int& pos, const char* literal) {
  if (!text.startsWith(literal, static_cast<unsigned int>(pos))) return false;
  pos += static_cast<int>(strlen(literal));
  return true;
}

// Reads the JSON string body at `pos` (just past its opening quote) into `out`
// and moves past the closing quote. False when unterminated or when the raw
// body is outside minRaw..maxRaw bytes.
bool takeString(const String& text, int& pos, int minRaw, int maxRaw, char* out, size_t outSize) {
  const int end = findStringEnd(text, pos);
  if (end < 0 || end - pos < minRaw || end - pos > maxRaw) return false;
  copyJsonString(text, pos, end, out, outSize);
  pos = end + 1;
  return true;
}

// Reads a non-negative integer of at most 10 digits no greater than `max`.
bool takeUint(const String& text, int& pos, uint32_t max, uint32_t& out) {
  uint64_t value = 0;
  int i = pos;
  while (i < static_cast<int>(text.length()) && i - pos < 10 && text[i] >= '0' && text[i] <= '9') {
    value = value * 10 + static_cast<uint64_t>(text[i] - '0');
    ++i;
  }
  if (i == pos || value > max) return false;
  out = static_cast<uint32_t>(value);
  pos = i;
  return true;
}

// Worst-case wire label: 24 UTF-16 units, each a 6-byte \uXXXX escape.
constexpr int kTimerLabelRawMax = 6 * static_cast<int>(kTimerLabelBytes - 1);

bool takeTimerEntry(const String& text, int& pos, TimerEntry& out) {
  char scratch[4 * (kTimerLabelBytes - 1) + 2];  // up to 24 4-byte code points.
  if (!take(text, pos, "{\"id\":\"") || !takeString(text, pos, 8, 64, scratch, sizeof(scratch))) {
    return false;
  }
  if (!take(text, pos, ",\"kind\":\"") || !takeString(text, pos, 5, 5, scratch, sizeof(scratch))) {
    return false;
  }
  if (strcmp(scratch, "timer") == 0) out.kind = TimerKind::kTimer;
  else if (strcmp(scratch, "alarm") == 0) out.kind = TimerKind::kAlarm;
  else return false;
  if (!take(text, pos, ",\"label\":\"") ||
      !takeString(text, pos, 0, kTimerLabelRawMax, scratch, sizeof(scratch))) {
    return false;
  }
  // Truncated into scratch means over 24 code points; folded, one char each.
  if (strlen(scratch) >= sizeof(scratch) - 1) return false;
  foldToAscii(scratch);
  if (strlen(scratch) >= kTimerLabelBytes) return false;
  memcpy(out.label, scratch, strlen(scratch) + 1);
  return take(text, pos, ",\"fires_in_ms\":") &&
         takeUint(text, pos, kTimerFiresInMaxMs, out.firesInMs) && take(text, pos, "}");
}

}  // namespace

bool isTimersState(const String& text) {
  return text.indexOf("\"type\":\"timers_state\"") >= 0;
}

bool parseTimersState(const String& text, TimersMessage& out) {
  out = TimersMessage();
  int pos = payloadStart(text);
  if (pos < 0 || !take(text, pos, "\"timers\":[")) return false;
  TimersMessage parsed;
  if (!take(text, pos, "]")) {
    for (;;) {
      if (parsed.count == kMaxTimers) return false;  // oversize: reject, never truncate.
      if (!takeTimerEntry(text, pos, parsed.entries[parsed.count])) return false;
      ++parsed.count;
      if (take(text, pos, "]")) break;
      if (!take(text, pos, ",")) return false;
    }
  }
  if (!take(text, pos, "}}")) return false;
  out = parsed;
  return true;
}

bool extractTurnRef(const String& text, char* out, size_t outSize) {
  return copyQuotedValue(text, "\"turn_ref\":\"", out, outSize);
}

bool parseEndOfTurn(const String& text, char* turnRef, size_t turnRefSize) {
  if (text.indexOf("\"type\":\"end_of_turn\"") < 0) return false;
  return copyQuotedWhole(text, "\"turn_ref\":\"", turnRef, turnRefSize);
}

const char* deviceModeName(DeviceMode mode) {
  switch (mode) {
    case DeviceMode::kPtt: return "ptt";
    case DeviceMode::kWake: return "wake";
    case DeviceMode::kAnnounceOnly: return "announce_only";
  }
  return "ptt";
}

const char* announceKindName(AnnounceKind kind) {
  switch (kind) {
    case AnnounceKind::kTimer: return "timer";
    case AnnounceKind::kAlarm: return "alarm";
    case AnnounceKind::kReminder: return "reminder";
    case AnnounceKind::kNotice: return "notice";
  }
  return "notice";
}

const char* announceActionName(AnnounceAction action) {
  switch (action) {
    case AnnounceAction::kPlayed: return "played";
    case AnnounceAction::kDismissed: return "dismissed";
    case AnnounceAction::kSnoozed: return "snoozed";
    case AnnounceAction::kMissed: return "missed";
  }
  return "dismissed";
}

bool parseOlx2Header(const uint8_t* payload, size_t length, Olx2Header* out) {
  if (!out) return false;
  if (length < config::kHeaderBytes) return false;
  if (payload[0] != config::kFrameMagic[0] ||
      payload[1] != config::kFrameMagic[1] ||
      payload[2] != config::kFrameMagic[2] ||
      payload[3] != config::kFrameMagic[3]) {
    return false;
  }
  out->version = payload[4];
  out->kind = payload[5];
  out->formatId = payload[6];
  out->channels = payload[7];
  out->turnHandle = (static_cast<uint32_t>(payload[8]) << 24) |
                    (static_cast<uint32_t>(payload[9]) << 16) |
                    (static_cast<uint32_t>(payload[10]) << 8) |
                    static_cast<uint32_t>(payload[11]);
  out->sequence = (static_cast<uint32_t>(payload[12]) << 24) |
                  (static_cast<uint32_t>(payload[13]) << 16) |
                  (static_cast<uint32_t>(payload[14]) << 8) |
                  static_cast<uint32_t>(payload[15]);
  out->payloadBytes = (static_cast<uint32_t>(payload[16]) << 24) |
                      (static_cast<uint32_t>(payload[17]) << 16) |
                      (static_cast<uint32_t>(payload[18]) << 8) |
                      static_cast<uint32_t>(payload[19]);

  // Validate payloadBytes matches actual frame size and respects format bounds.
  const size_t expectedPayloadBytes = length - config::kHeaderBytes;
  if (out->payloadBytes != expectedPayloadBytes) return false;

  if (out->formatId == config::kFormatPcm16) {
    if (out->payloadBytes > config::kMaxPcmPayloadBytes) return false;
  } else if (out->formatId == config::kFormatMp3) {
    if (out->payloadBytes > config::kMaxMp3PayloadBytes) return false;
  } else {
    return false;  // Invalid format.
  }

  return out->version == config::kFrameVersion && out->channels == 1;
}

// --- scene (BOB-SCENES) ---

bool isScene(const String& text) { return text.indexOf("\"type\":\"scene\"") >= 0; }

namespace {

// An optional signed integer after `key`, searching from `from`; false when absent or malformed.
bool findInt(const String& text, int from, const char* key, int32_t* out) {
  const int k = text.indexOf(key, from);
  if (k < 0) return false;
  int pos = k + static_cast<int>(strlen(key));
  bool negative = false;
  if (pos < static_cast<int>(text.length()) && text[pos] == '-') {
    negative = true;
    ++pos;
  }
  uint32_t value = 0;
  if (!takeUint(text, pos, 2147483647u, value)) return false;
  *out = negative ? -static_cast<int32_t>(value) : static_cast<int32_t>(value);
  return true;
}

}  // namespace

bool parseScene(const String& text, SceneMessage& out) {
  out = SceneMessage();
  const int pos = payloadStart(text);
  if (pos < 0) return false;
  if (readStringField(text, pos, "\"scene\":\"", out.scene, sizeof(out.scene)) < 0 || out.scene[0] == '\0') return false;
  int32_t v = 0;
  if (findInt(text, pos, "\"seconds\":", &v) && v > 0) out.seconds = static_cast<uint32_t>(v);
  out.hasValue = findInt(text, pos, "\"value\":", &out.value);
  readStringField(text, pos, "\"label\":\"", out.label, sizeof(out.label));  // optional: stays empty when absent
  foldToAscii(out.label);
  return true;
}

}  // namespace bob
