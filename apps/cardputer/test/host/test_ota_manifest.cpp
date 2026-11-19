// The OTA manifest.json parse and acceptance checks (include/ota_manifest.h).
#include <cstring>
#include <initializer_list>
#include <string>

#include "doctest.h"
#include "ota_manifest.h"
#include "ota_policy.h"

using namespace bob;

namespace {
const char* const kSha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

std::string sample(const std::string& version = "1.4.0", const std::string& extra = "") {
  return std::string("{\"schema\":1,\"product\":\"bob-cardputer\",\"version\":\"") + version +
         "\",\"boards\":[\"cardputer\",\"cardputer-adv\"],"
         "\"image\":{\"file\":\"bob-1.4.0.bin\",\"size\":1612288,\"sha256\":\"" + kSha + "\"},"
         "\"min_from\":\"1.0.0\",\"allow_downgrade\":false,\"rollback_safe\":true,"
         "\"settings_schema\":2,\"requires_bootloader\":\"arduino-esp32-2.0.17\",\"mandatory\":false,\"security_fix\":true,"
         "\"key_id\":\"k1\",\"git_sha\":\"abc1234\",\"built_at\":\"2026-10-04T10:00:00Z\","
         "\"notes\":\"Faster wake\"" + extra + "}";
}

bool parse(const std::string& json, OtaManifest* m) { return parseOtaManifest(json.data(), json.size(), m); }

std::string without(std::string json, const std::string& key) {
  const size_t at = json.find("\"" + key + "\":");
  REQUIRE(at != std::string::npos);
  return json.replace(at + 1, key.size(), std::string(key.size(), 'x'));
}
}  // namespace

TEST_CASE("a valid manifest parses every field") {
  OtaManifest m;
  REQUIRE(parse(sample(), &m));
  CHECK(m.schema == 1);
  CHECK(std::string(m.product) == "bob-cardputer");
  CHECK(std::string(m.version) == "1.4.0");
  REQUIRE(m.boardCount == 2);
  CHECK(std::string(m.boards[0]) == "cardputer");
  CHECK(std::string(m.boards[1]) == "cardputer-adv");
  CHECK(std::string(m.imageFile) == "bob-1.4.0.bin");
  CHECK(m.imageSize == 1612288);
  CHECK(std::string(m.sha256) == kSha);
  CHECK(std::string(m.minFrom) == "1.0.0");
  CHECK(m.rollbackSafe);
  CHECK_FALSE(m.allowDowngrade);
  CHECK(m.settingsSchema == 2);
  CHECK(m.securityFix);
  CHECK(std::string(m.keyId) == "k1");
  CHECK(std::string(m.notes) == "Faster wake");
}

TEST_CASE("a valid manifest is acceptable for an older device on either board") {
  OtaManifest m;
  REQUIRE(parse(sample(), &m));
  CHECK(otaManifestAcceptable(m, "1.3.0", "cardputer", kOtaSlotBytes) == OtaManifestReason::Ok);
  CHECK(otaManifestAcceptable(m, "1.3.0", "cardputer-adv", kOtaSlotBytes) == OtaManifestReason::Ok);
}

TEST_CASE("every missing key is rejected") {
  for (const char* key : {"schema", "product", "version", "boards", "image", "min_from", "allow_downgrade",
                          "rollback_safe", "settings_schema", "requires_bootloader", "mandatory",
                          "security_fix", "key_id", "git_sha", "built_at"}) {
    CAPTURE(key);
    OtaManifest m;
    CHECK_FALSE(parse(without(sample(), key), &m));
  }
  OtaManifest m;
  std::string noNotes = sample();
  noNotes.replace(noNotes.find(",\"notes\":\"Faster wake\""), 22, "");
  CHECK_FALSE(parse(noNotes, &m));
  CHECK_FALSE(parse(sample().replace(sample().find("\"size\":1612288,"), 15, ""), &m));
}

