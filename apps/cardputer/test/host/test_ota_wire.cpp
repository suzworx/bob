// The OTA wire (include/protocol.h, docs/cardputer/ota-wire.md): the offer in
// welcome and in update_offer, and the hello / check_update / ota_progress
// builders. The literals match apps/api/tests/fixtures/ota-wire.json.
#include <cstring>

#include "doctest.h"
#include "protocol.h"

using namespace bob;

namespace {
const char* kSha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

String offerBody(const char* version = "0.4.0", const char* size = "1500000",
                 const char* sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                 const char* keyId = "fw-2026a", const char* mandatory = "false",
                 const char* omit = "") {
  auto has = [&](const char* name) { return std::strcmp(omit, name) != 0; };
  String body = "{";
  if (has("version")) body += String("\"version\":\"") + version + "\",";
  if (has("size")) body += String("\"size\":") + size + ",";
  if (has("sha256")) body += String("\"sha256\":\"") + sha + "\",";
  if (has("key_id")) body += String("\"key_id\":\"") + keyId + "\",";
  if (has("mandatory")) body += String("\"mandatory\":") + mandatory + ",";
  if (has("apply_after_s")) body += "\"apply_after_s\":3600,";
  return body + "\"notes\":\"Faster wake word\"}";
}

String offerMessage(const String& body) {
  return String("{\"v\":1,\"type\":\"update_offer\",\"id\":\"updo_0123456789abcdef\",\"payload\":") +
         body + "}";
}

String welcomeWith(const String& tail) {
  return String(
             "{\"v\":1,\"type\":\"welcome\",\"id\":\"welcome_1\",\"payload\":{\"protocol\":\"bob.v2\","
             "\"format_id\":2,\"max_audio_bytes\":4096,\"credit_bytes\":16384,"
             "\"session_id\":\"session_1\"") +
         tail + "}}";
}
}  // namespace

TEST_CASE("update_offer message: a valid offer fills every field") {
  OtaOffer offer;
  const String text = offerMessage(offerBody());
  CHECK(isUpdateOffer(text));
  REQUIRE(parseUpdateOffer(text, offer));
  CHECK(std::strcmp(offer.version, "0.4.0") == 0);
  CHECK(offer.size == 1500000);
  CHECK(std::strcmp(offer.sha256, kSha) == 0);
  CHECK(std::strcmp(offer.keyId, "fw-2026a") == 0);
  CHECK_FALSE(offer.mandatory);
  CHECK(offer.applyAfterS == 3600);
}

TEST_CASE("update_offer message: offer null means no offer, and the output stays empty") {
  OtaOffer offer;
  std::strcpy(offer.version, "stale");
  const String text = offerMessage("{\"offer\":null}");
  CHECK(isUpdateOffer(text));
  CHECK_FALSE(parseUpdateOffer(text, offer));
  CHECK(offer.version[0] == '\0');
}

TEST_CASE("welcome.update_offer: parsed, mandatory read, and absent when the field is absent") {
  OtaOffer offer;
  const String without = welcomeWith("");
  CHECK_FALSE(parseWelcomeUpdateOffer(without, offer));
  const String text = welcomeWith(String(",\"update_offer\":") + offerBody("0.4.0", "1500000", kSha, "fw-2026a", "true"));
  REQUIRE(parseWelcomeUpdateOffer(text, offer));
  CHECK(std::strcmp(offer.version, "0.4.0") == 0);
  CHECK(offer.mandatory);
}

TEST_CASE("welcome carrying update_offer null or a non-object reads as no offer") {
  OtaOffer offer;
  CHECK_FALSE(parseWelcomeUpdateOffer(welcomeWith(",\"update_offer\":null"), offer));
}

TEST_CASE("a missing field refuses the whole offer") {
  OtaOffer offer;
  for (const char* key : {"version", "size", "sha256", "key_id", "mandatory", "apply_after_s"}) {
    CAPTURE(key);
    const String body = offerBody("0.4.0", "1500000", kSha, "fw-2026a", "false", key);
    CHECK_FALSE(parseUpdateOffer(offerMessage(body), offer));
    CHECK_FALSE(parseWelcomeUpdateOffer(welcomeWith(String(",\"update_offer\":") + body), offer));
  }
  CHECK_FALSE(parseUpdateOffer(offerMessage(offerBody("0.4.0", "0")), offer));
}

