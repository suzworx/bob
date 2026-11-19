// Bob's visor, derived from the art itself (pure, host-tested). The visor is the dark region of each pose image:
// where it is partly covered by a raised hand, the mask follows what is actually visible. Clearing the original
// eyes fills exactly the mask, and every procedural eye is clipped to it, so a face can never paint over an arm or
// the shell, whatever the gaze or expression. The face is drawn into the pose sprite (pose space) before any
// rotation or scale, so the eyes tilt with the head. bob_face.cpp does the drawing; this file owns the geometry.
#pragma once

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace bob {
namespace visor {

constexpr int kArt = 192;  // the pose images are 192 x 192, big-endian RGB565
constexpr int kMaxW = 72, kMaxH = 40, kRowBytes = (kMaxW + 7) / 8;

// Per pose: the visor centre between the eyes (art px), its tilt (degrees), and the art region searched for the visor.
// GENERATED from the art by scripts/bob_art_build.py (with --check), so new art can never leave the eyes outside the
// visor; test_bob_visor.cpp checks the eye positions against the art-derived mask.
struct Pose {
  float cx, cy, deg;
  int16_t rx, ry, rw, rh;
};
#include "bob_visor_poses.h"
constexpr float kEyeX = 18.0f;  // each eye's distance from the visor centre along its axis

// One pixel of a big-endian RGB565 pose image.
inline uint16_t pixelBE(const uint8_t* art, int x, int y) {
  const size_t i = 2u * (static_cast<size_t>(y) * kArt + x);
  return static_cast<uint16_t>((art[i] << 8) | art[i + 1]);
}

// Dark visor body, or the amber of an eye: both belong to the visor. The ivory shell, the hand and the anti-aliased
// rim do not, so the rim keeps the art's soft edge.
inline bool isVisorPixel(uint16_t v) {
  const int r = ((v >> 11) & 31) * 255 / 31, g = ((v >> 5) & 63) * 255 / 63, b = (v & 31) * 255 / 31;
  const int lum = (r * 30 + g * 59 + b * 11) / 100;
  return lum < 100 || (r > 170 && g > 100 && r - b > 70);  // dark body, or the yellow of an eye (ivory has r - b < 50)
}

struct Mask {
  int16_t x = 0, y = 0, w = 0, h = 0;  // the art region the bits cover
  uint8_t bits[kMaxH][kRowBytes];
  int count = 0;
  Mask() { memset(bits, 0, sizeof(bits)); }
  bool has(int ax, int ay) const {
    const int u = ax - x, v = ay - y;
    return u >= 0 && v >= 0 && u < w && v < h && (bits[v][u >> 3] >> (u & 7) & 1) != 0;
  }
  void set(int ax, int ay) {
    const int u = ax - x, v = ay - y;
    if (u < 0 || v < 0 || u >= w || v >= h || has(ax, ay)) return;
    bits[v][u >> 3] = static_cast<uint8_t>(bits[v][u >> 3] | (1 << (u & 7)));
    ++count;
  }
};

// The connected visor region of pose image `art`, flood-filled from the visor centre inside the pose's search region,
// with enclosed holes (the art's own eyes) filled in.
// Empty (count 0) when no visor pixel is found near the centre.
inline void buildMask(const uint8_t* art, const Pose& pose, Mask* out) {
  *out = Mask();
  out->x = pose.rx;
  out->y = pose.ry;
  out->w = pose.rw < kMaxW ? pose.rw : kMaxW;
  out->h = pose.rh < kMaxH ? pose.rh : kMaxH;
  int sx = static_cast<int>(lroundf(pose.cx)), sy = static_cast<int>(lroundf(pose.cy));
  bool found = false;
  for (int r = 0; r <= 8 && !found; ++r) {
    for (int dy = -r; dy <= r && !found; ++dy) {
      for (int dx = -r; dx <= r && !found; ++dx) {
        const int x = sx + dx, y = sy + dy;
        if (x >= out->x && y >= out->y && x < out->x + out->w && y < out->y + out->h && isVisorPixel(pixelBE(art, x, y))) {
          sx = x;
          sy = y;
          found = true;
        }
      }
    }
  }
  if (!found) return;
  static uint16_t stack[kMaxW * kMaxH];  // one thread builds masks (the loop task); the host test is single-threaded
  size_t top = 0;
  out->set(sx, sy);
  stack[top++] = static_cast<uint16_t>((sy - out->y) * kMaxW + (sx - out->x));
  while (top > 0) {
    const uint16_t cell = stack[--top];
    const int cx = out->x + cell % kMaxW, cy = out->y + cell / kMaxW;
    const int nx[4] = {cx + 1, cx - 1, cx, cx}, ny[4] = {cy, cy, cy + 1, cy - 1};
    for (int i = 0; i < 4; ++i) {
      if (nx[i] < out->x || ny[i] < out->y || nx[i] >= out->x + out->w || ny[i] >= out->y + out->h) continue;
      if (out->has(nx[i], ny[i]) || !isVisorPixel(pixelBE(art, nx[i], ny[i]))) continue;
      out->set(nx[i], ny[i]);
      stack[top++] = static_cast<uint16_t>((ny[i] - out->y) * kMaxW + (nx[i] - out->x));
    }
  }
  // Fill enclosed holes (the art's own eye pixels and glints): whatever the region's border cannot reach is visor.
  uint8_t outside[kMaxH][kRowBytes];
  memset(outside, 0, sizeof(outside));
  auto isOut = [&](int u, int v) { return (outside[v][u >> 3] >> (u & 7) & 1) != 0; };
  auto setOut = [&](int u, int v) { outside[v][u >> 3] = static_cast<uint8_t>(outside[v][u >> 3] | (1 << (u & 7))); };
  top = 0;
  auto seedOut = [&](int u, int v) {
    if (out->has(out->x + u, out->y + v) || isOut(u, v)) return;
    setOut(u, v);
    stack[top++] = static_cast<uint16_t>(v * kMaxW + u);
  };
  for (int u = 0; u < out->w; ++u) {
    seedOut(u, 0);
    seedOut(u, out->h - 1);
  }
  for (int v = 0; v < out->h; ++v) {
    seedOut(0, v);
    seedOut(out->w - 1, v);
  }
  while (top > 0) {
    const uint16_t cell = stack[--top];
    const int u = cell % kMaxW, v = cell / kMaxW;
    const int nu[4] = {u + 1, u - 1, u, u}, nv[4] = {v, v, v + 1, v - 1};
    for (int i = 0; i < 4; ++i) {
      if (nu[i] < 0 || nv[i] < 0 || nu[i] >= out->w || nv[i] >= out->h) continue;
      if (out->has(out->x + nu[i], out->y + nv[i]) || isOut(nu[i], nv[i])) continue;
      setOut(nu[i], nv[i]);
      stack[top++] = static_cast<uint16_t>(nv[i] * kMaxW + nu[i]);
    }
  }
  for (int v = 0; v < out->h; ++v) {
    for (int u = 0; u < out->w; ++u) {
      if (!out->has(out->x + u, out->y + v) && !isOut(u, v)) out->set(out->x + u, out->y + v);
    }
  }
}

// Calls f(x, y, runLength) for each horizontal run of mask pixels (art coordinates): fills and clears use these.
template <class F>
void forEachRun(const Mask& m, F f) {
  for (int v = 0; v < m.h; ++v) {
    int u = 0;
    while (u < m.w) {
      while (u < m.w && !m.has(m.x + u, m.y + v)) ++u;
      const int start = u;
      while (u < m.w && m.has(m.x + u, m.y + v)) ++u;
      if (u > start) f(m.x + start, m.y + v, u - start);
    }
  }
}

// The clip: every pixel of the mask's region that is NOT in the mask goes back to the art. Whatever was drawn there
// (an eye pushed past the visor by the gaze, a squashed shape) disappears; the shell, hand and rim are the art's.
inline void restoreOutside(uint8_t* dst, const uint8_t* art, const Mask& m) {
  for (int v = 0; v < m.h; ++v) {
    for (int u = 0; u < m.w; ++u) {
      if (m.has(m.x + u, m.y + v)) continue;
      const size_t i = 2u * (static_cast<size_t>(m.y + v) * kArt + (m.x + u));
      dst[i] = art[i];
      dst[i + 1] = art[i + 1];
    }
  }
}

// The same clip for a sprite that is not the plain art (the crossfade blends two poses): the region is saved before the face is
// drawn, and every pixel outside the mask goes back to what was there, so the blend stays intact around the visor.
constexpr size_t kSnapBytes = static_cast<size_t>(kMaxW) * kMaxH * 2;
inline void saveRegion(const uint8_t* img, const Mask& m, uint8_t* snap) {
  for (int v = 0; v < m.h; ++v) memcpy(snap + static_cast<size_t>(v) * m.w * 2, img + 2u * (static_cast<size_t>(m.y + v) * kArt + m.x), static_cast<size_t>(m.w) * 2);
}
inline void restoreOutsideFromSnap(uint8_t* dst, const uint8_t* snap, const Mask& m) {
  for (int v = 0; v < m.h; ++v) {
    for (int u = 0; u < m.w; ++u) {
      if (m.has(m.x + u, m.y + v)) continue;
      const size_t i = 2u * (static_cast<size_t>(m.y + v) * kArt + (m.x + u)), j = 2u * (static_cast<size_t>(v) * m.w + u);
      dst[i] = snap[j];
      dst[i + 1] = snap[j + 1];
    }
  }
}

// Visor-local (u along the visor, v down) to art coordinates for pose `p`.
inline void toArt(const Pose& p, float u, float v, float* x, float* y) {
  const float a = p.deg * 0.01745329f;
  *x = p.cx + u * cosf(a) - v * sinf(a);
  *y = p.cy + u * sinf(a) + v * cosf(a);
}

}  // namespace visor
}  // namespace bob
