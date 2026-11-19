// Audio level meters for the Waveshare ring light: how loud the mic is and how loud the reply being
// played is, each as 0..1 and smoothed. The audio paths only update an atomic (no locks, a handful of
// multiplies per frame); the UI reads it. The math is pure and host-tested; captureLevel01() and
// playbackLevel01() are declared in audio_capture.h / audio_playback.h.
#pragma once

#include <math.h>
#include <stddef.h>
#include <stdint.h>

#include <atomic>

namespace bob {
namespace level {

constexpr float kCaptureRangeDb = 30.0f;     // capture: 0 at the noise floor, 1 at floor + 30 dB
constexpr float kPlaybackFloorDbfs = -50.0f; // playback: 0 at -50 dBFS RMS ...
constexpr float kPlaybackTopDbfs = -5.0f;    // ... and 1 at -5 dBFS
constexpr uint32_t kSmoothMs = 80;           // time constant of the smoothing
constexpr uint32_t kStaleMs = 250;           // no update this long: the source went quiet, level 0

inline float clamp01(float v) { return v < 0.0f ? 0.0f : v > 1.0f ? 1.0f : v; }

// The mic frame's level (dB re one LSB, as the VAD computes it) against the adaptive floor. An
// unmeasured floor (< 0) gives 0.
inline float captureTarget01(float db, float floorDb) {
  if (floorDb < 0.0f) return 0.0f;
  return clamp01((db - floorDb) / kCaptureRangeDb);
}

// A PCM block's RMS (in LSB of int16) on the playback scale; silence gives 0.
inline float playbackTarget01(float rms) {
  if (rms <= 0.0f) return 0.0f;
  const float dbfs = 20.0f * log10f(rms / 32768.0f);
  return clamp01((dbfs - kPlaybackFloorDbfs) / (kPlaybackTopDbfs - kPlaybackFloorDbfs));
}

inline float rmsOf(const int16_t* samples, size_t n) {
  if (n == 0) return 0.0f;
  uint64_t sum = 0;
  for (size_t i = 0; i < n; ++i) sum += static_cast<int32_t>(samples[i]) * samples[i];
  return sqrtf(static_cast<float>(sum) / static_cast<float>(n));
}

// One step of an exponential filter with time constant tauMs over dtMs.
inline float smooth(float prev, float target, uint32_t dtMs, uint32_t tauMs = kSmoothMs) {
  const float alpha = static_cast<float>(dtMs) / static_cast<float>(tauMs + dtMs);
  return prev + alpha * (target - prev);
}

// One writer (the audio path), any number of readers. Level is stored as permille in atomics.
class Meter {
 public:
  void update(float target01, uint32_t nowMs) {
    const uint32_t at = at_.load(std::memory_order_relaxed);
    const uint32_t dt = static_cast<uint32_t>(nowMs - at);
    const float prev = dt > kStaleMs ? 0.0f : static_cast<float>(milli_.load(std::memory_order_relaxed)) / 1000.0f;
    const float next = clamp01(smooth(prev, clamp01(target01), dt > kStaleMs ? kSmoothMs : dt));
    milli_.store(static_cast<uint32_t>(next * 1000.0f + 0.5f), std::memory_order_relaxed);
    at_.store(nowMs, std::memory_order_relaxed);
  }
  float level(uint32_t nowMs) const {
    if (static_cast<uint32_t>(nowMs - at_.load(std::memory_order_relaxed)) > kStaleMs) return 0.0f;
    return static_cast<float>(milli_.load(std::memory_order_relaxed)) / 1000.0f;
  }

 private:
  std::atomic<uint32_t> milli_{0};
  std::atomic<uint32_t> at_{0};
};

// One reply's loudness as the speaker API received it, per submitted block on the playback scale
// (playbackTarget01): the loudest block and the mean. Journaled at playback_completed
// (playback_level01_peak / _mean) so HIL and the journal can tell a reply that carried sound from
// digital silence (P0 #1063). Digital level before the master volume; the volume, amp and codec are
// logged beside it. One writer; read once at teardown, after the writer stopped.
class ReplyLevel {
 public:
  void add(float target01) {
    const float v = clamp01(target01);
    if (v > peak_) peak_ = v;
    sum_ += v;
    ++blocks_;
  }
  float peak() const { return peak_; }
  float mean() const { return blocks_ == 0 ? 0.0f : static_cast<float>(sum_ / blocks_); }
  uint32_t blocks() const { return blocks_; }
  void clear() { *this = ReplyLevel(); }

 private:
  float peak_ = 0.0f;
  double sum_ = 0.0;
  uint32_t blocks_ = 0;
};

inline Meter& captureMeter() {
  static Meter m;
  return m;
}
inline Meter& playbackMeter() {
  static Meter m;
  return m;
}

}  // namespace level
}  // namespace bob
