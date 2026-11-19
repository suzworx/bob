// Bob Cardputer v2 — the OTA download (epic #343, OTA-5B): fetch and verify the
// signed manifest, then stream the image into the inactive slot, hashing as it
// goes, and switch the boot partition only when the hash matches. Blocking: the
// caller owns the screen and the state. Nothing here logs a URL, token or hash.
#pragma once

#include <cstdint>

#include "ota_policy.h"

namespace bob {

enum class OtaResult : uint8_t {
  kOk,
  kNoToken,
  kManifestHttp,  // manifest fetch failed or was refused
  kManifestSig,   // signature missing or invalid
  kManifestBad,   // unparseable, or not for this board/version/offer
  kImageHttp,     // image fetch failed, after the retries
  kFlashBegin,    // no room or no partition
  kFlashWrite,
  kHashMismatch,
  kAborted,
};

// A reason code for the wire and the journal: at most 24 chars, [a-z0-9_].
const char* otaReasonCode(OtaResult result);

// progress(done, total) runs about once a second. abortRequested() true stops
// the download between chunks (kAborted).
struct OtaHooks {
  void (*progress)(uint32_t done, uint32_t total) = nullptr;
  bool (*abortRequested)() = nullptr;
};

// Downloads and verifies `offer` for `board`, running `runningVersion`. On kOk
// the new image is the boot partition and the caller reboots.
OtaResult otaRun(const OtaOffer& offer, const char* board, const char* runningVersion,
                 const OtaHooks& hooks);

}  // namespace bob
