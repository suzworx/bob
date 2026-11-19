// The OTA manifest signature check (include/ota_verify.h).
#include "ota_verify.h"

#include <cstring>

#include "fw_keys.h"
#include "mbedtls/base64.h"
#include "mbedtls/pk.h"
#include "mbedtls/sha256.h"

namespace bob {

namespace {
// Base64 of kOtaSigMaxDerBytes, padded: anything longer is rejected unread.
constexpr size_t kSigMaxB64 = (kOtaSigMaxDerBytes + 2) / 3 * 4;
}  // namespace

bool verifyManifestSignaturePem(const uint8_t* manifest, size_t len, const char* sigB64, const char* pem) {
  if (manifest == nullptr || len == 0 || len > kOtaManifestMaxBytes || sigB64 == nullptr || pem == nullptr) {
    return false;
  }
  const size_t b64Len = strnlen(sigB64, kSigMaxB64 + 1);
  if (b64Len == 0 || b64Len > kSigMaxB64) return false;

  unsigned char der[kOtaSigMaxDerBytes];
  size_t derLen = 0;
  if (mbedtls_base64_decode(der, sizeof(der), &derLen, reinterpret_cast<const unsigned char*>(sigB64), b64Len) != 0 ||
      derLen == 0) {
    return false;
  }

  unsigned char digest[32];
  if (mbedtls_sha256_ret(manifest, len, digest, 0) != 0) return false;

  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  // mbedTLS wants the PEM length including its NUL terminator.
  const bool ok = mbedtls_pk_parse_public_key(&pk, reinterpret_cast<const unsigned char*>(pem), strlen(pem) + 1) == 0 &&
                  mbedtls_pk_can_do(&pk, MBEDTLS_PK_ECKEY) &&
                  mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, digest, sizeof(digest), der, derLen) == 0;
  mbedtls_pk_free(&pk);
  return ok;
}

bool verifyManifestSignature(const uint8_t* manifest, size_t len, const char* sigB64, const char* keyId) {
  if (keyId == nullptr) return false;
  for (size_t i = 0; i < kFwKeyCount; ++i) {
    if (strcmp(kFwKeys[i].id, keyId) == 0) return verifyManifestSignaturePem(manifest, len, sigB64, kFwKeys[i].pem);
  }
  return false;
}

}  // namespace bob
