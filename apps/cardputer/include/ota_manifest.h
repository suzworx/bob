// Bob Cardputer v2 — the OTA manifest.json (epic #343): a bounded, hand-rolled
// parse and the checks that need no signature (that is OTA-5B). Host-tested in
// test/host/test_ota_manifest.cpp.
#pragma once

#include <cstddef>
#include <cstdint>

namespace bob {

constexpr size_t kOtaMaxBoards = 4;

struct OtaManifest {
  uint32_t schema = 0;
  char product[24] = "";
  char version[32] = "";
  char boards[kOtaMaxBoards][24] = {};
  uint8_t boardCount = 0;
  char imageFile[48] = "";
  uint32_t imageSize = 0;
  char sha256[65] = "";
  char minFrom[32] = "";
  bool allowDowngrade = false;
  bool rollbackSafe = false;
  uint32_t settingsSchema = 0;
  char requiresBootloader[32] = "";  // empty when the manifest says null.
  bool mandatory = false;
  bool securityFix = false;
  char keyId[16] = "";
  char gitSha[48] = "";
  char builtAt[32] = "";
  char notes[96] = "";  // longer notes are cut; every other field must fit.
};

// True when every contract key is present with the right type, every string
// fits its field and sha256 is 64 hex digits. Unknown keys are skipped. On false
// `*out` is left in an unspecified state and must not be used.
bool parseOtaManifest(const char* json, size_t len, OtaManifest* out);

enum class OtaManifestReason : uint8_t { Ok, BadSchema, BadProduct, BadBoard, TooBig, NotNewer, BelowMinFrom };

OtaManifestReason otaManifestAcceptable(const OtaManifest& manifest, const char* runningVersion,
                                        const char* boardId, uint32_t slotSize);

}  // namespace bob
