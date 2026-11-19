// Server->device parsers and predicates (src/protocol.cpp), driven by the
// exact bytes in test/fixtures/wire. The firmware parser is substring- and
// key-order-sensitive, so these fixtures are also asserted, key order and
// all, against the server's real handleControl output in
// apps/api/tests/wire-fixtures.test.ts.
#include <cstring>
#include <string>
#include <utility>
#include <vector>

#include "doctest.h"
#include "protocol.h"
#include "support.h"

using hosttest::fixture;
using hosttest::str;

namespace {

using Predicate = bool (*)(const String&);

// Every type predicate, so each fixture can be shown to match exactly one.
const std::vector<std::pair<const char*, Predicate>> kPredicates = {
    {"welcome", bob::isWelcome},
    {"playback_start", bob::isPlaybackStart},
    {"playback_end", bob::isPlaybackEnd},
    {"error", bob::isServerError},
    {"status", bob::isStatus},
    {"conversations", bob::isConversations},
    {"conversation_selected", bob::isConversationSelected},
    {"conversation_cleared", bob::isConversationCleared},
    {"pairing_required", bob::isPairingRequired},
    {"pair_code", bob::isPairCode},
    {"paired", bob::isPaired},
    {"pair_expired", bob::isPairExpired},
    {"pair_denied", bob::isPairDenied},
    {"active_conversation", bob::isActiveConversation},
    {"spaces", bob::isSpaces},
    {"space_selected", bob::isSpaceSelected},
    {"active_space", bob::isActiveSpace},
    {"device_control", bob::isDeviceControl},
    {"reply_text", bob::isReplyText},
    {"announce", bob::isAnnounce},
    {"timers_state", bob::isTimersState},
    {"update_required", bob::isUpdateRequired},
};

// fixture name -> the predicate (by type) that must be the only one true.
const std::vector<std::pair<const char*, const char*>> kServerFixtures = {
    {"welcome", "welcome"}, {"welcome_active_null", "welcome"},
    {"welcome_active_cleared", "welcome"}, {"welcome_legacy", "welcome"},
    {"welcome_absent", "welcome"}, {"playback_start", "playback_start"},
    {"playback_end", "playback_end"}, {"error", "error"}, {"error_turn", "error"},
    {"status", "status"}, {"conversations", "conversations"},
    {"conversations_empty", "conversations"}, {"conversation_selected", "conversation_selected"},
    {"conversation_cleared", "conversation_cleared"}, {"pairing_required", "pairing_required"},
    {"pair_code", "pair_code"}, {"paired", "paired"}, {"pair_expired", "pair_expired"},
    {"pair_denied", "pair_denied"}, {"active_conversation", "active_conversation"},
    {"active_conversation_null", "active_conversation"},
    {"welcome_space_omitted", "welcome"}, {"spaces", "spaces"}, {"spaces_empty", "spaces"},
    {"space_selected", "space_selected"}, {"space_selected_none", "space_selected"},
    {"active_space", "active_space"}, {"active_space_null", "active_space"},
    {"error_space_not_found", "error"},
    {"device_control_volume", "device_control"}, {"device_control_mode_dnd", "device_control"},
    {"device_control_all", "device_control"}, {"reply_text", "reply_text"},
    {"reply_text_empty", "reply_text"}, {"announce_ring", "announce"},
    {"announce_notice", "announce"}, {"timers_state", "timers_state"},
    {"timers_state_empty", "timers_state"},
    {"welcome_min_fw", "welcome"}, {"update_required", "update_required"},
    {"update_required_unknown", "update_required"}, {"error_update_required", "error"},
};

}  // namespace

// #345: the versioned hello, update_required, and the welcome that carries
// min_fw_version (the firmware ignores that field; it must not disturb the rest).
TEST_CASE("buildHello with the build version and caps matches hello_versioned") {
  hostshim::setMillis(123456);  // the fixtures' ids: hello_123456_v2.
  CHECK(str(bob::buildHello(bob::AudioFormat::kMp3, bob::kFirmwareVersion,
                              bob::kFirmwareCaps, bob::kFirmwareCapCount)) ==
        str(fixture("hello_versioned")));
  CHECK(str(bob::buildHello(bob::AudioFormat::kMp3, "", nullptr, 0)) == str(fixture("hello")));
}

TEST_CASE("update_required: min_version and reason") {
  bob::UpdateRequired update;
  REQUIRE(bob::parseUpdateRequired(fixture("update_required"), update));
  CHECK(std::string(update.minVersion) == "0.2.0");
  CHECK_FALSE(update.unknownVersion);
  REQUIRE(bob::parseUpdateRequired(fixture("update_required_unknown"), update));
  CHECK(std::string(update.minVersion) == "0.2.0");
  CHECK(update.unknownVersion);
}