TEST_CASE("oversized fields are rejected, never truncated; long notes are cut") {
  OtaManifest m;
  CHECK_FALSE(parse(sample(std::string(32, '1')), &m));
  std::string longNotes = sample();
  longNotes.replace(longNotes.find("Faster wake"), 11, std::string(300, 'n'));
  REQUIRE(parse(longNotes, &m));
  CHECK(std::strlen(m.notes) == sizeof(m.notes) - 1);
  std::string manyBoards = sample();
  manyBoards.replace(manyBoards.find("\"cardputer\","), 12, "\"a\",\"b\",\"c\",\"d\",\"e\",");
  CHECK_FALSE(parse(manyBoards, &m));
  std::string badSha = sample();
  badSha.replace(badSha.find(kSha), 64, std::string(65, 'a'));
  CHECK_FALSE(parse(badSha, &m));
  std::string shortSha = sample();
  shortSha.replace(shortSha.find(kSha), 64, std::string(63, 'a'));
  CHECK_FALSE(parse(shortSha, &m));
}

TEST_CASE("extra keys of any shape are skipped") {
  OtaManifest m;
  REQUIRE(parse(sample("1.4.0", ",\"future\":{\"a\":[1,2,{\"b\":\"x\\\"y\"}],\"c\":null},\"n\":-1.5e3"), &m));
  CHECK(m.imageSize == 1612288);
}

TEST_CASE("truncated or malformed JSON is rejected at every length") {
  const std::string json = sample();
  OtaManifest m;
  for (size_t len = 0; len < json.size(); ++len) {
    CAPTURE(len);
    CHECK_FALSE(parseOtaManifest(json.data(), len, &m));
  }
  CHECK_FALSE(parseOtaManifest(nullptr, 0, &m));
  CHECK_FALSE(parse("[]", &m));
  CHECK_FALSE(parse(sample() + "x", &m));
}

TEST_CASE("acceptance reasons, in order") {
  OtaManifest m;
  REQUIRE(parse(sample(), &m));
  CHECK(otaManifestAcceptable(m, "1.3.0", "cardputer-s3", kOtaSlotBytes) == OtaManifestReason::BadBoard);
  CHECK(otaManifestAcceptable(m, "1.3.0", nullptr, kOtaSlotBytes) == OtaManifestReason::BadBoard);
  CHECK(otaManifestAcceptable(m, "1.3.0", "cardputer", 1612288) == OtaManifestReason::Ok);
  CHECK(otaManifestAcceptable(m, "1.3.0", "cardputer", 1612287) == OtaManifestReason::TooBig);
  CHECK(otaManifestAcceptable(m, "1.4.0", "cardputer", kOtaSlotBytes) == OtaManifestReason::NotNewer);
  CHECK(otaManifestAcceptable(m, "1.4.1", "cardputer", kOtaSlotBytes) == OtaManifestReason::NotNewer);
  CHECK(otaManifestAcceptable(m, "0.9.0", "cardputer", kOtaSlotBytes) == OtaManifestReason::BelowMinFrom);
  m.allowDowngrade = true;
  CHECK(otaManifestAcceptable(m, "1.4.1", "cardputer", kOtaSlotBytes) == OtaManifestReason::Ok);
  m.schema = 2;
  CHECK(otaManifestAcceptable(m, "1.3.0", "cardputer", kOtaSlotBytes) == OtaManifestReason::BadSchema);
  m.schema = 1;
  std::strcpy(m.product, "other");
  CHECK(otaManifestAcceptable(m, "1.3.0", "cardputer", kOtaSlotBytes) == OtaManifestReason::BadProduct);
}

TEST_CASE("a -dev running build is older than its release") {
  OtaManifest m;
  REQUIRE(parse(sample("1.3.0"), &m));
  CHECK(otaManifestAcceptable(m, "1.3.0-dev+abc", "cardputer", kOtaSlotBytes) == OtaManifestReason::Ok);
}

TEST_CASE("requires_bootloader is a string or null, as the signer writes it") {
  OtaManifest m;
  REQUIRE(parse(sample(), &m));
  CHECK(std::string(m.requiresBootloader) == "arduino-esp32-2.0.17");
  std::string nulled = sample();
  nulled.replace(nulled.find("\"arduino-esp32-2.0.17\""), 22, "null");
  REQUIRE(parse(nulled, &m));
  CHECK(m.requiresBootloader[0] == '\0');
}
