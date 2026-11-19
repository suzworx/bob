// Wall-clock guard for a capturing turn. The VAD only advances when the mic delivers a frame, so
// a mic that stops delivering (a shared-I2S hand-off gone wrong, a driver fault) would leave the
// turn on LISTENING forever. This watches the clock instead: no frame for kCaptureStallMs, or a
// turn older than kTurnWallMs, ends the turn with a journaled reason. Pure logic, host-tested.
#pragma once

#include <stdint.h>

namespace bob {

constexpr uint32_t kCaptureStallMs = 1500;  // no mic frame this long while capturing
constexpr uint32_t kTurnWallMs = 18000;     // kVadMaxTurnMs (15 s) plus slack, by the clock

enum class CaptureStallReason : uint8_t { kNone, kNoFrames, kTurnTooLong };

class CaptureStall {
 public:
  // Arms at the moment the mic opens; the first frame is expected within kCaptureStallMs.
  void arm(uint32_t nowMs) {
    armed_ = true;
    startMs_ = nowMs;
    lastFrameMs_ = nowMs;
  }
  void disarm() { armed_ = false; }
  bool armed() const { return armed_; }
  // Call whenever at least one mic frame was taken.
  void frame(uint32_t nowMs) { lastFrameMs_ = nowMs; }

  CaptureStallReason check(uint32_t nowMs) const {
    if (!armed_) return CaptureStallReason::kNone;
    if (static_cast<uint32_t>(nowMs - lastFrameMs_) >= kCaptureStallMs) return CaptureStallReason::kNoFrames;
    if (static_cast<uint32_t>(nowMs - startMs_) >= kTurnWallMs) return CaptureStallReason::kTurnTooLong;
    return CaptureStallReason::kNone;
  }

  static const char* name(CaptureStallReason r) {
    return r == CaptureStallReason::kNoFrames ? "no_frames" : r == CaptureStallReason::kTurnTooLong ? "turn_too_long" : "none";
  }

 private:
  bool armed_ = false;
  uint32_t startMs_ = 0;
  uint32_t lastFrameMs_ = 0;
};

}  // namespace bob
