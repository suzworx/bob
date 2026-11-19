// Device->server builders (src/protocol.cpp). Each builder's output must equal
// its fixture byte for byte: apps/api/tests/wire-fixtures.test.ts proves the
// same fixture passes the server's ClientControlDtoSchema, so together they
// pin the device's bytes to what the server accepts.
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <set>
#include <string>
#include <vector>

#include "doctest.h"
#include "protocol.h"
#include "support.h"

using hosttest::fixture;
using hosttest::str;

namespace {
constexpr unsigned long kFixtureMillis = 123456;  // ids in the fixtures: <prefix>_123456_v2.
}

TEST_CASE("buildHello matches the hello fixture") {
  hostshim::setMillis(kFixtureMillis);
  CHECK(str(bob::buildHello(bob::AudioFormat::kMp3)) == str(fixture("hello")));
}

TEST_CASE("buildHello carries format_id 1 for PCM") {
  hostshim::setMillis(kFixtureMillis);
  CHECK(str(bob::buildHello(bob::AudioFormat::kPcm16)) ==
        R"({"v":1,"type":"hello","id":"hello_123456_v2","payload":{"format_id":1}})");
}

TEST_CASE("buildTurnStart matches the turn_start fixture") {
  hostshim::setMillis(kFixtureMillis);
  CHECK(str(bob::buildTurnStart("turn_0001_abcd")) == str(fixture("turn_start")));
}

TEST_CASE("buildTurnStart carries the active conversation_id when the device knows one (#880)") {
  hostshim::setMillis(kFixtureMillis);
  CHECK(str(bob::buildTurnStart("turn_0001_abcd", "cnv_0123456789abcdef")) ==
        str(fixture("turn_start_conversation")));
  SUBCASE("no active conversation omits the key: the pre-#880 bytes") {
    CHECK(str(bob::buildTurnStart("turn_0001_abcd", nullptr)) == str(fixture("turn_start")));
    CHECK(str(bob::buildTurnStart("turn_0001_abcd", "")) == str(fixture("turn_start")));
  }
  SUBCASE("an id the server would refuse is omitted, so the turn still starts") {
    for (const char* bad : {"short", "has space id", "quote\"id_0001", "0123456789012345678901234567890123456789012345678901234567890123x"}) {
      CHECK(str(bob::buildTurnStart("turn_0001_abcd", bad)) == str(fixture("turn_start")));
    }
  }
}

TEST_CASE("buildTurnStart carries conversation_id and assistant_name together (#880)") {
  hostshim::setMillis(kFixtureMillis);
  CHECK(str(bob::buildTurnStart("turn_0001_abcd", "cnv_0123456789abcdef", bob::WakeWord::kBob, true)) ==
        str(fixture("turn_start_conversation_assistant_name")));
  SUBCASE("either key alone keeps its own bytes") {
    CHECK(str(bob::buildTurnStart("turn_0001_abcd", "cnv_0123456789abcdef", bob::WakeWord::kBob, false)) ==
          str(fixture("turn_start_conversation")));
    CHECK(str(bob::buildTurnStart("turn_0001_abcd", nullptr, bob::WakeWord::kBob, true)) ==
          R"({"v":1,"type":"turn_start","id":"start_123456_v2","turn_ref":"turn_0001_abcd","payload":{"assistant_name":"bob"}})");
  }
}

TEST_CASE("turn_start carries conversation_id only after a welcome that accepts it (#880)") {
  // A released server's strict turn_start refuses the key: no flag, no key.
  CHECK(bob::welcomeAcceptsTurnConversation(fixture("welcome_turn_conversation")));
  CHECK(bob::welcomeSupportsAssistantName(fixture("welcome_turn_conversation")));
  CHECK_FALSE(bob::welcomeAcceptsTurnConversation(fixture("welcome_device_log")));
  CHECK_FALSE(bob::welcomeAcceptsTurnConversation(fixture("welcome_assistant_name")));
  CHECK_FALSE(bob::welcomeAcceptsTurnConversation(fixture("welcome")));
  CHECK_FALSE(bob::welcomeAcceptsTurnConversation(fixture("welcome_legacy")));
}

TEST_CASE("buildTurnEnd reports the last sent sequence, one below the next") {
  hostshim::setMillis(kFixtureMillis);
  CHECK(str(bob::buildTurnEnd("turn_0001_abcd", 42)) == str(fixture("turn_end")));
  SUBCASE("no frames sent reports seq 0, never an underflowed 4294967295") {
    const std::string out = str(bob::buildTurnEnd("turn_0001_abcd", 0));
    CHECK(out.find("\"seq\":0,") != std::string::npos);
  }
}

TEST_CASE("buildListConversations matches the list_conversations fixture") {
  hostshim::setMillis(kFixtureMillis);
  CHECK(str(bob::buildListConversations()) == str(fixture("list_conversations")));
}

