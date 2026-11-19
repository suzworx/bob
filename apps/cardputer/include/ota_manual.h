// Explicit, session-local update intent. No network, flash or persistent consent.
#pragma once
#include <cstring>
#include <cstdio>
#include "ota_policy.h"
namespace bob {
inline void otaNumericVersionText(const char* full, char* out, size_t capacity) {
  const OtaVersion version = otaParseVersion(full);
  if (!version.valid) { if (capacity > 0) out[0] = '\0'; return; }
  snprintf(out, capacity, "%u.%u.%u", static_cast<unsigned>(version.major),
           static_cast<unsigned>(version.minor), static_cast<unsigned>(version.patch));
}
enum class ManualOtaPhase : uint8_t { kIdle, kChecking, kOffered, kConfirmed, kNoOffer, kFailed };
constexpr uint32_t kManualOtaTimeoutMs = 15000;
struct ManualOta {
  ManualOtaPhase phase = ManualOtaPhase::kIdle;
  OtaOffer offer;
  uint32_t startedAt = 0;
  bool awaitingReply = false;
  void begin(uint32_t now) { offer = OtaOffer(); startedAt = now; awaitingReply = true; phase = ManualOtaPhase::kChecking; }
  void cancel() { phase = ManualOtaPhase::kIdle; offer = OtaOffer(); }
  void disconnected() { *this = ManualOta(); }
  void tick(uint32_t now) {
    if (static_cast<int32_t>(now - startedAt) < 0) return;  // loop snapshot can precede a key event.
    if ((phase == ManualOtaPhase::kChecking && now - startedAt >= kManualOtaTimeoutMs) ||
        (phase == ManualOtaPhase::kOffered && now - startedAt >= 120000)) phase = ManualOtaPhase::kFailed; }
  bool receive(const OtaOffer* candidate, const char* running) {
    // Consume late/cancelled replies; an offer alone never grants permission.
    if (!awaitingReply) return phase == ManualOtaPhase::kOffered || phase == ManualOtaPhase::kConfirmed;
    awaitingReply = false;
    if (phase != ManualOtaPhase::kChecking) return true;
    if (candidate == nullptr || candidate->size == 0 || candidate->size > kOtaSlotBytes ||
        !otaIsNewer(candidate->version, running)) { phase = ManualOtaPhase::kNoOffer; return true; }
    offer = *candidate; phase = ManualOtaPhase::kOffered; return true;
  }
  bool confirm(const char* version) {
    if (phase != ManualOtaPhase::kOffered || version == nullptr || strcmp(version, offer.version) != 0) return false;
    phase = ManualOtaPhase::kConfirmed; return true;
  }
};
}
