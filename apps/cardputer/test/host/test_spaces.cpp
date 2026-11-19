// Space picker parsers (#301, src/protocol.cpp): spaces, space_selected,
// active_space, and welcome.active_space. The builders are in
// test_builders.cpp; wire-fixtures.test.ts byte-compares the same fixtures
// with the server's real handleControl output.
#include <cstring>
#include <string>

#include "doctest.h"
#include "protocol.h"
#include "support.h"

using hosttest::fixture;
using hosttest::str;

namespace {

constexpr char kFamilyId[] = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
constexpr char kWorkId[] = "6b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e";
constexpr char kFamilyCut[] = "Family, friends and neighbou";  // 30-char name cut to 28.

// A `spaces` reply with `count` entries, uuids 00000000-0000-4000-8000-0000000000NN.
std::string spacesWith(int count) {
  std::string text = R"({"v":1,"type":"spaces","id":"spcs_0123456789abcdef0123","payload":{"spaces":[)";
  for (int i = 0; i < count; ++i) {
    const std::string n = (i < 10 ? "0" : "") + std::to_string(i);
    if (i > 0) text += ",";
    text += R"({"id":"00000000-0000-4000-8000-0000000000)" + n + R"(","name":"Space )" + n + R"("})";
  }
  return text + "]}}";
}

}  // namespace

TEST_CASE("spaces: entries in order, names cut to 28 chars") {
  bob::ListedSpace out[bob::kMaxListedSpaces];
  REQUIRE(bob::parseSpaces(fixture("spaces"), out, bob::kMaxListedSpaces) == 3);
  CHECK(std::string(out[0].id) == kFamilyId);
  CHECK(std::string(out[0].name) == kFamilyCut);
  CHECK(std::strlen(out[0].name) == bob::kSpaceNameBytes - 1);
  CHECK(std::string(out[1].id) == kWorkId);
  CHECK(std::string(out[1].name) == "Work");
  CHECK(std::string(out[2].name) == "Book club");
  CHECK(bob::parseSpaces(fixture("spaces_empty"), out, bob::kMaxListedSpaces) == 0);
  CHECK(bob::parseSpaces(fixture("spaces"), nullptr, 10) == 0);
  CHECK(bob::parseSpaces(fixture("spaces"), out, 0) == 0);
  CHECK(bob::parseSpaces(fixture("conversations"), out, 10) == 0);
}

TEST_CASE("spaces: the list stops at maxEntries (SPACES_LIST_CAP = 10)") {
  bob::ListedSpace out[bob::kMaxListedSpaces];
  CHECK(bob::parseSpaces(String(spacesWith(11)), out, bob::kMaxListedSpaces) == 10);
  CHECK(std::string(out[9].id) == "00000000-0000-4000-8000-000000000009");
  CHECK(std::string(out[9].name) == "Space 09");
}

TEST_CASE("spaces: an entry whose id is longer than a 36-char uuid is skipped, not truncated") {
  const String text(std::string(R"({"type":"spaces","payload":{"spaces":[{"id":")") + kFamilyId +
                    R"(","name":"First"},{"id":")" + std::string(40, 'a') +
                    R"(","name":"Too long"},{"id":")" + kWorkId + R"(","name":"Last"}]}})");
  bob::ListedSpace out[bob::kMaxListedSpaces];
  REQUIRE(bob::parseSpaces(text, out, bob::kMaxListedSpaces) == 2);
  CHECK(std::string(out[0].name) == "First");
  CHECK(std::string(out[1].id) == kWorkId);
  CHECK(std::string(out[1].name) == "Last");
}

TEST_CASE("spaces: names are JSON-unescaped (\\\" and \\\\ kept, \\uXXXX shown as ?)") {
  const String text(std::string(R"({"type":"spaces","payload":{"spaces":[{"id":")") + kFamilyId +
                    // Not a raw string: GCC expands a \u UCN even inside R"(...)".
                    "\",\"name\":\"The \\\"Q\\\" team \\\\ caf\\u00e9\"}]}}");
  bob::ListedSpace out[1];
  REQUIRE(bob::parseSpaces(text, out, 1) == 1);
  CHECK(std::string(out[0].name) == "The \"Q\" team \\ caf?");
}

TEST_CASE("space_selected: a Space, and the null form for no Space") {
  bob::ActiveSpace space;
  REQUIRE(bob::parseSpaceSelected(fixture("space_selected"), space));
  CHECK(space.present);
  CHECK(std::string(space.id) == kWorkId);
  CHECK(std::string(space.name) == "Work");
  REQUIRE(bob::parseSpaceSelected(fixture("space_selected_none"), space));
  CHECK_FALSE(space.present);
  CHECK_FALSE(bob::parseSpaceSelected("{\"type\":\"space_selected\"}", space));
}

TEST_CASE("active_space: a Space, and the null form") {
  bob::ActiveSpace space;
  REQUIRE(bob::parseActiveSpace(fixture("active_space"), space));
  CHECK(space.present);
  CHECK(std::string(space.id) == kWorkId);
  CHECK(std::string(space.name) == "Work");
  REQUIRE(bob::parseActiveSpace(fixture("active_space_null"), space));
  CHECK_FALSE(space.present);
  CHECK_FALSE(bob::parseActiveSpace("{\"type\":\"active_space\"}", space));
}

TEST_CASE("welcome.active_space: present, null, and absent (old server or Space store outage)") {
  bob::ActiveSpace space;
  bob::parseWelcomeActiveSpace(fixture("welcome"), space);
  CHECK(space.present);
  CHECK(std::string(space.id) == kFamilyId);
  CHECK(std::string(space.name) == kFamilyCut);
  for (const char* name : {"welcome_active_null", "welcome_active_cleared", "welcome_legacy",
                           "welcome_space_omitted", "welcome_absent"}) {
    CAPTURE(name);
    space.present = true;
    bob::parseWelcomeActiveSpace(fixture(name), space);
    CHECK_FALSE(space.present);
  }
}

TEST_CASE("welcome.active_space: an oversized id means no Space, never a truncated one") {
  std::string text = str(fixture("welcome"));
  text.replace(text.find(kFamilyId), std::strlen(kFamilyId), std::string(40, 'a'));
  bob::ActiveSpace space;
  bob::parseWelcomeActiveSpace(String(text), space);
  CHECK_FALSE(space.present);
}

TEST_CASE("error: SPACE_NOT_FOUND") {
  char code[32];
  REQUIRE(bob::extractErrorCode(fixture("error_space_not_found"), code, sizeof(code)));
  CHECK(std::string(code) == "SPACE_NOT_FOUND");
}
