// The OTA decisions (include/ota_policy.h): version order, start preconditions,
// countdown and postpone, retry delay and the post-boot health gate.
#include <cstdint>
#include <cstring>
#include <initializer_list>

#include "doctest.h"
#include "ota_policy.h"
#include "ota_build.h"

TEST_CASE("standard firmware keeps accepting public OTA releases") {
  CHECK(bob::kAcceptStandardOta);
}

using namespace bob;

namespace {
OtaContext ready() {
  OtaContext c;
  c.runningVersion = "1.3.0";
  std::strcpy(c.offer.version, "1.4.0");
  c.offer.size = 1612288;
  c.idleS = 120;
  c.batteryPct = 40;
  c.wifiUp = true;
  return c;
}
}  // namespace

TEST_CASE("versions order, with -dev below the same release") {
  CHECK(otaIsNewer("1.4.0", "1.3.9"));
  CHECK(otaIsNewer("1.10.0", "1.9.0"));
  CHECK_FALSE(otaIsNewer("1.3.0", "1.3.0"));
  CHECK(otaIsNewer("1.3.0", "1.3.0-dev+abc123"));
  CHECK_FALSE(otaIsNewer("1.3.0-dev+abc123", "1.3.0"));
  CHECK(otaIsNewer("1.3.1-dev", "1.3.0"));
  CHECK_FALSE(otaIsNewer("1.3.0-dev+a", "1.3.0-dev+b"));
}

TEST_CASE("garbage versions are invalid") {
  for (const char* bad : {"", "1", "1.2", "1.2.x", "1.2.3.4", "v1.2.3", "1.2.3-rc1", "1.2.3-dev+", "1.2.3-dev+a b", "1..3", "1234567.0.0"}) {
    CAPTURE(bad);
    CHECK_FALSE(otaParseVersion(bad).valid);
    CHECK_FALSE(otaIsNewer(bad, "0.0.1"));
  }
  CHECK_FALSE(otaParseVersion(nullptr).valid);
  CHECK_FALSE(otaIsNewer("2.0.0", "garbage"));
}

TEST_CASE("a ready device starts, every precondition at its boundary") {
  CHECK(otaShouldStart(ready()).verdict == OtaVerdict::Start);
  OtaContext c = ready();
  c.batteryPct = 39;
  CHECK(otaShouldStart(c).reason == OtaReason::LowBattery);
  c.charging = true;
  CHECK(otaShouldStart(c).verdict == OtaVerdict::Start);
  c = ready();
  c.idleS = 119;
  CHECK(otaShouldStart(c).reason == OtaReason::NotIdle);
  c = ready();
  c.secToNextTimer = 300;
  CHECK(otaShouldStart(c).reason == OtaReason::TimerSoon);
  c.secToNextTimer = 301;
  CHECK(otaShouldStart(c).verdict == OtaVerdict::Start);
  c = ready();
  c.wifiUp = false;
  CHECK(otaShouldStart(c).reason == OtaReason::NoWifi);
  c = ready();
  c.offer.applyAfterS = 600;
  c.sinceOfferSeenS = 599;
  CHECK(otaShouldStart(c).reason == OtaReason::TooEarly);
  c.sinceOfferSeenS = 600;
  CHECK(otaShouldStart(c).verdict == OtaVerdict::Start);
}

TEST_CASE("a turn, pairing, settings or setup holds the update") {
  for (int i = 0; i < 4; ++i) {
    OtaContext c = ready();
    (i == 0 ? c.inTurn : i == 1 ? c.inPairing : i == 2 ? c.inSettings : c.inSetup) = true;
    CHECK(otaShouldStart(c).verdict == OtaVerdict::NotYet);
    CHECK(otaShouldStart(c).reason == OtaReason::Busy);
  }
}

TEST_CASE("image size must be 1..slot and the offer newer") {
  OtaContext c = ready();
  c.offer.size = kOtaSlotBytes;
  CHECK(otaShouldStart(c).verdict == OtaVerdict::Start);
  c.offer.size = kOtaSlotBytes + 1;
  CHECK(otaShouldStart(c).verdict == OtaVerdict::Refuse);
  CHECK(otaShouldStart(c).reason == OtaReason::BadSize);
  c.offer.size = 0;
  CHECK(otaShouldStart(c).reason == OtaReason::BadSize);
  c = ready();
  std::strcpy(c.offer.version, "1.3.0");
  CHECK(otaShouldStart(c).reason == OtaReason::NotNewer);
}

