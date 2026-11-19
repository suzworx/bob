// Bob's move library for the rig (docs/waveshare/bob-motion-design.md section 6): per-part keyframe tracks, a
// constexpr table, and the pure functions that sample them. Pure maths, no Arduino: host-tested.
//
// A move is a set of tracks. A track animates one channel of the rig (root, head, belly, arms, button, feet,
// eyes ...) with keys {ms, value, ease}. Every channel is a DELTA from rest, so a channel without a track
// sits at 0 and every move starts and ends at the rest arrangement (moves chain without a jump).
// Sign conventions: angles in degrees, clockwise positive; arm angles are positive OUTWARD / UP for both
// arms (the renderer mirrors the right one); lengths in device px on the 197 px stage; y is down.
// The moves the approved demo has are its own functions (bob_demo_moves.h), converted to these channels; their
// follow-through (arms, head and button lagging the body) is part of each function. nod, shake and dance are
// device-only keyframe tracks.
#pragma once

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "bob_demo_moves.h"
#include "bob_life.h"
#include "bob_rig_data.h"

namespace bob {
namespace moves {

enum Ch : uint8_t {
  kRootRot,      // lean about the feet (clamped to +-8 deg unless the move flips)
  kRootDx, kRootDy,
  kRootSx, kRootSy,  // squash and stretch about the feet (delta from 1)
  kFlip,         // whole-rig rotation, locked parts (backflip); negative = counter-clockwise
  kHeadRot, kHeadDx, kHeadDy,  // about the neck seam
  kBelly,        // belly scale delta (breathing, speaking pulse)
  kButtonRot, kButtonPop, kButtonSpin,  // wobble, lift (px), spin (deg, drawn as a cos flip)
  kVisorDx, kVisorDy,  // visor parallax against the head
  kVisorRot,     // visor turn against the head (deg)
  kArmLRot, kArmRRot,  // outward/up positive, about the shoulder
  kArmLStretch, kArmRStretch,  // rubbery stretch along the arm (delta from 1)
  kArmLDy, kArmRDy,  // shoulder lift (px, up negative)
  kFootLDy, kFootRDy,  // foot lift (px, up negative)
  kCheeks,       // blush 0..1
  kSquint,       // 0..1: >0.5 swaps the eyes for ^ ^
  kEyeOpen,      // delta from open (-1 = shut): lids, droop, slow blinks
  kGazeU, kGazeV,  // extra pupil offset, visor px
  kEyeStyle,     // the eyes a move asks for: demo::Eyes as a number (0 = the feeling's own)
  kChCount
};

enum Ease : uint8_t { kLin, kSoft, kSpring };
constexpr Ease kL = kLin, kE = kSoft, kS = kSpring;

struct Key {
  uint16_t ms;
  float v;
  Ease ease;  // how the segment ARRIVING at this key moves
};

struct Track {
  Ch ch;
  const Key* keys;
  uint8_t n;
};

enum MoveFlags : uint8_t {
  kLoop = 1,    // wraps around (sway, hum)
  kHold = 2,    // the last key stays until the emotion changes (tilt, droop, hand to ear)
  kFlipMove = 4,  // may rotate the whole rig through 360 deg
  kArmsFront = 8,  // both arms are drawn in front of the body (clap)
};

constexpr int8_t kPoseArm = -1;  // keep the pose's own arm

struct Move {
  const char* name;
  uint16_t ms;
  uint8_t flags;
  int8_t armL, armR;  // rig::Part of the arm variant to show, or kPoseArm
  const Track* tracks;
  uint8_t nTracks;
  demo::Fn fn;        // the demo's move function (tracks unused), or null for a keyframe move
  int8_t pose;        // BobPose an explicit move swaps to while it plays, or -1 to keep the pose
};

// The demo's parameters as rig channels: art px to device px, the right arm mirrored to "outward positive", the look in
// visor px (the demo's LK), the button's flip as the angle whose cosine is its width.
constexpr float kDemoLookPx = rig::kArtScale * 1.6f;
inline void demoChannels(const demo::P& p, float out[kChCount]) {
  const float s = rig::kArtScale;
  out[kRootRot] = p.bodyRot;
  out[kRootDx] = p.bodyDx * s;
  out[kRootDy] = p.bodyDy * s;
  out[kRootSx] = p.bodySx - 1.0f;
  out[kRootSy] = p.bodySy - 1.0f;
  out[kFlip] = p.spin;
  out[kHeadRot] = p.headRot;
  out[kHeadDx] = p.headDx * s;
  out[kHeadDy] = p.headDy * s;
  out[kBelly] = p.bellySx - 1.0f;
  out[kButtonRot] = p.button;
  out[kButtonSpin] = acosf(p.buttonSx < -1.0f ? -1.0f : (p.buttonSx > 1.0f ? 1.0f : p.buttonSx)) * 57.29578f;
  out[kVisorDx] = p.visorDx * s;
  out[kVisorDy] = p.visorDy * s;
  out[kVisorRot] = p.visorRot;
  out[kArmLRot] = p.armL;
  out[kArmRRot] = -p.armR;
  out[kArmLStretch] = p.armLs - 1.0f;
  out[kArmRStretch] = p.armRs - 1.0f;
  out[kFootLDy] = p.footL * s;
  out[kFootRDy] = p.footR * s;
  out[kCheeks] = p.blush;
  out[kEyeOpen] = p.squish - 1.0f;
  out[kGazeU] = p.lookX * kDemoLookPx;
  out[kGazeV] = p.lookY * kDemoLookPx;
  out[kEyeStyle] = static_cast<float>(p.eyes);
}

// cubic-bezier(.45, 0, .55, 1), the house ease: bisect x(s) = t and return y(s).
inline float houseEase(float t) {
  if (t <= 0.0f) return 0.0f;
  if (t >= 1.0f) return 1.0f;
  auto bez = [](float s, float p1, float p2) {
    const float u = 1.0f - s;
    return 3.0f * u * u * s * p1 + 3.0f * u * s * s * p2 + s * s * s;
  };
  float lo = 0.0f, hi = 1.0f;
  for (int i = 0; i < 14; i++) {
    const float mid = (lo + hi) * 0.5f;
    (bez(mid, 0.45f, 0.55f) < t ? lo : hi) = mid;
  }
  return bez((lo + hi) * 0.5f, 0.0f, 1.0f);
}

inline float easeBy(Ease e, float x) {
  return e == kSpring ? life::springEase(x) : e == kSoft ? houseEase(x) : (x < 0 ? 0.0f : x > 1 ? 1.0f : x);
}

// Value of one track at time t (ms): before the first key it holds the first value, after the last the last.
inline float sampleTrack(const Track& tr, float t) {
  if (tr.n == 0) return 0.0f;
  if (t <= tr.keys[0].ms) return tr.keys[0].v;
  for (uint8_t i = 1; i < tr.n; i++) {
    if (t <= tr.keys[i].ms) {
      const Key& a = tr.keys[i - 1];
      const Key& b = tr.keys[i];
      const float span = static_cast<float>(b.ms - a.ms);
      const float x = span > 0 ? (t - a.ms) / span : 1.0f;
      return a.v + (b.v - a.v) * easeBy(b.ease, x);
    }
  }
  return tr.keys[tr.n - 1].v;
}

// Fills out[] with every channel's delta at time t (0 for channels the move does not animate).
inline void sampleMove(const Move& m, float t, float out[kChCount]) {
  for (uint8_t c = 0; c < kChCount; c++) out[c] = 0.0f;
  if (m.flags & kLoop) {
    if (m.ms > 0) t = fmodf(t, static_cast<float>(m.ms));
  } else if (t > m.ms) {
    t = m.ms;
  }
  if (m.fn != nullptr) {
    demoChannels(m.fn(m.ms > 0 ? t / m.ms : 1.0f), out);
    return;
  }
  for (uint8_t i = 0; i < m.nTracks; i++) out[m.tracks[i].ch] = sampleTrack(m.tracks[i], t);
}

// One damped spring for follow-through: the channel trails its target by about 1/omega s and overshoots a little.
struct Follow {
  float x = 0.0f, v = 0.0f;
  void step(float target, float dtS, float omega, float zeta) {
    float left = dtS;
    while (left > 0.0f) {  // sub-steps keep the integration stable at 30 fps
      const float h = left > 0.008f ? 0.008f : left;
      const float a = omega * omega * (target - x) - 2.0f * zeta * omega * v;
      v += a * h;
      x += v * h;
      left -= h;
    }
  }
};

// The hand-over spring every channel runs through (about 25 ms): a new move blends from the current pose instead of
// snapping. The follow-through itself is in the demo's moves (their lagged arms, head and button).
constexpr float kHandOverOmega = 40.0f, kHandOverZeta = 0.85f;

// ---- keyframe tables. Times in ms. -----------------------------------------------------------------
template <size_t N>
constexpr Track tr(Ch c, const Key (&k)[N]) {
  return Track{c, k, static_cast<uint8_t>(N)};
}

// The device-only keyframe moves (the demo has no nod, shake or dance loop); every other move is the demo's own function
// (bob_demo_moves.h).
// sway pieces shared by dance (1600, loop): sway with a bounce on every beat and arms that pump.
constexpr Key swRoot[] = {{0, 0, kE}, {400, 6, kE}, {800, 0, kE}, {1200, -6, kE}, {1600, 0, kE}};
constexpr Key swDx[] = {{0, 0, kE}, {400, 3, kE}, {800, 0, kE}, {1200, -3, kE}, {1600, 0, kE}};
constexpr Key swFootL[] = {{0, 0, kE}, {400, -2, kE}, {800, 0, kE}, {1600, 0, kE}};
constexpr Key swFootR[] = {{0, 0, kE}, {800, 0, kE}, {1200, -2, kE}, {1600, 0, kE}};
constexpr Key swBtn[] = {{0, 0, kE}, {400, -8, kE}, {800, 0, kE}, {1200, 8, kE}, {1600, 0, kE}};
constexpr Key swHead[] = {{0, 0, kE}, {400, -3, kE}, {800, 0, kE}, {1200, 3, kE}, {1600, 0, kE}};
constexpr Key dnDy[] = {{0, 0, kE}, {200, -2.5f, kE}, {400, 0, kE}, {600, -2.5f, kE}, {800, 0, kE}, {1000, -2.5f, kE}, {1200, 0, kE}, {1400, -2.5f, kE}, {1600, 0, kE}};
constexpr Key dnArm[] = {{0, 0, kE}, {200, 9, kE}, {400, -3, kE}, {600, 9, kE}, {800, -3, kE}, {1000, 9, kE}, {1200, -3, kE}, {1400, 9, kE}, {1600, 0, kE}};
constexpr Key dnSquint[] = {{0, 1, kE}, {1600, 1, kE}};
constexpr Key dnCheek[] = {{0, 0.3f, kE}, {1600, 0.3f, kE}};
constexpr Track kDanceTr[] = {tr(kRootRot, swRoot), tr(kRootDx, swDx), tr(kRootDy, dnDy), tr(kArmLRot, dnArm), tr(kArmRRot, dnArm), tr(kFootLDy, swFootL),
                              tr(kFootRDy, swFootR), tr(kButtonRot, swBtn), tr(kHeadRot, swHead), tr(kSquint, dnSquint), tr(kCheeks, dnCheek)};

// nod (800): two soft nods; shake (700): a kind "hm, no", never harsh.
constexpr Key ndHead[] = {{0, 0, kE}, {140, -3, kE}, {280, 4, kS}, {480, -2, kE}, {620, 3, kS}, {800, 0, kS}};
constexpr Key ndDy[] = {{0, 0, kE}, {280, 1.2f, kE}, {400, 0, kE}, {620, 1.2f, kE}, {800, 0, kS}};
constexpr Track kNodTr[] = {tr(kHeadRot, ndHead), tr(kRootDy, ndDy)};
constexpr Key skHead[] = {{0, 0, kE}, {110, -4, kE}, {260, 4, kE}, {420, -3, kE}, {560, 2, kE}, {700, 0, kS}};
constexpr Key skVisor[] = {{0, 0, kE}, {110, -1.5f, kE}, {260, 1.5f, kE}, {420, -1, kE}, {700, 0, kS}};
constexpr Key skRoot[] = {{0, 0, kE}, {200, 1.5f, kE}, {450, -1, kE}, {700, 0, kS}};
constexpr Track kShakeTr[] = {tr(kHeadRot, skHead), tr(kVisorDx, skVisor), tr(kRootRot, skRoot)};

constexpr int8_t kEar = rig::kArmLEar, kChin = rig::kArmLChin;
constexpr int8_t kDownL = rig::kArmLDown, kDownR = rig::kArmRDown, kUpL = rig::kArmLUp, kUpR = rig::kArmRUp;
// BobPose order (bob_art.h): the pose a move swaps to while it plays as an explicit move (the demo's MV[].pose).
constexpr int8_t kHelper = 0, kCurious = 1, kThoughtful = 2, kPlayful = 3, kKeepPose = -1;

enum MoveId : uint8_t {
  kMvWave, kMvHandToEar, kMvChinRub, kMvArmsUp, kMvClap, kMvPoint, kMvShrug, kMvFootTap, kMvHop, kMvHappyWiggle, kMvSway, kMvDance, kMvBow,
  kMvLookAround, kMvButtonSpin, kMvButtonWobble, kMvShiver, kMvDroop, kMvYawn, kMvStretch, kMvPressSquish, kMvTapGiggle, kMvHum, kMvBackflip,
  kMvNod, kMvShake, kMvCuriousTilt, kMvDelight, kMvShyLookAway, kMvBellySpeak, kMoveCount
};

// Keyframe move (device only): its pose is kept.
#define BOB_MOVE(name, ms, flags, armL, armR, tracks) {name, ms, flags, armL, armR, tracks, static_cast<uint8_t>(sizeof(tracks) / sizeof(Track)), nullptr, kKeepPose}
// The demo's move: MV[name] = {fn, dur, pose, arms, front}. Reactions (tap-giggle, press-squish) keep the pose and arms.
#define BOB_DEMO_MOVE(name, ms, flags, pose, armL, armR, fn) {name, ms, flags, armL, armR, nullptr, 0, fn, pose}
constexpr Move kMoves[kMoveCount] = {
    BOB_DEMO_MOVE("wave", 1300, 0, kHelper, kDownL, rig::kArmRWave, demo::wave),
    BOB_DEMO_MOVE("hand-to-ear", 650, kHold | kArmsFront, kCurious, kEar, kDownR, demo::ear),
    BOB_DEMO_MOVE("chin-rub", 1300, kArmsFront, kThoughtful, kChin, rig::kArmRDown2, demo::chin),
    BOB_DEMO_MOVE("arms-up", 900, 0, kPlayful, kUpL, kUpR, demo::armsUp),
    BOB_DEMO_MOVE("clap", 1000, kArmsFront, kHelper, kDownL, kDownR, demo::clap),
    BOB_DEMO_MOVE("point", 900, 0, kHelper, kDownL, rig::kArmRWave, demo::point),
    BOB_DEMO_MOVE("shrug", 800, 0, kHelper, kDownL, kDownR, demo::shrug),
    BOB_DEMO_MOVE("foot-tap", 1100, 0, kHelper, kDownL, kDownR, demo::footTap),
    BOB_DEMO_MOVE("hop", 650, 0, kPlayful, kUpL, kUpR, demo::hop),
    BOB_DEMO_MOVE("happy-wiggle", 1000, 0, kPlayful, kUpL, kUpR, demo::wiggle),
    BOB_DEMO_MOVE("sway", 1600, kLoop, kPlayful, kUpL, kUpR, demo::sway),
    BOB_MOVE("dance", 1600, kLoop, kUpL, kUpR, kDanceTr),
    BOB_DEMO_MOVE("bow", 1000, 0, kHelper, kDownL, kDownR, demo::bow),
    BOB_DEMO_MOVE("look-around", 1600, 0, kHelper, kDownL, kDownR, demo::look),
    BOB_DEMO_MOVE("button-spin", 900, 0, kPlayful, kUpL, kUpR, demo::buttonSpin),
    BOB_DEMO_MOVE("button-wobble", 900, 0, kHelper, kDownL, kDownR, demo::buttonWobble),
    BOB_DEMO_MOVE("shiver", 800, kArmsFront, kThoughtful, kChin, rig::kArmRDown2, demo::shiver),
    BOB_DEMO_MOVE("droop", 1000, kHold, kHelper, kDownL, kDownR, demo::droop),
    BOB_DEMO_MOVE("sleepy-yawn", 2400, 0, kHelper, kDownL, kDownR, demo::yawn),
    BOB_DEMO_MOVE("stretch", 1200, 0, kHelper, kDownL, kDownR, demo::stretch),
    BOB_DEMO_MOVE("press-squish", 900, kHold, kKeepPose, kPoseArm, kPoseArm, demo::press),
    BOB_DEMO_MOVE("tap-giggle", 1000, 0, kKeepPose, kPoseArm, kPoseArm, demo::giggle),
    BOB_DEMO_MOVE("hum", 1600, kLoop, kPlayful, kUpL, kUpR, demo::hum),
    BOB_DEMO_MOVE("backflip", 900, kFlipMove, kPlayful, kUpL, kUpR, demo::backflip),
    BOB_MOVE("nod", 800, 0, kPoseArm, kPoseArm, kNodTr),
    BOB_MOVE("shake", 700, 0, kPoseArm, kPoseArm, kShakeTr),
    BOB_DEMO_MOVE("curious-tilt", 800, kHold | kArmsFront, kCurious, kEar, kDownR, demo::tilt),
    BOB_DEMO_MOVE("delight", 900, 0, kPlayful, kUpL, kUpR, demo::delight),
    BOB_DEMO_MOVE("shy-look-away", 1200, 0, kHelper, kDownL, kDownR, demo::shy),
    BOB_DEMO_MOVE("belly-speaking-pulse", 1400, kLoop, kPlayful, kUpL, kUpR, demo::bellySpeak),
};
#undef BOB_DEMO_MOVE
#undef BOB_MOVE

inline const Move& moveById(MoveId id) { return kMoves[id]; }

// Looks a move up by name; null when unknown.
inline const Move* moveByName(const char* name) {
  for (uint8_t i = 0; i < kMoveCount; i++) {
    if (strcmp(kMoves[i].name, name) == 0) return &kMoves[i];
  }
  return nullptr;
}

// The gesture of an emotion (BobGesture order: none, nod, shake, bounce, shiver, bow, wobble, dance, tilt, slump, sway)
// as a move; -1 for none.
inline int moveForGesture(uint8_t gesture) {
  static const int8_t kMap[] = {-1, kMvNod, kMvShake, kMvHop, kMvShiver, kMvBow, kMvHappyWiggle, kMvDance, kMvCuriousTilt, kMvDroop, kMvSway};
  return gesture < sizeof(kMap) ? kMap[gesture] : -1;
}

}  // namespace moves
}  // namespace bob
