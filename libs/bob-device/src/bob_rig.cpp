// Bob's rig renderer: the part blobs composed into a bob::Framebuffer, with the target's memory from bob::hal().
// The parts come from the app's lib/bob_art/rig (the build passes its -Wa,-I path); see bob_rig_blobs.inc.
#if defined(BOB_RIG)

#include "bob_rig.h"

#include <string.h>

#include "bob_emotion_table.h"
#include "bob_face_aa.h"
#include "bob_hal.h"

static_assert(static_cast<int>(bob::demo::Eyes::kSquint) - 1 == static_cast<int>(bob::face::EyeStyle::kSquint) &&
                  static_cast<int>(bob::demo::Eyes::kOpen) - 1 == static_cast<int>(bob::face::EyeStyle::kOpen),
              "moveEyeStyle() relies on demo::Eyes and face::EyeStyle sharing their order");

// The 20 part blobs (RGB565 LE then A8) are .incbin'd from lib/bob_art/rig. The assembler does not track them as
// Blobs last regenerated from the approved demo art (bob_rig_from_demo.py).
// dependencies: touch this file after regenerating them with scripts/bob_rig_build.py --device-blobs.
#include "bob_rig_blobs.inc"

namespace bob
{
namespace rig
{
namespace
{
using raster::BlobSink;
using raster::Clip;
using raster::FrameSink;

constexpr int kFrameW = kBobFrameW, kFrameH = kBobFrameH;
constexpr int kScratchMargin = 14;
constexpr int kScratch = kStage + 2 * kScratchMargin; // the backflip turns the composed figure inside this square
constexpr uint16_t kKey = kBobGround + 1;              // scratch background: one blue step off the ground, so edge blends stay invisible
constexpr int kFaceW = kParts[kVisor].w, kFaceH = kParts[kVisor].h; // the face blob covers the visor part

uint8_t* s_faceBlob = nullptr; // kFaceW * kFaceH * 3: the face as a blob
uint8_t* s_scratch = nullptr;  // kScratch * kScratch * 2, big-endian RGB565
bool s_ready = false;
const FaceState* s_face = nullptr; // the face of the frame being composed

struct FaceKey
{
  uint8_t eyes;
  int8_t open, lu, lv, gu, gv, px, py, sc, style, tilt; // quantised: a redraw only when something visible changed
  bool operator==(const FaceKey& o) const { return memcmp(this, &o, sizeof(FaceKey)) == 0; }
};
FaceKey s_faceKey{255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};

// ---- Cache of transformed small parts (arms, button, feet) that hold still for a frame or two. ----------------------
constexpr int kSlots = 5;
constexpr int kCacheDim = 112;
struct Slot
{
  uint8_t* buf = nullptr; // kCacheDim * kCacheDim * 3
  bool valid = false;
  int16_t key[7] = {};  // part, the four linear coefficients in 1/64 steps, the pivot's sub-pixel phase in 1/16 px
  int16_t pend[7] = {}; // the key requested last frame
  bool hasPend = false;
  int w = 0, h = 0, px = 0, py = 0; // cached size and where the part's pivot sits inside it
};
Slot s_slots[kSlots];
uint32_t s_hits = 0, s_misses = 0;

int slotFor(uint8_t part)
{
  if (part == kFootL) { return 0; }
  if (part == kFootR) { return 1; }
  if (part == kButton) { return 2; }
  if (part == kArmLDown || part == kArmLUp || part == kArmLEar || part == kArmLChin) { return 3; }
  if (part == kArmRWave || part == kArmRUp || part == kArmRDown || part == kArmRDown2) { return 4; }
  return -1;
}

constexpr float kPhaseSteps = 16.0f; // the cached part keeps where its pivot falls inside a pixel, in 1/16 px

void makeKey(int16_t* k, uint8_t part, const Affine& m, int16_t phaseX, int16_t phaseY)
{
  k[0] = part;
  k[1] = static_cast<int16_t>(lroundf(m.a * 64.0f));
  k[2] = static_cast<int16_t>(lroundf(m.b * 64.0f));
  k[3] = static_cast<int16_t>(lroundf(m.c * 64.0f));
  k[4] = static_cast<int16_t>(lroundf(m.d * 64.0f));
  k[5] = phaseX;
  k[6] = phaseY;
}
bool sameKey(const int16_t* a, const int16_t* b) { return memcmp(a, b, 7 * sizeof(int16_t)) == 0; }

// Draws blob `part` with matrix m (stage -> frame already applied), through the part cache when it holds still.
template <class Sink>
void drawPart(Sink& sink, const Clip& clip, uint8_t part, const Affine& m, uint32_t gain)
{
  const PartInfo& info = kParts[part];
  const uint8_t* blob = kBlobs[part];
  const int si = (gain == 255) ? slotFor(part) : -1;
  if (si < 0 || s_slots[si].buf == nullptr)
  {
    raster::drawBlob(sink, clip, blob, info.w, info.h, m, gain);
    return;
  }
  Slot& s = s_slots[si];
  float pivX, pivY;
  m.apply(info.pivotX, info.pivotY, &pivX, &pivY);
  // The cached image is rasterised at the pivot's sub-pixel phase and blitted on whole pixels, so a cached part lands
  // exactly where a direct draw would (rounding the pivot moved arms and feet by up to half a pixel).
  int16_t phx = static_cast<int16_t>(lroundf((pivX - floorf(pivX)) * kPhaseSteps)), phy = static_cast<int16_t>(lroundf((pivY - floorf(pivY)) * kPhaseSteps));
  float baseX = floorf(pivX), baseY = floorf(pivY);
  if (phx == kPhaseSteps) { phx = 0; baseX += 1.0f; }
  if (phy == kPhaseSteps) { phy = 0; baseY += 1.0f; }
  int16_t key[7];
  makeKey(key, part, m, phx, phy);
  if (s.valid && sameKey(s.key, key))
  {
    ++s_hits;
    raster::drawBlob(sink, clip, s.buf, s.w, s.h, raster::translate(baseX - s.px, baseY - s.py), 255);
    return;
  }
  if (!(s.hasPend && sameKey(s.pend, key)))
  {
    // First time this transform is asked for: draw directly, and remember it. A second consecutive frame builds the cache.
    memcpy(s.pend, key, sizeof(key));
    s.hasPend = true;
    s.valid = false;
    ++s_misses;
    raster::drawBlob(sink, clip, blob, info.w, info.h, m, 255);
    return;
  }
  // Same transform twice in a row: rasterise the part once about its pivot into the slot, then blit that.
  Affine lin = m;
  lin.tx = phx / kPhaseSteps;
  lin.ty = phy / kPhaseSteps;
  const Affine about = lin * raster::translate(-info.pivotX, -info.pivotY);
  Clip box;
  if (!raster::transformedBounds(about, info.w, info.h, Clip{-4096, -4096, 4096, 4096}, &box)) { return; }
  const int w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1;
  if (w > kCacheDim || h > kCacheDim || w * h * 3 > kCacheDim * kCacheDim * 3)
  {
    raster::drawBlob(sink, clip, blob, info.w, info.h, m, 255);
    return;
  }
  memset(s.buf, 0, static_cast<size_t>(w) * h * 3);
  BlobSink cache{s.buf, w, h};
  raster::drawBlob(cache, Clip{0, 0, w, h}, blob, info.w, info.h, raster::translate(-box.x0, -box.y0) * about, 255);
  memcpy(s.key, key, sizeof(key));
  s.w = w;
  s.h = h;
  s.px = -box.x0;
  s.py = -box.y0;
  s.valid = true;
  raster::drawBlob(sink, clip, s.buf, s.w, s.h, raster::translate(baseX - s.px, baseY - s.py), 255);
}

// The demo's eye style for each device expression (bob_face_aa.h). The demo's own styles map one to one; the
// device-only expressions use the same primitives.
face::Params faceParams(BobEyes eyes)
{
  using face::EyeStyle;
  face::Params p;
  auto both = [&](EyeStyle s) { p.left.style = s; p.right.style = s; };
  switch (eyes)
  {
  case BobEyes::kDot: both(EyeStyle::kOpen); break;
  case BobEyes::kWide: both(EyeStyle::kWide); break;
  case BobEyes::kNarrow: case BobEyes::kShades: both(EyeStyle::kDash); break;
  case BobEyes::kHappyArc: both(EyeStyle::kSquint); break;
  case BobEyes::kClosed: both(EyeStyle::kClosed); break;
  case BobEyes::kHalfLid: both(EyeStyle::kHalf); break;
  case BobEyes::kAngry: case BobEyes::kSad: both(EyeStyle::kWorried); break;
  case BobEyes::kHeart: both(EyeStyle::kHeart); break;
  case BobEyes::kStar: both(EyeStyle::kStar); break;
  case BobEyes::kX: both(EyeStyle::kX); break;
  case BobEyes::kSpiral: both(EyeStyle::kSpiral); break;
  case BobEyes::kBigSmall: p.left.scale = 0.7f; p.right.style = EyeStyle::kWide; break;
  case BobEyes::kWink: p.right.style = EyeStyle::kSquint; break;
  case BobEyes::kLookLeft: p.left.du = p.right.du = -7.0f; break;
  case BobEyes::kLookRight: p.left.du = p.right.du = 7.0f; break;
  case BobEyes::kLookUp: both(EyeStyle::kLook); break;
  case BobEyes::kLaugh: both(EyeStyle::kLaugh); break;
  case BobEyes::kRoll: p.left.du = p.right.du = 4.0f; p.left.dv = p.right.dv = -7.0f; break;
  case BobEyes::kWavy: both(EyeStyle::kWavy); break;
  case BobEyes::kSkeptic: p.left.style = EyeStyle::kDash; break;
  default: break;
  }
  return p;
}

// Repaints the face blob when the face changed visibly. (phaseX, phaseY): the sub-pixel offset the blob will be drawn
// at, so a resting visor shows the eyes exactly where the demo's vector eyes fall, with no resampling blur.
void updateFace(const FaceState& f, float phaseX, float phaseY, float scale)
{
  FaceKey k{static_cast<uint8_t>(f.eyes),  static_cast<int8_t>(lroundf(f.open * 20.0f)),  static_cast<int8_t>(lroundf(f.lookU * 4.0f)),
            static_cast<int8_t>(lroundf(f.lookV * 4.0f)), static_cast<int8_t>(lroundf(f.gazeU * 4.0f)), static_cast<int8_t>(lroundf(f.gazeV * 4.0f)),
            static_cast<int8_t>(lroundf(phaseX * 8.0f)), static_cast<int8_t>(lroundf(phaseY * 8.0f)), static_cast<int8_t>(lroundf(scale * 100.0f)), f.style,
            static_cast<int8_t>(lroundf(f.tilt * 2.0f))};
  if (k == s_faceKey) { return; }
  s_faceKey = k;
  face::Params p = faceParams(f.eyes);
  if (f.style >= 0) { p.left = p.right = face::Eye(); p.left.style = p.right.style = static_cast<face::EyeStyle>(f.style); }
  p.tilt = f.tilt;
  p.lookX = f.gazeU / face::kLook;
  p.lookY = f.gazeV / face::kLook;
  p.squish = f.open;
  p.phaseX = phaseX;
  p.phaseY = phaseY;
  p.scale = scale;
  face::render(s_faceBlob, kFaceW, kFaceH, kParts[kVisor].pivotX, kParts[kVisor].pivotY, p);
}

// The demo's cheeks: coral ellipses (rx 9, ry 4.4) at +-70 art px and 34 art px below the visor pivot, opacity .75 * blush.
constexpr float kCheekDx = 70.0f * kArtScale, kCheekDy = 34.0f * kArtScale, kCheekRx = 9.0f, kCheekRy = 4.4f, kCheekOpacity = 0.75f;

// An anti-aliased (4x4 coverage) coral ellipse of radius (rx, ry) at (cx, cy) in frame pixels, at opacity `amount`.
template <class Sink>
void blush(Sink& sink, const Clip& clip, float cx, float cy, float rx, float ry, float amount)
{
  const uint16_t coral = bobRgb((bobtok::kCoral >> 16) & 255, (bobtok::kCoral >> 8) & 255, bobtok::kCoral & 255);
  for (int y = static_cast<int>(floorf(cy - ry)); y <= static_cast<int>(ceilf(cy + ry)); y++)
  {
    if (y < clip.y0 || y >= clip.y1) { continue; }
    for (int x = static_cast<int>(floorf(cx - rx)); x <= static_cast<int>(ceilf(cx + rx)); x++)
    {
      if (x < clip.x0 || x >= clip.x1) { continue; }
      int in = 0;
      for (int sy = 0; sy < 4; sy++)
        for (int sx = 0; sx < 4; sx++)
        {
          const float dx = (x + (sx + 0.5f) / 4 - cx) / rx, dy = (y + (sy + 0.5f) / 4 - cy) / ry;
          in += dx * dx + dy * dy <= 1.0f;
        }
      if (in > 0) { sink.put(x, y, coral, static_cast<uint32_t>(in / 16.0f * amount * 255.0f + 0.5f)); }
    }
  }
}

// ---- Baked static runs ---------------------------------------------------------------------------------------------
// Bilinear is the quality path but costs several times the nearest blit. Most of Bob holds still most of the time (head,
// belly, feet at rest while only the face blinks), so a run of consecutive layers whose matrices have not changed for two
// frames is composed ONCE into a transparent sprite (frame sized) and blitted with the cheap integer path. Layers that
// move (a waving arm, the button, the face) are still drawn bilinear every frame, in their normal order around the run.
struct Sig
{
  uint8_t part, alpha;
  int16_t k[6]; // matrix in 1/32 (linear) and 1/16 px (translation)
  bool operator==(const Sig& o) const { return part == o.part && alpha == o.alpha && memcmp(k, o.k, sizeof(k)) == 0; }
};
struct Bake
{
  uint8_t* buf = nullptr; // kFrameW * kFrameH * 3
  bool valid = false;
  bool building = false; // being composed a band of rows per frame (a single pass costs half a second)
  int rowsDone = 0;
  int first = 0, last = -1;
  Sig sigs[kMaxLayers];
  Clip box{0, 0, 0, 0};
};
Bake s_bake;
Sig s_prevSig[kMaxLayers];
bool s_moving[kMaxLayers]; // layer changed this frame: big parts then use the nearest (cheap) sampler
uint8_t s_stableFor[kMaxLayers];
int s_prevN = 0;
uint32_t s_bakeHits = 0, s_bakeMisses = 0;

Sig sigOf(const Layer& l, const Affine& m)
{
  Sig s{};
  s.part = l.part;
  s.alpha = l.alpha;
  s.k[0] = static_cast<int16_t>(lroundf(m.a * 32.0f));
  s.k[1] = static_cast<int16_t>(lroundf(m.b * 32.0f));
  s.k[2] = static_cast<int16_t>(lroundf(m.c * 32.0f));
  s.k[3] = static_cast<int16_t>(lroundf(m.d * 32.0f));
  s.k[4] = static_cast<int16_t>(lroundf(m.tx * 16.0f));
  s.k[5] = static_cast<int16_t>(lroundf(m.ty * 16.0f));
  return s;
}

// The approved demo draws every part as a composited layer, and Chrome puts a layer on whole pixels of the space it is
// laid out in. Measured on the goldens (each part rendered alone, device art):
//  - full-size Bob (the rig box has no transform): an upright part's CSS box at glass (x, y) lands at x' = round(x),
//    y' = round(y + 0.5) (the glass sits half a pixel down the page; positions are 1/64 px layout units, truncated, so
//    a tie goes down);
//  - under any transformed ancestor (a small-Bob view scales the rig box; a move translates, leans or squashes the body or
//    turns the head): the rig box itself snaps that way, each part's box rounds to whole rig pixels inside it, and the
//    ancestors' transforms are applied after, so parts land on fractional glass pixels.
// The part's own transform (an arm's swing, the button's wobble) is applied about its pivot after the snap. The device
// places layers the same way, so each part sits on the demo's pixel.
constexpr float kSnapBiasY = 0.5f, kLayoutUnit = 1.0f / 64.0f;
bool s_smallView = false;  // the rig box is scaled (pairing, speaking, reply)
bool s_noSnap = false;     // composing the locked backflip figure, which is turned as a whole
Affine s_rigExact, s_rigSnapped; // rig px -> frame px, with the rig box where the demo writes it / on whole glass pixels
float snapGlassX(float x) { return roundf(x - kLayoutUnit); }
float snapGlassY(float y) { return roundf(y + kSnapBiasY - kLayoutUnit); }
bool isIdentity(const Affine& m) { return m.nearIdentityLinear() && fabsf(m.tx) < 1e-3f && fabsf(m.ty) < 1e-3f; }
// The part's matrix on the frame: ancestors `anc`, box at (bx, by) in rig px, own transform `own`; `outer` maps rig px
// to the frame when nothing is snapped.
Affine placeBox(const Affine& outer, const Affine& anc, float bx, float by, const Affine& own)
{
  if (s_noSnap) { return outer * anc * raster::translate(bx, by) * own; }
  if (!s_smallView && isIdentity(anc))
  {
    float x, y;
    s_rigExact.apply(bx, by, &x, &y);
    return raster::translate(snapGlassX(x), snapGlassY(y)) * own;
  }
  Affine m = s_rigSnapped * anc * raster::translate(roundf(bx), roundf(by)) * own;
  // An axis the ancestors leave alone (no turn, scale or offset along it: a clap's breath only stretches and lifts) keeps
  // the glass snap on that axis, as measured on the clap goldens.
  const bool turned = fabsf(anc.b) > 1e-4f || fabsf(anc.c) > 1e-4f;
  if (!s_smallView && !turned)
  {
    float x, y;
    s_rigExact.apply(bx, by, &x, &y);
    if (fabsf(anc.a - 1.0f) < 1e-4f && fabsf(anc.tx) < 1e-3f) { m.tx += snapGlassX(x) - (s_rigSnapped.tx + roundf(bx)); }
    if (fabsf(anc.d - 1.0f) < 1e-4f && fabsf(anc.ty) < 1e-3f) { m.ty += snapGlassY(y) - (s_rigSnapped.ty + roundf(by)); }
  }
  return m;
}
Affine placeLayer(const Affine& outer, const Layer& l) { return placeBox(outer, l.anc, l.bx, l.by, l.own); }

// The ground shadow exactly as the demo's CSS draws it: an anti-aliased ellipse, Gaussian-blurred (sigma = the CSS blur
// radius), darkening with rgb(8, 20, 30) at `amount`. Coverage is recomputed only when the shadow changed.
constexpr int kShadowMaxW = 160, kShadowMaxH = 48, kShadowSs = 4;
constexpr float kShadowTruncate = 4.0f; // kernel half-width in sigmas
float* s_shCov = nullptr;               // kShadowMaxW * kShadowMaxH coverage, then the blurred result
float* s_shTmp = nullptr;
struct ShadowKey
{
  int16_t fx, fy, rx, ry, sigma;
  bool operator==(const ShadowKey& o) const { return memcmp(this, &o, sizeof(ShadowKey)) == 0; }
};
ShadowKey s_shKey{-1, -1, -1, -1, -1};
int s_shW = 0, s_shH = 0;

void blurredEllipse(FrameSink& sink, const Clip& clip, float cx, float cy, float rx, float ry, float sigma, float amount)
{
  if (s_shCov == nullptr || s_shTmp == nullptr || rx <= 0 || ry <= 0) { return; }
  // The blur is rebuilt whenever its key changes (tens of milliseconds); a hop or a breath changes the ellipse a little every frame, so the
  // size and sub-pixel position are held to a quarter pixel (invisible) and most frames reuse the last blur.
  rx = roundf(rx * 4.0f) / 4.0f;
  ry = roundf(ry * 4.0f) / 4.0f;
  cx = floorf(cx) + roundf((cx - floorf(cx)) * 4.0f) / 4.0f;
  cy = floorf(cy) + roundf((cy - floorf(cy)) * 4.0f) / 4.0f;
  if (rx <= 0 || ry <= 0) { return; }
  const int pad = static_cast<int>(ceilf(kShadowTruncate * sigma)) + 1;
  const int ox = static_cast<int>(floorf(cx - rx)) - pad, oy = static_cast<int>(floorf(cy - ry)) - pad; // buffer origin on the frame
  const ShadowKey key{static_cast<int16_t>(lroundf((cx - floorf(cx)) * 16.0f)), static_cast<int16_t>(lroundf((cy - floorf(cy)) * 16.0f)),
                      static_cast<int16_t>(lroundf(rx * 16.0f)), static_cast<int16_t>(lroundf(ry * 16.0f)), static_cast<int16_t>(lroundf(sigma * 16.0f))};
  if (!(key == s_shKey))
  {
    s_shKey = key;
    s_shW = static_cast<int>(ceilf(cx + rx)) + pad + 1 - ox;
    s_shH = static_cast<int>(ceilf(cy + ry)) + pad + 1 - oy;
    s_shW = s_shW > kShadowMaxW ? kShadowMaxW : s_shW;
    s_shH = s_shH > kShadowMaxH ? kShadowMaxH : s_shH;
    const float lx = cx - ox, ly = cy - oy; // the centre in buffer px
    for (int y = 0; y < s_shH; y++)
      for (int x = 0; x < s_shW; x++)
      {
        int in = 0;
        for (int sy = 0; sy < kShadowSs; sy++)
          for (int sx = 0; sx < kShadowSs; sx++)
          {
            const float dx = (x + (sx + 0.5f) / kShadowSs - lx) / rx, dy = (y + (sy + 0.5f) / kShadowSs - ly) / ry;
            in += dx * dx + dy * dy <= 1.0f;
          }
        s_shCov[y * kShadowMaxW + x] = float(in) / (kShadowSs * kShadowSs);
      }
    // separable Gaussian, zero outside (the CSS filter's transparent surround)
    float k[2 * kShadowMaxH];
    const int r = pad - 1 < kShadowMaxH - 1 ? pad - 1 : kShadowMaxH - 1;
    float sum = 0;
    for (int i = -r; i <= r; i++) { k[i + r] = expf(-0.5f * (i * i) / (sigma * sigma)); sum += k[i + r]; }
    for (int i = 0; i <= 2 * r; i++) { k[i] /= sum; }
    for (int y = 0; y < s_shH; y++)
      for (int x = 0; x < s_shW; x++)
      {
        float acc = 0;
        for (int i = -r; i <= r; i++) { const int xx = x + i; if (xx >= 0 && xx < s_shW) { acc += k[i + r] * s_shCov[y * kShadowMaxW + xx]; } }
        s_shTmp[y * kShadowMaxW + x] = acc;
      }
    for (int y = 0; y < s_shH; y++)
      for (int x = 0; x < s_shW; x++)
      {
        float acc = 0;
        for (int i = -r; i <= r; i++) { const int yy = y + i; if (yy >= 0 && yy < s_shH) { acc += k[i + r] * s_shTmp[yy * kShadowMaxW + x]; } }
        s_shCov[y * kShadowMaxW + x] = acc;
      }
  }
  const uint16_t shade = bobRgb((kShadowRgb >> 16) & 255, (kShadowRgb >> 8) & 255, kShadowRgb & 255);
  for (int y = 0; y < s_shH; y++)
  {
    const int fy = oy + y;
    if (fy < clip.y0 || fy >= clip.y1) { continue; }
    for (int x = 0; x < s_shW; x++)
    {
      const int fx = ox + x;
      if (fx < clip.x0 || fx >= clip.x1) { continue; }
      const uint32_t a = static_cast<uint32_t>(s_shCov[y * kShadowMaxW + x] * amount * 255.0f + 0.5f);
      if (a > 0) { sink.put(fx, fy, shade, a); }
    }
  }
}

template <class Sink>
void drawLayers(Sink& sink, const Clip& clip, const Layer* layers, int n, const Affine& outer, bool allowCache, int baseIdx = 0)
{
  for (int i = 0; i < n; i++)
  {
    const Layer& l = layers[i];
    const Affine m = placeLayer(outer, l);
    if (l.part == kLayerFace)
    {
      // an unrotated visor (any uniform size): the eyes are rasterised at that size and the destination's sub-pixel
      // phase, then blitted on whole pixels, as the demo draws its vector eyes; a turned visor resamples the blob
      const bool upright = fabsf(m.b) < 1e-3f && fabsf(m.c) < 1e-3f && fabsf(m.a - m.d) < 1e-3f && m.a > 0.1f && m.a <= 1.0f + 3e-3f;
      if (upright)
      {
        const float ox = floorf(m.tx), oy = floorf(m.ty);
        updateFace(*s_face, m.tx - ox, m.ty - oy, m.a);
        raster::drawBlob(sink, clip, s_faceBlob, kFaceW, kFaceH, raster::translate(ox, oy), 255);
      }
      else
      {
        updateFace(*s_face, 0.0f, 0.0f, 1.0f);
        raster::drawBlob(sink, clip, s_faceBlob, kFaceW, kFaceH, m, 255);
      }
    }
    else if (l.part == kLayerCheeks)
    {
      float x, y;
      for (int s = -1; s <= 1; s += 2)
      {
        m.apply(kParts[kVisor].pivotX + s * kCheekDx, kParts[kVisor].pivotY + kCheekDy, &x, &y);
        blush(sink, clip, x, y, kCheekRx, kCheekRy, kCheekOpacity * l.alpha / 255.0f);
      }
    }
    else if (allowCache && s_moving[baseIdx + i])
    {
      // A part in motion has a new matrix every frame, so a cached sprite would be rendered whole and used once: draw it straight onto the
      // frame (only the rows of this band), the big ones with the cheap sampler.
      const bool big = kMotionLod && kParts[l.part].w * kParts[l.part].h >= 6000;
      if (big) { raster::drawBlob(sink, clip, kBlobs[l.part], kParts[l.part].w, kParts[l.part].h, m, l.alpha, false); }
      else { raster::drawBlob(sink, clip, kBlobs[l.part], kParts[l.part].w, kParts[l.part].h, m, l.alpha); }
    }
    else if (allowCache) { drawPart(sink, clip, l.part, m, l.alpha); }
    else { raster::drawBlob(sink, clip, kBlobs[l.part], kParts[l.part].w, kParts[l.part].h, m, l.alpha); }
  }
}
} // namespace

bool begin()
{
  auto alloc = bob::hal().alloc;
  using bob::Mem;
  s_faceBlob = static_cast<uint8_t*>(alloc(static_cast<size_t>(kFaceW) * kFaceH * 3, Mem::kAny));
  s_scratch = static_cast<uint8_t*>(alloc(static_cast<size_t>(kScratch) * kScratch * 2, Mem::kLarge));
  s_ready = s_faceBlob != nullptr && s_scratch != nullptr;
  s_shCov = static_cast<float*>(alloc(sizeof(float) * kShadowMaxW * kShadowMaxH, Mem::kLarge)); // may stay null: no shadow
  s_shTmp = static_cast<float*>(alloc(sizeof(float) * kShadowMaxW * kShadowMaxH, Mem::kLarge));
  s_bake.buf = static_cast<uint8_t*>(alloc(static_cast<size_t>(kFrameW) * kFrameH * 3, Mem::kLarge)); // may stay null: no bake
  for (Slot& s : s_slots) { s.buf = static_cast<uint8_t*>(alloc(static_cast<size_t>(kCacheDim) * kCacheDim * 3, Mem::kLarge)); } // may stay null: no cache
  return s_ready;
}

namespace
{
// What this frame draws, decided once (band 0) and used by every band: the plain layer list, or a baked run between plain layers.
int s_planA = 0, s_planB = -1; // s_planB < s_planA: no baked run
void planFrame(const Layer* layers, int n, const Affine& outer)
{
  s_planA = 0;
  s_planB = -1;
  Sig sig[kMaxLayers];
  bool bakeable[kMaxLayers];
  for (int i = 0; i < n; i++)
  {
    sig[i] = sigOf(layers[i], outer * layers[i].m);
    const bool same = i < s_prevN && sig[i] == s_prevSig[i];
    s_moving[i] = !same;
    s_stableFor[i] = same ? (s_stableFor[i] < 250 ? s_stableFor[i] + 1 : 250) : 0;
    bakeable[i] = layers[i].part != kLayerFace && layers[i].part != kLayerCheeks && s_stableFor[i] >= 2;
  }
  for (int i = 0; i < n; i++) { s_prevSig[i] = sig[i]; }
  s_prevN = n;
  // longest run of bakeable layers
  int bestA = 0, bestB = -1;
  for (int i = 0; i < n;)
  {
    if (!bakeable[i]) { i++; continue; }
    int j = i;
    while (j + 1 < n && bakeable[j + 1]) { j++; }
    if (j - i > bestB - bestA) { bestA = i; bestB = j; }
    i = j + 1;
  }
  if (bestB - bestA + 1 < 3) { s_bake.valid = false; s_bake.building = false; return; }
  bool same = s_bake.first == bestA && s_bake.last == bestB;
  for (int i = bestA; same && i <= bestB; i++) { same = sig[i] == s_bake.sigs[i]; }
  if (s_bake.valid && same) { ++s_bakeHits; }
  else
  {
    if (!(s_bake.building && same))
    {
      ++s_bakeMisses; // a new target: start again from the top
      for (int i = bestA; i <= bestB; i++) { s_bake.sigs[i] = sig[i]; }
      s_bake.first = bestA;
      s_bake.last = bestB;
      s_bake.building = true;
      s_bake.valid = false;
      s_bake.rowsDone = 0;
    }
    constexpr int kBakeBand = 8;
    const int y0 = s_bake.rowsDone, y1 = y0 + kBakeBand < kFrameH ? y0 + kBakeBand : kFrameH;
    memset(s_bake.buf + static_cast<size_t>(y0) * kFrameW * 2, 0, static_cast<size_t>(y1 - y0) * kFrameW * 2);
    memset(s_bake.buf + static_cast<size_t>(kFrameW) * kFrameH * 2 + static_cast<size_t>(y0) * kFrameW, 0, static_cast<size_t>(y1 - y0) * kFrameW);
    raster::BlobOverSink bs{s_bake.buf, kFrameW, kFrameH};
    drawLayers(bs, Clip{0, y0, kFrameW, y1}, layers + bestA, bestB - bestA + 1, outer, false);
    s_bake.rowsDone = y1;
    if (y1 < kFrameH) { return; } // meanwhile Bob is drawn the ordinary way
    // tight box of what was drawn, so the per-frame blit skips the empty margin
    const uint8_t* al = s_bake.buf + static_cast<size_t>(kFrameW) * kFrameH * 2;
    int bx0 = kFrameW, bx1 = 0, by0 = kFrameH, by1 = 0;
    for (int y = 0; y < kFrameH; y++)
      for (int x = 0; x < kFrameW; x++)
        if (al[y * kFrameW + x]) { bx0 = x < bx0 ? x : bx0; bx1 = x > bx1 ? x : bx1; by0 = y < by0 ? y : by0; by1 = y > by1 ? y : by1; }
    s_bake.box = Clip{bx0, by0, bx1 + 1, by1 + 1};
    s_bake.valid = bx1 >= bx0;
    s_bake.building = false;
  }
  if (s_bake.valid) { s_planA = bestA; s_planB = bestB; }
}
} // namespace

int composeBands(const Drive& d) { return fabsf(d.flip) < kFlipLockDeg ? kComposeBands : 1; }

void compose(const bob::Framebuffer& frame, const Look& look, const Drive& d, const FaceState& face, int frameX, int frameY, float scale, float rise, int band, int bands)
{
  if (!s_ready) { return; }
  uint8_t* base = frame.pixels;
  if (base == nullptr) { return; }
  FrameSink sink{base, frame.w * 2};
  // The frame is composed in bands of rows over several loop passes (a whole pass is ~100 ms); band 0 plans the frame.
  const int rowsPer = (frame.h + bands - 1) / bands;
  const Clip clip{0, band * rowsPer, frame.w, (band + 1) * rowsPer < frame.h ? (band + 1) * rowsPer : frame.h};
  s_face = &face;
  Layer layers[kMaxLayers];
  const int n = buildLayers(look, d, layers);
  // A state may draw Bob smaller and higher (pairing, speaking): scale about the rig's transform origin (by the feet), then rise.
  s_smallView = fabsf(scale - 1.0f) > 1e-3f || fabsf(rise) > 1e-3f;
  s_noSnap = false;
  auto rig = [&](float left, float top) {
    return raster::translate(0.0f, rise) * raster::scaleAbout(scale, scale, left + kDemoRigOriginX - frameX, top + kDemoRigOriginY - frameY) *
           raster::translate(left - frameX, top - frameY);
  };
  const float left = kPoseRigLeft[look.pose & 3];
  s_rigExact = rig(left, kDemoRigTop);
  s_rigSnapped = rig(snapGlassX(left), snapGlassY(kDemoRigTop));
  const Affine stage = s_smallView ? s_rigSnapped : s_rigExact;
  // The shadow stays on the ground: it narrows and fades with the hop, and never turns with the flip. Its CSS box snaps
  // like a part (the blur filter makes it a layer), then narrows about its centre.
  {
    const Shadow sh = shadowFor(d);
    const Affine box = placeBox(stage, Affine(), sh.cx - kShadowW / 2, sh.cy - kShadowH / 2, Affine());
    float cx, cy;
    box.apply(kShadowW / 2, kShadowH / 2, &cx, &cy);
    blurredEllipse(sink, clip, cx, cy, sh.rx * scale, sh.ry * scale, kShadowBlur * scale, sh.alpha);
  }
  if (fabsf(d.flip) < kFlipLockDeg)
  {
    const Affine outer = stage; // the hop offset is in each layer (buildLayers)
    if (s_bake.buf == nullptr) { drawLayers(sink, clip, layers, n, outer, true); return; }
    if (band == 0) { planFrame(layers, n, outer); }
    if (s_planB < s_planA) { drawLayers(sink, clip, layers, n, outer, true, 0); return; }
    if (s_planA > 0) { drawLayers(sink, clip, layers, s_planA, outer, true, 0); }
    const Clip bc{s_bake.box.x0 > clip.x0 ? s_bake.box.x0 : clip.x0, s_bake.box.y0 > clip.y0 ? s_bake.box.y0 : clip.y0,
                  s_bake.box.x1 < clip.x1 ? s_bake.box.x1 : clip.x1, s_bake.box.y1 < clip.y1 ? s_bake.box.y1 : clip.y1};
    if (bc.x1 > bc.x0 && bc.y1 > bc.y0) { raster::drawBlob(sink, bc, s_bake.buf, kFrameW, kFrameH, raster::translate(0, 0), 255); }
    if (s_planB + 1 < n) { drawLayers(sink, clip, layers + s_planB + 1, n - s_planB - 1, outer, true, s_planB + 1); }
    return;
  }
  // Backflip: the parts are locked, so compose the upright figure once into a keyed scratch square and turn that.
  const uint16_t key = raster::bswap(kKey);
  uint16_t* sp = reinterpret_cast<uint16_t*>(s_scratch);
  for (int i = 0; i < kScratch * kScratch; i++) { sp[i] = key; }
  FrameSink ssink{s_scratch, kScratch * 2};
  s_noSnap = true;
  drawLayers(ssink, Clip{0, 0, kScratch, kScratch}, layers, n, raster::translate(kScratchMargin, kScratchMargin), false);
  const Affine whole = stage * rootOuter(d) * raster::translate(-kScratchMargin, -kScratchMargin);
  raster::drawSurface(sink, clip, s_scratch, kScratch, kScratch, whole, kKey);
}

void takeCacheStats(uint32_t* hits, uint32_t* misses)
{
  *hits = s_hits;
  *misses = s_misses;
  s_hits = s_misses = 0;
}

void takeBakeStats(uint32_t* hits, uint32_t* misses)
{
  *hits = s_bakeHits;
  *misses = s_bakeMisses;
  s_bakeHits = s_bakeMisses = 0;
}

} // namespace rig
} // namespace bob

#endif // BOB_RIG