TEST_CASE("postponed offers wait, except a mandatory one after 24 h") {
  OtaContext c = ready();
  c.postponedForS = 3600;
  CHECK(otaShouldStart(c).verdict == OtaVerdict::Postponed);
  c.offer.mandatory = true;
  c.sinceOfferSeenS = kOtaMandatoryForceS - 1;
  CHECK(otaShouldStart(c).verdict == OtaVerdict::Postponed);
  c.sinceOfferSeenS = kOtaMandatoryForceS;
  CHECK(otaShouldStart(c).verdict == OtaVerdict::Start);
}

TEST_CASE("three failed attempts in 24 h give up on the offer") {
  OtaContext c = ready();
  c.failedAttempts24h = 2;
  CHECK(otaShouldStart(c).verdict == OtaVerdict::Start);
  c.failedAttempts24h = 3;
  CHECK(otaShouldStart(c).reason == OtaReason::GaveUp);
}

TEST_CASE("the countdown is 10 s, a key postpones it up to 3 times") {
  OtaCountdown c;
  c.elapsedMs = 0;
  CHECK(otaCountdownStep(c).action == OtaCountdownAction::Continue);
  CHECK(otaCountdownStep(c).secondsLeft == 10);
  c.elapsedMs = 9001;
  CHECK(otaCountdownStep(c).secondsLeft == 1);
  c.elapsedMs = 10000;
  CHECK(otaCountdownStep(c).action == OtaCountdownAction::Start);
  c.elapsedMs = 3000;
  c.keyPressed = true;
  for (uint8_t used = 0; used < 3; ++used) {
    c.postponesUsed = used;
    CHECK(otaCountdownStep(c).action == OtaCountdownAction::Postpone);
  }
  c.postponesUsed = 3;
  CHECK(otaCountdownStep(c).action == OtaCountdownAction::Continue);
  c.elapsedMs = 10000;
  CHECK(otaCountdownStep(c).action == OtaCountdownAction::Start);
  CHECK(kOtaPostponeS == 4 * 3600);
}

TEST_CASE("a mandatory offer cannot be postponed after 24 h") {
  OtaCountdown c;
  c.elapsedMs = 2000;
  c.keyPressed = true;
  c.mandatory = true;
  c.sinceOfferSeenS = kOtaMandatoryForceS - 1;
  CHECK(otaCountdownStep(c).action == OtaCountdownAction::Postpone);
  c.sinceOfferSeenS = kOtaMandatoryForceS;
  CHECK(otaCountdownStep(c).action == OtaCountdownAction::Continue);
  c.mandatory = false;
  CHECK(otaCountdownStep(c).action == OtaCountdownAction::Postpone);
}

TEST_CASE("retry delay doubles from 5 min and caps at 6 h") {
  CHECK(otaRetryDelayMs(0) == 300000);
  CHECK(otaRetryDelayMs(1) == 300000);
  CHECK(otaRetryDelayMs(2) == 600000);
  CHECK(otaRetryDelayMs(3) == 1200000);
  CHECK(otaRetryDelayMs(7) == 19200000);
  CHECK(otaRetryDelayMs(8) == kOtaRetryCapMs);
  CHECK(otaRetryDelayMs(1000000) == kOtaRetryCapMs);
}

TEST_CASE("the health gate marks valid, rolls back or waits") {
  OtaHealth h;
  h.bootOk = true;
  h.wifiUp = true;
  CHECK(otaHealthDecision(h) == OtaHealthAction::Wait);
  h.welcomeSeen = true;
  h.msSinceBoot = 59999;
  CHECK(otaHealthDecision(h) == OtaHealthAction::Wait);
  h.msSinceBoot = 60000;
  CHECK(otaHealthDecision(h) == OtaHealthAction::MarkValid);
  h.bootOk = false;
  CHECK(otaHealthDecision(h) == OtaHealthAction::Rollback);
}

TEST_CASE("no network is healthy only after 3 boots") {
  OtaHealth h;
  h.bootOk = true;
  h.networklessHealthyBoots = 2;
  CHECK(otaHealthDecision(h) == OtaHealthAction::Wait);
  h.networklessHealthyBoots = 3;
  CHECK(otaHealthDecision(h) == OtaHealthAction::MarkValid);
  h.wifiUp = true;
  CHECK(otaHealthDecision(h) == OtaHealthAction::Wait);
}
