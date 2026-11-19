// Bob as a rig of independent parts (docs/waveshare/bob-motion-design.md): the pure kinematics. Every part has
// its own transform (a rotation about its pivot, plus offset and scale) on its own clock; this header turns the
// driven values into one Affine per part, in draw order. No Arduino: host-tested (test_bob_rig.cpp).
// The renderer (blobs, cache, compose into a bob::Framebuffer) is bob_rig.cpp, built with BOB_RIG.
#pragma once

#include <math.h>
#include <stdint.h>

#include "bob_moves.h"
#include "bob_raster.h"
#include "bob_rig_data.h"

namespace bob {
namespace rig {

using raster::Affine;

// Two layers that are not blobs: the procedural face (eyes, lids; drawn on the visor) and the cheeks.
constexpr uint8_t kLayerFace = kPartCount, kLayerCheeks = kPartCount + 1;

// The demo's pivots (art px x kArtScale): the body turns and squashes about (240, 430), the bottom centre of the body
// (its root layer's transform-origin); the hop offset and the backflip turn about (240, 290) (its float layer's).
constexpr float kRootPivotX = 240.0f * kArtScale, kRootPivotY = 430.0f * kArtScale;
constexpr float kFigureCx = 240.0f * kArtScale, kFigureCy = 290.0f * kArtScale;
constexpr float kMaxLeanDeg = 8.0f;  // body rotation limit outside the backflip

// Everything the renderer needs for one frame. Channels are the final values after follow-through.
struct Drive {
  float rootRot = 0, rootDx = 0, rootDy = 0, rootSx = 1, rootSy = 1;
  float flip = 0;  // whole-rig rotation, degrees
  float headRot = 0, headDx = 0, headDy = 0;
  float belly = 0;
  float buttonRot = 0, buttonPop = 0, buttonSpin = 0;
  float visorDx = 0, visorDy = 0, visorRot = 0;
  float armLRot = 0, armRRot = 0, armLStretch = 0, armRStretch = 0, armLDy = 0, armRDy = 0;  // outward positive
  float footLDy = 0, footRDy = 0;
  float cheeks = 0;
};

// Which arm variants are shown. A variant swap cross-fades: `prev` fades out while `cur` fades in (mix 0..1).
struct ArmSlot {
  Part cur, prev;
  float mix;
  ArmSlot(Part c = kArmLDown, Part p = kArmLDown, float m = 1.0f) : cur(c), prev(p), mix(m) {}
};

struct Look {
  uint8_t pose = 0;  // BobPose index: 0 helper/welcome, 1 curious, 2 thoughtful, 3 playful
  ArmSlot armL{kArmLDown, kArmLDown, 1.0f}, armR{kArmRWave, kArmRWave, 1.0f};
  bool armsFront = false;  // both arms in front of the body (clap)
};

inline float clampf(float v, float lo, float hi) { return v < lo ? lo : v > hi ? hi : v; }

// The body lean is limited to +-8 deg; only the backflip (Drive::flip) turns further.
inline float clampLean(float deg) { return clampf(deg, -kMaxLeanDeg, kMaxLeanDeg); }

// Root transform without translation and flip: lean and squash about the feet.
inline Affine rootInner(const Drive& d) {
  return raster::rotateAbout(clampLean(d.rootRot), kRootPivotX, kRootPivotY) * raster::scaleAbout(d.rootSx, d.rootSy, kRootPivotX, kRootPivotY);
}

// Applied on top of the root: hop offset and the backflip turn about the figure centre.
inline Affine rootOuter(const Drive& d) { return raster::translate(d.rootDx, d.rootDy) * raster::rotateAbout(d.flip, kFigureCx, kFigureCy); }

// A part placed on the stage by `pivotAt` (where its pivot lands), rotated by rot, scaled by s about that pivot.
inline Affine placeAt(Part p, float rot, float sx, float sy, float atX, float atY) {
  return raster::translate(atX, atY) * raster::rotate(rot) * raster::scale(sx, sy) * raster::translate(-kParts[p].pivotX, -kParts[p].pivotY);
}

// Head group: the head, visor, face, cheeks and button turn together about the neck seam.
inline Affine headGroup(const PoseRig& pr, const Drive& d) { return raster::translate(d.headDx, d.headDy) * raster::rotateAbout(d.headRot, pr.seamX, pr.seamY); }

struct Layer {
  uint8_t part;  // Part, kLayerFace or kLayerCheeks
  uint8_t alpha;
  Affine m;      // part pixels -> stage: m = anc * translate(bx, by) * own (the feet take neither the lean, squash nor hop)
  // The same split the demo's DOM has, so the renderer can put the part on the pixel Chrome puts it on: `anc` is what the
  // part's ancestor layers do (hop offset, lean and squash, the head group), (bx, by) is where its box sits on the stage
  // (CSS left/top), `own` its own transform about its pivot (part px -> box px).
  Affine anc;
  float bx, by;
  Affine own;
};
constexpr float kFlipLockDeg = 0.5f;  // a flip at least this far composes the locked figure and turns it (bob_rig.cpp)
constexpr int kMaxLayers = 14;

struct Shadow {
  float cx, cy, rx, ry, alpha;  // alpha 0..1 of the darkening
  float sx;                     // horizontal scale about the centre (rx already includes it)
};

// The demo's .shadow box: a 99 x 11 ellipse at (49, 187) of the rig, rgba(8,20,30,.55), blurred by 2.5 px. It stays
// on the ground (it never follows the body's sway or flip) and, as the body lifts, narrows and fades:
// scale(1 - .28 * min(lift, 30) / 30 + (bodySx - 1) * .6, 1), opacity 1 - .4 * min(lift, 30) / 30 (approved-demo.html paint()).
constexpr float kShadowX = 49.0f, kShadowY = 187.0f, kShadowW = 99.0f, kShadowH = 11.0f, kShadowAlpha = 0.55f, kShadowBlur = 2.5f;
constexpr uint32_t kShadowRgb = 0x08141E;  // rgb(8, 20, 30)
constexpr float kShadowLiftPx = 30.0f, kShadowLiftNarrow = 0.28f, kShadowLiftFade = 0.4f, kShadowSquashFollow = 0.6f;

inline Shadow shadowFor(const Drive& d) {
  const float lift = clampf(-d.rootDy, 0.0f, kShadowLiftPx) / kShadowLiftPx;
  const float sx = 1.0f - kShadowLiftNarrow * lift + (d.rootSx - 1.0f) * kShadowSquashFollow;
  return Shadow{kShadowX + kShadowW / 2, kShadowY + kShadowH / 2, kShadowW / 2 * sx, kShadowH / 2, kShadowAlpha * (1.0f - kShadowLiftFade * lift), sx};
}

inline uint8_t alphaOf(float f) { return static_cast<uint8_t>(clampf(f, 0.0f, 1.0f) * 255.0f + 0.5f); }

// Builds the layers back to front: feet, back arms, belly, head, visor, face, cheeks, button, front arms.
// (The shadow is drawn first by the renderer, from shadowFor.) Returns the layer count.
inline int buildLayers(const Look& look, const Drive& d, Layer out[kMaxLayers]) {
  const PoseRig& pr = kPoses[look.pose & 3];
  // In the backflip the parts are locked: the renderer turns the composed figure (rootOuter), so the hop offset stays out
  // of the layers and the feet ride the body like everything else.
  const bool locked = fabsf(d.flip) >= kFlipLockDeg;
  const Affine body = (locked ? Affine() : raster::translate(d.rootDx, d.rootDy)) * rootInner(d);
  int n = 0;
  // a part whose pivot lands at (atX, atY), turned by rot and scaled about the pivot, nudged by (dx, dy) after
  auto own = [](Part p, float rot, float sx, float sy, float dx, float dy) {
    const float px = kParts[p].pivotX, py = kParts[p].pivotY;
    return raster::translate(px + dx, py + dy) * raster::rotate(rot) * raster::scale(sx, sy) * raster::translate(-px, -py);
  };
  auto addA = [&](uint8_t part, const Affine& anc, float bx, float by, const Affine& o, uint8_t alpha) {
    if (n < kMaxLayers && alpha > 0) out[n++] = Layer{part, alpha, anc * raster::translate(bx, by) * o, anc, bx, by, o};
  };
  // feet: on the ground, outside the body (the demo's feet layers): they neither lean, squash nor hop with it, only lift
  // by their own channel
  auto foot = [&](Part p, const Placed& pl, float dy) {
    addA(p, locked ? rootInner(d) : Affine(), pl.x - kParts[p].pivotX, pl.y - kParts[p].pivotY, own(p, pl.rot, pl.scale, pl.scale, 0.0f, dy), 255);
  };
  foot(kFootL, pr.footL, d.footLDy);
  foot(kFootR, pr.footR, d.footRDy);
  // arms: left turns clockwise-positive, the right one is mirrored so "outward" is positive for both. Every arm variant
  // hangs from the POSE's shoulder on its side (the demo's applyPlacement), not from the shoulder of the art it was cut from.
  auto arm = [&](Part p, float rot, float stretch, float dy, float alpha, bool right) {
    const Shoulder& s = kShoulders[right ? pr.armR : pr.armL];
    addA(p, body, s.x - kParts[p].pivotX, s.y - kParts[p].pivotY, own(p, right ? -rot : rot, 1.0f, 1.0f + stretch, 0.0f, dy), alphaOf(alpha));
  };
  auto arms = [&](bool front) {
    const bool onTop = look.armsFront || kParts[look.armL.cur].front;
    if (onTop == front) {
      if (look.armL.mix < 1.0f) arm(look.armL.prev, d.armLRot, d.armLStretch, d.armLDy, 1.0f - look.armL.mix, false);
      arm(look.armL.cur, d.armLRot, d.armLStretch, d.armLDy, look.armL.mix, false);
    }
    const bool onTopR = look.armsFront || kParts[look.armR.cur].front;
    if (onTopR == front) {
      if (look.armR.mix < 1.0f) arm(look.armR.prev, d.armRRot, d.armRStretch, d.armRDy, 1.0f - look.armR.mix, true);
      arm(look.armR.cur, d.armRRot, d.armRStretch, d.armRDy, look.armR.mix, true);
    }
  };
  arms(false);
  // belly: breathing and the speaking pulse scale it about its base; arms and feet do not follow
  addA(pr.belly, body, pr.bellyX, pr.bellyY, own(pr.belly, 0.0f, 1.0f + d.belly, 1.0f + 1.5f * d.belly, 0.0f, 0.0f), 255);
  const Affine group = body * headGroup(pr, d);
  addA(pr.head, group, pr.headX, pr.headY, Affine(), 255);
  const float vbx = pr.visor.x - kParts[kVisor].pivotX, vby = pr.visor.y - kParts[kVisor].pivotY;
  const Affine vown = own(kVisor, pr.visor.rot + d.visorRot, pr.visor.scale, pr.visor.scale, d.visorDx, d.visorDy);
  addA(kVisor, group, vbx, vby, vown, 255);
  addA(kLayerFace, group, vbx, vby, vown, 255);
  addA(kLayerCheeks, group, vbx, vby, vown, alphaOf(d.cheeks));
  // button: wobble, pop and the cos flip of a spin
  {
    const float spin = cosf(d.buttonSpin * 0.017453292f);
    const float sx = fabsf(spin) < 0.08f ? (spin < 0 ? -0.08f : 0.08f) : spin;
    addA(kButton, group, pr.button.x - kParts[kButton].pivotX, pr.button.y - kParts[kButton].pivotY,
         own(kButton, pr.button.rot + d.buttonRot, pr.button.scale * sx, pr.button.scale, 0.0f, d.buttonPop), 255);
  }
  arms(true);
  return n;
}

// Position of the figure's pivot point after the whole transform, e.g. to keep a rotated part honest in tests.
inline void stagePoint(const Drive& d, float x, float y, float* ox, float* oy) { (rootOuter(d) * rootInner(d)).apply(x, y, ox, oy); }

// ---- The driver: move channels in, final Drive out, with follow-through springs. ----------------------------------
using moves::Follow;

// The face::EyeStyle a move's demo::Eyes asks for, or -1 for the feeling's own (the two enums share their order).
inline int8_t moveEyeStyle(float channel) {
  const int v = static_cast<int>(lroundf(channel));
  return v <= 0 ? static_cast<int8_t>(-1) : static_cast<int8_t>(v - 1);
}

struct Extras {
  float squish = 0;      // a held touch, 0..1 (press-squish blended on top of any move)
  float speakLevel = 0;  // playbackLevel01()
  float breathe = 0;     // -1..1 idle breathing phase
  float gazeU = 0, gazeV = 0;
};

class Driver {
 public:
  // Advances the channels by dtS toward the targets `ch` (moves::sampleMove output). The demo's moves carry their own
  // follow-through (lagged arms, button and head), so every channel only gets the light hand-over spring (about 25 ms)
  // that keeps one move handing over to the next from popping.
  void step(const float ch[moves::kChCount], const Extras& ex, float dtS) {
    using namespace moves;
    rrot_.step(ch[kRootRot], dtS, kHandOverOmega, kHandOverZeta);
    rdx_.step(ch[kRootDx], dtS, kHandOverOmega, kHandOverZeta);
    rdy_.step(ch[kRootDy], dtS, kHandOverOmega, kHandOverZeta);
    rsx_.step(ch[kRootSx], dtS, kHandOverOmega, kHandOverZeta);
    rsy_.step(ch[kRootSy], dtS, kHandOverOmega, kHandOverZeta);
    head_.step(ch[kHeadRot], dtS, kHandOverOmega, kHandOverZeta);
    headDx_.step(ch[kHeadDx], dtS, kHandOverOmega, kHandOverZeta);
    headDy_.step(ch[kHeadDy], dtS, kHandOverOmega, kHandOverZeta);
    armL_.step(ch[kArmLRot], dtS, kHandOverOmega, kHandOverZeta);
    armR_.step(ch[kArmRRot], dtS, kHandOverOmega, kHandOverZeta);
    stretchL_.step(ch[kArmLStretch], dtS, kHandOverOmega, kHandOverZeta);
    stretchR_.step(ch[kArmRStretch], dtS, kHandOverOmega, kHandOverZeta);
    button_.step(ch[kButtonRot], dtS, kHandOverOmega, kHandOverZeta);
    pop_.step(ch[kButtonPop], dtS, kHandOverOmega, kHandOverZeta);
    pulse_.step(ex.speakLevel, dtS, 22.0f, 0.9f);
    cheeks_.step(ch[kCheeks], dtS, 14.0f, 1.0f);
    squish_.step(ex.squish, dtS, 16.0f, 0.75f);
    d_ = Drive();
    const float q = clampf(squish_.x, 0.0f, 1.2f);
    d_.rootRot = rrot_.x - 3.0f * q;
    d_.rootDx = rdx_.x;
    d_.rootDy = rdy_.x;
    d_.rootSx = 1.0f + rsx_.x + 0.045f * q;
    d_.rootSy = 1.0f + rsy_.x - 0.07f * q;
    d_.flip = ch[kFlip];
    d_.headRot = head_.x + 0.8f * ex.gazeU;
    d_.headDx = headDx_.x;
    d_.headDy = headDy_.x - 1.0f * pulse_.x + 0.9f * ex.breathe; // breathing lives in the belly and head, so a calm figure stays a pure translation
    d_.belly = ch[kBelly] + 0.012f * ex.breathe + 0.035f * clampf(pulse_.x, 0.0f, 1.0f);
    d_.buttonRot = button_.x + 8.0f * q;
    d_.buttonPop = pop_.x;
    d_.buttonSpin = ch[kButtonSpin];
    d_.visorDx = ch[kVisorDx] + 1.2f * ex.gazeU;
    d_.visorDy = ch[kVisorDy] + 1.0f * ex.gazeV;
    d_.visorRot = ch[kVisorRot];
    d_.armLRot = armL_.x - 14.0f * q;
    d_.armRRot = armR_.x - 14.0f * q;
    d_.armLStretch = stretchL_.x;
    d_.armRStretch = stretchR_.x;
    d_.armLDy = ch[kArmLDy];
    d_.armRDy = ch[kArmRDy];
    d_.footLDy = ch[kFootLDy];
    d_.footRDy = ch[kFootRDy];
    d_.cheeks = clampf(cheeks_.x + 0.8f * q, 0.0f, 1.0f);
  }
  const Drive& drive() const { return d_; }
  void reset() { *this = Driver(); }

