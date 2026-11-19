// Bob Cardputer v2 — the OTA decisions (epic #343, docs/cardputer/ota-decision.md):
// pure, header-only, host-tested (test/host/test_ota_policy.cpp). No flash, no
// network, no NVS: the OTA client feeds these the facts and acts on the verdict.
#pragma once

#include <cstddef>
#include <cstdint>

namespace bob {

constexpr uint32_t kOtaSlotBytes = 3342336;
constexpr uint32_t kOtaIdleMinS = 120;
constexpr uint8_t kOtaBatteryMinPct = 40;
constexpr uint32_t kOtaTimerGuardS = 300;
constexpr uint32_t kOtaNoTimer = UINT32_MAX;  // secToNextTimer when none is set.
constexpr uint32_t kOtaCountdownMs = 10000;
constexpr uint32_t kOtaPostponeS = 4 * 3600;
constexpr uint8_t kOtaMaxPostpones = 3;
constexpr uint32_t kOtaMandatoryForceS = 24 * 3600;
constexpr uint32_t kOtaRetryBaseMs = 5 * 60 * 1000;
constexpr uint32_t kOtaRetryCapMs = 6 * 3600 * 1000;
constexpr uint8_t kOtaMaxAttempts = 3;  // failed attempts in 24 h before giving up on an offer.
constexpr uint32_t kOtaHealthyMs = 60000;
constexpr uint8_t kOtaNetlessBoots = 3;

// "X.Y.Z" or "X.Y.Z-dev[+sha]". A -dev build sorts below the same X.Y.Z release.
struct OtaVersion {
  bool valid = false;
  bool dev = false;
  uint32_t major = 0, minor = 0, patch = 0;
};

inline OtaVersion otaParseVersion(const char* text) {
  OtaVersion v;
  if (text == nullptr) return v;
  uint32_t* parts[3] = {&v.major, &v.minor, &v.patch};
  const char* p = text;
  for (int i = 0; i < 3; ++i) {
    if (i > 0) {
      if (*p != '.') return OtaVersion();
      ++p;
    }
    int digits = 0;
    uint32_t n = 0;
    for (; *p >= '0' && *p <= '9'; ++p, ++digits) {
      if (digits >= 6) return OtaVersion();
      n = n * 10 + static_cast<uint32_t>(*p - '0');
    }
    if (digits == 0) return OtaVersion();
    *parts[i] = n;
  }
  if (*p == '-') {
    if (p[1] != 'd' || p[2] != 'e' || p[3] != 'v') return OtaVersion();
    v.dev = true;
    p += 4;
    if (*p == '+') {
      ++p;
      if (*p == '\0') return OtaVersion();
      for (; *p != '\0'; ++p) {
        const bool alnum = (*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z');
        if (!alnum) return OtaVersion();
      }
    }
  }
  if (*p != '\0') return OtaVersion();
  v.valid = true;
  return v;
}

// <0, 0, >0 like strcmp. Only meaningful when both are valid.
inline int otaCompareVersion(const OtaVersion& a, const OtaVersion& b) {
  if (a.major != b.major) return a.major < b.major ? -1 : 1;
  if (a.minor != b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch != b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.dev != b.dev) return a.dev ? -1 : 1;
  return 0;
}

inline bool otaIsNewer(const char* offer, const char* running) {
  const OtaVersion o = otaParseVersion(offer);
  const OtaVersion r = otaParseVersion(running);
  return o.valid && r.valid && otaCompareVersion(o, r) > 0;
}

struct OtaOffer {
  char version[32] = "";
  uint32_t size = 0;
  char sha256[65] = "";
  char keyId[16] = "";
  bool mandatory = false;
  uint32_t applyAfterS = 0;
};

enum class OtaVerdict : uint8_t { Start, NotYet, Postponed, Refuse };
enum class OtaReason : uint8_t {
  Ok, BadSize, NotNewer, GaveUp, PostponedByUser, Busy, NotIdle, LowBattery, TimerSoon, NoWifi, TooEarly
};

struct OtaContext {
  const char* runningVersion = "";
  OtaOffer offer;
  uint32_t idleS = 0;
  uint8_t batteryPct = 0;
  bool charging = false;
  uint32_t secToNextTimer = kOtaNoTimer;
  bool wifiUp = false;
  uint32_t sinceOfferSeenS = 0;
  bool inTurn = false, inPairing = false, inSettings = false, inSetup = false;
  uint32_t postponedForS = 0;  // seconds left of a user postponement.
  uint8_t failedAttempts24h = 0;
};

struct OtaDecision {
  OtaVerdict verdict;
  OtaReason reason;
};

inline OtaDecision otaShouldStart(const OtaContext& c) {
  if (c.offer.size == 0 || c.offer.size > kOtaSlotBytes) return {OtaVerdict::Refuse, OtaReason::BadSize};
  if (!otaIsNewer(c.offer.version, c.runningVersion)) return {OtaVerdict::Refuse, OtaReason::NotNewer};
  if (c.failedAttempts24h >= kOtaMaxAttempts) return {OtaVerdict::Refuse, OtaReason::GaveUp};
  const bool forced = c.offer.mandatory && c.sinceOfferSeenS >= kOtaMandatoryForceS;
  if (c.postponedForS > 0 && !forced) return {OtaVerdict::Postponed, OtaReason::PostponedByUser};
  if (c.inTurn || c.inPairing || c.inSettings || c.inSetup) return {OtaVerdict::NotYet, OtaReason::Busy};
  if (c.idleS < kOtaIdleMinS) return {OtaVerdict::NotYet, OtaReason::NotIdle};
  if (!c.charging && c.batteryPct < kOtaBatteryMinPct) return {OtaVerdict::NotYet, OtaReason::LowBattery};
  if (c.secToNextTimer <= kOtaTimerGuardS) return {OtaVerdict::NotYet, OtaReason::TimerSoon};
  if (!c.wifiUp) return {OtaVerdict::NotYet, OtaReason::NoWifi};
  if (c.sinceOfferSeenS < c.offer.applyAfterS) return {OtaVerdict::NotYet, OtaReason::TooEarly};
  return {OtaVerdict::Start, OtaReason::Ok};
}

enum class OtaCountdownAction : uint8_t { Continue, Start, Postpone };

struct OtaCountdown {
  uint32_t elapsedMs = 0;
  bool keyPressed = false;
  uint8_t postponesUsed = 0;
  bool mandatory = false;
  uint32_t sinceOfferSeenS = 0;
};

struct OtaCountdownStep {
  OtaCountdownAction action;
  uint8_t secondsLeft;
};

// A key postpones (4 h) unless 3 postponements are used or a mandatory offer is
// 24 h old; then the key is ignored and the countdown runs out.
inline OtaCountdownStep otaCountdownStep(const OtaCountdown& c) {
  const bool canPostpone =
      c.postponesUsed < kOtaMaxPostpones && !(c.mandatory && c.sinceOfferSeenS >= kOtaMandatoryForceS);
  const uint32_t left = c.elapsedMs >= kOtaCountdownMs ? 0 : (kOtaCountdownMs - c.elapsedMs + 999) / 1000;
  if (c.keyPressed && canPostpone) return {OtaCountdownAction::Postpone, static_cast<uint8_t>(left)};
  if (left == 0) return {OtaCountdownAction::Start, 0};
  return {OtaCountdownAction::Continue, static_cast<uint8_t>(left)};
}

// Delay before failed attempt `attempt` (1-based) is retried: 5 min doubling, capped at 6 h.
inline uint32_t otaRetryDelayMs(uint32_t attempt) {
  uint32_t delay = kOtaRetryBaseMs;
  for (uint32_t i = 1; i < attempt && delay < kOtaRetryCapMs; ++i) delay *= 2;
  return delay < kOtaRetryCapMs ? delay : kOtaRetryCapMs;
}

enum class OtaHealthAction : uint8_t { MarkValid, Rollback, Wait };

struct OtaHealth {
  bool bootOk = false;
  bool wifiUp = false;
  bool welcomeSeen = false;
  uint32_t msSinceBoot = 0;
  uint8_t networklessHealthyBoots = 0;
};

inline OtaHealthAction otaHealthDecision(const OtaHealth& h) {
  if (!h.bootOk) return OtaHealthAction::Rollback;
  if (h.welcomeSeen && h.msSinceBoot >= kOtaHealthyMs) return OtaHealthAction::MarkValid;
  if (!h.wifiUp && h.networklessHealthyBoots >= kOtaNetlessBoots) return OtaHealthAction::MarkValid;
  return OtaHealthAction::Wait;
}

}  // namespace bob
