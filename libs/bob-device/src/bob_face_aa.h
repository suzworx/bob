// Bob's rig eyes, anti-aliased, exactly as the approved demo draws them (docs/waveshare/golden/approved-demo.html
// eyeShape / drawEyes / lightDot): each eye is a small vector shape in eye units (u = kArtScale * 1.15 device px) at
// +-44 art px from the visor pivot, squished vertically by the blink, clipped to the visor glass polygon
// (bob_rig_data.h kVisorClip) and rasterised with 4x4 coverage into a blob (RGB565 LE then A8) of the visor part's
// size. A sub-pixel phase lets a resting visor be drawn on whole pixels without resampling the eyes.
// Pure C++11, no Arduino: host-testable. The renderer that maps BobEyes to these styles is bob_rig.cpp.
#pragma once

#include <math.h>
#include <stdint.h>
#include <string.h>

#include "bob_rig_data.h"
#include "bob_tokens.h"

namespace bob {
namespace face {

// The demo's eye styles, plus the device-only expressions drawn with the same primitives.
enum class EyeStyle : uint8_t { kOpen, kWide, kSparkle, kHalf, kClosed, kSquint, kHeart, kStar, kDash, kLook, kWorried, kX, kSpiral, kLaugh, kWavy };

constexpr float kUnit = rig::kArtScale * 1.15f;  // the demo's EU: eye units in device px
constexpr float kLook = rig::kArtScale * 1.6f;   // the demo's LK: gaze units in device px
constexpr float kSep = 44.0f * rig::kArtScale;   // each eye's distance from the visor pivot
constexpr float kGazeMax = 12.0f;                // the demo clamps the look to +-12 units

struct Eye {
  EyeStyle style = EyeStyle::kOpen;
  float du = 0, dv = 0;  // extra offset in eye units (look-left/right/up expressions)
  float scale = 1;       // size factor (the big/small pair)
};

struct Params {
  Eye left, right;
  float lookX = 0, lookY = 0;  // gaze in the demo's look units (clamped to +-kGazeMax)
  float squish = 1;            // vertical eye scale (the blink), 0.1 .. 1.2
  float tilt = 0;              // body + head rotation (deg): nudges the catch-light like the demo
  float pulse = 0;             // heart/star pulse phase in radians (0 = the demo's frozen size)
  float phaseX = 0, phaseY = 0;  // sub-pixel offset of the destination (0..1)
  float scale = 1;               // the visor drawn at this size (a small-Bob view): eyes are rasterised at it, not resampled
};

namespace detail {

struct Rgb {
  float r, g, b;
};
inline Rgb rgbOf(uint32_t c) { return Rgb{float((c >> 16) & 255), float((c >> 8) & 255), float(c & 255)}; }

enum class Kind : uint8_t { kDisc, kPoly, kStroke };
constexpr int kMaxPts = 32, kMaxPrims = 12;  // the busiest face (sparkle) is 5 primitives per eye; the heart 29 points

struct Prim {
  Kind kind;
  uint8_t eye;        // 0 left, 1 right
  Rgb col;
  float alpha;        // opacity (the worried brow is .85)
  float x, y, r;      // disc
  float w;            // stroke width
  bool roundCap;
  int n;
  float px[kMaxPts], py[kMaxPts];
  float x0, y0, x1, y1;  // bounds in eye space (unsquished)
};

struct List {
  Prim p[kMaxPrims];
  int n = 0;
  Prim* add(Kind k, uint8_t eye, uint32_t col, float alpha = 1) {
    if (n >= kMaxPrims) return nullptr;
    Prim& q = p[n++];
    q.kind = k;
    q.eye = eye;
    q.col = rgbOf(col);
    q.alpha = alpha;
    q.x = q.y = q.r = q.w = 0;
    q.roundCap = true;
    q.n = 0;
    return &q;
  }
  void disc(uint8_t eye, float x, float y, float r, uint32_t col) {
    Prim* q = add(Kind::kDisc, eye, col);
    if (!q) return;
    q->x = x;
    q->y = y;
    q->r = r;
    q->x0 = x - r; q->x1 = x + r; q->y0 = y - r; q->y1 = y + r;
  }
  Prim* poly(Kind k, uint8_t eye, uint32_t col, float w = 0, bool roundCap = true, float alpha = 1) {
    Prim* q = add(k, eye, col, alpha);
    if (q) { q->w = w; q->roundCap = roundCap; }
    return q;
  }
};

inline void pt(Prim* q, float x, float y) {
  if (q && q->n < kMaxPts) { q->px[q->n] = x; q->py[q->n] = y; q->n++; }
}
inline void finish(Prim* q) {
  if (!q || q->n == 0) return;
  const float m = q->kind == Kind::kStroke ? q->w / 2 : 0;
  q->x0 = q->x1 = q->px[0];
  q->y0 = q->y1 = q->py[0];
  for (int i = 1; i < q->n; i++) {
    q->x0 = fminf(q->x0, q->px[i]); q->x1 = fmaxf(q->x1, q->px[i]);
    q->y0 = fminf(q->y0, q->py[i]); q->y1 = fmaxf(q->y1, q->py[i]);
  }
  q->x0 -= m; q->x1 += m; q->y0 -= m; q->y1 += m;
}
// SVG elliptical arc between two points on a circle/ellipse centred (cx, cy), from angle a0 to a1 (radians, y down).
inline void arcPts(Prim* q, float cx, float cy, float rx, float ry, float a0, float a1, int steps) {
  for (int i = 0; i <= steps; i++) {
    const float a = a0 + (a1 - a0) * float(i) / float(steps);
    pt(q, cx + rx * cosf(a), cy + ry * sinf(a));
  }
}
inline void quadPts(Prim* q, float x0, float y0, float cx, float cy, float x1, float y1, int steps) {
  for (int i = 0; i <= steps; i++) {
    const float t = float(i) / float(steps), s = 1 - t;
    pt(q, s * s * x0 + 2 * s * t * cx + t * t * x1, s * s * y0 + 2 * s * t * cy + t * t * y1);
  }
}
inline void cubicPts(Prim* q, float x0, float y0, float ax, float ay, float bx, float by, float x1, float y1, int steps, bool first) {
  for (int i = first ? 0 : 1; i <= steps; i++) {
    const float t = float(i) / float(steps), s = 1 - t;
    pt(q, s * s * s * x0 + 3 * s * s * t * ax + 3 * s * t * t * bx + t * t * t * x1, s * s * s * y0 + 3 * s * s * t * ay + 3 * s * t * t * by + t * t * t * y1);
  }
}

// lightDot(R, lx, ly, tilt, cy): the demo's catch-light.
inline void lightDot(List& L, uint8_t e, float R, float lx, float ly, float tilt, float cyk = -0.38f) {
  L.disc(e, -0.34f * R - 0.28f * lx + 0.05f * tilt, cyk * R - 0.28f * ly, fmaxf(0.9f, 0.27f * R), bobtok::kPaper);
}

inline void eyeShape(List& L, uint8_t e, const Eye& eye, int sgn, float lx, float ly, float tilt, float pulse) {
  const float u = kUnit * eye.scale;
  const uint32_t A = bobtok::kYellow, LIGHT = bobtok::kPaper;
  switch (eye.style) {
    case EyeStyle::kWide: {
      const float R = 17 * u;
      L.disc(e, 0, 0, R, A); lightDot(L, e, R, lx, ly, tilt); L.disc(e, 0.4f * R, 0.4f * R, 0.12f * R, LIGHT);
      break;
    }
    case EyeStyle::kSparkle: {
      const float R = 16 * u, k = R * 1.25f;
      L.disc(e, 0, 0, R, A); lightDot(L, e, R, lx, ly, tilt); L.disc(e, 0.4f * R, 0.4f * R, 0.12f * R, LIGHT);
      Prim* a = L.poly(Kind::kStroke, e, LIGHT, 1.1f); pt(a, k, -k - 2.4f); pt(a, k, -k + 2.4f); finish(a);
      Prim* b = L.poly(Kind::kStroke, e, LIGHT, 1.1f); pt(b, k - 2.4f, -k); pt(b, k + 2.4f, -k); finish(b);
      break;
    }
    case EyeStyle::kHalf: {
      // M-R -1 A R .95R 0 0 0 R -1 Z: the lower half of an ellipse centred (0, -1)
      const float R = 14 * u;
      Prim* q = L.poly(Kind::kPoly, e, A); arcPts(q, 0, -1, R, 0.95f * R, 3.14159265f, 0, 24); finish(q);
      L.disc(e, -0.32f * R, 0.28f * R, 0.25f * R, LIGHT);
      break;
    }
    case EyeStyle::kClosed: {
      Prim* q = L.poly(Kind::kStroke, e, A, 5 * u); quadPts(q, -13 * u, -1 * u, 0, 8 * u, 13 * u, -1 * u, 16); finish(q);
      break;
    }
    case EyeStyle::kSquint: {
      // M-13.2u 2.2u A 14u 14u 0 0 1 13.2u 2.2u: the short arc over the top of a 14u circle
      const float r = 14 * u, hx = 13.2f * u, cy = 2.2f * u + sqrtf(r * r - hx * hx), a = atan2f(2.2f * u - cy, hx);
      Prim* q = L.poly(Kind::kStroke, e, A, 6 * u); arcPts(q, 0, cy, r, r, 3.14159265f - a, 2 * 3.14159265f + a, 20); finish(q);
      break;
    }
    case EyeStyle::kHeart: {
      // transform scale(k) translate(-17 -16), the demo's heart path in coral
      const float k = 0.5f * (1 + 0.09f * sinf(pulse));
      Prim* q = L.poly(Kind::kPoly, e, bobtok::kCoral);
#define OLX_H(x, y) (k * ((x) - 17)), (k * ((y) - 16))
      cubicPts(q, OLX_H(17, 28), OLX_H(2, 17), OLX_H(5, 5), OLX_H(13, 5), 10, true);
      cubicPts(q, OLX_H(13, 5), OLX_H(15, 5), OLX_H(17, 7), OLX_H(17, 9), 4, false);
      cubicPts(q, OLX_H(17, 9), OLX_H(17, 7), OLX_H(19, 5), OLX_H(21, 5), 4, false);
      cubicPts(q, OLX_H(21, 5), OLX_H(29, 5), OLX_H(32, 17), OLX_H(17, 28), 10, false);
#undef OLX_H
      finish(q);
      break;
    }
    case EyeStyle::kStar: {
      const float k = 0.5f * (1 + 0.1f * sinf(pulse));
      static const float s[10][2] = {{17, 2}, {21, 12}, {32, 12}, {23, 19}, {27, 30}, {17, 23}, {7, 30}, {11, 19}, {2, 12}, {13, 12}};
      Prim* q = L.poly(Kind::kPoly, e, A);
      for (int i = 0; i < 10; i++) pt(q, k * (s[i][0] - 17), k * (s[i][1] - 16));
      finish(q);
      break;
    }
    case EyeStyle::kDash: {
      Prim* q = L.poly(Kind::kStroke, e, A, 6 * u, false); pt(q, -12 * u, 0); pt(q, 12 * u, 0); finish(q);
      break;
    }
    case EyeStyle::kLook: {
      const float R = 15 * u;
      L.disc(e, 0, 0, R, A); lightDot(L, e, R, lx, ly, tilt); L.disc(e, 4 * u + lx * 0.6f, -4 * u + ly * 0.6f, 4 * u, bobtok::kVisor);
      break;
    }
    case EyeStyle::kWorried: {
      const float R = 15 * u;
      L.disc(e, 0, 0, R, A); lightDot(L, e, R, lx, ly, tilt);
      Prim* q = L.poly(Kind::kStroke, e, A, 1.3f, true, 0.85f);
      quadPts(q, sgn * R, -R * 1.12f, sgn * R * 0.15f, -R * 1.3f, -sgn * R * 0.9f, -R * 1.62f, 12); finish(q);
      break;
    }
    case EyeStyle::kX: {
      const float h = 9 * u;
      Prim* a = L.poly(Kind::kStroke, e, A, 4.5f * u); pt(a, -h, -h); pt(a, h, h); finish(a);
      Prim* b = L.poly(Kind::kStroke, e, A, 4.5f * u); pt(b, -h, h); pt(b, h, -h); finish(b);
      break;
    }
    case EyeStyle::kSpiral: {
      Prim* q = L.poly(Kind::kStroke, e, A, 3 * u);
      for (int i = 0; i <= 30; i++) {
        const float r = (2 + 11.0f * i / 30) * u, a = i * 0.5f * sgn;
        pt(q, r * cosf(a), r * sinf(a));
      }
      finish(q);
      break;
    }
    case EyeStyle::kLaugh: {
      Prim* q = L.poly(Kind::kStroke, e, A, 4.5f * u); pt(q, sgn * 8 * u, -8 * u); pt(q, -sgn * 6 * u, 0); pt(q, sgn * 8 * u, 8 * u); finish(q);
      break;
    }
    case EyeStyle::kWavy: {
      Prim* q = L.poly(Kind::kStroke, e, A, 3 * u);
      for (int i = 0; i <= 24; i++) pt(q, (-12 + i) * u, 4.5f * u * sinf(i * 0.52f));
      finish(q);
      break;
    }
    case EyeStyle::kOpen:
    default: {
      const float R = 13 * u;
      L.disc(e, 0, 0, R, A); lightDot(L, e, R, lx, ly, tilt);
      break;
    }
  }
}

inline bool inPoly(const float* xs, const float* ys, int n, float x, float y) {
  bool in = false;
  for (int i = 0, j = n - 1; i < n; j = i++) {
    if (((ys[i] > y) != (ys[j] > y)) && (x < (xs[j] - xs[i]) * (y - ys[i]) / (ys[j] - ys[i]) + xs[i])) in = !in;
  }
  return in;
}
inline bool inClip(float x, float y) {
  bool in = false;
  for (int i = 0, j = rig::kVisorClipN - 1; i < rig::kVisorClipN; j = i++) {
    const rig::ClipPt& a = rig::kVisorClip[i];
    const rig::ClipPt& b = rig::kVisorClip[j];
    if (((a.y > y) != (b.y > y)) && (x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x)) in = !in;
  }
  return in;
}
inline float segDist2(float px, float py, float ax, float ay, float bx, float by, bool clampEnds) {
  const float dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  float t = l2 > 1e-9f ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  if (clampEnds) t = t < 0 ? 0 : (t > 1 ? 1 : t);
  else if (t < 0 || t > 1) return 1e9f;
  const float ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}
inline bool hit(const Prim& q, float x, float y) {
  if (x < q.x0 || x > q.x1 || y < q.y0 || y > q.y1) return false;
  switch (q.kind) {
    case Kind::kDisc: return (x - q.x) * (x - q.x) + (y - q.y) * (y - q.y) <= q.r * q.r;
    case Kind::kPoly: return inPoly(q.px, q.py, q.n, x, y);
    case Kind::kStroke: {
      // round joints; a butt-capped stroke (the dash) is a single segment, so its projection must fall inside it
      const float h2 = q.w * q.w / 4;
      const bool clampEnds = q.roundCap || q.n > 2;
      for (int i = 0; i + 1 < q.n; i++) {
        if (segDist2(x, y, q.px[i], q.py[i], q.px[i + 1], q.py[i + 1], clampEnds) <= h2) return true;
      }
      return false;
    }
  }
  return false;
}

}  // namespace detail

// The face into `blob` (w * h, RGB565 little endian then A8), visor-part px with the eyes centred on (cx, cy).
inline void render(uint8_t* blob, int w, int h, float cx, float cy, const Params& p) {
  using namespace detail;
  static List L;  // one face at a time (the loop task); host tests are single threaded
  L.n = 0;
  const float lx = fmaxf(-kGazeMax, fminf(kGazeMax, p.lookX)) * kLook, ly = fmaxf(-kGazeMax, fminf(kGazeMax, p.lookY)) * kLook;
  const float sq = fmaxf(0.1f, fminf(1.2f, p.squish));
  float ex[2], ey[2];
  for (int k = 0; k < 2; k++) {
    const Eye& eye = k == 0 ? p.left : p.right;
    const int sgn = k == 0 ? -1 : 1;
    const float shift = eye.style == EyeStyle::kWorried ? -1.2f : 0.0f;
    ex[k] = cx + sgn * kSep + lx + eye.du * kUnit;
    ey[k] = cy + ly + shift + eye.dv * kUnit;
    eyeShape(L, static_cast<uint8_t>(k), eye, sgn, lx, ly, p.tilt, p.pulse);
  }
  memset(blob, 0, static_cast<size_t>(w) * h * 3);
  uint8_t* alpha = blob + static_cast<size_t>(w) * h * 2;
  // pixel bounds of everything drawn (screen space), so the 16 samples run only near the eyes
  float bx0 = 1e9f, by0 = 1e9f, bx1 = -1e9f, by1 = -1e9f;
  for (int i = 0; i < L.n; i++) {
    const Prim& q = L.p[i];
    bx0 = fminf(bx0, ex[q.eye] + q.x0); bx1 = fmaxf(bx1, ex[q.eye] + q.x1);
    by0 = fminf(by0, ey[q.eye] + q.y0 * sq); by1 = fmaxf(by1, ey[q.eye] + q.y1 * sq);
  }
  const int x0 = static_cast<int>(fmaxf(0.0f, floorf(bx0 * p.scale + p.phaseX) - 1)), x1 = static_cast<int>(fminf(float(w), ceilf(bx1 * p.scale + p.phaseX) + 1));
  const int y0 = static_cast<int>(fmaxf(0.0f, floorf(by0 * p.scale + p.phaseY) - 1)), y1 = static_cast<int>(fminf(float(h), ceilf(by1 * p.scale + p.phaseY) + 1));
  constexpr int kSs = 4;
  for (int py = y0; py < y1; py++) {
    for (int px = x0; px < x1; px++) {
      float r = 0, g = 0, b = 0, cov = 0;
      for (int sy = 0; sy < kSs; sy++) {
        for (int sx = 0; sx < kSs; sx++) {
          const float X = (px + (sx + 0.5f) / kSs - p.phaseX) / p.scale, Y = (py + (sy + 0.5f) / kSs - p.phaseY) / p.scale;
          if (!inClip(X, Y)) continue;
          // top-most primitive first; a translucent one (the brow) blends over what is under it
          Rgb c{0, 0, 0};
          float a = 0;
          for (int i = L.n - 1; i >= 0 && a < 0.999f; i--) {
            const Prim& q = L.p[i];
            if (!hit(q, X - ex[q.eye], (Y - ey[q.eye]) / sq)) continue;
            const float wgt = q.alpha * (1 - a);
            c.r += q.col.r * wgt; c.g += q.col.g * wgt; c.b += q.col.b * wgt;
            a += wgt;
          }
          r += c.r; g += c.g; b += c.b; cov += a;
        }
      }
      if (cov <= 0) continue;
      const float n = float(kSs * kSs);
      const uint32_t R = static_cast<uint32_t>(r / cov), G = static_cast<uint32_t>(g / cov), B = static_cast<uint32_t>(b / cov);
      const uint16_t v = static_cast<uint16_t>(((R >> 3) << 11) | ((G >> 2) << 5) | (B >> 3));
      const size_t i = static_cast<size_t>(py) * w + px;
      memcpy(blob + i * 2, &v, 2);
      alpha[i] = static_cast<uint8_t>(fminf(255.0f, cov / n * 255.0f + 0.5f));
    }
  }
}

}  // namespace face
}  // namespace bob
