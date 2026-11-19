#if defined(BOB_BOARD_WAVESHARE_185C)

#include <math.h>

#include "bob_emotions.h"
#include "bob_life.h"
#include "bob_visor.h"

// The pose images are .incbin'd by bob_art.cpp; the face needs them to find (and clip to) the visor.
extern "C" const uint8_t bob_welcome[];
extern "C" const uint8_t bob_curious[];
extern "C" const uint8_t bob_thoughtful[];
extern "C" const uint8_t bob_playful[];

// Eye expressions drawn on the dark visor of the pose sprite, in visor-local coordinates
// (u along the visor, v down). Mirrors scripts/bob_emotions_preview.py shape for shape.
namespace bob
{
namespace
{
constexpr uint16_t kVisor = 0x2945;  // dark visor colour sampled from the art
constexpr uint16_t kShades = 0x0841; // darker band for the shades
constexpr float kEyeX = visor::kEyeX, kClearHalfLen = 27.0f, kClearHalfH = 8.0f;

// Per pose geometry (visor centre, tilt, search region) lives in bob_visor.h, next to the mask built from the art.
using Visor = visor::Pose;

// The art's visor per pose, built once from the pose image the first time that pose is drawn.
const visor::Mask& maskFor(BobPose p)
{
  static visor::Mask masks[kBobPoseCount];
  static bool built[kBobPoseCount] = {};
  static const uint8_t* const art[kBobPoseCount] = {bob_welcome, bob_curious, bob_thoughtful, bob_playful};
  const uint8_t i = static_cast<uint8_t>(p);
  if (!built[i])
  {
    visor::buildMask(art[i], visor::kPoses[i], &masks[i]);
    built[i] = true;
  }
  return masks[i];
}
int ri(float v) { return static_cast<int>(lroundf(v)); }

struct Pen
{
  M5Canvas& c;
  float cx, cy, ca, sa;
  Pen(M5Canvas& canvas, const Visor& v) : c(canvas), cx(v.cx), cy(v.cy), ca(cosf(v.deg * 0.01745329f)), sa(sinf(v.deg * 0.01745329f)) {}
  float X(float u, float v) const { return cx + u * ca - v * sa; }
  float Y(float u, float v) const { return cy + u * sa + v * ca; }
  void disc(float u, float v, float r, uint16_t col = kBobAmber) { c.fillCircle(ri(X(u, v)), ri(Y(u, v)), ri(r), col); }
  void seg(float u0, float v0, float u1, float v1, float w, uint16_t col = kBobAmber) { bobLine(c, X(u0, v0), Y(u0, v0), X(u1, v1), Y(u1, v1), w, col); }
  void ell(float u, float v, float rx, float ry, uint16_t col = kBobAmber)
  {
    const int irx = ri(rx), iry = ri(ry);
    c.fillEllipse(ri(X(u, v)), ri(Y(u, v)), irx < 1 ? 1 : irx, iry < 1 ? 1 : iry, col);
  }
  void tri(float u0, float v0, float u1, float v1, float u2, float v2, uint16_t col = kVisor)
  {
    c.fillTriangle(ri(X(u0, v0)), ri(Y(u0, v0)), ri(X(u1, v1)), ri(Y(u1, v1)), ri(X(u2, v2)), ri(Y(u2, v2)), col);
  }
  void arc(float u, float v, float r, float a0, float a1, float w = 3, uint16_t col = kBobAmber)
  {
    for (int i = 0; i < 8; i++)
    {
      const float p = (a0 + (a1 - a0) * i / 8) * 0.01745329f, q = (a0 + (a1 - a0) * (i + 1) / 8) * 0.01745329f;
      seg(u + r * cosf(p), v + r * sinf(p), u + r * cosf(q), v + r * sinf(q), w, col);
    }
  }
  // The visor plate (rig shades): a capsule of kClearHalfLen x kClearHalfH about the pen origin.
  void capsule(uint16_t col)
  {
    const float h = kClearHalfH, e = kClearHalfLen - h;
    tri(-e, -h, e, -h, e, h, col);
    tri(-e, -h, e, h, -e, h, col);
    disc(-e, 0, h, col);
    disc(e, 0, h, col);
  }
};
} // namespace

void bobLine(M5Canvas& c, float x0, float y0, float x1, float y1, float w, uint16_t col)
{
  const float dx = x1 - x0, dy = y1 - y0, n = fmaxf(hypotf(dx, dy), 0.001f);
  const float ox = -dy / n * w / 2, oy = dx / n * w / 2;
  c.fillTriangle(ri(x0 + ox), ri(y0 + oy), ri(x0 - ox), ri(y0 - oy), ri(x1 + ox), ri(y1 + oy), col);
  c.fillTriangle(ri(x1 + ox), ri(y1 + oy), ri(x1 - ox), ri(y1 - oy), ri(x0 - ox), ri(y0 - oy), col);
  if (w > 2)
  {
    c.fillCircle(ri(x0), ri(y0), ri(w / 2 - 0.5f), col);
    c.fillCircle(ri(x1), ri(y1), ri(w / 2 - 0.5f), col);
  }
}

void bobArc(M5Canvas& c, float x, float y, float r, float a0, float a1, float w, uint16_t col)
{
  for (int i = 0; i < 10; i++)
  {
    const float p = (a0 + (a1 - a0) * i / 10) * 0.01745329f, q = (a0 + (a1 - a0) * (i + 1) / 10) * 0.01745329f;
    bobLine(c, x + r * cosf(p), y + r * sinf(p), x + r * cosf(q), y + r * sinf(q), w, col);
  }
}

void bobEyePos(BobPose p, int s, float u, float v, float* x, float* y)
{
  const Visor& vz = visor::kPoses[static_cast<uint8_t>(p)];
  const float a = vz.deg * 0.01745329f, uu = s * kEyeX + u;
  *x = kBobPoseX + vz.cx + uu * cosf(a) - v * sinf(a);
  // Bob's centre sits kBobCy - kBobFrameTop - 125 px lower in the frame than where this pose table was measured.
  *y = kBobPoseY + (bobtok::kBobCy - bobtok::kBobFrameTop - 125) + vz.cy + uu * sinf(a) + v * cosf(a);
}

// Draws the eyes of `eyes` in pose space (the visor is already cleared; the caller clips the result to the visor mask).
static void drawFace(M5Canvas& pose, BobPose p, BobEyes eyes, float open, float lookU, float lookV, float gazeU, float gazeV)
{
  const Visor& vz = visor::kPoses[static_cast<uint8_t>(p)];
  bobFaceDrawAt(pose, vz.cx, vz.cy, vz.deg, eyes, false, open, lookU, lookV, gazeU, gazeV);
}

void bobFaceDrawAt(M5Canvas& pose, float cx, float cy, float deg, BobEyes eyes, bool clearPlate, float open, float lookU, float lookV, float gazeU,
                   float gazeV)
{
  Pen g(pose, Visor{cx, cy, deg});
  // Whole-pose art has the old eyes painted in, so the plate is cleared first; the rig's visor part is already clean.
  if (clearPlate || eyes == BobEyes::kShades) { g.capsule(eyes == BobEyes::kShades ? kShades : kVisor); }
  if (eyes == BobEyes::kShades)
  {
    for (int s = -1; s <= 1; s += 2) { g.seg(s * kEyeX - 6, -3, s * kEyeX - 2, -6, 2, kBobSky); }
    return;
  }
  // A white catch-light in each amber eye (the "adorable" detail); lookU/lookV move it up to 1 px with Bob's motion.
  const float lu = lookU < -1.0f ? -1.0f : lookU > 1.0f ? 1.0f : lookU, lv = lookV < -1.0f ? -1.0f : lookV > 1.0f ? 1.0f : lookV;
  auto glint = [&](float cu, float cv) { g.disc(cu - 1.5f + lu, cv - 1.5f + lv, 1, kBobPaper); };
  const bool blinkable = eyes == BobEyes::kDot || eyes == BobEyes::kWide || eyes == BobEyes::kBigSmall || eyes == BobEyes::kLookLeft ||
                         eyes == BobEyes::kLookRight || eyes == BobEyes::kLookUp || eyes == BobEyes::kRoll;
  const float gu = gazeU < -life::kGazeMaxU ? -life::kGazeMaxU : gazeU > life::kGazeMaxU ? life::kGazeMaxU : gazeU;
  const float gv = gazeV < -life::kGazeMaxV ? -life::kGazeMaxV : gazeV > life::kGazeMaxV ? life::kGazeMaxV : gazeV;
  for (int s = -1; s <= 1; s += 2) // s = -1 left eye, +1 right eye; the inner side is -s
  {
    const float ex = s * kEyeX, inn = -s;
    const float px = ex + gu, pv = gv; // where a pupil sits: the gaze moves discs, never arcs, hearts or stars
    if (open < 1.0f && blinkable)
    {
      // The squish blink: the eye's height eases to 0 while it widens a little (bob_life.h blinkShape()).
      float cu = ex, cvv = 0, r = 4;
      switch (eyes)
      {
      case BobEyes::kWide: r = 6; break;
      case BobEyes::kBigSmall: r = s > 0 ? 6 : 3; break;
      case BobEyes::kLookLeft: cu = ex - 3.5f; break;
      case BobEyes::kLookRight: cu = ex + 3.5f; break;
      case BobEyes::kLookUp: cu = ex - 2; cvv = -3.5f; break;
      case BobEyes::kRoll: cu = ex + 2; cvv = -4; r = 3.5f; break;
      default: break;
      }
      if (open < 0.12f) { g.seg(cu - r, cvv, cu + r, cvv, 3); }
      else
      {
        g.ell(cu, cvv, r * (1.0f + 0.15f * (1.0f - open)), r * open);
        if (open > 0.6f) { glint(cu, cvv); }
      }
      continue;
    }
    switch (eyes)
    {
    case BobEyes::kDot: g.disc(px, pv, 4); glint(px, pv); break;
    case BobEyes::kWide: g.disc(px, pv, 6); g.disc(px - 2 + lu, pv - 2 + lv, 1.0f, kBobPaper); break;
    case BobEyes::kNarrow: g.seg(ex - 5, 0, ex + 5, 0, 4); break;
    case BobEyes::kHappyArc: g.arc(ex, 3, 5, 180, 360); break;
    case BobEyes::kClosed: g.arc(ex, -3, 5, 0, 180); break;
    case BobEyes::kHalfLid:
      g.disc(px, pv, 4.5f);
      glint(px, pv);
      g.tri(ex - 7, -8, ex + 7, -8, ex + 7, -0.5f);
      g.tri(ex - 7, -8, ex + 7, -0.5f, ex - 7, -0.5f);
      break;
    case BobEyes::kAngry: g.disc(px, pv, 4.5f); glint(px, pv); g.tri(ex + inn * 7, 1, ex + inn * 7, -8, ex - inn * 7, -8); break;
    case BobEyes::kSad: g.disc(px, pv + 1, 4.5f); glint(px, pv + 1); g.tri(ex - inn * 7, 2, ex - inn * 7, -8, ex + inn * 7, -8); break;
    case BobEyes::kHeart:
      g.disc(ex - 2.6f, -1.5f, 3, kBobCoral); g.disc(ex + 2.6f, -1.5f, 3, kBobCoral);
      g.tri(ex - 5.4f, -0.2f, ex + 5.4f, -0.2f, ex, 5.5f, kBobCoral);
      break;
    case BobEyes::kStar:
    {
      constexpr float q = 1.6f, pts[8][2] = {{0, -7}, {q, -q}, {7, 0}, {q, q}, {0, 7}, {-q, q}, {-7, 0}, {-q, -q}};
      for (int i = 0; i < 8; i++) { g.tri(ex, 0, ex + pts[i][0], pts[i][1], ex + pts[(i + 1) % 8][0], pts[(i + 1) % 8][1], kBobAmber); }
      break;
    }
    case BobEyes::kX: g.seg(ex - 4, -4, ex + 4, 4, 3); g.seg(ex - 4, 4, ex + 4, -4, 3); break;
    case BobEyes::kSpiral:
      for (int i = 0; i < 24; i++)
      {
        const float r0 = 1 + 5.0f * i / 24, r1 = 1 + 5.0f * (i + 1) / 24;
        g.seg(ex + r0 * cosf(i * 0.5f * s), r0 * sinf(i * 0.5f * s), ex + r1 * cosf((i + 1) * 0.5f * s), r1 * sinf((i + 1) * 0.5f * s), 2);
      }
      break;
    case BobEyes::kBigSmall: g.disc(px, pv, s > 0 ? 6 : 3); if (s > 0) { glint(px, pv); } break;
    case BobEyes::kWink: if (s < 0) { g.disc(px, pv, 4); glint(px, pv); } else { g.arc(ex, 3, 5, 180, 360); } break;
    case BobEyes::kLookLeft: g.disc(ex - 3.5f, 0, 4); glint(ex - 3.5f, 0); break;
    case BobEyes::kLookRight: g.disc(ex + 3.5f, 0, 4); glint(ex + 3.5f, 0); break;
    case BobEyes::kLookUp: g.disc(ex - 2, -3.5f, 4); glint(ex - 2, -3.5f); break;
    case BobEyes::kLaugh: g.seg(ex - inn * 4, -4, ex + inn * 3, 0, 3); g.seg(ex + inn * 3, 0, ex - inn * 4, 4, 3); break;
    case BobEyes::kRoll: g.disc(ex + 2, -4, 3.5f); glint(ex + 2, -4); break;
    case BobEyes::kWavy:
      for (int i = 0; i < 12; i++) { g.seg(ex - 6 + i, 2.2f * sinf(i * 1.05f), ex - 5 + i, 2.2f * sinf((i + 1) * 1.05f), 2); }
      break;
    case BobEyes::kSkeptic: if (s < 0) { g.seg(ex - 5, 0, ex + 5, 0, 4); } else { g.disc(px, pv, 4.5f); glint(px, pv); } break;
    default: break;
    }
  }
}

void bobFaceRegion(BobPose p, int16_t* x, int16_t* y, int16_t* w, int16_t* h)
{
  const visor::Pose& v = visor::kPoses[static_cast<uint8_t>(p)];
  *x = v.rx;
  *y = v.ry;
  *w = v.rw < visor::kMaxW ? v.rw : visor::kMaxW;
  *h = v.rh < visor::kMaxH ? v.rh : visor::kMaxH;
}

// The art back in the visor region of the pose sprite (and nowhere else): the start of a visor-only redraw.
void bobFaceReset(M5Canvas& pose, BobPose p)
{
  static const uint8_t* const art[kBobPoseCount] = {bob_welcome, bob_curious, bob_thoughtful, bob_playful};
  int16_t x, y, w, h;
  bobFaceRegion(p, &x, &y, &w, &h);
  auto* dst = static_cast<uint8_t*>(pose.getBuffer());
  const uint8_t* src = art[static_cast<uint8_t>(p)];
  for (int v = 0; v < h; ++v)
  {
    const size_t i = 2u * (static_cast<size_t>(y + v) * visor::kArt + x);
    memcpy(dst + i, src + i, static_cast<size_t>(w) * 2);
  }
}

// The face into the pose sprite, in pose space, BEFORE the sprite is rotated or scaled (so the eyes tilt with the head):
// 1. clear the art's own eyes by filling exactly the visor mask (derived from the art, so a hand over the visor stays),
// 2. draw the eyes, 3. put the art back everywhere outside the mask, so nothing can ever land on the arm or the shell.
void bobFaceDraw(M5Canvas& pose, BobPose p, BobEyes eyes, float open, float lookU, float lookV, float gazeU, float gazeV)
{
  const visor::Mask& mask = maskFor(p);
  const uint16_t base = eyes == BobEyes::kShades ? kShades : kVisor;
  // What is in the sprite now (the art, or a crossfade blend) is what the clip puts back outside the visor.
  static uint8_t snap[visor::kSnapBytes];
  auto* buf = static_cast<uint8_t*>(pose.getBuffer());
  visor::saveRegion(buf, mask, snap);
  visor::forEachRun(mask, [&](int x, int y, int len) { pose.fillRect(x, y, len, 1, base); });
  drawFace(pose, p, eyes, open, lookU, lookV, gazeU, gazeV);
  visor::restoreOutsideFromSnap(buf, snap, mask);
}

} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
