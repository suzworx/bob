// Host shim for the slice of mbedTLS 2.28 pk.h that src/ota_verify.cpp calls,
// over OpenSSL libcrypto. The device links the real mbedTLS, so this proves the
// call sequence and the bounds around it, not mbedTLS's own parsing.
#pragma once

#include <openssl/bio.h>
#include <openssl/evp.h>
#include <openssl/pem.h>

#include <cstddef>

enum mbedtls_pk_type_t { MBEDTLS_PK_NONE = 0, MBEDTLS_PK_RSA, MBEDTLS_PK_ECKEY };
enum mbedtls_md_type_t { MBEDTLS_MD_NONE = 0, MBEDTLS_MD_SHA256 = 6 };

struct mbedtls_pk_context {
  EVP_PKEY* key;
};

inline void mbedtls_pk_init(mbedtls_pk_context* ctx) { ctx->key = nullptr; }

inline void mbedtls_pk_free(mbedtls_pk_context* ctx) {
  EVP_PKEY_free(ctx->key);
  ctx->key = nullptr;
}

// Like mbedTLS, a PEM key must be NUL-terminated and keylen must count the NUL.
inline int mbedtls_pk_parse_public_key(mbedtls_pk_context* ctx, const unsigned char* key, size_t keylen) {
  if (keylen == 0 || key[keylen - 1] != '\0') return -1;
  BIO* bio = BIO_new_mem_buf(key, static_cast<int>(keylen - 1));
  if (bio == nullptr) return -1;
  ctx->key = PEM_read_bio_PUBKEY(bio, nullptr, nullptr, nullptr);
  BIO_free(bio);
  return ctx->key != nullptr ? 0 : -1;
}

inline int mbedtls_pk_can_do(const mbedtls_pk_context* ctx, mbedtls_pk_type_t type) {
  return ctx->key != nullptr && type == MBEDTLS_PK_ECKEY && EVP_PKEY_base_id(ctx->key) == EVP_PKEY_EC;
}

inline int mbedtls_pk_verify(mbedtls_pk_context* ctx, mbedtls_md_type_t md_alg, const unsigned char* hash,
                             size_t hash_len, const unsigned char* sig, size_t sig_len) {
  if (ctx->key == nullptr || md_alg != MBEDTLS_MD_SHA256) return -1;
  EVP_PKEY_CTX* pctx = EVP_PKEY_CTX_new(ctx->key, nullptr);
  const int ok = pctx != nullptr && EVP_PKEY_verify_init(pctx) == 1 &&
                 EVP_PKEY_CTX_set_signature_md(pctx, EVP_sha256()) == 1 &&
                 EVP_PKEY_verify(pctx, sig, sig_len, hash, hash_len) == 1;
  EVP_PKEY_CTX_free(pctx);
  return ok ? 0 : -1;
}
