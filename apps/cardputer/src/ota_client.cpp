// The OTA download (include/ota_client.h).
#include "ota_client.h"

#include <Arduino.h>
#include <HTTPClient.h>
#include <Update.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <mbedtls/sha256.h>

#include <cstdlib>
#include <cstring>

#include "ca_roots.h"
#include "device_settings.h"
#include "device_token.h"
#include "ota_manifest.h"
#include "ota_verify.h"
#include "server_profile.h"
#include "types.h"

namespace bob {

namespace {

constexpr uint32_t kHttpTimeoutMs = 15000;
constexpr uint8_t kImageTries = 4;  // the first request plus three resumes.
constexpr size_t kChunkBytes = 1024;
constexpr uint32_t kProgressEveryMs = 1000;

// A dev version carries a plus sign, which a query value must send as %2B.
void appendQueryVersion(String& url, const char* version) {
  for (const char* p = version; *p != '\0'; ++p) {
    if (*p == '+') {
      url += "%2B";
    } else {
      url += *p;
    }
  }
}

struct Source {
  WiFiClientSecure tls;
  WiFiClient plain;
  HTTPClient http;
  bool open = false;

  // GET `path`; a positive `rangeFrom` asks for the rest of the image.
  // Returns the HTTP status, or a negative HTTPClient error.
  int get(const char* path, const char* token, uint32_t rangeFrom, const char* etag) {
    const Endpoint& endpoint = activeEndpoint();
    String url = String(endpoint.tls ? "https://" : "http://") + endpoint.host + ":" + endpoint.port + path;
    if (endpoint.tls) {
      tls.setCACert(kCaRoots);
      open = http.begin(tls, url);
    } else {
      open = http.begin(plain, url);
    }
    if (!open) return -1;
    http.setTimeout(kHttpTimeoutMs);
    http.setReuse(false);
    http.addHeader("Authorization", String("Bearer ") + token);
    const char* collect[] = {"X-Bob-Signature", "ETag"};
    http.collectHeaders(collect, 2);
    if (rangeFrom > 0) {
      http.addHeader("Range", String("bytes=") + rangeFrom + "-");
      if (etag != nullptr && etag[0] != '\0') http.addHeader("If-Range", etag);
    }
    return http.GET();
  }

