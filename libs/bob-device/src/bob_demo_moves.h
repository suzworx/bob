// Bob's move library as the approved demo animates it (docs/waveshare/golden/approved-demo.html, `const F` and `MV`): each
// move is a function of normalised time t (0..1) returning per-part parameters, ported line for line so a move's key pose
// on the device is the demo's. Units are the demo's: body/head/visor offsets and foot lifts in ART px (x kArtScale on the
// device), angles in degrees (clockwise, the right arm NOT mirrored), scales as factors, the look in the demo's look units.
// bob_moves.h wraps these as moves (duration, pose, arms) and converts them to rig channels. Pure C++11: host-tested.
#pragma once

#include <math.h>
#include <stdint.h>

namespace bob {
namespace demo {

// The eye style a move asks for (the demo's `eyes`), or none: the feeling's own eyes stay.
enum class Eyes : uint8_t { kNone, kOpen, kWide, kSparkle, kHalf, kClosed, kSquint };

struct P {
  float bodyDx = 0, bodyDy = 0, bodyRot = 0, bodySx = 1, bodySy = 1, spin = 0;
  float headRot = 0, headDx = 0, headDy = 0;
  float bellySx = 1, bellySy = 1;
  float armL = 0, armR = 0, armLs = 1, armRs = 1;
  float footL = 0, footR = 0;
  float button = 0, buttonSx = 1;
  float visorDx = 0, visorDy = 0, visorRot = 0;
  float lookX = 0, lookY = 0;
  float squish = 1, blush = 0;
  Eyes eyes = Eyes::kNone;
};

namespace m {
constexpr float kPi = 3.14159265f, kT2 = 2 * kPi;
inline float clamp(float x, float a, float b) { return x < a ? a : (x > b ? b : x); }
inline float bez(float x1, float y1, float x2, float y2, float t) {
  float lo = 0, hi = 1, mid = 0.5f;
  for (int i = 0; i < 24; i++) {
    mid = (lo + hi) / 2;
    const float x = 3 * (1 - mid) * (1 - mid) * mid * x1 + 3 * (1 - mid) * mid * mid * x2 + mid * mid * mid;
    if (x < t) lo = mid; else hi = mid;
  }
  mid = (lo + hi) / 2;
  return 3 * (1 - mid) * (1 - mid) * mid * y1 + 3 * (1 - mid) * mid * mid * y2 + mid * mid * mid;
}
inline float ease(float t) { return bez(0.45f, 0, 0.55f, 1, t); }                                   // EASE
inline float sp(float t, float f = 2.2f, float d = 5.5f) { return 1 - expf(-d * t) * cosf(kT2 * f * t); }  // spring 0 -> 1
inline float seg(float t, float a, float b) { return clamp((t - a) / (b - a), 0, 1); }
inline float hs(float x) { return sinf(kPi * x); }
inline float lagEase(float t, float d) { return ease(fmaxf(0.0f, t - d)); }
inline float lagHs(float t, float d) { return hs(fmaxf(0.0f, t - d)); }
inline float blinkF(float t, float at, float w = 0.16f) {
  const float q = (t - at) / w;
  return q <= 0 || q >= 1 ? 1 : 1 - 0.88f * sinf(kPi * q) * sinf(kPi * q);
}
}  // namespace m

// ---- the moves (F.*) ------------------------------------------------------------------------------------------------
inline P wave(float t) {
  using namespace m;
  P p;
  const float ant = -6 * seg(t, 0, 0.12f) * (1 - seg(t, 0.12f, 0.2f));
  const float sw = 16 * sinf(kT2 * 2 * seg(t, 0.12f, 0.92f)) * (1 - 0.5f * seg(t, 0.5f, 1));
  p.bodyRot = 1.5f * sinf(kT2 * t);
  p.bodyDy = -2 * fabsf(sinf(kT2 * t));
  p.armR = -6 + ant + sw;
  p.armL = 2 * sinf(kT2 * t);
  p.button = -8 * sinf(kT2 * (t - 0.1f) * 2);
  p.eyes = Eyes::kSquint;
  return p;
}
inline P ear(float t) {
  using namespace m;
  P p;
  const float e = sp(seg(t, 0.05f, 0.6f));
  p.armL = (1 - e) * -52;
  p.bodyRot = -4 * ease(seg(t, 0, 0.5f));
  p.bodyDy = -1 * hs(seg(t, 0, 0.4f));
  p.button = -6 * (1 - ease(seg(t, 0.3f, 1)));
  p.lookX = -3 * ease(seg(t, 0, 0.6f));
  p.eyes = Eyes::kWide;
  return p;
}
inline P chin(float t) {
  using namespace m;
  P p;
  const float e = sp(seg(t, 0, 0.45f)), rub = 4 * sinf(kT2 * 3 * seg(t, 0.45f, 0.95f));
  p.armL = (1 - e) * -40 + rub;
  p.bodyRot = 2.5f * sinf(kT2 * t);
  p.button = 7 * sinf(kT2 * (t - 0.15f));
  p.lookX = 2;
  p.lookY = -2;
  return p;
}
inline P armsUp(float t) {
  using namespace m;
  P p;
  const float up = sp(seg(t, 0.1f, 0.55f), 2.0f, 6.0f), pump = 5 * sinf(kT2 * 2 * seg(t, 0.55f, 1)), j = hs(seg(t, 0.08f, 0.5f));
  p.armL = (1 - up) * 38 + pump;
  p.armR = -(1 - up) * 38 - pump;
  p.bodyDy = -10 * j;
  p.bodySy = 1 + 0.05f * j;
  p.bodySx = 1 - 0.03f * j;
  p.footL = p.footR = -10 * j;
  p.button = 10 * sinf(kT2 * (t - 0.12f) * 2);
  p.eyes = Eyes::kSquint;
  return p;
}
inline P clap(float t) {
  using namespace m;
  P p;
  const float k = 0.5f + 0.5f * cosf(kT2 * 3 * t);
  p.armL = -52 * k;
  p.armR = 52 * k;
  p.bodyDy = -1.5f * (1 - k);
  p.bodySy = 1 + 0.015f * (1 - k);
  p.eyes = Eyes::kSquint;
  p.button = 6 * sinf(kT2 * 3 * (t - 0.08f));
  return p;
}
inline P point(float t) {
  using namespace m;
  P p;
  const float a = ease(seg(t, 0.15f, 0.45f));
  p.armR = -30 * a + 3 * sinf(kT2 * 3 * seg(t, 0.5f, 1)) * (1 - seg(t, 0.7f, 1));
  p.bodyRot = 3 * a;
  p.bodyDy = -2 * hs(seg(t, 0.1f, 0.4f));
  p.lookX = 6 * a;
  p.lookY = -5 * a;
  p.armL = -3 * a;
  return p;
}
inline P shrug(float t) {
  using namespace m;
  P p;
  const float s = sinf(kPi * ease(seg(t, 0.1f, 0.85f)));
  p.armL = 26 * s;
  p.armR = -26 * s;
  p.bodyDy = -5 * s;
  p.bodySy = 1 + 0.02f * s;
  p.button = -6 * s;
  p.eyes = Eyes::kHalf;
  p.visorDy = 2 * s;
  return p;
}
inline P footTap(float t) {
  using namespace m;
  P p;
  const float tap = fabsf(sinf(kPi * 3 * seg(t, 0.1f, 0.95f)));
  p.footR = -12 * tap;
  p.bodyDy = -1.2f * tap;
  p.bodyRot = 1.2f * sinf(kT2 * 3 * t);
  p.armL = 2 * sinf(kT2 * 3 * t);
  p.armR = -2 * sinf(kT2 * 3 * t);
  p.button = 5 * sinf(kT2 * (3 * t - 0.2f));
  p.eyes = Eyes::kSquint;
  return p;
}
inline P hop(float t) {
  using namespace m;
  P p;
  const float crouch = ease(seg(t, 0, 0.22f)), air = sinf(kPi * seg(t, 0.22f, 0.72f)), land = seg(t, 0.72f, 0.82f) * (1 - seg(t, 0.82f, 1));
  p.bodySy = 1 - 0.12f * crouch * (1 - seg(t, 0.22f, 0.3f)) + 0.08f * air - 0.1f * land + 0.02f * (1 - sp(seg(t, 0.82f, 1)));
  p.bodySx = 1 + 0.08f * crouch * (1 - seg(t, 0.22f, 0.3f)) - 0.05f * air + 0.08f * land;
  p.bodyDy = -46 * air + 3 * crouch * (1 - seg(t, 0.22f, 0.3f));
  p.footL = p.footR = -46 * air;
  p.armL = -34 * air + 20 * crouch;
  p.armR = 34 * air - 20 * crouch;
  p.button = -18 * (air - land);
  p.eyes = Eyes::kSquint;
  return p;
}
inline P sway(float t) {
  using namespace m;
  P p;
  const float s = sinf(kT2 * t), c = cosf(kT2 * t);
  p.bodyRot = 6 * s;
  p.bodyDx = 7 * s;
  p.bodyDy = -2 * fabsf(c);
  p.footL = -5 * fmaxf(0.0f, s);
  p.footR = -5 * fmaxf(0.0f, -s);
  p.armL = -16 * c;
  p.armR = 16 * c;
  p.button = -12 * sinf(kT2 * (t - 0.12f));
  p.eyes = Eyes::kSquint;
  return p;
}
inline P bow(float t) {
  using namespace m;
  P p;
  const float b = sinf(kPi * ease(seg(t, 0.08f, 0.9f)));
  p.bodyRot = 7 * b;
  p.bodySy = 1 - 0.05f * b;
  p.bodyDy = 2 * b;
  p.visorDy = 4 * b;
  p.visorRot = 3 * b;
  p.armL = 10 * b;
  p.armR = -10 * b;
  p.button = 14 * lagHs(seg(t, 0.08f, 0.9f), 0.08f);
  p.eyes = b > 0.55f ? Eyes::kClosed : Eyes::kNone;
  return p;
}
inline P look(float t) {
  using namespace m;
  P p;
  const float sw = sinf(kT2 * t);
  p.lookX = 9 * sw;
  p.lookY = -1;
  p.bodyRot = 2.5f * sw;
  p.visorDx = 7 * sw;
  p.visorRot = 2 * sw;
  p.button = -5 * sinf(kT2 * fmaxf(0.0f, t - 0.06f));
  return p;
}
inline P buttonSpin(float t) {
  using namespace m;
  P p;
  const float spn = cosf(kT2 * 2 * seg(t, 0.1f, 0.9f)), j = sinf(kPi * seg(t, 0.1f, 0.5f));
  p.buttonSx = spn;
  p.button = 6 * sinf(kT2 * t * 2);
  p.bodyDy = -3 * j;
  p.bodySy = 1 + 0.02f * j;
  p.armL = -20 * j;
  p.armR = 20 * j;
  p.eyes = Eyes::kSquint;
  return p;
}
inline P buttonWobble(float t) {
  using namespace m;
  P p;
  const float e = 1 - t;
  p.button = 12 * sinf(kT2 * 2.5f * t) * e * e + (-6) * hs(seg(t, 0, 0.1f));
  p.bodyDy = -0.6f * hs(seg(t, 0.05f, 0.3f));
  return p;
}
inline P shiver(float t) {
  using namespace m;
  P p;
  const float j = sinf(kT2 * 9 * t) * (1 - 0.4f * t);
  p.bodyDx = 2.2f * j;
  p.bodyRot = 0.8f * j;
  p.armL = 5 * j;
  p.armR = -5 * j;
  p.button = 9 * sinf(kT2 * 9 * (t - 0.05f));
  p.eyes = Eyes::kWide;
  p.lookX = 1.5f * j;
  return p;
}
inline P droop(float t) {
  using namespace m;
  P p;
  const float d = ease(seg(t, 0, 0.75f));
  p.bodySy = 1 - 0.06f * d;
  p.bodySx = 1 + 0.02f * d;
  p.bodyDy = 5 * d;
  p.bodyRot = -3 * d;
  p.armL = 14 * lagEase(d, 0.1f);
  p.armR = -14 * lagEase(d, 0.1f);
  p.button = -26 * lagEase(d, 0.2f);
  p.visorDy = 3 * d;
  p.eyes = Eyes::kHalf;
  p.lookY = 3 * d;
  return p;
}
inline P giggle(float t) {
  using namespace m;
  P p;
  const float k = seg(t, 0, 0.85f), dec = 1 - k;
  p.bodyRot = 3.2f * sinf(kT2 * 3 * k) * dec;
  p.bodyDy = -4 * fabsf(sinf(kPi * 3 * k)) * dec;
  p.bodySy = 1 + 0.03f * sinf(kPi * 6 * k) * dec;
  p.armL = 8 * sinf(kT2 * 3 * (k - 0.08f)) * dec;
  p.armR = -8 * sinf(kT2 * 3 * (k - 0.08f)) * dec;
  p.button = 12 * sinf(kT2 * 3 * (k - 0.15f)) * dec;
  p.eyes = Eyes::kSquint;
  p.blush = 0.6f * (1 - seg(t, 0.7f, 1));
  return p;
}
inline P wiggle(float t) {
  using namespace m;
  P p;
  const float s = sinf(kT2 * 2.5f * seg(t, 0.05f, 0.9f)), env = powf(hs(seg(t, 0.05f, 0.9f)), 0.6f);
  p.bodyDx = 4 * s * env;
  p.bodyRot = 3 * s * env;
  p.bodyDy = -1.5f * fabsf(s) * env;
  p.footL = -3 * fmaxf(0.0f, s) * env;
  p.footR = -3 * fmaxf(0.0f, -s) * env;
  p.armL = 10 * s * env;
  p.armR = 10 * s * env;
  p.button = -14 * sinf(kT2 * 2.5f * (seg(t, 0.05f, 0.9f) - 0.1f)) * env;
  p.eyes = Eyes::kSquint;
  p.blush = 0.4f * env;
  return p;
}
inline P yawn(float t) {
  using namespace m;
  P p;
  const float swy = 2 * sinf(kT2 * t), y = sinf(kPi * ease(seg(t, 0.3f, 0.75f)));
  const float sq = fminf(1.0f, 1 - 0.88f * ease(seg(t, 0.25f, 0.45f)) + 0.88f * ease(seg(t, 0.8f, 1)));
  p.bodyRot = swy - 1.5f * seg(t, 0.75f, 1);
  p.bodySy = 1 + 0.035f * y;
  p.bodySx = 1 - 0.015f * y;
  p.bodyDy = -2 * y + 2 * seg(t, 0.85f, 1);
  p.armL = -14 * y;
  p.armR = 14 * y;
  p.button = -8 * lagHs(seg(t, 0.3f, 0.75f), 0.1f) + 3 * sinf(kT2 * t);
  p.eyes = Eyes::kHalf;
  p.squish = fmaxf(0.12f, sq);
  p.lookY = 2;
  return p;
}
inline P tilt(float t) {
  using namespace m;
  P p;
  const float e = sp(seg(t, 0.05f, 0.5f), 2.0f, 6.5f);
  p.headRot = -7.5f * e;
  p.headDx = -2 * e;
  p.bodyDy = -1.5f * hs(seg(t, 0.05f, 0.4f));
  p.visorRot = -1 * e;
  p.button = 7 * (1 - sp(fmaxf(0.0f, seg(t, 0.05f, 0.5f) - 0.12f), 2.0f, 6.5f));
  p.lookX = -5 * e;
  p.lookY = -4 * e;
  p.armR = -3 * e;
  p.eyes = Eyes::kWide;
  p.squish = blinkF(t, 0.78f);
  return p;
}
inline P shy(float t) {
  using namespace m;
  P p;
  const float e = ease(seg(t, 0.05f, 0.4f));
  p.bodyRot = 3 * e;
  p.bodyDy = 1.5f * e;
  p.bodySx = 1 - 0.015f * e;
  p.visorDx = -3 * e;
  p.lookX = -9 * e;
  p.lookY = 4 * e;
  p.blush = e * (1 - seg(t, 0.85f, 1));
  p.armL = -4 * e + 4 * sinf(kT2 * 2 * seg(t, 0.4f, 0.9f)) * e;
  p.armR = 2 * e;
  p.button = -5 * lagEase(e, 0.15f);
  p.eyes = Eyes::kOpen;
  p.squish = blinkF(t, 0.55f, 0.2f);
  return p;
}
inline P press(float t) {
  using namespace m;
  P p;
  const float lean = ease(seg(t, 0, 0.3f)) * (1 - ease(seg(t, 0.72f, 1))), rel = sp(seg(t, 0.72f, 1), 2.4f, 6.0f) - 1;
  p.bodySy = 1 - 0.07f * lean - 0.04f * rel;
  p.bodySx = 1 + 0.045f * lean + 0.02f * rel;
  p.bodyRot = -3 * lean;
  p.bodyDy = 3 * lean;
  p.button = -10 * lean + 10 * rel;
  p.armL = 6 * lean;
  p.armR = -6 * lean;
  p.eyes = lean > 0.3f ? Eyes::kSquint : Eyes::kOpen;
  p.blush = 0.5f * lean;
  return p;
}
inline P hum(float t) {
  using namespace m;
  P p;
  p.bodyRot = 2 * sinf(kT2 * 1.5f * t);
  p.bodyDy = -1.5f * fabsf(sinf(kT2 * 1.5f * t));
  p.button = 7 * sinf(kT2 * (1.5f * t - 0.15f));
  p.eyes = Eyes::kSquint;
  p.armL = 4 * sinf(kT2 * 1.5f * t);
  p.armR = -4 * sinf(kT2 * 1.5f * t);
  return p;
}
inline P stretch(float t) {
  using namespace m;
  P p;
  const float y = sinf(kPi * ease(seg(t, 0.1f, 0.85f)));
  p.bodySy = 1 + 0.05f * y;
  p.bodySx = 1 - 0.025f * y;
  p.bodyDy = -3 * y;
  p.armL = -26 * y;
  p.armR = 26 * y;
  p.footL = p.footR = -2 * y;
  p.button = -6 * lagHs(seg(t, 0.1f, 0.85f), 0.1f);
  p.eyes = y > 0.5f ? Eyes::kClosed : Eyes::kNone;
  p.squish = blinkF(t, 0.08f, 0.1f);
  return p;
}
inline P delight(float t) {
  using namespace m;
  P p;
  const float j = sinf(kPi * seg(t, 0.1f, 0.55f));
  p.bodyDy = -14 * j;
  p.bodySy = 1 + 0.05f * j;
  p.bodySx = 1 - 0.03f * j;
  p.footL = p.footR = -14 * j;
  p.armL = -30 * j;
  p.armR = 30 * j;
  p.eyes = Eyes::kSparkle;
  p.button = 14 * sinf(kT2 * (t - 0.1f) * 2);
  p.blush = 0.3f;
  return p;
}
inline P backflip(float t) {
  using namespace m;
  P p;
  const float crouch = ease(seg(t, 0, 0.18f)) * (1 - seg(t, 0.18f, 0.24f)), air = sinf(kPi * seg(t, 0.24f, 0.74f)), k = ease(seg(t, 0.27f, 0.72f));
  const float land = t < 0.84f ? sinf(kPi * seg(t, 0.74f, 0.84f)) : 0, settle = t >= 0.84f ? 1 - sp(seg(t, 0.84f, 1), 2.2f, 5.0f) : 0;
  const float tuck = sinf(kPi * seg(t, 0.27f, 0.72f));
  p.bodySy = 1 - 0.15f * crouch + 0.10f * air * (1 - seg(t, 0.55f, 0.74f)) - 0.16f * land + 0.02f * settle;
  p.bodySx = 1 + 0.10f * crouch - 0.06f * air * (1 - seg(t, 0.55f, 0.74f)) + 0.12f * land;
  p.bodyDy = 10 * crouch - 72 * air + 5 * land;
  p.spin = -360 * k;
  p.bodyRot = -4 * settle * sinf(kT2 * 2.5f * seg(t, 0.84f, 1));
  p.armL = -30 * tuck + 20 * crouch;
  p.armR = 30 * tuck - 20 * crouch;
  p.button = 24 * tuck * cosf(kPi * seg(t, 0.27f, 0.72f)) - 10 * land + 12 * settle * sinf(kT2 * 3 * seg(t, 0.84f, 1));
  p.headRot = -4 * lagHs(seg(t, 0.27f, 0.72f), 0.12f) + 4 * settle * sinf(kT2 * 2.5f * seg(t, 0.84f, 1));
  p.eyes = t > 0.3f && t < 0.7f ? Eyes::kSquint : (t >= 0.8f ? Eyes::kSparkle : Eyes::kNone);
  p.blush = 0.4f * seg(t, 0.75f, 0.9f) * (1 - seg(t, 0.95f, 1));
  return p;
}
inline P bellySpeak(float t) {
  using namespace m;
  P p;
  const float lvl = clamp(0.5f + 0.3f * sinf(kT2 * 5 * t) + 0.2f * sinf(kT2 * 8.3f * t + 1), 0, 1);
  p.bellySy = 1 + 0.035f * lvl;
  p.bellySx = 1 + 0.02f * lvl;
  p.bodyDy = -0.8f * lvl;
  p.headRot = 1.2f * sinf(kT2 * 2 * t);
  p.headDy = -0.8f * lvl;
  p.button = 5 * sinf(kT2 * (5 * t - 0.1f));
  p.eyes = Eyes::kSquint;
  return p;
}

using Fn = P (*)(float);

}  // namespace demo
}  // namespace bob
