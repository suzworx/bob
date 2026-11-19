// The OTA manifest signature check (include/ota_verify.h). Every key and
// signature below is TEST ONLY: generated once with node:crypto for this file,
// the private key never written down. None is trusted by any firmware.
#include <cstring>
#include <string>

#include "doctest.h"
#include "ota_verify.h"

using namespace bob;

namespace {
const char* const kTestOnlyPem =
    "-----BEGIN PUBLIC KEY-----\n"
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEUUibCvpD7f0QnSjc+egmTO2XwpKe\n"
    "nkVBp46F71KPU5WBJbRJwRxUx5iAbMVz8Q499l4omnJDNkZe+GFJBoLv5A==\n"
    "-----END PUBLIC KEY-----\n";
// A second TEST ONLY key that did not sign kTestOnlyManifest.
const char* const kTestOnlyOtherPem =
    "-----BEGIN PUBLIC KEY-----\n"
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEZ88DULIkV9+ZsN99XaFifodRuGjg\n"
    "bCuQrR36iqX9LFgN7UQhmD1+aSqhMtRATN9FYPwYPX8OrocbdBeUH5cO7A==\n"
    "-----END PUBLIC KEY-----\n";
const std::string kTestOnlyManifest =
    "{\"key_id\":\"test-only\",\"product\":\"bob-cardputer\",\"schema\":1,\"version\":\"1.4.0\"}";
const std::string kTestOnlySig =
    "MEQCIDd94BZGgAZyh4XKZX7zFJZ6AQ7wlzLTcs3+62gGm5FzAiAnbrXBSb5q0sX/w5vYMQ6oyvG+HUtQ+bknaMzMD4ZGzw==";

bool verify(const std::string& manifest, const std::string& sig, const char* pem = kTestOnlyPem) {
  return verifyManifestSignaturePem(reinterpret_cast<const uint8_t*>(manifest.data()), manifest.size(), sig.c_str(),
                                    pem);
}
}  // namespace

TEST_CASE("a good signature verifies") { CHECK(verify(kTestOnlyManifest, kTestOnlySig)); }

TEST_CASE("one flipped manifest byte fails") {
  std::string m = kTestOnlyManifest;
  m[m.size() / 2] ^= 0x01;
  CHECK_FALSE(verify(m, kTestOnlySig));
}

TEST_CASE("one flipped signature byte fails") {
  std::string s = kTestOnlySig;
  s[20] = s[20] == 'A' ? 'B' : 'A';
  CHECK_FALSE(verify(kTestOnlyManifest, s));
}

TEST_CASE("another key does not verify the signature") {
  CHECK_FALSE(verify(kTestOnlyManifest, kTestOnlySig, kTestOnlyOtherPem));
  CHECK_FALSE(verify(kTestOnlyManifest, kTestOnlySig, "not a pem"));
}

TEST_CASE("an unknown or missing key id is refused") {
  const auto* bytes = reinterpret_cast<const uint8_t*>(kTestOnlyManifest.data());
  CHECK_FALSE(verifyManifestSignature(bytes, kTestOnlyManifest.size(), kTestOnlySig.c_str(), "test-only"));
  CHECK_FALSE(verifyManifestSignature(bytes, kTestOnlyManifest.size(), kTestOnlySig.c_str(), ""));
  CHECK_FALSE(verifyManifestSignature(bytes, kTestOnlyManifest.size(), kTestOnlySig.c_str(), nullptr));
  // A trusted id with a signature from another key is still false.
  CHECK_FALSE(verifyManifestSignature(bytes, kTestOnlyManifest.size(), kTestOnlySig.c_str(), "fw-2026a"));
}

TEST_CASE("malformed base64 fails") {
  CHECK_FALSE(verify(kTestOnlyManifest, ""));
  CHECK_FALSE(verify(kTestOnlyManifest, kTestOnlySig.substr(0, kTestOnlySig.size() - 1)));  // not a multiple of 4
  std::string bad = kTestOnlySig;
  bad[10] = '*';
  CHECK_FALSE(verify(kTestOnlyManifest, bad));
  CHECK_FALSE(verify(kTestOnlyManifest, "===="));
}

TEST_CASE("valid base64 that is not a DER signature fails") {
  CHECK_FALSE(verify(kTestOnlyManifest, "AAAA"));
  CHECK_FALSE(verify(kTestOnlyManifest, "MEUCIHR/LNcIwWLT+wuX"));                     // a DER prefix only
  CHECK_FALSE(verify(kTestOnlyManifest, std::string(108, 'A')));                      // 81 zero bytes: over the cap
  CHECK_FALSE(verify(kTestOnlyManifest, std::string(4096, 'A')));                     // far over, rejected unread
}

TEST_CASE("truncated, empty or oversized manifests fail") {
  CHECK_FALSE(verify(kTestOnlyManifest.substr(0, kTestOnlyManifest.size() - 1), kTestOnlySig));
  CHECK_FALSE(verify("", kTestOnlySig));
  CHECK_FALSE(verifyManifestSignaturePem(nullptr, 10, kTestOnlySig.c_str(), kTestOnlyPem));
  CHECK_FALSE(verifyManifestSignaturePem(reinterpret_cast<const uint8_t*>(kTestOnlyManifest.data()),
                                         kTestOnlyManifest.size(), nullptr, kTestOnlyPem));
  const std::string huge(kOtaManifestMaxBytes + 1, ' ');
  CHECK_FALSE(verify(huge, kTestOnlySig));
}