TEST_CASE("buildSelectConversation matches the select_conversation fixture") {
  hostshim::setMillis(kFixtureMillis);
  CHECK(str(bob::buildSelectConversation("cnv_0123456789abcdef")) ==
        str(fixture("select_conversation")));
}

TEST_CASE("buildNewConversation matches the new_conversation fixture") {
  hostshim::setMillis(kFixtureMillis);
  CHECK(str(bob::buildNewConversation("ncreq_123456_v2")) == str(fixture("new_conversation")));
}

TEST_CASE("buildPairRequest omits resume unless one is given") {
  hostshim::setMillis(kFixtureMillis);
  const char* claim = "0123456789abcdef0123456789abcdef";
  CHECK(str(bob::buildPairRequest(claim, nullptr)) == str(fixture("pair_request")));
  CHECK(str(bob::buildPairRequest(claim, "")) == str(fixture("pair_request")));
  CHECK(str(bob::buildPairRequest(claim, "3f2b8c1e-5d4a-4e7b-9c6d-1a2b3c4d5e6f")) ==
        str(fixture("pair_request_resume")));
}

TEST_CASE("buildListSpaces matches the list_spaces fixture") {
  hostshim::setMillis(kFixtureMillis);
  CHECK(str(bob::buildListSpaces()) == str(fixture("list_spaces")));
}

TEST_CASE("buildSelectSpace sends the uuid, or space_id null for no Space") {
  hostshim::setMillis(kFixtureMillis);
  CHECK(str(bob::buildSelectSpace("6b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e")) == str(fixture("select_space")));
  CHECK(str(bob::buildSelectSpace(nullptr)) == str(fixture("select_space_none")));
  CHECK(str(bob::buildSelectSpace("")) == str(fixture("select_space_none")));
}

TEST_CASE("messageId is <prefix>_<uptime ms>_v2") {
  hostshim::setMillis(987654321);
  CHECK(str(bob::messageId("start")) == "start_987654321_v2");
}

TEST_CASE("an oversized argument is truncated at the 512-byte buffer, never overflowed") {
  hostshim::setMillis(kFixtureMillis);
  const std::string huge(4096, 'x');
  const std::string out = str(bob::buildSelectConversation(huge.c_str()));
  CHECK(out.size() == 511);
  CHECK(out.rfind(R"({"v":1,"type":"select_conversation")", 0) == 0);
}

TEST_CASE("writeU32 writes big-endian at the offset") {
  uint8_t out[8] = {0};
  bob::writeU32(out, 2, 0x01020304u);
  const uint8_t expected[8] = {0, 0, 0x01, 0x02, 0x03, 0x04, 0, 0};
  CHECK(std::memcmp(out, expected, sizeof(out)) == 0);
}

TEST_CASE("generateClaim fills 32 lowercase hex chars and a NUL") {
  hostshim::seedRandom(42);
  char claim[bob::kClaimBytes];
  std::memset(claim, '#', sizeof(claim));
  bob::generateClaim(claim, sizeof(claim));
  CHECK(std::strlen(claim) == 32);
  CHECK(std::string(claim).find_first_not_of("0123456789abcdef") == std::string::npos);

  SUBCASE("two claims differ") {
    char second[bob::kClaimBytes];
    bob::generateClaim(second, sizeof(second));
    CHECK(std::string(second) != std::string(claim));
  }
  SUBCASE("a buffer smaller than kClaimBytes is left untouched") {
    char small[8];
    std::memset(small, '#', sizeof(small));
    bob::generateClaim(small, sizeof(small));
    CHECK(small[0] == '#');
    CHECK(small[7] == '#');
  }
}

