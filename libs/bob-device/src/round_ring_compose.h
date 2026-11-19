// Bob — turns a RingSpec into the light ring's 360 per-degree pixels, plus the helpers that keep a
// frame cheap: stage resolution (intro -> then), frame crossfade, RGB565 blend and the dirty-segment
// diff. Pure math, host-tested in test/host/test_round_ring_spec.cpp (no M5 includes).
//
// A composed pixel is `alpha << 24 | 0xRRGGBB` (alpha 0 = dark). Angles: 0 = right, clockwise,
// the top of the ring is 270.
#pragma once

#include <cmath>
#include <cstdint>

#include "round_ring_policy.h"
#include "round_ring_spec.h"

namespace bob
{

constexpr int kRingAngles = 360;
constexpr float kRingTop = 270.0f;

inline float ringClamp01(float x) { return x < 0.0f ? 0.0f : x > 1.0f ? 1.0f : x; }
inline float ringFrac(float x) { return x - std::floor(x); }
inline float ringTri(float x) { return 1.0f - std::fabs(2.0f * ringFrac(x) - 1.0f); } // 0 -> 1 -> 0 per unit
inline float ringSmoothStep(float x) { x = ringClamp01(x); return x * x * (3.0f - 2.0f * x); }
inline float ringWrap360(float a) { a = std::fmod(a, 360.0f); return a < 0.0f ? a + 360.0f : a; }
inline float ringAngDist(float a, float b) { const float d = std::fabs(ringWrap360(a - b)); return d > 180.0f ? 360.0f - d : d; }

inline float ringBounceOut(float x)
{
  x = ringClamp01(x);
  if (x < 1.0f / 2.75f) { return 7.5625f * x * x; }
  if (x < 2.0f / 2.75f) { x -= 1.5f / 2.75f; return 7.5625f * x * x + 0.75f; }
  if (x < 2.5f / 2.75f) { x -= 2.25f / 2.75f; return 7.5625f * x * x + 0.9375f; }
  x -= 2.625f / 2.75f;
  return 7.5625f * x * x + 0.984375f;
}

// Turns travelled after t ms by an accelerating motion: 0.35x speed ramping to 1x over 2.5 s.
inline float ringAccelTurns(uint32_t t, uint32_t periodMs)
{
  constexpr float kRamp = 2500.0f, kStart = 0.35f;
  const float ms = static_cast<float>(t);
  const float travelled = ms < kRamp ? kStart * ms + (1.0f - kStart) * ms * ms / (2.0f * kRamp)
                                     : kStart * kRamp + (1.0f - kStart) * kRamp * 0.5f + (ms - kRamp);
  return travelled / static_cast<float>(periodMs);
}

// Where the motion has taken a head or pattern, in turns (cw positive); oscillating motions stay bounded.
inline float ringPhase(const RingSpec& s, uint32_t t)
{
  const float period = static_cast<float>(s.periodMs > 0 ? s.periodMs : 1);
  const float x = static_cast<float>(t) / period;
  const float d = s.dir < 0 ? -1.0f : 1.0f;
  switch (s.motion)
  {
    case RingMotion::kCw: return x;
    case RingMotion::kCcw: return -x;
    case RingMotion::kPingPong: return d * 0.5f * ringTri(x);
    case RingMotion::kEaseInOut: return d * (std::floor(x) + ringSmoothStep(ringFrac(x)));
    case RingMotion::kBounce: return d * 0.5f * ringBounceOut(ringTri(x));
    case RingMotion::kAccel: return d * ringAccelTurns(t, s.periodMs > 0 ? s.periodMs : 1);
    case RingMotion::kStill: break;
  }
  return 0.0f;
}

// Fill/drain progress 0..1 (one shot, except ping-pong which fills then drains and repeats).
inline float ringProgress(const RingSpec& s, uint32_t t)
{
  const float x = static_cast<float>(t) / static_cast<float>(s.periodMs > 0 ? s.periodMs : 1);
  const float once = x > 1.0f ? 1.0f : x;
  switch (s.motion)
  {
    case RingMotion::kCw: return once;
    case RingMotion::kCcw: return 1.0f - once;
    case RingMotion::kPingPong: return ringTri(x);
    case RingMotion::kEaseInOut: return ringSmoothStep(once);
    case RingMotion::kBounce: return ringBounceOut(once);
    case RingMotion::kAccel: return once * once;
    case RingMotion::kStill: break;
  }
  return 1.0f;
}

// 0..1 multiplier: fade in, hold, fade out (holdMs 0 holds forever).
inline float ringEnvelope(const RingSpec& s, uint32_t t)
{
  float e = s.inMs > 0 && t < s.inMs ? static_cast<float>(t) / static_cast<float>(s.inMs) : 1.0f;
  if (s.holdMs > 0)
  {
    const uint32_t end = static_cast<uint32_t>(s.inMs) + s.holdMs;
    if (t >= end) { e *= s.outMs > 0 && t - end < s.outMs ? 1.0f - static_cast<float>(t - end) / static_cast<float>(s.outMs) : 0.0f; }
  }
  return e;
}

// The spec's life is over (a one-shot has faded out).
inline bool ringFinished(const RingSpec& s, uint32_t t) { return s.holdMs > 0 && t >= static_cast<uint32_t>(s.inMs) + s.holdMs + s.outMs; }

// Which spec is on stage `sinceMs` after `s` started: follows `then` after each introMs.
struct RingStage
{
  const RingSpec* spec;
  uint32_t since;      // ms into this stage
};

inline RingStage ringStage(const RingSpec* s, uint32_t sinceMs)
{
  for (int hops = 0; hops < 3 && s->then != nullptr && sinceMs >= s->introMs; ++hops)
  {
    const RingSpec* next = ringSpecByName(s->then);
    if (next == nullptr) { break; }
    sinceMs -= s->introMs;
    s = next;
  }
  return RingStage{s, sinceMs};
}

inline uint32_t ringHue(float t) // pastel rainbow, t 0..1
{
  const float h = ringFrac(t) * 6.0f;
  const float f = h - std::floor(h);
  const float r[6] = {1, 1 - f, 0, 0, f, 1}, g[6] = {f, 1, 1, 1 - f, 0, 0}, b[6] = {0, 0, f, 1, 1, 1 - f};
  const int i = static_cast<int>(h) % 6;
  const uint32_t rgb = (static_cast<uint32_t>(r[i] * 255.0f) << 16) | (static_cast<uint32_t>(g[i] * 255.0f) << 8) | static_cast<uint32_t>(b[i] * 255.0f);
  return ringMix(rgb, kRingPaper, 40);
}

// The colour at position t (0..1) along the spec's palette.
inline uint32_t ringPaletteAt(const RingSpec& s, float t)
{
  if (s.nColors == 0) { return ringHue(t); }
  if (s.nColors == 1) { return s.colors[0]; }
  const float x = ringClamp01(t) * static_cast<float>(s.nColors - 1);
  const int i = static_cast<int>(x);
  if (i >= s.nColors - 1) { return s.colors[s.nColors - 1]; }
  return ringMix(s.colors[i], s.colors[i + 1], static_cast<uint32_t>((x - static_cast<float>(i)) * 256.0f));
}

inline uint32_t ringHash(uint32_t x)
{
  x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16;
  return x;
}

// Composes the spec `t` ms after it started into out[0..359]. `level` 0..1 drives kLevel.
inline void ringCompose(const RingSpec& s, uint32_t t, float level, uint32_t out[kRingAngles])
{
  const float env = ringEnvelope(s, t);
  if (env <= 0.0f || (s.lo == 0 && s.hi == 0))
  {
    for (int a = 0; a < kRingAngles; ++a) { out[a] = 0; }
    return;
  }
  auto emit = [&](int a, float shape, float cpos) {
    const float b = (static_cast<float>(s.lo) + static_cast<float>(s.hi - s.lo) * ringClamp01(shape)) * env;
    const uint32_t alpha = b <= 0.5f ? 0u : b >= 254.5f ? 255u : static_cast<uint32_t>(b + 0.5f);
    out[a] = alpha == 0 ? 0u : (alpha << 24) | ringPaletteAt(s, cpos);
  };
  const float phase = ringPhase(s, t);
  const float period = static_cast<float>(s.periodMs > 0 ? s.periodMs : 1);
  const float x = static_cast<float>(t) / period;
  const float turn = phase * 360.0f;
  const float lookAhead = ringPhase(s, t + 40) - phase;
  const float sgn = lookAhead < 0.0f ? -1.0f : 1.0f;

  switch (s.pattern)
  {
    case RingShape::kSolid:
      for (int a = 0; a < kRingAngles; ++a) { emit(a, 1.0f, 0.0f); }
      break;
    case RingShape::kBreathe:
    {
      const float shape = 0.5f - 0.5f * std::cos(6.2831853f * ringFrac(x));
      for (int a = 0; a < kRingAngles; ++a) { emit(a, shape, 0.0f); }
      break;
    }
    case RingShape::kLevel:
    {
      const float lv = ringClamp01(level);
      for (int a = 0; a < kRingAngles; ++a)
      {
        const float ripple = 0.85f + 0.15f * std::cos((static_cast<float>(a) - kRingTop - turn) * 0.0174533f);
        emit(a, lv * ripple, lv);
      }
      break;
    }
    case RingShape::kGlow: // the whole rim at one brightness that follows the level (the demo's speak ring)
    {
      const float lv = ringClamp01(level);
      for (int a = 0; a < kRingAngles; ++a) { emit(a, lv, lv); }
      break;
    }
    case RingShape::kHeartbeat:
    {
      const float u = ringFrac(x);
      auto bump = [&](float start, float width) { return u >= start && u < start + width ? std::sin(3.1415927f * (u - start) / width) : 0.0f; };
      const float shape = std::fmax(bump(0.0f, 0.16f), 0.75f * bump(0.22f, 0.14f)); // lub, then a softer dub
      for (int a = 0; a < kRingAngles; ++a) { emit(a, shape, 0.0f); }
      break;
    }
    case RingShape::kPulse: // a ripple from the top outward to the bottom, fading as it goes
    {
      const float ph = ringFrac(x), front = ph * 190.0f;
      for (int a = 0; a < kRingAngles; ++a)
      {
        const float d = ringAngDist(static_cast<float>(a) + 0.5f, kRingTop);
        emit(a, ringClamp01(1.0f - std::fabs(d - front) / 45.0f) * (1.0f - ph), d / 180.0f);
      }
      break;
    }
    case RingShape::kSweep:
    {
      const float tail = static_cast<float>(s.tailHalf) * 2.0f, head = kRingTop + turn + static_cast<float>(s.segments) * 2.0f;
      for (int a = 0; a < kRingAngles; ++a)
      {
        const float behind = ringWrap360(head - (static_cast<float>(a) + 0.5f));
        float k = behind < tail ? 1.0f - behind / tail : 0.0f;
        const float ahead = static_cast<float>(s.aheadDeg < 1 ? 1 : s.aheadDeg);
        if (behind > 360.0f - ahead) { k = 1.0f - (360.0f - behind) / ahead; } // in front of the head the sweep fades out over aheadDeg
        emit(a, k, 0.0f);
      }
      break;
    }
    case RingShape::kComet:
    {
      const int heads = s.segments < 1 ? 1 : s.segments > 3 ? 3 : s.segments;
      const float tail = heads == 1 ? 110.0f : heads == 2 ? 85.0f : 65.0f;
      for (int a = 0; a < kRingAngles; ++a)
      {
        const float ang = static_cast<float>(a) + 0.5f;
        float best = 0.0f, bestPos = 1.0f;
        for (int h = 0; h < heads; ++h)
        {
          const float head = kRingTop + turn + 360.0f * static_cast<float>(h) / static_cast<float>(heads);
          const float behind = ringWrap360(sgn * (head - ang));
          float k = behind < tail ? (1.0f - behind / tail) * (1.0f - behind / tail) : 0.0f;
          if (behind > 357.0f) { k = (360.0f - behind) / 3.0f; } // a soft leading edge
          if (k > best) { best = k; bestPos = behind < tail ? behind / tail : 0.0f; }
        }
        emit(a, best, bestPos);
      }
      break;
    }
    case RingShape::kDualComet: // two heads mirrored about the top, sweeping to the bottom and starting again
    {
      const float p = std::fmod(std::fabs(turn), 180.0f), tail = 80.0f;
      for (int a = 0; a < kRingAngles; ++a)
      {
        const float ang = static_cast<float>(a) + 0.5f;
        const float side = ang - kRingTop;                       // + clockwise of the top
        const float off = ringWrap360(side + 180.0f) - 180.0f;    // -180..180
        const float dist = std::fabs(off);                        // 0..180 from the top
        const float behind = p - dist;                            // how far the head is past this angle
        const float k = behind >= 0.0f && behind < tail ? (1.0f - behind / tail) * (1.0f - behind / tail) : 0.0f;
        emit(a, k, behind >= 0.0f && behind < tail ? behind / tail : 0.0f);
      }
      break;
    }
    case RingShape::kSpinner:
    {
      const int arcs = s.segments < 1 ? 1 : s.segments;
      const float spacing = 360.0f / static_cast<float>(arcs), len = spacing * 0.5f < 75.0f ? spacing * 0.5f : 75.0f;
      for (int a = 0; a < kRingAngles; ++a)
      {
        const float local = std::fmod(ringWrap360(static_cast<float>(a) + 0.5f - kRingTop - turn), spacing);
        const float edge = local < len - local ? local : len - local;
        emit(a, local < len ? ringClamp01(edge / 9.0f) : 0.0f, 1.0f - local / len);
      }
      break;
    }
    case RingShape::kChase:
    {
      const int n = s.segments < 2 ? 12 : s.segments;
      const float cell = 360.0f / static_cast<float>(n), edge = cell * 0.14f;
      for (int a = 0; a < kRingAngles; ++a)
      {
        const float pos = ringWrap360(static_cast<float>(a) + 0.5f - kRingTop - turn);
        const int idx = static_cast<int>(pos / cell);
        const float local = pos - static_cast<float>(idx) * cell, rest = cell * 0.5f - local;
        const float shape = local < cell * 0.5f ? ringClamp01((local < rest ? local : rest) / edge) : 0.0f;
        emit(a, shape, s.nColors > 1 ? static_cast<float>(idx % s.nColors) / static_cast<float>(s.nColors - 1) : 0.0f);
      }
      break;
    }
    case RingShape::kWave:
    {
      const float crests = static_cast<float>(s.segments < 1 ? 3 : s.segments);
      for (int a = 0; a < kRingAngles; ++a)
      {
        const float shape = 0.5f + 0.5f * std::sin(6.2831853f * (crests * (static_cast<float>(a) + 0.5f - kRingTop) / 360.0f - phase));
        emit(a, shape, shape);
      }
      break;
    }
    case RingShape::kGradient:
    case RingShape::kRainbow:
      for (int a = 0; a < kRingAngles; ++a)
      {
        const float pos = (static_cast<float>(a) + 0.5f - kRingTop) / 360.0f - phase;
        emit(a, 1.0f, s.pattern == RingShape::kRainbow ? ringFrac(pos) : ringTri(pos));
      }
      break;
    case RingShape::kFill:
    {
      const float reach = ringProgress(s, t) * 360.0f;
      for (int a = 0; a < kRingAngles; ++a)
      {
        const float rel = ringWrap360(static_cast<float>(a) + 0.5f - kRingTop);
        emit(a, reach >= 359.0f ? 1.0f : ringClamp01((reach - rel) / 6.0f), rel / 360.0f);
      }
      break;
    }
    case RingShape::kTicks:
    {
      const int n = s.segments < 2 ? 12 : s.segments;
      const float cell = 360.0f / static_cast<float>(n);
      const int lit = static_cast<int>(ringFrac(phase) * static_cast<float>(n)) % n;
      for (int a = 0; a < kRingAngles; ++a)
      {
        const float pos = ringWrap360(static_cast<float>(a) + 0.5f - kRingTop);
        const int idx = static_cast<int>(pos / cell + 0.5f) % n;
        float d = pos - static_cast<float>(idx) * cell;
        d = d < 0.0f ? -d : d;
        d = d > 180.0f ? 360.0f - d : d;
        const float tick = ringClamp01(1.0f - d / 2.4f);
        emit(a, tick * (idx == lit ? 1.0f : idx < lit ? 0.6f : 0.3f), idx == lit ? 1.0f : 0.0f);
      }
      break;
    }
    case RingShape::kSparkle:
    {
      const uint32_t life = s.periodMs < 120 ? 120u : s.periodMs;
      for (int a = 0; a < kRingAngles; ++a)
      {
        const uint32_t cell = static_cast<uint32_t>(a) / 6u;
        const uint32_t shifted = t + ringHash(cell) % life;
        const uint32_t h = ringHash(cell * 7919u + (shifted / life) * 104729u);
        const float u = static_cast<float>(shifted % life) / static_cast<float>(life);
        const float inCell = (static_cast<float>(a % 6) + 0.5f) / 6.0f;
        const float on = (h & 255u) < 80u ? std::sin(3.1415927f * u) * std::sin(3.1415927f * u) : 0.0f;
        emit(a, on * std::sin(3.1415927f * inCell), static_cast<float>((h >> 8) & 255u) / 255.0f);
      }
      break;
    }
  }

  if (s.ticks >= 2) // clock marks over the pattern, in the palette's last colour
  {
    const uint32_t mark = s.nColors > 0 ? s.colors[s.nColors - 1] : kRingPaper;
    const float cell = 360.0f / static_cast<float>(s.ticks), a8 = 235.0f * env;
    for (int i = 0; i < s.ticks; ++i)
    {
      const float at = ringWrap360(kRingTop + static_cast<float>(i) * cell);
      for (int da = -2; da <= 2; ++da)
      {
        const int a = (static_cast<int>(at) + da + kRingAngles) % kRingAngles;
        const float d = ringAngDist(static_cast<float>(a) + 0.5f, at);
        const uint32_t alpha = d < 2.0f ? static_cast<uint32_t>(a8 * (1.0f - d / 2.0f)) : 0u;
        if (alpha > (out[a] >> 24)) { out[a] = (alpha << 24) | mark; }
      }
    }
  }
}

// Premultiplied crossfade of two composed frames: t 0 = a ... 256 = b. Lets one ring pattern melt into
// the next (and its colours into the next colours) over 300 ms instead of cutting.
inline uint32_t ringBlendPixel(uint32_t a, uint32_t b, uint32_t t)
{
  const uint32_t aa = (a >> 24) * (256 - t), ab = (b >> 24) * t, total = aa + ab;
  if (total == 0) { return 0; }
  uint32_t rgb = 0;
  for (int shift = 0; shift <= 16; shift += 8)
  {
    rgb |= (((((a >> shift) & 255) * aa) + (((b >> shift) & 255) * ab)) / total) << shift;
  }
  return ((total >> 8) << 24) | rgb;
}

inline void ringBlendFrames(const uint32_t* a, const uint32_t* b, uint32_t t, uint32_t* out)
{
  for (int i = 0; i < kRingAngles; ++i) { out[i] = ringBlendPixel(a[i], b[i], t); }
}

// RGB565 of 0xRRGGBB, and the fast 5-bit-alpha blend of fg over bg (the panel path).
constexpr uint16_t ringRgb565(uint32_t rgb) { return static_cast<uint16_t>(((rgb >> 8) & 0xF800) | ((rgb >> 5) & 0x07E0) | ((rgb >> 3) & 0x001F)); }

inline uint16_t ringBlend565(uint16_t bg, uint16_t fg, uint32_t alpha8)
{
  const uint32_t a = (alpha8 + 4) >> 3; // 0..32
  const uint32_t f = (fg | (static_cast<uint32_t>(fg) << 16)) & 0x07E0F81FU;
  const uint32_t b = (bg | (static_cast<uint32_t>(bg) << 16)) & 0x07E0F81FU;
  const uint32_t r = ((((f - b) * a) >> 5) + b) & 0x07E0F81FU;
  return static_cast<uint16_t>(r | (r >> 16));
}

// What the panel can show of a composed pixel: 5 alpha bits and RGB565. Equal keys need no redraw.
constexpr uint32_t ringKey(uint32_t px) { return (px >> 24) < 4 ? 0u : (((px >> 24) >> 3) << 16) | ringRgb565(px & 0xFFFFFF); }

struct RingSeg
{
  int16_t from, to; // degrees [from, to)
};

// The runs of angles whose key changed (gaps of up to 3 degrees are bridged). When there are more
// than `max` runs they collapse into one span from the first to the last change. Returns the count.
inline int ringDiffSegments(const uint32_t* prev, const uint32_t* cur, RingSeg* segs, int max)
{
  int n = 0, first = -1, last = -1;
  int start = -1;
  int runs[kRingAngles / 2][2];
  int count = 0;
  for (int a = 0; a <= kRingAngles; ++a)
  {
    const bool changed = a < kRingAngles && ringKey(prev[a]) != ringKey(cur[a]);
    if (changed)
    {
      if (first < 0) { first = a; }
      last = a;
      if (start < 0) { start = a; }
      continue;
    }
    if (start >= 0 && (a >= kRingAngles || a - last > 3))
    {
      if (count < kRingAngles / 2) { runs[count][0] = start; runs[count][1] = last + 1; ++count; }
      start = -1;
    }
  }
  if (count == 0) { return 0; }
  if (count > max)
  {
    segs[0] = RingSeg{static_cast<int16_t>(first), static_cast<int16_t>(last + 1)};
    return 1;
  }
  for (; n < count; ++n) { segs[n] = RingSeg{static_cast<int16_t>(runs[n][0]), static_cast<int16_t>(runs[n][1])}; }
  return n;
}

} // namespace bob
