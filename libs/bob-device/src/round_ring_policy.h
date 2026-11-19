// Bob — the round screen's light ring: which pattern each Bob mood shows and the pure
// animation math (host-tested in test/host/test_ring_policy.cpp; no M5 includes).
#pragma once

#include <cmath>
#include <cstdint>

namespace bob
{

enum class RingMode : uint8_t { kOff, kListening, kThinking, kSpeaking, kError, kNotify, kSleep, kDnd, kOk };

// Indexed by UiMood (round_ui.h): Idle, Listening, Thinking, Speaking, Sleeping, Offline, Error,
// Updating, Hello. One state-to-presentation map: the same mood picks Bob's emotion and the ring.
constexpr uint8_t kRingMoodCount = 9;
constexpr RingMode kRingForMood[kRingMoodCount] = {
    RingMode::kOff,       // Idle
    RingMode::kListening, // Listening
    RingMode::kThinking,  // Thinking
    RingMode::kSpeaking,  // Speaking
    RingMode::kSleep,     // Sleeping
    RingMode::kOff,       // Offline: the demo rests the ring (soft rim), the offline icons carry the news
    RingMode::kError,     // Error
    RingMode::kThinking,  // Updating
    RingMode::kOff,       // Hello
};

// Do-not-disturb dims an otherwise dark Ready ring to the slow ink breathe.
inline RingMode ringModeForMood(uint8_t mood, bool dnd)
{
  const RingMode mode = mood < kRingMoodCount ? kRingForMood[mood] : RingMode::kOff;
  return mode == RingMode::kOff && dnd ? RingMode::kDnd : mode;
}

// The ring-language name (round_ring_spec.h) each coarse mode shows.
inline const char* ringNameForMode(RingMode mode)
{
  switch (mode)
  {
    case RingMode::kListening: return "listening";
    case RingMode::kThinking: return "thinking";
    case RingMode::kSpeaking: return "speaking";
    case RingMode::kError: return "error";
    case RingMode::kNotify: return "notification";
    case RingMode::kSleep: return "sleeping";
    case RingMode::kDnd: return "dnd";
    case RingMode::kOk: return "ok";
    case RingMode::kOff: break;
  }
  return "idle";
}

// One-pole smoothing with separate attack and release time constants (ms).
inline float ringSmooth(float prev, float target, uint32_t dtMs, uint32_t attackMs, uint32_t releaseMs)
{
  const float tau = static_cast<float>(target > prev ? attackMs : releaseMs);
  if (tau <= 0.0f) { return target; }
  return prev + (target - prev) * (1.0f - std::exp(-static_cast<float>(dtMs) / tau));
}

// 0..1, one full cycle per period.
inline float ringBreathe(uint32_t nowMs, uint32_t periodMs)
{
  return 0.5f + 0.5f * std::sin(6.2831853f * static_cast<float>(nowMs % periodMs) / static_cast<float>(periodMs));
}

// How much of the ring has swept in (0..1, eased out) `elapsedMs` after listening began.
inline float ringSweep(uint32_t elapsedMs, uint32_t durMs)
{
  const float t = elapsedMs >= durMs ? 1.0f : static_cast<float>(elapsedMs) / static_cast<float>(durMs);
  return 1.0f - (1.0f - t) * (1.0f - t);
}

// Comet head angle in degrees (0 = right, clockwise), one lap per lapMs.
inline float ringCometAngle(uint32_t nowMs, uint32_t lapMs)
{
  return 360.0f * static_cast<float>(nowMs % lapMs) / static_cast<float>(lapMs);
}

// The coral error double pulse: two bumps 300 ms apart, then a dim rest (0.15) until the cycle ends.
inline float ringErrorPulse(uint32_t sinceMs)
{
  const uint32_t t = sinceMs % 2000;
  auto bump = [](uint32_t at, uint32_t start) {
    if (at < start || at >= start + 220) { return 0.0f; }
    return std::sin(3.1415927f * static_cast<float>(at - start) / 220.0f);
  };
  const float peak = bump(t, 0) > bump(t, 300) ? bump(t, 0) : bump(t, 300);
  return peak > 0.15f ? peak : 0.15f;
}

// The yellow notification pulse: a soft pulse every 1.5 s.
inline float ringNotifyPulse(uint32_t sinceMs)
{
  const uint32_t t = sinceMs % 1500;
  return t < 500 ? std::sin(3.1415927f * static_cast<float>(t) / 500.0f) : 0.0f;
}

} // namespace bob