TEST_CASE("update_required: a missing, empty or over-32-char min_version is rejected") {
  bob::UpdateRequired update;
  const std::string head = R"({"v":1,"type":"update_required","id":"updreq_0123456789abcdef0123","payload":{)";
  CHECK_FALSE(bob::parseUpdateRequired(String((head + R"("reason":"below_minimum"}})").c_str()), update));
  CHECK_FALSE(bob::parseUpdateRequired(
      String((head + R"("min_version":"","reason":"below_minimum"}})").c_str()), update));
  const std::string at32 = "1.2.3-" + std::string(26, 'a');
  CHECK(bob::parseUpdateRequired(
      String((head + "\"min_version\":\"" + at32 + "\",\"reason\":\"below_minimum\"}}").c_str()), update));
  CHECK(std::string(update.minVersion) == at32);
  CHECK_FALSE(bob::parseUpdateRequired(
      String((head + "\"min_version\":\"" + at32 + "b\",\"reason\":\"below_minimum\"}}").c_str()), update));
  CHECK(update.minVersion[0] == '\0');
}

TEST_CASE("welcome_min_fw: the additive field leaves format and session id intact") {
  const String text = fixture("welcome_min_fw");
  CHECK(bob::extractWelcomeFormatId(text) == 2);
  CHECK(str(bob::extractSessionId(text)) == "session_0123456789abcdef0123");
}

TEST_CASE("every server fixture matches exactly its own type predicate") {
  for (const auto& [name, type] : kServerFixtures) {
    CAPTURE(name);
    const String text = fixture(name);
    for (const auto& [predicateType, predicate] : kPredicates) {
      CAPTURE(predicateType);
      CHECK(predicate(text) == (std::strcmp(predicateType, type) == 0));
    }
  }
}

TEST_CASE("welcome: format id and session id") {
  const String text = fixture("welcome");
  CHECK(bob::extractWelcomeFormatId(text) == 2);
  CHECK(str(bob::extractSessionId(text)) == "session_0123456789abcdef0123");
  CHECK(bob::extractWelcomeFormatId("{\"type\":\"welcome\"}") == 0);
  CHECK(str(bob::extractSessionId("{\"type\":\"welcome\"}")).empty());
}

TEST_CASE("welcome: device name and a present active_conversation, title cut to 28 chars") {
  char name[bob::kDeviceNameBytes];
  bob::ActiveConversation active;
  REQUIRE(bob::parseWelcomeAdditive(fixture("welcome"), name, sizeof(name), active));
  CHECK(std::string(name) == "Test Card");
  CHECK(active.present);
  CHECK(std::string(active.id) == "cnv_0123456789abcdef");
  CHECK(std::string(active.title) == "Planning the spring vegetabl");
  CHECK(std::strlen(active.title) == bob::kConversationTitleBytes - 1);
}

TEST_CASE("welcome: active_conversation null, cleared {id:null,title:null}, or device null") {
  for (const char* name : {"welcome_active_null", "welcome_active_cleared", "welcome_legacy",
                           "welcome_space_omitted"}) {
    CAPTURE(name);
    char device[bob::kDeviceNameBytes];
    bob::ActiveConversation active;
    active.present = true;
    REQUIRE(bob::parseWelcomeAdditive(fixture(name), device, sizeof(device), active));
    CHECK_FALSE(active.present);
    CHECK(std::string(device) == (std::strcmp(name, "welcome_legacy") == 0 ? "" : "Test Card"));
  }
}

TEST_CASE("welcome: an old server without the additive fields returns false and leaves both empty") {
  char device[bob::kDeviceNameBytes] = "stale";
  bob::ActiveConversation active;
  active.present = true;
  CHECK_FALSE(bob::parseWelcomeAdditive(fixture("welcome_absent"), device, sizeof(device), active));
  CHECK(std::string(device).empty());
  CHECK_FALSE(active.present);
}

TEST_CASE("conversations: entries in order, titles cut to 28 chars") {
  bob::ListedConversation out[bob::kMaxListedConversations];
  REQUIRE(bob::parseConversations(fixture("conversations"), out, bob::kMaxListedConversations) == 3);
  CHECK(std::string(out[0].id) == "cnv_0123456789abcdef");
  CHECK(std::string(out[0].title) == "Planning the spring vegetabl");
  CHECK(std::string(out[1].id) == "cnv_fedcba9876543210");
  CHECK(std::string(out[1].title) == "Groceries");
  CHECK(std::string(out[2].title) == "Trip to Lisbon");
  CHECK(bob::parseConversations(fixture("conversations_empty"), out, 10) == 0);
  CHECK(bob::parseConversations(fixture("conversations"), nullptr, 10) == 0);
  CHECK(bob::parseConversations(fixture("conversations"), out, 0) == 0);
}