TEST_CASE("oversize or malformed strings are refused, never truncated") {
  OtaOffer offer;
  const String longVersion = "1.2.3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  CHECK_FALSE(parseUpdateOffer(offerMessage(offerBody(longVersion.c_str())), offer));
  CHECK_FALSE(parseUpdateOffer(offerMessage(offerBody("0.4.0", "1500000", kSha, "abcdefghijklmnop")), offer));
  CHECK_FALSE(parseUpdateOffer(offerMessage(offerBody("0.4.0", "1500000", "abc123")), offer));
  CHECK_FALSE(parseUpdateOffer(offerMessage(offerBody("0.4.0", "1500000", "0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef")), offer));
  CHECK_FALSE(parseUpdateOffer(offerMessage(offerBody("0.4.0", "99999999999")), offer));
  CHECK_FALSE(parseUpdateOffer(offerMessage(offerBody("0.4.0", "1500000", kSha, "fw-2026a", "\"yes\"")), offer));
  CHECK(offer.version[0] == '\0');
}

TEST_CASE("a truncated message is refused") {
  OtaOffer offer;
  const String full = offerMessage(offerBody());
  CHECK_FALSE(parseUpdateOffer(full.substring(0, 60), offer));
  CHECK_FALSE(parseUpdateOffer(full.substring(0, full.indexOf("\"apply_after_s\"")), offer));
  CHECK_FALSE(parseWelcomeUpdateOffer(welcomeWith(",\"update_offer\":{\"version\":\"0.4.0\",\"size\":15"), offer));
}

TEST_CASE("unknown extra keys and long notes are ignored") {
  OtaOffer offer;
  const String flat =
      String("{\"future\":1,\"version\":\"0.4.0\",\"size\":1500000,\"sha256\":\"") + kSha +
      "\",\"key_id\":\"fw-2026a\",\"mandatory\":false,\"apply_after_s\":3600,\"channel\":\"beta\","
      "\"notes\":\"Faster wake word\"}";
  REQUIRE(parseUpdateOffer(offerMessage(flat), offer));
  CHECK(std::strcmp(offer.version, "0.4.0") == 0);
  CHECK(offer.applyAfterS == 3600);
}

TEST_CASE("hello without OTA fields is unchanged, with them it adds board, last_ota and ota_slot") {
  const char* caps[] = {"reply_text", "ota"};
  const String plain = buildHello(AudioFormat::kPcm16, "0.3.0", caps, 2);
  CHECK(plain.indexOf("\"board\"") < 0);
  CHECK(plain.indexOf("\"caps\":[\"reply_text\",\"ota\"]}}") > 0);
  HelloOta ota;
  ota.board = "cardputer";
  ota.lastResult = "rolled_back";
  ota.lastTo = "0.4.0";
  ota.lastReason = "boot_loop";
  ota.slot = 1;
  const String text = buildHello(AudioFormat::kPcm16, "0.3.0", caps, 2, &ota);
  CHECK(text.indexOf("\"caps\":[\"reply_text\",\"ota\"],\"board\":\"cardputer\","
                     "\"last_ota\":{\"result\":\"rolled_back\",\"to\":\"0.4.0\",\"reason\":\"boot_loop\"},"
                     "\"ota_slot\":1}}") > 0);
  HelloOta partial;
  partial.lastResult = "ok";
  partial.slot = 7;
  const String bare = buildHello(AudioFormat::kPcm16, "0.3.0", caps, 2, &partial);
  CHECK(bare.indexOf("last_ota") < 0);
  CHECK(bare.indexOf("ota_slot") < 0);
}

TEST_CASE("check_update and ota_progress builders") {
  const String check = buildCheckUpdate();
  CHECK(check.indexOf("{\"v\":1,\"type\":\"check_update\",\"id\":\"chk_") == 0);
  CHECK(check.indexOf("\",\"payload\":{}}") > 0);
  const String start = buildOtaProgress("start", "0.4.0", nullptr);
  CHECK(start.indexOf("\"type\":\"ota_progress\"") > 0);
  CHECK(start.indexOf("\"payload\":{\"stage\":\"start\",\"to\":\"0.4.0\"}}") > 0);
  const String failed = buildOtaProgress("failed", "0.4.0", "flash_write");
  CHECK(failed.indexOf("\"payload\":{\"stage\":\"failed\",\"to\":\"0.4.0\",\"reason\":\"flash_write\"}}") > 0);
}
