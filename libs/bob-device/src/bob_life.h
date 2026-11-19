// The "alive" maths of Bob on the Waveshare, pure and host-tested: spring easing for gestures and
// settles, the squish blink, the gaze spring and clamp, and when an idle micro-behaviour is due.
// bob_motion.cpp owns the state and the drawing; this file owns the numbers.
#pragma once

#include <math.h>
#include <stdint.h>

namespace bob {
namespace life {

inline float clampf(float v, float lo, float hi) { return v < lo ? lo : v > hi ? hi : v; }

// Spring easing for p in 0..1: 0 at the start and 1 at the end, with one small overshoot (zeta 0.65,
// about 7%) and settled by p = 1. Gestures and settles use it instead of a cubic bezier, so every move
// follows through and lands softly.
inline float springEase(float p) {
  if (p <= 0.0f) return 0.0f;
  if (p >= 1.0f) return 1.0f;
  constexpr float kZeta = 0.65f, kOmega = 9.0f;
  const float wd = kOmega * sqrtf(1.0f - kZeta * kZeta);
  const float e = expf(-kZeta * kOmega * p);
  return 1.0f - e * (cosf(wd * p) + kZeta * kOmega / wd * sinf(wd * p));
}

// --- Blink -----------------------------------------------------------------------------------
constexpr uint32_t kBlinkMs = 180;

struct BlinkShape {
  float open;   // eye height: 1 open .. 0 shut
  float widen;  // eye width factor: the eye squishes wider as it shuts
};

// The eyes shut fast (45% of the time) and open slower, widening slightly while they are low.
inline BlinkShape blinkShape(uint32_t elapsedMs, uint32_t durMs = kBlinkMs) {
  if (elapsedMs >= durMs) return BlinkShape{1.0f, 1.0f};
  const float t = static_cast<float>(elapsedMs) / static_cast<float>(durMs);
  float open;
  if (t < 0.45f) {
    const float x = t / 0.45f;
    open = 1.0f - x * x;
  } else {
    const float x = (t - 0.45f) / 0.55f;
    open = 1.0f - (1.0f - x) * (1.0f - x);
  }
  return BlinkShape{open, 1.0f + 0.15f * (1.0f - open)};
}

// --- Gaze --------------------------------------------------------------------------------------
constexpr float kGazeMaxU = 3.0f;  // visor px the pupils may move sideways, inside the visor
constexpr float kGazeMaxV = 1.5f;  // and up or down
constexpr float kGazeReach = 50.0f;  // a target this many screen px from the visor is full deflection
constexpr uint32_t kGazeHoldMs = 2500;  // the gaze returns to centre this long after its target went away

struct Gaze {
  float u, v;
};

// Where the eyes point for a target at (tx, ty) when the visor is at (vx, vy), both in screen px.
inline Gaze gazeToward(float tx, float ty, float vx, float vy) {
  return Gaze{clampf((tx - vx) / kGazeReach, -1.0f, 1.0f) * kGazeMaxU, clampf((ty - vy) / kGazeReach, -1.0f, 1.0f) * kGazeMaxV};
}

// One critically damped spring axis: follows a target without overshoot, so the eyes glide and settle.
struct Spring {
  float x = 0.0f, v = 0.0f;
  void step(float target, float dtS, float omega = 12.0f) {
    const float a = omega * omega * (target - x) - 2.0f * omega * v;
    v += a * dtS;
    x += v * dtS;
  }
};

// --- Idle micro-behaviours ---------------------------------------------------------------------
enum class Micro : uint8_t { kNone, kLookAround, kBlinkPair, kButtonWobble, kHum, kHop };
constexpr uint32_t kMicroMinMs = 10000, kMicroSpanMs = 15000;  // one every 10-25 s

class IdleScheduler {
 public:
  void arm(uint32_t nowMs, uint32_t random) { nextAt_ = nowMs + kMicroMinMs + random % (kMicroSpanMs + 1); }
  bool due(uint32_t nowMs) const { return nextAt_ != 0 && static_cast<int32_t>(nowMs - nextAt_) >= 0; }
  uint32_t nextAt() const { return nextAt_; }
  void disarm() { nextAt_ = 0; }
  static Micro pick(uint32_t random) { return static_cast<Micro>(1 + random % 5); }

 private:
  uint32_t nextAt_ = 0;
};

}  // namespace life
}  // namespace bob
