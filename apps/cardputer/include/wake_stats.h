// Bob Cardputer v2 — the wake_stats telemetry window (pure logic, no I/O).
//
// While the wake word listens, the device journals one wake_stats line per
// window: how many 10 ms frames reached the model and at what rate, the
// largest model output and the loudest frame. None of it is audio content.
#pragma once

#include <cstdint>

namespace bob {

// Frames per second over `elapsedMs`, rounded; 0 for an empty interval.
inline uint32_t framesPerSecond(uint32_t frames, uint32_t elapsedMs) {
  if (elapsedMs == 0) return 0;
  return static_cast<uint32_t>((static_cast<uint64_t>(frames) * 1000 + elapsedMs / 2) / elapsedMs);
}

struct WakeStats {
  uint32_t frames = 0;
  uint32_t fps = 0;
  uint32_t pending = 0;        // frames queued for the wake task, not yet through the model.
  uint8_t maxProbability = 0;  // model output, 0-255.
  float peakDb = 0.0f;         // loudest frame, dB re one LSB.
};

class WakeStatsWindow {
 public:
  void begin(uint32_t nowMs) {
    startMs_ = nowMs;
    frames_ = 0;
    maxProbability_ = 0;
    peakDb_ = 0.0f;
  }

  void addFrame(float db) {
    ++frames_;
    if (db > peakDb_) peakDb_ = db;
  }

  void addProbability(uint8_t p) {
    if (p > maxProbability_) maxProbability_ = p;
  }

  bool due(uint32_t nowMs, uint32_t periodMs) const { return nowMs - startMs_ >= periodMs; }

  // The window's figures; a new window starts at `nowMs`.
  WakeStats take(uint32_t nowMs) {
    WakeStats stats;
    stats.frames = frames_;
    stats.fps = framesPerSecond(frames_, nowMs - startMs_);
    stats.maxProbability = maxProbability_;
    stats.peakDb = peakDb_;
    begin(nowMs);
    return stats;
  }

 private:
  uint32_t startMs_ = 0;
  uint32_t frames_ = 0;
  uint8_t maxProbability_ = 0;
  float peakDb_ = 0.0f;
};

}  // namespace bob