TEST_CASE("conversation_selected: the selected id, truncated to the caller's buffer") {
  char id[bob::kConversationIdBytes];
  REQUIRE(bob::extractSelectedConversationId(fixture("conversation_selected"), id, sizeof(id)));
  CHECK(std::string(id) == "cnv_fedcba9876543210");
  char small[5];
  REQUIRE(bob::extractSelectedConversationId(fixture("conversation_selected"), small, sizeof(small)));
  CHECK(std::string(small) == "cnv_");
  CHECK_FALSE(bob::extractSelectedConversationId(fixture("conversation_cleared"), id, sizeof(id)));
  CHECK_FALSE(bob::extractSelectedConversationId(fixture("conversation_selected"), nullptr, 8));
  CHECK_FALSE(bob::extractSelectedConversationId(fixture("conversation_selected"), id, 0));
}

TEST_CASE("active_conversation: a set pointer and the null form") {
  bob::ActiveConversation active;
  REQUIRE(bob::parseActiveConversation(fixture("active_conversation"), active));
  CHECK(active.present);
  CHECK(std::string(active.id) == "cnv_fedcba9876543210");
  CHECK(std::string(active.title) == "Groceries");

  REQUIRE(bob::parseActiveConversation(fixture("active_conversation_null"), active));
  CHECK_FALSE(active.present);
  CHECK(std::string(active.id).empty());

  CHECK_FALSE(bob::parseActiveConversation("{\"type\":\"active_conversation\"}", active));
  CHECK_FALSE(active.present);
}

TEST_CASE("status: every server stage, and unknown stages are rejected") {
  bob::ServerStage stage = bob::ServerStage::kIdle;
  REQUIRE(bob::extractStatusStage(fixture("status"), stage));
  CHECK(stage == bob::ServerStage::kThinking);
  const std::string base = str(fixture("status"));
  for (const char* name : {"speaking", "idle", "thinking"}) {
    std::string text = base;
    text.replace(text.find("thinking"), 8, name);
    REQUIRE(bob::extractStatusStage(String(text), stage));
    CHECK(std::string(bob::serverStageName(stage)) == name);
  }
  std::string unknown = base;
  unknown.replace(unknown.find("thinking"), 8, "dancing");
  CHECK_FALSE(bob::extractStatusStage(String(unknown), stage));
  CHECK(std::string(bob::serverStageName(static_cast<bob::ServerStage>(9))) == "unknown");
}

TEST_CASE("error: the code with and without turn_ref, and every V2ErrorCode the server can send") {
  char code[32];
  REQUIRE(bob::extractErrorCode(fixture("error"), code, sizeof(code)));
  CHECK(std::string(code) == "STATE_VIOLATION");
  REQUIRE(bob::extractErrorCode(fixture("error_turn"), code, sizeof(code)));
  CHECK(std::string(code) == "SEQUENCE_GAP");
  // apps/api/src/schemas.ts V2ErrorCodeSchema; the firmware buffer is char[32].
  const std::string base = str(fixture("error"));
  for (const char* name : {"BAD_MESSAGE", "BAD_AUDIO", "STATE_VIOLATION", "FRAME_TOO_LARGE",
                           "SEQUENCE_GAP", "QUEUE_FULL", "INTERNAL", "CONVERSATION_NOT_FOUND",
                           "UNPAIRED", "PAIRING_RATE_LIMITED", "SPACE_NOT_FOUND"}) {
    CAPTURE(name);
    std::string text = base;
    text.replace(text.find("STATE_VIOLATION"), std::strlen("STATE_VIOLATION"), name);
    REQUIRE(bob::extractErrorCode(String(text), code, sizeof(code)));
    CHECK(std::string(code) == name);
  }
  char small[4];
  REQUIRE(bob::extractErrorCode(fixture("error"), small, sizeof(small)));
  CHECK(std::string(small) == "STA");
  CHECK_FALSE(bob::extractErrorCode(fixture("status"), code, sizeof(code)));
}

namespace {

// timers_state with `entries` spliced into the fixture's envelope.
String timersState(const std::string& entries) {
  return String("{\"v\":1,\"type\":\"timers_state\",\"id\":\"tmrs_0123456789abcdef0123\","
                "\"payload\":{\"timers\":[" + entries + "]}}");
}

std::string timerEntry(const std::string& kind, const std::string& label, const std::string& firesIn) {
  return "{\"id\":\"3f2b8c1e-7a4d-4e9b-9c1a-2b3c4d5e6f70\",\"kind\":\"" + kind + "\",\"label\":\"" +
         label + "\",\"fires_in_ms\":" + firesIn + "}";
}

}  // namespace

