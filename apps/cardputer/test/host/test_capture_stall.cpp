// Wall-clock capture guard (include/capture_stall.h). Escaped defect, Waveshare 2026-10-15: after
// "Hey Bob" the turn sat on LISTENING forever because capture stopped delivering frames and
// the VAD, which only advances per frame, never ended it.
#include <cstdint>

#include "capture_stall.h"
#include "doctest.h"

using bob::CaptureStall;
using bob::CaptureStallReason;
using bob::kCaptureStallMs;
using bob::kTurnWallMs;

TEST_CASE("capture stall: an unarmed guard never fires") {
  CaptureStall s;
  CHECK(s.check(0) == CaptureStallReason::kNone);
  CHECK(s.check(1000000) == CaptureStallReason::kNone);
}

TEST_CASE("capture stall: a mic that never delivers is caught") {
  CaptureStall s;
  s.arm(1000);
  CHECK(s.check(1000 + kCaptureStallMs - 1) == CaptureStallReason::kNone);
  CHECK(s.check(1000 + kCaptureStallMs) == CaptureStallReason::kNoFrames);
}

TEST_CASE("capture stall: steady frames keep the turn alive until the wall cap") {
  CaptureStall s;
  s.arm(5000);
  for (uint32_t t = 5000; t < 5000 + kTurnWallMs; t += 10) {
    s.frame(t);
    REQUIRE(s.check(t) == CaptureStallReason::kNone);
  }
  s.frame(5000 + kTurnWallMs);
  CHECK(s.check(5000 + kTurnWallMs) == CaptureStallReason::kTurnTooLong);
}

TEST_CASE("capture stall: frames that stop mid-turn are caught after the gap") {
  CaptureStall s;
  s.arm(0);
  for (uint32_t t = 0; t <= 2000; t += 10) s.frame(t);
  CHECK(s.check(2000 + kCaptureStallMs - 1) == CaptureStallReason::kNone);
  CHECK(s.check(2000 + kCaptureStallMs) == CaptureStallReason::kNoFrames);
}

TEST_CASE("capture stall: disarm and re-arm restart the clock") {
  CaptureStall s;
  s.arm(0);
  s.disarm();
  CHECK(s.check(60000) == CaptureStallReason::kNone);
  s.arm(60000);
  CHECK(s.check(60000 + kCaptureStallMs - 1) == CaptureStallReason::kNone);
}

TEST_CASE("capture stall: the millisecond counter wrapping does not fire early") {
  CaptureStall s;
  s.arm(0xFFFFFF00u);
  s.frame(0xFFFFFFF0u);
  CHECK(s.check(0x00000010u) == CaptureStallReason::kNone);  // 32 ms after the last frame, across the wrap
}
