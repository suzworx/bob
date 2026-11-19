// Bounds and hostile input for the server->device parsers. Runs under
// ASan+UBSan (test/host/run.mjs), so "never overflows" is checked by the
// sanitizer on every call, not only by the assertions.
//
// Tests marked doctest::should_fail() document REAL parser defects found by
// this suite; they pass while the bug exists and turn red once src/ is fixed,
// at which point drop the decorator. See docs/cardputer/testing.md.
#include <cstring>
#include <string>

#include "doctest.h"
#include "protocol.h"
#include "support.h"

using hosttest::fixture;
using hosttest::str;

namespace {

std::string conversationsWith(int count, const std::string& idPrefix = "cnv_entry_") {
  std::string text = R"({"v":1,"type":"conversations","id":"conv_0123456789abcdef0123","payload":{"conversations":[)";
  for (int i = 0; i < count; ++i) {
    if (i > 0) text += ",";
    text += R"({"id":")" + idPrefix + (i < 10 ? "0" : "") + std::to_string(i) + R"(","title":"Chat )" +
            std::to_string(i) + R"("})";
  }
  return text + "]}}";
}

// True when `s` is well-formed UTF-8 (no truncated multi-byte sequence).
bool validUtf8(const char* s) {
  for (const unsigned char* p = reinterpret_cast<const unsigned char*>(s); *p;) {
    const int extra = *p < 0x80 ? 0 : (*p >> 5) == 0x6 ? 1 : (*p >> 4) == 0xe ? 2 : (*p >> 3) == 0x1e ? 3 : -1;
    if (extra < 0) return false;
    ++p;
    for (int i = 0; i < extra; ++i, ++p) {
      if ((*p & 0xc0) != 0x80) return false;
    }
  }
  return true;
}

}  // namespace

TEST_CASE("conversations: the list stops at maxEntries (CONVERSATIONS_LIST_CAP = 10)") {
  bob::ListedConversation out[bob::kMaxListedConversations];
  CHECK(bob::parseConversations(String(conversationsWith(11)), out, bob::kMaxListedConversations) == 10);
  CHECK(std::string(out[9].id) == "cnv_entry_09");
  CHECK(std::string(out[9].title) == "Chat 9");
  CHECK(bob::parseConversations(String(conversationsWith(10)), out, 3) == 3);
}

TEST_CASE("conversations: a 64-char id (OpaqueIdSchema max) is kept whole; longer is cut to 64") {
  bob::ListedConversation out[2];
  const std::string id64(62, 'a');  // + two-digit index = 64 chars.
  REQUIRE(bob::parseConversations(String(conversationsWith(1, id64)), out, 2) == 1);
  CHECK(std::strlen(out[0].id) == 64);
  const std::string id200(200, 'b');
  REQUIRE(bob::parseConversations(String(conversationsWith(1, id200)), out, 2) == 1);
  CHECK(std::strlen(out[0].id) == 64);
}

TEST_CASE("conversations: an escaped quote in one title does not corrupt the next entry") {
  const String text(R"({"type":"conversations","payload":{"conversations":[{"id":"cnv_a1234567","title":"Say \"hi\""},{"id":"cnv_b1234567","title":"Next"}]}})");
  bob::ListedConversation out[bob::kMaxListedConversations];
  REQUIRE(bob::parseConversations(text, out, bob::kMaxListedConversations) == 2);
  CHECK(std::string(out[1].id) == "cnv_b1234567");
  CHECK(std::string(out[1].title) == "Next");
}

TEST_CASE("KNOWN BUG: a title with an escaped quote is cut at the backslash" * doctest::should_fail()) {
  // JSON.stringify sends `Say "hi"` as `Say \"hi\"`; the parser stops at the
  // first '"' and shows `Say \`. Same helper shape in parseActiveBody.
  const String text(R"({"type":"conversations","payload":{"conversations":[{"id":"cnv_a1234567","title":"Say \"hi\""}]}})");
  bob::ListedConversation out[1];
  REQUIRE(bob::parseConversations(text, out, 1) == 1);
  CHECK(std::string(out[0].title) == "Say \"hi\"");
}

TEST_CASE("KNOWN BUG: the 28-byte title cut can split a UTF-8 character" * doctest::should_fail()) {
  // 27 ASCII bytes then "é" (2 bytes): the cut at 28 bytes keeps half of it.
  const String text(R"({"type":"conversations","payload":{"conversations":[{"id":"cnv_a1234567","title":"abcdefghijklmnopqrstuvwxyz0é tail"}]}})");
  bob::ListedConversation out[1];
  REQUIRE(bob::parseConversations(text, out, 1) == 1);
  CHECK(validUtf8(out[0].title));
}

TEST_CASE("garbage never overflows: every prefix and byte mutation of every fixture through every parser") {
  const char* names[] = {"welcome", "welcome_active_null", "welcome_active_cleared", "welcome_legacy",
                         "welcome_absent", "conversations", "conversation_selected", "conversation_cleared",
                         "active_conversation", "active_conversation_null", "status", "error", "error_turn",
                         "pairing_required", "pair_code", "paired", "pair_expired", "pair_denied",
                         "welcome_space_omitted", "spaces", "space_selected", "space_selected_none",
                         "active_space", "active_space_null"};
  const char replacements[] = {'"', '{', '}', ':', ',', '\\', 'x'};
  auto exercise = [](const String& text) {
    char a[bob::kDeviceNameBytes], b[bob::kDeviceTokenBytes], small[2];
    bob::ActiveConversation active;
    bob::ListedConversation list[bob::kMaxListedConversations];
    bob::ListedSpace spaces[bob::kMaxListedSpaces];
    bob::ActiveSpace space;
    CHECK(bob::parseSpaces(text, spaces, bob::kMaxListedSpaces) <= bob::kMaxListedSpaces);
    bob::parseSpaceSelected(text, space);
    bob::parseActiveSpace(text, space);
    bob::parseWelcomeActiveSpace(text, space);
    CHECK(std::strlen(space.id) < sizeof(space.id));
    CHECK(std::strlen(space.name) < sizeof(space.name));
    bob::PairingInfo info;
    bob::ServerStage stage;
    bob::parseWelcomeAdditive(text, a, sizeof(a), active);
    CHECK(std::strlen(a) < sizeof(a));
    CHECK(std::strlen(active.title) < sizeof(active.title));
    bob::parseActiveConversation(text, active);
    const size_t count = bob::parseConversations(text, list, bob::kMaxListedConversations);
    CHECK(count <= bob::kMaxListedConversations);
    bob::extractSelectedConversationId(text, small, sizeof(small));
    bob::extractErrorCode(text, a, sizeof(a));
    bob::extractPairingRequiredReason(text, a, sizeof(a));
    bob::parsePairCode(text, info);
    bob::parsePaired(text, b, sizeof(b), a, sizeof(a));
    bob::extractStatusStage(text, stage);
    bob::extractWelcomeFormatId(text);
    bob::extractSessionId(text);
  };
  for (const char* name : names) {
    const std::string full = str(fixture(name));
    for (size_t cut = 0; cut <= full.size(); ++cut) exercise(String(full.substr(0, cut)));
    for (size_t at = 0; at < full.size(); ++at) {
      for (char c : replacements) {
        std::string mutated = full;
        mutated[at] = c;
        exercise(String(mutated));
      }
    }
  }
}