TEST_CASE("timers_state: the fixture's entries in order, escapes decoded, empty label kept") {
  bob::TimersMessage out;
  REQUIRE(bob::parseTimersState(fixture("timers_state"), out));
  REQUIRE(out.count == 3);
  CHECK(std::string(out.entries[0].label) == "Pasta");
  CHECK(out.entries[0].kind == bob::TimerKind::kTimer);
  CHECK(out.entries[0].firesInMs == 272000u);
  CHECK(std::string(out.entries[1].label) == "Laundry \"whites\"");
  CHECK(out.entries[1].firesInMs == 5400000u);
  CHECK(out.entries[2].kind == bob::TimerKind::kAlarm);
  CHECK(std::string(out.entries[2].label).empty());
  CHECK(out.entries[2].firesInMs == 30600000u);
}

TEST_CASE("timers_state: an empty list parses to zero timers (clears the view)") {
  bob::TimersMessage out;
  out.count = 2;
  REQUIRE(bob::parseTimersState(fixture("timers_state_empty"), out));
  CHECK(out.count == 0);
}

TEST_CASE("timers_state: 24-char and UTF-8 labels and the fires_in_ms bounds are accepted") {
  bob::TimersMessage out;
  const std::string label24(24, 'x');
  REQUIRE(bob::parseTimersState(timersState(timerEntry("timer", label24, "2147483647")), out));
  CHECK(std::string(out.entries[0].label) == label24);
  CHECK(out.entries[0].firesInMs == 2147483647u);
  REQUIRE(bob::parseTimersState(timersState(timerEntry("alarm", "Tea \xE2\x80\x94 caf\xC3\xA9", "0")), out));
  CHECK(std::string(out.entries[0].label) == "Tea - caf?");
  CHECK(out.entries[0].firesInMs == 0u);
}

TEST_CASE("timers_state: oversize or malformed messages are rejected whole") {
  const std::string ok = timerEntry("timer", "a", "1000");
  const std::vector<std::pair<const char*, String>> bad = {
      {"five timers", timersState(ok + "," + ok + "," + ok + "," + ok + "," + ok)},
      {"25-char label", timersState(timerEntry("timer", std::string(25, 'x'), "1"))},
      {"fires_in_ms over 2^31-1", timersState(timerEntry("timer", "a", "2147483648"))},
      {"negative fires_in_ms", timersState(timerEntry("timer", "a", "-1"))},
      {"fractional fires_in_ms", timersState(timerEntry("timer", "a", "1.5"))},
      {"unknown kind", timersState(timerEntry("clock", "a", "1"))},
      {"keys out of order", timersState("{\"kind\":\"timer\",\"id\":\"3f2b8c1e-7a4d\",\"label\":\"a\",\"fires_in_ms\":1}")},
      {"unterminated list", String("{\"v\":1,\"type\":\"timers_state\",\"id\":\"x\",\"payload\":{\"timers\":[" + ok)},
      {"no payload", String("{\"v\":1,\"type\":\"timers_state\",\"id\":\"x\"}")},
  };
  for (const auto& [name, text] : bad) {
    CAPTURE(name);
    bob::TimersMessage out;
    out.count = 1;
    CHECK_FALSE(bob::parseTimersState(text, out));
    CHECK(out.count == 0);
  }
  bob::TimersMessage four;
  REQUIRE(bob::parseTimersState(timersState(ok + "," + ok + "," + ok + "," + ok), four));
  CHECK(four.count == 4);
}

// end_of_turn (#1365): the parser a later device unit calls; nothing calls it yet.
TEST_CASE("end_of_turn: the fixture parses to its turn_ref, which fits a buffer of exactly its length") {
  char turnRef[32];
  REQUIRE(bob::parseEndOfTurn(fixture("end_of_turn"), turnRef, sizeof(turnRef)));
  CHECK(std::string(turnRef) == "turn_0001_abcd");
  char exact[15];  // "turn_0001_abcd" is 14 chars plus the NUL.
  CHECK(bob::parseEndOfTurn(fixture("end_of_turn"), exact, sizeof(exact)));
}

TEST_CASE("end_of_turn: another type, a missing turn_ref, or a turn_ref longer than the buffer is rejected") {
  char turnRef[32];
  CHECK_FALSE(bob::parseEndOfTurn(fixture("reply_text"), turnRef, sizeof(turnRef)));
  CHECK_FALSE(bob::parseEndOfTurn(fixture("playback_end"), turnRef, sizeof(turnRef)));
  CHECK_FALSE(bob::parseEndOfTurn(
      String(R"({"v":1,"type":"end_of_turn","id":"eotn_0123456789abcdef0123","payload":{}})"), turnRef, sizeof(turnRef)));
  char small[14];  // 14 bytes hold only 13 chars: the 14-char turn_ref is refused, never cut.
  CHECK_FALSE(bob::parseEndOfTurn(fixture("end_of_turn"), small, sizeof(small)));
}
