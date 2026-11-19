// Host shim for mbedtls_base64_decode: the same contract (0 on success, an error
// for a bad character, bad padding or a short buffer) but stricter, since it
// also rejects whitespace, which mbedTLS skips. A header value carries none.
#pragma once

#include <cstddef>

constexpr int MBEDTLS_ERR_BASE64_BUFFER_TOO_SMALL = -0x002A;
constexpr int MBEDTLS_ERR_BASE64_INVALID_CHARACTER = -0x002C;

inline int mbedtls_base64_decode(unsigned char* dst, size_t dlen, size_t* olen, const unsigned char* src, size_t slen) {
  *olen = 0;
  if (slen % 4 != 0) return MBEDTLS_ERR_BASE64_INVALID_CHARACTER;
  size_t pad = 0;
  if (slen > 0 && src[slen - 1] == '=') pad = (slen > 1 && src[slen - 2] == '=') ? 2 : 1;
  const size_t need = slen / 4 * 3 - pad;
  if (need > dlen) {
    *olen = need;
    return MBEDTLS_ERR_BASE64_BUFFER_TOO_SMALL;
  }
  unsigned acc = 0;
  size_t bits = 0, out = 0;
  for (size_t i = 0; i < slen - pad; ++i) {
    const unsigned char c = src[i];
    int v = -1;
    if (c >= 'A' && c <= 'Z') v = c - 'A';
    else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
    else if (c >= '0' && c <= '9') v = c - '0' + 52;
    else if (c == '+') v = 62;
    else if (c == '/') v = 63;
    if (v < 0) return MBEDTLS_ERR_BASE64_INVALID_CHARACTER;
    acc = (acc << 6) | static_cast<unsigned>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      dst[out++] = static_cast<unsigned char>(acc >> bits);
    }
  }
  *olen = out;
  return 0;
}
