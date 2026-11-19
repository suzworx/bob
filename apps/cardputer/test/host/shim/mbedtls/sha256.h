// Host shim for the mbedTLS 2.28 one-shot SHA-256 the device uses, over OpenSSL
// libcrypto (the device links the real mbedTLS; see src/ota_verify.cpp).
#pragma once

#include <openssl/evp.h>

#include <cstddef>

inline int mbedtls_sha256_ret(const unsigned char* input, size_t ilen, unsigned char output[32], int is224) {
  if (is224 != 0) return -1;
  return EVP_Digest(input, ilen, output, nullptr, EVP_sha256(), nullptr) == 1 ? 0 : -1;
}
