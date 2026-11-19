// Scene engine, pure half (host-tested, Bob's portable core, ADR 0004): per-layer clocks and keyframed
// transforms, so Bob, each prop, the caption and the ring run on INDEPENDENT clocks. The device half
// (compositor and the props' drawing) is apps/cardputer/include/scene_engine.h.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "bob_life.h"
#include "scene_table.h"

namespace bob {
namespace scene {

struct Transform {
  float x, y;  // offset from the slot, screen px
  float scale;
  float rot;   // degrees, clockwise
  float alpha;
  Transform(float px = 0.0f, float py = 0.0f, float sc = 1.0f, float r = 0.0f, float al = 1.0f) : x(px), y(py), scale(sc), rot(r), alpha(al) {}
};

struct Keyframe {
  float t;  // 0..1 of the track
  float dx, dy, scale, rot, alpha;
};

// Interpolates the track at p with the spring easing between keys (a small overshoot, then settled).
inline Transform sampleKeys(const Keyframe* keys, size_t n, float p) {
  Transform out;
  if (n == 0) return out;
  if (n == 1 || p <= keys[0].t) return Transform{keys[0].dx, keys[0].dy, keys[0].scale, keys[0].rot, keys[0].alpha};
  size_t i = 0;
  while (i + 2 < n && p > keys[i + 1].t) ++i;
  const Keyframe& a = keys[i];
  const Keyframe& b = keys[i + 1];
  const float span = b.t - a.t;
  const float k = life::springEase(span > 0.0f ? life::clampf((p - a.t) / span, 0.0f, 1.0f) : 1.0f);
  out.x = a.dx + (b.dx - a.dx) * k;
  out.y = a.dy + (b.dy - a.dy) * k;
  out.scale = a.scale + (b.scale - a.scale) * k;
  out.rot = a.rot + (b.rot - a.rot) * k;
  out.alpha = life::clampf(a.alpha + (b.alpha - a.alpha) * k, 0.0f, 1.0f);
  return out;
}

// One layer's own clock: when it started, how long one cycle lasts, whether it loops.
struct LayerClock {
  uint32_t startMs = 0, durMs = 1000;
  bool loop = false;
  uint32_t elapsed(uint32_t nowMs) const { return static_cast<int32_t>(nowMs - startMs) > 0 ? nowMs - startMs : 0; }
  // 0..1 through the cycle; a loop wraps, otherwise it holds at 1.
  float phase(uint32_t nowMs) const {
    if (durMs == 0) return 1.0f;
    const uint32_t e = elapsed(nowMs);
    if (loop) return static_cast<float>(e % durMs) / static_cast<float>(durMs);
    return e >= durMs ? 1.0f : static_cast<float>(e) / static_cast<float>(durMs);
  }
};

// A prop pops in (small, low, spring to full size with a slight overshoot) and is gone in the last 300 ms.
constexpr uint32_t kEnterMs = 350, kExitMs = 300, kPropStaggerMs = 200, kCaptionDelayMs = 300, kCaptionFadeMs = 250;
constexpr Keyframe kEnter[] = {{0.0f, 0, 14, 0.5f, -8, 0}, {0.55f, 0, -3, 1.1f, 2, 1}, {1.0f, 0, 0, 1.0f, 0, 1}};

inline float exitAlpha(uint32_t sceneElapsedMs, uint32_t sceneDurMs) {
  if (sceneElapsedMs + kExitMs <= sceneDurMs) return 1.0f;
  if (sceneElapsedMs >= sceneDurMs) return 0.0f;
  return static_cast<float>(sceneDurMs - sceneElapsedMs) / static_cast<float>(kExitMs);
}

// Prop `index` (0 or 1) at `sceneElapsedMs` into a scene of `sceneDurMs`: its entrance on its own clock (the
// second prop starts 200 ms after the first), then held, then faded out with the scene.
inline Transform propTransform(uint8_t index, uint32_t sceneElapsedMs, uint32_t sceneDurMs) {
  LayerClock c;
  c.startMs = index * kPropStaggerMs;
  c.durMs = kEnterMs;
  Transform t = sampleKeys(kEnter, sizeof(kEnter) / sizeof(kEnter[0]), c.phase(sceneElapsedMs));
  t.alpha *= exitAlpha(sceneElapsedMs, sceneDurMs);
  return t;
}

// The caption fades in after a beat and out with the scene.
inline float captionAlpha(uint32_t sceneElapsedMs, uint32_t sceneDurMs) {
  LayerClock c;
  c.startMs = kCaptionDelayMs;
  c.durMs = kCaptionFadeMs;
  return c.phase(sceneElapsedMs) * exitAlpha(sceneElapsedMs, sceneDurMs);
}

// A prop's own animation clock in ms: starts when the prop appears, independent of Bob and the ring.
inline uint32_t propClockMs(uint8_t index, uint32_t sceneElapsedMs) {
  const uint32_t start = index * kPropStaggerMs;
  return sceneElapsedMs > start ? sceneElapsedMs - start : 0;
}

}  // namespace scene
}  // namespace bob
