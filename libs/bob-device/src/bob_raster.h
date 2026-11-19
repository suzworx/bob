// A tiny software sprite rasteriser for the Bob rig: affine transform, nearest sampling, 8-bit alpha, straight
// into a big-endian RGB565 buffer (the round UI framebuffer). Pure C++, no Arduino: host-tested.
//
// Source blobs are what scripts/bob_rig_build.py --device-blobs writes: w*h RGB565 (little endian) then w*h A8.
// The affine maps source pixel coordinates to destination coordinates; sampling is inverse-mapped at pixel
// centres, so a part rotated about its pivot keeps the pivot pixel put.
#pragma once

#include <math.h>
#include <stdint.h>
#include <string.h>

namespace bob {
namespace raster {

// x' = a*x + c*y + tx, y' = b*x + d*y + ty
struct Affine {
  float a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0;
  void apply(float x, float y, float* ox, float* oy) const {
    *ox = a * x + c * y + tx;
    *oy = b * x + d * y + ty;
  }
  bool identityLinear() const { return fabsf(a - 1) < 1e-4f && fabsf(b) < 1e-4f && fabsf(c) < 1e-4f && fabsf(d - 1) < 1e-4f; }
  bool nearIdentityLinear() const { return fabsf(a - 1) < 3e-3f && fabsf(b) < 3e-3f && fabsf(c) < 3e-3f && fabsf(d - 1) < 3e-3f; }
};

// outer * inner: apply `inner` first, then `outer`.
inline Affine operator*(const Affine& o, const Affine& i) {
  Affine r;
  r.a = o.a * i.a + o.c * i.b;
  r.b = o.b * i.a + o.d * i.b;
  r.c = o.a * i.c + o.c * i.d;
  r.d = o.b * i.c + o.d * i.d;
  r.tx = o.a * i.tx + o.c * i.ty + o.tx;
  r.ty = o.b * i.tx + o.d * i.ty + o.ty;
  return r;
}

inline Affine translate(float x, float y) {
  Affine r;
  r.tx = x;
  r.ty = y;
  return r;
}

inline Affine scale(float sx, float sy) {
  Affine r;
  r.a = sx;
  r.d = sy;
  return r;
}

// Clockwise rotation by `deg` on a y-down screen.
inline Affine rotate(float deg) {
  const float t = deg * 0.017453292f, c = cosf(t), s = sinf(t);
  Affine r;
  r.a = c;
  r.b = s;
  r.c = -s;
  r.d = c;
  return r;
}

inline Affine rotateAbout(float deg, float px, float py) { return translate(px, py) * rotate(deg) * translate(-px, -py); }
inline Affine scaleAbout(float sx, float sy, float px, float py) { return translate(px, py) * scale(sx, sy) * translate(-px, -py); }

struct Clip {
  int x0, y0, x1, y1;  // [x0, x1) x [y0, y1)
};

inline uint16_t bswap(uint16_t v) { return static_cast<uint16_t>((v >> 8) | (v << 8)); }

// Blends RGB565 `s` over `d` (both native order) with alpha a5 in 0..31.
inline uint16_t blend565(uint16_t d, uint16_t s, uint32_t a5) {
  uint32_t dd = d, ss = s;
  dd = (dd | (dd << 16)) & 0x07E0F81Fu;
  ss = (ss | (ss << 16)) & 0x07E0F81Fu;
  const uint32_t r = (dd + (((ss - dd) * a5) >> 5)) & 0x07E0F81Fu;
  return static_cast<uint16_t>(r | (r >> 16));
}

// Destination: a big-endian RGB565 surface; (0,0) of the transform is surface pixel (0,0).
struct FrameSink {
  uint8_t* base;
  int stride;  // bytes per row
  void put(int x, int y, uint16_t s, uint32_t a) {
    uint16_t* p = reinterpret_cast<uint16_t*>(base + static_cast<size_t>(y) * stride) + x;
    if (a >= 248) {
      *p = bswap(s);
    } else {
      *p = bswap(blend565(bswap(*p), s, a >> 3));
    }
  }
};

// Destination: a blob-format buffer (RGB565 LE then A8) of w*h, for caching a transformed part.
struct BlobSink {
  uint8_t* base;
  int w, h;
  void put(int x, int y, uint16_t s, uint32_t a) {
    memcpy(base + (static_cast<size_t>(y) * w + x) * 2, &s, 2);
    base[static_cast<size_t>(w) * h * 2 + static_cast<size_t>(y) * w + x] = static_cast<uint8_t>(a);
  }
};

// Destination: a blob-format buffer (RGB565 LE then A8) that COMPOSITES: a later layer is blended over what is there
// (straight alpha), so several parts can be baked into one transparent sprite. Opaque writes overwrite.
struct BlobOverSink {
  uint8_t* base;
  int w, h;
  void put(int x, int y, uint16_t s, uint32_t a) {
    uint16_t* cp = reinterpret_cast<uint16_t*>(base) + static_cast<size_t>(y) * w + x;
    uint8_t* ap = base + static_cast<size_t>(w) * h * 2 + static_cast<size_t>(y) * w + x;
    const uint32_t da = *ap;
    if (a >= 248 || da == 0) {
      *cp = s;
      *ap = static_cast<uint8_t>(a >= 248 ? 255 : a);
      return;
    }
    const uint16_t d = *cp;
    const uint32_t oa = a + (da * (255 - a) + 127) / 255;  // 1..255
    const uint32_t wd = da * (255 - a);                    // weight of the old colour, scaled by 255
    const uint32_t ws = a * 255;                           // weight of the new colour, scaled by 255
    const uint32_t tot = oa * 255;
    const uint32_t r = (((s >> 11) & 31) * ws + ((d >> 11) & 31) * wd + tot / 2) / tot;
    const uint32_t g = (((s >> 5) & 63) * ws + ((d >> 5) & 63) * wd + tot / 2) / tot;
    const uint32_t b = ((s & 31) * ws + (d & 31) * wd + tot / 2) / tot;
    *cp = static_cast<uint16_t>(((r > 31 ? 31 : r) << 11) | ((g > 63 ? 63 : g) << 5) | (b > 31 ? 31 : b));
    *ap = static_cast<uint8_t>(oa);
  }
};

// Bounding box of the transformed w*h source, intersected with the clip. False when empty.
inline bool transformedBounds(const Affine& m, int w, int h, const Clip& clip, Clip* out) {
  float xs[4], ys[4];
  m.apply(0, 0, &xs[0], &ys[0]);
  m.apply(static_cast<float>(w), 0, &xs[1], &ys[1]);
  m.apply(0, static_cast<float>(h), &xs[2], &ys[2]);
  m.apply(static_cast<float>(w), static_cast<float>(h), &xs[3], &ys[3]);
  float x0 = xs[0], x1 = xs[0], y0 = ys[0], y1 = ys[0];
  for (int i = 1; i < 4; i++) {
    x0 = xs[i] < x0 ? xs[i] : x0;
    x1 = xs[i] > x1 ? xs[i] : x1;
    y0 = ys[i] < y0 ? ys[i] : y0;
    y1 = ys[i] > y1 ? ys[i] : y1;
  }
  Clip c{static_cast<int>(floorf(x0)), static_cast<int>(floorf(y0)), static_cast<int>(ceilf(x1)) + 1, static_cast<int>(ceilf(y1)) + 1};
  if (c.x0 < clip.x0) c.x0 = clip.x0;
  if (c.y0 < clip.y0) c.y0 = clip.y0;
  if (c.x1 > clip.x1) c.x1 = clip.x1;
  if (c.y1 > clip.y1) c.y1 = clip.y1;
  *out = c;
  return c.x0 < c.x1 && c.y0 < c.y1;
}

// Draws a blob transformed by `m` into `sink`. `gain` (0..255) scales the blob's alpha (cross-fades).
// Nearest sampling, 8-bit alpha, the cheap path: used for big parts while they are moving (motion hides the stair-steps;
// the settled frame is drawn bilinear). About 5x faster than drawBlob's bilinear path.
template <class Sink>
inline void drawBlobNearest(Sink& sink, const Clip& clip, const uint8_t* blob, int w, int h, const Affine& m, uint32_t gain = 255) {
  Clip box;
  if (!transformedBounds(m, w, h, clip, &box)) return;
  const uint8_t* alpha = blob + static_cast<size_t>(w) * h * 2;
  const float det = m.a * m.d - m.b * m.c;
  if (fabsf(det) < 1e-6f) return;
  const float ia = m.d / det, ib = -m.b / det, ic = -m.c / det, id = m.a / det;
  const int32_t dudx = static_cast<int32_t>(ia * 65536.0f), dvdx = static_cast<int32_t>(ib * 65536.0f);
  const int32_t maxU = w << 16, maxV = h << 16;
  for (int y = box.y0; y < box.y1; y++) {
    const float px = static_cast<float>(box.x0) + 0.5f - m.tx, py = static_cast<float>(y) + 0.5f - m.ty;
    int32_t u = static_cast<int32_t>((ia * px + ic * py) * 65536.0f);
    int32_t v = static_cast<int32_t>((ib * px + id * py) * 65536.0f);
    for (int x = box.x0; x < box.x1; x++, u += dudx, v += dvdx) {
      if (u < 0 || v < 0 || u >= maxU || v >= maxV) continue;
      const size_t i = static_cast<size_t>(v >> 16) * w + (u >> 16);
      uint32_t a = alpha[i];
      if (a == 0) continue;
      if (gain != 255) a = (a * gain) >> 8;
      if (a == 0) continue;
      uint16_t s;
      memcpy(&s, blob + i * 2, 2);
      sink.put(x, y, s, a);
    }
  }
}

template <class Sink>
inline void drawBlob(Sink& sink, const Clip& clip, const uint8_t* blob, int w, int h, const Affine& m, uint32_t gain = 255, bool smooth = true) {
  if (!smooth) return drawBlobNearest(sink, clip, blob, w, h, m, gain);
  Clip box;
  if (!transformedBounds(m, w, h, clip, &box)) return;
  const uint8_t* alpha = blob + static_cast<size_t>(w) * h * 2;
  if (m.nearIdentityLinear() && fabsf(m.tx - roundf(m.tx)) < 0.06f && fabsf(m.ty - roundf(m.ty)) < 0.06f) {
    // A part at rest or nudged (under 0.003 of rotation or scale): snap the offset to whole pixels, no per-pixel maths.
    const int ox = static_cast<int>(roundf(m.tx)), oy = static_cast<int>(roundf(m.ty));
    for (int y = box.y0; y < box.y1; y++) {
      const int sy = y - oy;
      if (sy < 0 || sy >= h) continue;
      const uint8_t* arow = alpha + static_cast<size_t>(sy) * w;
      const uint8_t* crow = blob + static_cast<size_t>(sy) * w * 2;
      for (int x = box.x0; x < box.x1; x++) {
        const int sx = x - ox;
        if (sx < 0 || sx >= w) continue;
        uint32_t a = arow[sx];
        if (a == 0) continue;
        if (gain != 255) a = (a * gain) >> 8;
        if (a == 0) continue;
        uint16_t s;
        memcpy(&s, crow + sx * 2, 2);
        sink.put(x, y, s, a);
      }
    }
    return;
  }
  const float det = m.a * m.d - m.b * m.c;
  if (fabsf(det) < 1e-6f) return;
  const float ia = m.d / det, ib = -m.b / det, ic = -m.c / det, id = m.a / det;  // inverse linear part
  // Bilinear with premultiplied alpha. The source coordinate of destination pixel centre (x + .5, y + .5) is
  // inv * (p - t); texel i is centred at i + .5, so the taps are at (u - .5, v - .5). Colour and alpha are filtered
  // together premultiplied, so a soft edge never picks up the colour of a transparent neighbour (no dark halo), and
  // adjacent parts overlap by their alpha instead of leaving a seam. 16.16 fixed point, 8-bit tap weights.
  const int32_t dudx = static_cast<int32_t>(ia * 65536.0f), dvdx = static_cast<int32_t>(ib * 65536.0f);
  const int32_t half = 32768;
  for (int y = box.y0; y < box.y1; y++) {
    const float px = static_cast<float>(box.x0) + 0.5f - m.tx, py = static_cast<float>(y) + 0.5f - m.ty;
    int32_t u = static_cast<int32_t>((ia * px + ic * py) * 65536.0f) - half;
    int32_t v = static_cast<int32_t>((ib * px + id * py) * 65536.0f) - half;
    for (int x = box.x0; x < box.x1; x++, u += dudx, v += dvdx) {
      const int32_t x0 = u >> 16, y0 = v >> 16;
      if (x0 < -1 || y0 < -1 || x0 >= w || y0 >= h) continue;
      if (x0 >= 0 && y0 >= 0 && x0 + 1 < w && y0 + 1 < h) {
        // Interior fast path: the four taps are inside the part. Almost every pixel is fully opaque or fully clear; only the
        // rim is partial. No division here: 5-bit tap weights (sum 32) on the spread RGB565 (0x07E0F81F) form, in 32 bits.
        const size_t i0 = static_cast<size_t>(y0) * w + x0;
        const uint32_t a00 = alpha[i0], a10 = alpha[i0 + 1], a01 = alpha[i0 + w], a11 = alpha[i0 + w + 1];
        if ((a00 | a10 | a01 | a11) == 0) continue;
        if ((a00 & a10 & a01 & a11) == 255) {
          const uint32_t fx5 = (u >> 11) & 31, fy5 = (v >> 11) & 31;
          const uint32_t q00 = ((32 - fx5) * (32 - fy5) + 16) >> 5, q10 = (fx5 * (32 - fy5) + 16) >> 5, q01 = ((32 - fx5) * fy5 + 16) >> 5;
          const uint32_t q11 = 32 - q00 - q10 - q01 > 32 ? 0 : 32 - q00 - q10 - q01;
          uint16_t c00, c10, c01, c11;
          memcpy(&c00, blob + i0 * 2, 2);
          memcpy(&c10, blob + (i0 + 1) * 2, 2);
          memcpy(&c01, blob + (i0 + w) * 2, 2);
          memcpy(&c11, blob + (i0 + w + 1) * 2, 2);
          auto spread = [](uint32_t c) { return (c | (c << 16)) & 0x07E0F81Fu; };
          const uint32_t acc = (spread(c00) * q00 + spread(c10) * q10 + spread(c01) * q01 + spread(c11) * q11) >> 5;
          const uint32_t r = acc & 0x07E0F81Fu;
          const uint32_t a = gain == 255 ? 255 : gain;
          sink.put(x, y, static_cast<uint16_t>(r | (r >> 16)), a);
          continue;
        }
      }
      const uint32_t fx = (u >> 8) & 255, fy = (v >> 8) & 255;
      const uint32_t w00 = (256 - fx) * (256 - fy), w10 = fx * (256 - fy), w01 = (256 - fx) * fy, w11 = fx * fy;  // sum 65536
      uint32_t ar = 0, ag = 0, ab = 0, aa = 0;
      for (int k = 0; k < 4; k++) {
        const int tx = x0 + (k & 1), ty = y0 + (k >> 1);
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const size_t i = static_cast<size_t>(ty) * w + tx;
        const uint32_t a = alpha[i];
        if (a == 0) continue;
        const uint32_t wt = (k == 0 ? w00 : k == 1 ? w10 : k == 2 ? w01 : w11) >> 8;  // 0..256
        uint16_t sc;
        memcpy(&sc, blob + i * 2, 2);
        const uint32_t wa = wt * a;  // weight times alpha: the premultiplied tap weight
        ar += wa * ((sc >> 11) & 31);
        ag += wa * ((sc >> 5) & 63);
        ab += wa * (sc & 31);
        aa += wa;
      }
      if (aa < (1u << 13)) continue;  // under 1/8 of one 255-alpha texel: invisible
      uint32_t alpha_out = aa >> 8;  // 0..255
      if (gain != 255) alpha_out = (alpha_out * gain) >> 8;
      if (alpha_out == 0) continue;
      const uint32_t r = (ar + (aa >> 1)) / aa, g = (ag + (aa >> 1)) / aa, b = (ab + (aa >> 1)) / aa;
      sink.put(x, y, static_cast<uint16_t>((r << 11) | (g << 5) | b), alpha_out > 255 ? 255 : alpha_out);
    }
  }
}

// Opaque blit of a big-endian RGB565 surface (w*h) transformed by `m`; pixels equal to `key` (native order) are
// skipped. Used for the backflip, where the whole composed figure turns as one unit.
inline void drawSurface(FrameSink& sink, const Clip& clip, const uint8_t* src, int w, int h, const Affine& m, uint16_t key) {
  Clip box;
  if (!transformedBounds(m, w, h, clip, &box)) return;
  const float det = m.a * m.d - m.b * m.c;
  if (fabsf(det) < 1e-6f) return;
  const float ia = m.d / det, ib = -m.b / det, ic = -m.c / det, id = m.a / det;
  const int32_t dudx = static_cast<int32_t>(ia * 65536.0f), dvdx = static_cast<int32_t>(ib * 65536.0f);
  // Bilinear: the turning figure has soft edges instead of crawling jaggies. Key (and out-of-range) taps count as
  // transparent, so the edge blends over whatever is already in the frame.
  auto tap = [&](int x, int y, uint32_t* r, uint32_t* g, uint32_t* b, uint32_t wt, uint32_t* cov) {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    uint16_t s;
    memcpy(&s, src + (static_cast<size_t>(y) * w + x) * 2, 2);
    s = bswap(s);
    if (s == key) return;
    *r += wt * ((s >> 11) & 31);
    *g += wt * ((s >> 5) & 63);
    *b += wt * (s & 31);
    *cov += wt;
  };
  for (int y = box.y0; y < box.y1; y++) {
    const float px = static_cast<float>(box.x0) + 0.5f - m.tx, py = static_cast<float>(y) + 0.5f - m.ty;
    int32_t u = static_cast<int32_t>((ia * px + ic * py) * 65536.0f) - 0x8000;
    int32_t v = static_cast<int32_t>((ib * px + id * py) * 65536.0f) - 0x8000;
    uint16_t* row = reinterpret_cast<uint16_t*>(sink.base + static_cast<size_t>(y) * sink.stride);
    for (int x = box.x0; x < box.x1; x++, u += dudx, v += dvdx) {
      const int ix = u >> 16, iy = v >> 16;
      if (ix < -1 || iy < -1 || ix >= w || iy >= h) continue;
      const uint32_t fx = static_cast<uint32_t>(u & 0xFFFF) >> 8, fy = static_cast<uint32_t>(v & 0xFFFF) >> 8;
      uint32_t r = 0, g = 0, b = 0, cov = 0;
      tap(ix, iy, &r, &g, &b, (256 - fx) * (256 - fy), &cov);
      tap(ix + 1, iy, &r, &g, &b, fx * (256 - fy), &cov);
      tap(ix, iy + 1, &r, &g, &b, (256 - fx) * fy, &cov);
      tap(ix + 1, iy + 1, &r, &g, &b, fx * fy, &cov);
      if (cov < 2048) continue;  // under 3% covered
      const uint16_t s = static_cast<uint16_t>(((r / cov) << 11) | ((g / cov) << 5) | (b / cov));
      const uint32_t a5 = cov >> 11;  // 0..32
      row[x] = a5 >= 31 ? bswap(s) : bswap(blend565(bswap(row[x]), s, a5));
    }
  }
}

}  // namespace raster
}  // namespace bob
