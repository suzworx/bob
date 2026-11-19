// Bob Cardputer v2 — the OTA manifest signature check (epic #343, OTA-5B):
// ECDSA P-256 over SHA-256 of the exact manifest.json bytes, the signature
// base64 DER (the X-Bob-Signature header). mbedTLS on the device; the host
// tests (test/host/test_ota_verify.cpp) compile the same source against an
// OpenSSL-backed mbedTLS shim in test/host/shim/mbedtls.
#pragma once

#include <cstddef>
#include <cstdint>

namespace bob {

constexpr size_t kOtaManifestMaxBytes = 4096;
constexpr size_t kOtaSigMaxDerBytes = 80;  // a P-256 DER signature is at most 72.

// True only when `sigB64` is a valid signature of the `len` manifest bytes by
// the trusted key `keyId` (include/fw_keys.h). Any unknown key, malformed or
// oversized input is false.
bool verifyManifestSignature(const uint8_t* manifest, size_t len, const char* sigB64, const char* keyId);

// The same check against an explicit EC public key PEM (the seam the tests use).
bool verifyManifestSignaturePem(const uint8_t* manifest, size_t len, const char* sigB64, const char* pem);

}  // namespace bob