// ---- Emitted wire messages (test-gap class C, docs/testing/test-strategy.md §7).
// Every device->server builder's exact output, as the device sends it, lands in
// test/fixtures/wire/emitted/<name>.json. apps/api/tests/wire-compat.test.ts
// parses each file under the current schemas AND the released server's frozen
// schemas, so a new firmware message production refuses fails CI. The files are
// committed: this case fails when one is stale, missing or orphaned. Regenerate
// with `npm run wire:emit` (sets BOB_WIRE_EMIT=1).
namespace {

struct Emitted {
  std::string name;
  std::string bytes;
};

std::vector<Emitted> emittedMessages() {
  hostshim::setMillis(kFixtureMillis);
  using bob::AnnounceAction;
  using bob::AudioFormat;
  const char* const* caps = bob::kFirmwareCaps;
  const size_t capCount = bob::kFirmwareCapCount;
  const char* claim = "0123456789abcdef0123456789abcdef";
  bob::DeviceSettings settings;
  settings.volume = 6;
  settings.mode = bob::DeviceMode::kWake;
  settings.dnd = true;
  bob::DeviceSettings quiet;
  quiet.volume = 0;
  quiet.muted = true;
  return {
      // The hello the device sends first (state.cpp): version and caps.
      {"hello_versioned", str(bob::buildHello(AudioFormat::kMp3, bob::kFirmwareVersion, caps, capCount))},
      {"hello_versioned_pcm", str(bob::buildHello(AudioFormat::kPcm16, bob::kFirmwareVersion, caps, capCount))},
      // A build with no version string: fw_version is absent, never gated.
      {"hello_no_version", str(bob::buildHello(AudioFormat::kMp3, "", caps, capCount))},
      {"hello_version_only", str(bob::buildHello(AudioFormat::kMp3, bob::kFirmwareVersion))},
      // The bare hello: the fallback (test_hello_fallback.cpp) and pre-#345 form.
      {"hello_bare", str(bob::buildHello(AudioFormat::kMp3))},
      {"hello_bare_pcm", str(bob::buildHello(AudioFormat::kPcm16))},
      {"pair_request", str(bob::buildPairRequest(claim, nullptr))},
      {"pair_request_resume", str(bob::buildPairRequest(claim, "3f2b8c1e-5d4a-4e7b-9c6d-1a2b3c4d5e6f"))},
      {"turn_start", str(bob::buildTurnStart("turn_0001_abcd"))},
      {"turn_start_conversation", str(bob::buildTurnStart("turn_0001_abcd", "cnv_0123456789abcdef"))},
      {"turn_start_conversation_assistant_name",
       str(bob::buildTurnStart("turn_0001_abcd", "cnv_0123456789abcdef", bob::WakeWord::kBob, true))},
      {"turn_end", str(bob::buildTurnEnd("turn_0001_abcd", 42))},
      {"turn_end_no_frames", str(bob::buildTurnEnd("turn_0001_abcd", 0))},
      {"cancel", str(bob::buildCancel("turn_0001_abcd"))},
      {"cancel_no_turn", str(bob::buildCancel(""))},
      {"list_conversations", str(bob::buildListConversations())},
      {"select_conversation", str(bob::buildSelectConversation("cnv_0123456789abcdef"))},
      {"new_conversation", str(bob::buildNewConversation("ncreq_123456_v2"))},
      {"list_spaces", str(bob::buildListSpaces())},
      {"select_space", str(bob::buildSelectSpace("6b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e"))},
      {"select_space_none", str(bob::buildSelectSpace(nullptr))},
      {"device_state", str(bob::buildDeviceState(settings, 87, 1))},
      {"device_state_unknown_battery", str(bob::buildDeviceState(quiet, -1, -1))},
      {"announce_ack_played", str(bob::buildAnnounceAck("tm_0123456789abcdef", AnnounceAction::kPlayed))},
      {"announce_ack_dismissed", str(bob::buildAnnounceAck("tm_0123456789abcdef", AnnounceAction::kDismissed))},
      {"announce_ack_snoozed", str(bob::buildAnnounceAck("tm_0123456789abcdef", AnnounceAction::kSnoozed))},
      {"announce_ack_missed", str(bob::buildAnnounceAck("tm_0123456789abcdef", AnnounceAction::kMissed))},
  };
}

}  // namespace

TEST_CASE("every builder's output is emitted to test/fixtures/wire/emitted (npm run wire:emit)") {
  namespace fs = std::filesystem;
  const fs::path dir = "test/fixtures/wire/emitted";
  const bool emit = std::getenv("BOB_WIRE_EMIT") != nullptr;
  const std::vector<Emitted> messages = emittedMessages();
  std::set<std::string> files;
  if (emit) {
    fs::create_directories(dir);
    for (const auto& entry : fs::directory_iterator(dir)) {
      if (entry.path().extension() == ".json") fs::remove(entry.path());
    }
  }
  for (const Emitted& message : messages) {
    const std::string file = message.name + ".json";
    CHECK_MESSAGE(files.insert(file).second, "two messages share the name ", message.name);
    if (emit) {
      std::ofstream out(dir / file, std::ios::binary);
      out << message.bytes << '\n';
      CHECK_MESSAGE(out.good(), "could not write ", file);
      continue;
    }
    CHECK_MESSAGE(fs::exists(dir / file), "missing ", file, ": run npm run wire:emit");
    if (!fs::exists(dir / file)) continue;
    CHECK_MESSAGE(str(fixture("emitted/" + message.name)) == message.bytes,
                  "stale ", file, ": run npm run wire:emit");
  }
  if (emit || !fs::exists(dir)) return;
  for (const auto& entry : fs::directory_iterator(dir)) {
    const std::string file = entry.path().filename().string();
    CHECK_MESSAGE(files.count(file) == 1, "no builder emits ", file, ": run npm run wire:emit");
  }
}