 private:
  Follow rrot_, rdx_, rdy_, rsx_, rsy_, head_, headDx_, headDy_, armL_, armR_, stretchL_, stretchR_, button_, pop_, pulse_, cheeks_, squish_;
  Drive d_;
};

// Advances a cross-fade: when `want` differs from the shown variant the old one starts fading out over `fadeMs`.
inline void armSwap(ArmSlot* s, Part want, float dtMs, float fadeMs = 80.0f) {
  if (want != s->cur) {
    s->prev = s->cur;
    s->cur = want;
    s->mix = 0.0f;
  }
  if (s->mix < 1.0f) s->mix = clampf(s->mix + dtMs / fadeMs, 0.0f, 1.0f);
}

}  // namespace rig
}  // namespace bob

// ---- Renderer (bob_rig.cpp) --------------------------------------------------------------------------------------
#if defined(BOB_RIG)

#include "bob_emotion_table.h"
#include "bob_hal.h"
#include "bob_tokens.h"

namespace bob {
namespace rig {

// Where the 197 px stage sits in the 232 x 240 Bob frame (centred on the old 192 px pose box).
constexpr int kStageOx = 18, kStageOy = 28;
constexpr bool kMotionLod = true; // big parts use the nearest sampler while they move (settled frames are bilinear)
// Where the stage's top-left sits on the glass, exactly as the approved demo places it: x is the pose's kPoseRigLeft
// (bob_rig_data.h: the body centred on x 180, as the demo writes it), y the demo's .rig top, calc(--bob-feet-y - 194.5px).
constexpr float kDemoRigFeetToTop = 194.5f;
// The demo's .rig transform-origin (98.5px 194px): a small-Bob view scales about this point of the rig box.
constexpr float kDemoRigOriginX = kStage / 2.0f, kDemoRigOriginY = 194.0f;
constexpr float kDemoRigTop = static_cast<float>(bobtok::kBobFeetY) - kDemoRigFeetToTop;

struct FaceState {
  BobEyes eyes = BobEyes::kDot;
  float open = 1.0f;
  float lookU = 0, lookV = 0, gazeU = 0, gazeV = 0;
  int8_t style = -1;  // a move's eyes (face::EyeStyle) over the feeling's, or -1
  float tilt = 0;     // body + head turn (deg): the demo nudges the catch-light with it
};


// Allocates the face canvas, the backflip scratch and the part caches. False (rig unusable) when PSRAM is missing.
bool begin();

// Composes shadow, feet, arms, belly, head, face, button and front arms into `frame` (which holds the ground colour).
constexpr int kComposeBands = 8;  // a frame is composed in this many bands of rows, one per loop pass
int composeBands(const Drive& drive);  // 1 for the locked backflip figure, else kComposeBands
void compose(const bob::Framebuffer& frame, const Look& look, const Drive& drive, const FaceState& face, int frameX, int frameY, float scale = 1.0f, float rise = 0.0f, int band = 0, int bands = 1);

// Cache hits and misses since the last call, for the journal.
void takeCacheStats(uint32_t* hits, uint32_t* misses);
void takeBakeStats(uint32_t* hits, uint32_t* misses);  // baked static-run hits / re-bakes since the last read

}  // namespace rig
}  // namespace bob

#endif  // BOB_RIG