  void close() {
    if (open) http.end();
    open = false;
  }
};

bool readExactly(WiFiClient* stream, uint8_t* out, size_t length) {
  size_t got = 0;
  const uint32_t deadline = millis() + kHttpTimeoutMs;
  while (got < length && millis() < deadline) {
    const int n = stream->readBytes(out + got, length - got);
    if (n <= 0) break;
    got += static_cast<size_t>(n);
  }
  return got == length;
}

bool manifestMatchesOffer(const OtaManifest& manifest, const OtaOffer& offer) {
  return strcmp(manifest.version, offer.version) == 0 && manifest.imageSize == offer.size &&
         strcmp(manifest.sha256, offer.sha256) == 0 && strcmp(manifest.keyId, offer.keyId) == 0;
}

OtaResult checkManifest(const uint8_t* body, size_t length, const String& signature, const OtaOffer& offer,
                        const char* board, const char* running) {
  if (signature.length() == 0 || !verifyManifestSignature(body, length, signature.c_str(), offer.keyId)) {
    return OtaResult::kManifestSig;
  }
  OtaManifest* manifest = new OtaManifest();
  const bool ok = parseOtaManifest(reinterpret_cast<const char*>(body), length, manifest) &&
                  otaManifestAcceptable(*manifest, running, board, kOtaSlotBytes) == OtaManifestReason::Ok &&
                  manifestMatchesOffer(*manifest, offer);
  delete manifest;
  return ok ? OtaResult::kOk : OtaResult::kManifestBad;
}

OtaResult fetchManifest(const OtaOffer& offer, const char* board, const char* running, const char* token) {
  uint8_t* body = static_cast<uint8_t*>(malloc(kOtaManifestMaxBytes));
  if (body == nullptr) return OtaResult::kManifestHttp;
  OtaResult result = OtaResult::kManifestHttp;
  {
    Source source;
    String path = String("/v2/firmware/") + board + "/" + offer.version + ".manifest?from=";
    appendQueryVersion(path, running);
    const int status = source.get(path.c_str(), token, 0, nullptr);
    const int length = source.open ? source.http.getSize() : -1;
    if (status == 200 && length > 0 && length <= static_cast<int>(kOtaManifestMaxBytes) &&
        readExactly(source.http.getStreamPtr(), body, static_cast<size_t>(length))) {
      result = checkManifest(body, static_cast<size_t>(length), source.http.header("X-Bob-Signature"),
                             offer, board, running);
    }
    source.close();
  }
  free(body);
  return result;
}

void toHex(const unsigned char* digest, char* out) {
  static const char kHex[] = "0123456789abcdef";
  for (int i = 0; i < 32; ++i) {
    out[i * 2] = kHex[digest[i] >> 4];
    out[i * 2 + 1] = kHex[digest[i] & 0x0f];
  }
  out[64] = '\0';
}

struct Download {
  mbedtls_sha256_context sha;
  uint32_t done = 0;
  char etag[80] = "";
  uint32_t lastProgress = 0;
};

// Streams one response body into flash. Returns kImageHttp when the stream
// ended early (the caller may resume), kOk when every byte arrived.
OtaResult pump(WiFiClient* stream, const OtaOffer& offer, const OtaHooks& hooks, Download* d) {
  uint8_t chunk[kChunkBytes];
  uint32_t lastData = millis();
  while (d->done < offer.size) {
    if (hooks.abortRequested != nullptr && hooks.abortRequested()) return OtaResult::kAborted;
    const size_t avail = stream->available();
    if (avail == 0) {
      if (!stream->connected() || millis() - lastData > kHttpTimeoutMs) return OtaResult::kImageHttp;
      delay(2);
      continue;
    }
    const size_t want = min<size_t>(sizeof(chunk), offer.size - d->done);
    const size_t n = stream->readBytes(chunk, min(want, avail));
    if (n == 0) return OtaResult::kImageHttp;
    lastData = millis();
    if (Update.write(chunk, n) != n) return OtaResult::kFlashWrite;
    mbedtls_sha256_update_ret(&d->sha, chunk, n);
    d->done += static_cast<uint32_t>(n);
    if (hooks.progress != nullptr && millis() - d->lastProgress >= kProgressEveryMs) {
      d->lastProgress = millis();
      hooks.progress(d->done, offer.size);
    }
  }
  return OtaResult::kOk;
}

OtaResult finishImage(const OtaOffer& offer, Download* d) {
  unsigned char digest[32];
  mbedtls_sha256_finish_ret(&d->sha, digest);
  char hex[65];
  toHex(digest, hex);
  if (strcmp(hex, offer.sha256) != 0) return OtaResult::kHashMismatch;
  return Update.end(true) ? OtaResult::kOk : OtaResult::kFlashWrite;
}

OtaResult downloadImage(const OtaOffer& offer, const char* board, const char* running, const char* token,
                        const OtaHooks& hooks) {
  if (!Update.begin(offer.size, U_FLASH)) return OtaResult::kFlashBegin;
  Download* d = new Download();
  mbedtls_sha256_init(&d->sha);
  mbedtls_sha256_starts_ret(&d->sha, 0);

  String path = String("/v2/firmware/") + board + "/" + offer.version + ".bin?from=";
  appendQueryVersion(path, running);
  OtaResult result = OtaResult::kImageHttp;
  for (uint8_t attempt = 0; attempt < kImageTries && result == OtaResult::kImageHttp; ++attempt) {
    Source source;
    const int status = source.get(path.c_str(), token, d->done, d->etag);
    // A resume must be a 206 for the same bytes; a 200 would restart at zero.
    const bool fresh = d->done == 0 && status == 200;
    if (fresh || (d->done > 0 && status == 206)) {
      if (fresh) strlcpy(d->etag, source.http.header("ETag").c_str(), sizeof(d->etag));
      result = pump(source.http.getStreamPtr(), offer, hooks, d);
    }
    source.close();
  }
  if (result == OtaResult::kOk) result = finishImage(offer, d);
  mbedtls_sha256_free(&d->sha);
  delete d;
  if (result != OtaResult::kOk) Update.abort();
  return result;
}

}  // namespace

const char* otaReasonCode(OtaResult result) {
  switch (result) {
    case OtaResult::kOk: return "ok";
    case OtaResult::kNoToken: return "no_token";
    case OtaResult::kManifestHttp: return "manifest_http";
    case OtaResult::kManifestSig: return "manifest_sig";
    case OtaResult::kManifestBad: return "manifest_bad";
    case OtaResult::kImageHttp: return "image_http";
    case OtaResult::kFlashBegin: return "flash_begin";
    case OtaResult::kFlashWrite: return "flash_write";
    case OtaResult::kHashMismatch: return "hash_mismatch";
    case OtaResult::kAborted: return "aborted";
  }
  return "unknown";
}

OtaResult otaRun(const OtaOffer& offer, const char* board, const char* runningVersion, const OtaHooks& hooks) {
  char token[kDeviceTokenBytes];
  if (!loadDeviceToken(token, sizeof(token))) return OtaResult::kNoToken;
  const OtaResult manifest = fetchManifest(offer, board, runningVersion, token);
  if (manifest != OtaResult::kOk) return manifest;
  return downloadImage(offer, board, runningVersion, token, hooks);
}

}  // namespace bob
