// Pairing parsers (src/protocol.cpp): pairing_required, pair_code, paired.
// pair_expired / pair_denied carry nothing the firmware reads beyond their
// type; test_parsers.cpp covers their predicates.
#include <cstring>
#include <string>

#include "doctest.h"
#include "protocol.h"
#include "support.h"

using hosttest::fixture;
using hosttest::str;

TEST_CASE("pairing_required: every reason the server sends") {
  char reason[16];
  REQUIRE(bob::extractPairingRequiredReason(fixture("pairing_required"), reason, sizeof(reason)));
  CHECK(std::string(reason) == "revoked");
  const std::string base = str(fixture("pairing_required"));
  for (const char* name : {"none", "unknown", "revoked"}) {
    std::string text = base;
    text.replace(text.find("revoked"), 7, name);
    REQUIRE(bob::extractPairingRequiredReason(String(text), reason, sizeof(reason)));
    CHECK(std::string(reason) == name);
  }
  CHECK_FALSE(bob::extractPairingRequiredReason(fixture("pair_code"), reason, sizeof(reason)));
}

TEST_CASE("pair_code: ids, code, uri, and the absolute expiry from expires_in") {
  hostshim::setMillis(1000);
  bob::PairingInfo info;
  REQUIRE(bob::parsePairCode(fixture("pair_code"), info));
  CHECK(info.active);
  CHECK(std::string(info.pairingId) == "3f2b8c1e-5d4a-4e7b-9c6d-1a2b3c4d5e6f");
  CHECK(std::string(info.userCode) == "BCDF-GHJK");
  CHECK(std::string(info.verificationUri) == "https://heybob.xyz/pair");
  CHECK(info.expiresAtMs == 1000u + 600u * 1000u);
}

TEST_CASE("pair_code: a missing field rejects the whole message") {
  const std::string base = str(fixture("pair_code"));
  for (const char* key : {"\"pairing_id\"", "\"user_code\"", "\"verification_uri\"", "\"expires_in\""}) {
    CAPTURE(key);
    std::string text = base;
    text.replace(text.find(key), std::strlen(key), "\"renamed_key\"");
    bob::PairingInfo info;
    CHECK_FALSE(bob::parsePairCode(String(text), info));
    CHECK_FALSE(info.active);
  }
}

TEST_CASE("pair_code: a 200-char verification_uri (the schema max) fits; longer is truncated") {
  const std::string base = str(fixture("pair_code"));
  for (size_t length : {size_t{200}, size_t{600}}) {
    CAPTURE(length);
    std::string text = base;
    const std::string uri = "https://heybob.xyz/pair";
    text.replace(text.find(uri), uri.size(), std::string(length, 'u'));
    bob::PairingInfo info;
    REQUIRE(bob::parsePairCode(String(text), info));
    CHECK(std::strlen(info.verificationUri) == 200);
  }
}

TEST_CASE("paired: device token and display name") {
  char token[bob::kDeviceTokenBytes];
  char name[bob::kDeviceNameBytes];
  REQUIRE(bob::parsePaired(fixture("paired"), token, sizeof(token), name, sizeof(name)));
  CHECK(std::string(token) == "olxd_TESTTOKENtesttokenTESTTOKENtesttokenTESTT1-");
  CHECK(std::strlen(token) == bob::kDeviceTokenBytes - 1);
  CHECK(std::string(name) == "Kitchen Card");
  CHECK_FALSE(bob::parsePaired(fixture("pair_denied"), token, sizeof(token), name, sizeof(name)));
}
