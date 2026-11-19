#if defined(BOB_BOARD_WAVESHARE_185C)

#include "bob_motion.h"

#include <M5Unified.h>

#include "bob_emotions.h"
#include "bob_life.h"
#include "bob_tokens.h"
#include "bob_moves.h"
#include "bob_rig.h"
#if defined(BOB_RIG)
namespace bob { float playbackLevel01(); }  // only this call is needed, not the whole player header
#endif
#include <math.h>

// The pose images are .incbin'd by bob_art.cpp; read them here as plain symbols.
extern "C" const uint8_t bob_welcome[];
extern "C" const uint8_t bob_curious[];
extern "C" const uint8_t bob_thoughtful[];
extern "C" const uint8_t bob_playful[];

namespace bob
{
namespace
{
// --- Timing, from heybob.app globals.css (.bob-icon): 650 ms gestures, cubic-bezier(.45,0,.55,1).
constexpr uint32_t kGestureMs = 650;
constexpr uint32_t kFadeMs = 200;
constexpr uint32_t kFrameMs = 33; // 30 fps cap
constexpr float kBreathMs = 3200.0f;
constexpr float kPxScale = 192.0f / 88.0f; // the site's px values are for an 88 px icon
constexpr float kBreathPx = 2.0f * kPxScale;

// Pivot at 50% x / 90% y of the 192 px image, relative to the image centre.
constexpr float kPivotDy = 192.0f * 0.9f - 96.0f;

// The composed frame: pose box plus room for the largest gesture, pose centred in it.
// The frame spans from the token clip top (the top-gap rule: 6 px below the status discs) to the same distance below Bob's centre,
// so nothing of Bob is ever cut at the hop and backflip apex.
constexpr int16_t kFrameW = 232, kFrameH = bobtok::kBobFrameH, kTopOff = bobtok::kBobCy - bobtok::kBobFrameTop; // kTopOff: Bob's centre below the frame top
constexpr float kFrameCx = kFrameW / 2.0f, kFrameCy = kFrameH / 2.0f;

constexpr uint16_t kGround = kBobGround;
constexpr uint16_t kVisor = 0x2945; // dark visor colour sampled from the welcome art (native RGB565)

// Eye centres in the 192 px art (welcome, curious, thoughtful); playful's eyes are closed arcs.
struct Eyes
{
  bool has;
  int16_t lx, ly, rx, ry;
};
constexpr Eyes kEyes[kBobPoseCount] = {{true, 76, 52, 108, 48}, {true, 67, 54, 99, 47}, {true, 72, 44, 104, 51}, {false, 0, 0, 0, 0}};
constexpr int16_t kEyeHalf = 6; // blink cover: a (2 * kEyeHalf) square around each eye centre
constexpr uint32_t kBlinkMs = 120;
// Rotated frames: anti-aliased costs ~55 ms/frame (about 18 fps during the 650 ms gesture),
// plain rotate ~14 ms (30 fps) with crawling edges. Unrotated idle frames are a ~14 ms copy.
constexpr bool kAaGesture = true;

struct Key
{
  float t;   // 0..1 of the gesture
  float rot; // degrees, clockwise
  float ty;  // CSS px at 88 px icon size, down positive
  float tx;  // same units, right positive
  constexpr Key(float t_, float rot_, float ty_, float tx_ = 0) : t(t_), rot(rot_), ty(ty_), tx(tx_) {}
};
struct Gesture
{
  const Key* keys;
  uint8_t n;
  uint16_t ms;
  constexpr Gesture(const Key* k, uint8_t count, uint16_t duration = kGestureMs) : keys(k), n(count), ms(duration) {}
};
// Emotion gestures (BobGesture), same keyframe model and easing. A gesture ends on its last key
// and holds it (tilt, slump) until the emotion changes or its loop replays it.
const Key kNod[] = {{0, 0, 0}, {0.25f, 0, 3}, {0.5f, 0, 0}, {0.75f, 0, 3}, {1, 0, 0}};
const Key kShake[] = {{0, 0, 0}, {0.2f, -6, 0}, {0.4f, 6, 0}, {0.6f, -6, 0}, {0.8f, 6, 0}, {1, 0, 0}};
const Key kBounce[] = {{0, 0, 0}, {0.2f, 0, -8}, {0.4f, 0, 0}, {0.6f, 0, -8}, {0.8f, 0, 0}, {1, 0, 0}};
const Key kShiver[] = {{0, 0, 0, 0}, {0.1f, 0, 0, 1.5f}, {0.2f, 0, 0, -1.5f}, {0.3f, 0, 0, 1.5f}, {0.4f, 0, 0, -1.5f}, {0.5f, 0, 0, 1.5f}, {0.6f, 0, 0, -1.5f}, {0.7f, 0, 0, 1.5f}, {0.8f, 0, 0, -1.5f}, {1, 0, 0, 0}};
const Key kBow[] = {{0, 0, 0}, {0.4f, 12, 3}, {0.7f, 12, 3}, {1, 0, 0}};
const Key kWobble[] = {{0, 0, 0}, {0.2f, -5, 0}, {0.4f, 5, 0}, {0.6f, -5, 0}, {0.8f, 5, 0}, {1, 0, 0}};
const Key kDance[] = {{0, 0, 0}, {0.2f, -6, -4}, {0.4f, 6, 0}, {0.6f, -6, -4}, {0.8f, 6, 0}, {1, 0, 0}};
const Key kTilt[] = {{0, 0, 0}, {1, -7, 0}};
const Key kSlump[] = {{0, 0, 0}, {1, 0, 3}};
const Key kSway[] = {{0, 0, 0}, {0.25f, 5, 0}, {0.5f, 0, 0}, {0.75f, -5, 0}, {1, 0, 0}};
const Gesture kEmoGestures[] = {{nullptr, 0},     {kNod, 5, 800},    {kShake, 6, 700}, {kBounce, 6, 900}, {kShiver, 10, 600},
                                {kBow, 4, 1200},  {kWobble, 6, 900}, {kDance, 6, 1000}, {kTilt, 2, 500},   {kSlump, 2, 700},
                                {kSway, 5, 1500}};

// Tap giggle and idle micro-behaviours: small, soft, played over the emotion's own gesture.
const Key kGiggleKeys[] = {{0, 0, 0}, {0.12f, -5, -2}, {0.30f, 5, 0}, {0.48f, -4, -1}, {0.66f, 3, 0}, {0.84f, -1.5f, 0}, {1, 0, 0}};
const Key kButtonKeys[] = {{0, 0, 0}, {0.2f, 2.5f, 0}, {0.4f, -2.5f, 0}, {0.6f, 2, 0}, {0.8f, -1, 0}, {1, 0, 0}};
const Key kHopKeys[] = {{0, 0, 0}, {0.3f, 0, -5}, {0.6f, 0, 0}, {0.8f, 0, -1.5f}, {1, 0, 0}};
const Gesture kGiggle(kGiggleKeys, 7, 700), kButtonWobble(kButtonKeys, 6, 500), kHop(kHopKeys, 5, 500);
const Key kWelcome[] = {{0, 0, 0}, {0.33f, -8, 0}, {0.66f, 6, 0}, {1, 0, 0}};
const Key kCurious[] = {{0, 0, 0}, {0.35f, -7, -2}, {0.65f, -7, -2}, {1, 0, 0}};
const Key kThoughtful[] = {{0, 0, 0}, {0.5f, 4, -3}, {1, 0, 0}};
const Key kPlayful[] = {{0, 0, 0}, {0.25f, -4, -8}, {0.5f, 0, 0}, {0.75f, 4, -4}, {1, 0, 0}};
const Gesture kGestures[kBobPoseCount] = {{kWelcome, 4}, {kCurious, 4}, {kThoughtful, 3}, {kPlayful, 5}};

const uint8_t* const kImages[kBobPoseCount] = {bob_welcome, bob_curious, bob_thoughtful, bob_playful};

// cubic-bezier(.45, 0, .55, 1): solve x(s) = t by bisection, return y(s).
float ease(float t)
{
  auto bez = [](float s, float p1, float p2) {
    const float u = 1.0f - s;
    return 3.0f * u * u * s * p1 + 3.0f * u * s * s * p2 + s * s * s;
  };
  float lo = 0.0f, hi = 1.0f;
  for (int i = 0; i < 18; i++)
  {
    const float mid = (lo + hi) * 0.5f;
    (bez(mid, 0.45f, 0.55f) < t ? lo : hi) = mid;
  }
  return bez((lo + hi) * 0.5f, 0.0f, 1.0f);
}

// Rotation and translation of the gesture `g` at progress p (0..1), eased per segment as CSS does.
void sampleGesture(const Gesture& g, float p, float* rot, float* ty, float* tx, bool spring)
{
  if (g.n < 2) { return; }
  uint8_t i = 0;
  while (i + 2 < g.n && p > g.keys[i + 1].t) { i++; }
  const Key& a = g.keys[i];
  const Key& b = g.keys[i + 1];
  const float x = fminf(fmaxf((p - a.t) / (b.t - a.t), 0.0f), 1.0f);
  const float k = spring ? life::springEase(x) : ease(x); // emotions follow through; the legacy poses keep the site curve
  *rot = a.rot + (b.rot - a.rot) * k;
  *ty = (a.ty + (b.ty - a.ty) * k) * kPxScale;
  *tx = (a.tx + (b.tx - a.tx) * k) * kPxScale;
}

constexpr uint16_t kAccentMs = 2400;
// Animation period of an accent's phase t (ms); most loop slowly, a few are faster.
uint16_t accentPeriod(BobAccent a)
{
  switch (a)
  {
  case BobAccent::kSpinner: return 1000;
  case BobAccent::kBell: return 1200;
  case BobAccent::kShiverLines: return 900;
  case BobAccent::kAnger: return 1000;
  default: return kAccentMs;
  }
}

M5Canvas s_pose;  // the pose being drawn (crossfade result, blink cover): 192 x 192
M5Canvas s_frame; // the composed frame: 232 x 240, ground colour behind the rotated pose
M5Canvas s_hold;  // the held (rotated) pose without breathing, see drawFrame
bool s_holdReady = false;
uint32_t s_poseSerial = 0, s_holdSerial = 0;
float s_holdRot = 0, s_holdTx = 0, s_holdTy = 0, s_holdZx = 1, s_holdZy = 1;
bool s_ready = false;
lgfx::LovyanGFX* s_target = &M5.Display; // where frames are composed (round UI: its framebuffer)
M5Canvas* s_targetCanvas = nullptr;       // s_target when it is a canvas: frames are copied with memcpy

BobPose s_cur = BobPose::kWelcome, s_prev = BobPose::kWelcome;
BobEmotion s_emo = BobEmotion::kIdle;
bool s_legacy = true; // true: pose-only mode (bobMotionSet), the original per-pose gestures and blink
uint32_t s_emoAt = 0; // start of the current emotion, the accents' clock
int16_t s_cx = 180, s_cy = 160;
uint32_t s_gestureAt = 0, s_fadeAt = 0, s_lastFrame = 0, s_nextBlink = 0, s_blinkAt = 0, s_statsAt = 0;
bool s_fading = false, s_gesturing = false, s_blinking = false, s_dirtyPose = true;
uint32_t s_rng = 0x2545F491u;
BobMotionStats s_stats;

// Visor-only redraw (upright Bob): a blink or a gaze change touches nothing but the visor, so it refreshes that region of
// the pose sprite from the art, draws the eyes and pushes just that rectangle: no 73 KB pose copy, no full-frame present.
bool s_still = false; // the UI holds Bob still (READY): no idle extras, only blinks and looks
bool s_faceDirty = false, s_lastUpright = false, s_visorDirty = false;
int s_lastPoseX = 0, s_lastPoseY = 0; // where the pose sat in the frame at the last full frame
int16_t s_vx = 0, s_vy = 0, s_vw = 0, s_vh = 0;

// Alive (bob_life.h): the squish blink and its double, the gaze spring, a held squish, the tap reaction and the
// rare idle micro-behaviours. Only emotion mode (not the bring-up pose-only mode) uses them.
constexpr uint32_t kReactMs = 900, kHumMs = 2400, kLookAroundMs = 1500;
constexpr float kSquishLeanDeg = -4.0f, kSquishX = 0.06f, kSquishY = 0.09f;
constexpr float kVisorAboveCentre = 46.0f; // the visor sits this far above the pose centre on screen
life::Spring s_gazeU, s_gazeV, s_squish;
float s_gazeTx = 0, s_gazeTy = 0, s_drawnGu = 0, s_drawnGv = 0;
uint32_t s_gazeUntil = 0, s_reactAt = 0, s_overAt = 0, s_microAt = 0;
bool s_held = false, s_reacting = false, s_blinkAgain = false, s_secondBlink = false, s_forcePair = false;
const Gesture* s_overG = nullptr; // a reaction or micro gesture that plays instead of the emotion's own
life::IdleScheduler s_idle;
life::Micro s_micro = life::Micro::kNone;

// Rig mode (bob_rig.h, bob_moves.h): Bob drawn from independent parts, each part on its own clock. Used for
// emotions when the rig blobs are built in and PSRAM is there; otherwise everything above (whole-pose images) runs.
bool s_rigOk = false;
float s_stageScale = 1.0f, s_stageRise = 0.0f; // a state may draw the rig smaller and higher (bobMotionSetStage)
#if defined(BOBSIM_FREEZE)
bool s_freeze = false;                  // sim only (visual gate REST mode): no breath, blink, gaze, micro-behaviour or looping gesture
const moves::Move* s_frzM = nullptr;    // the move frozen at s_frzT ms, nullptr: the rest pose
float s_frzT = 0.0f;
#endif
const moves::Move* s_baseM = nullptr; // the emotion's own move (loops, or holds its last key)
const moves::Move* s_overM = nullptr; // a reaction, idle delight or explicit move that plays instead of it
uint32_t s_calmSince = 0, s_baseLoopMs = 0;
rig::Driver s_drv;
rig::Look s_look;
uint8_t s_restPose = 0;      // the feeling's pose (an explicit move swaps it while it plays)
bool s_restArmsDown = false; // the feeling rests with both arms down (the demo's error and reply), not the pose's own
uint32_t s_rigLast = 0;
float s_chLast[moves::kChCount] = {};

uint32_t rnd() // xorshift: blink spacing only needs to look irregular
{
  s_rng ^= s_rng << 13;
  s_rng ^= s_rng >> 17;
  s_rng ^= s_rng << 5;
  return s_rng;
}

const Gesture& curGesture()
{
  return s_legacy ? kGestures[uint8_t(s_cur)] : kEmoGestures[uint8_t(bobEmotionSpec(s_emo).gesture)];
}

// Mixes two big-endian RGB565 images into the pose sprite: alpha 0 = a, 256 = b.
void blend(uint8_t* dst, const uint8_t* a, const uint8_t* b, uint32_t alpha)
{
  for (int i = 0; i < kBobSize * kBobSize; i++)
  {
    const uint32_t va = (a[2 * i] << 8) | a[2 * i + 1], vb = (b[2 * i] << 8) | b[2 * i + 1];
    const uint32_t r = (((va >> 11) & 31) * (256 - alpha) + ((vb >> 11) & 31) * alpha) >> 8;
    const uint32_t g = (((va >> 5) & 63) * (256 - alpha) + ((vb >> 5) & 63) * alpha) >> 8;
    const uint32_t bl = ((va & 31) * (256 - alpha) + (vb & 31) * alpha) >> 8;
    const uint32_t v = (r << 11) | (g << 5) | bl;
    dst[2 * i] = v >> 8;
    dst[2 * i + 1] = v & 0xFF;
  }
}

void loadPose(uint32_t now)
{
  ++s_poseSerial;
  auto* buf = static_cast<uint8_t*>(s_pose.getBuffer());
  const size_t bytes = size_t(kBobSize) * kBobSize * 2;
  if (s_fading)
  {
    const uint32_t alpha = (now - s_fadeAt) * 256 / kFadeMs;
    blend(buf, kImages[uint8_t(s_prev)], kImages[uint8_t(s_cur)], alpha > 256 ? 256 : alpha);
  }
  else { memcpy(buf, kImages[uint8_t(s_cur)], bytes); }
  const Eyes& e = kEyes[uint8_t(s_cur)];
  if (!s_legacy)
  {
    const BobEyes eyes = s_reacting ? BobEyes::kHappyArc : bobEmotionSpec(s_emo).eyes;
    const float open = (s_blinking && !s_fading) ? life::blinkShape(now - s_blinkAt).open : 1.0f;
    bobFaceDraw(s_pose, s_cur, eyes, open, 0.3f * s_gazeU.x, 0.3f * s_gazeV.x, s_gazeU.x, s_gazeV.x);
    s_drawnGu = s_gazeU.x;
    s_drawnGv = s_gazeV.x;
  }
  else if (s_blinking && !s_fading && e.has)
  {
    s_pose.fillRect(e.lx - kEyeHalf, e.ly - kEyeHalf, 2 * kEyeHalf, 2 * kEyeHalf, kVisor);
    s_pose.fillRect(e.rx - kEyeHalf, e.ry - kEyeHalf, 2 * kEyeHalf, 2 * kEyeHalf, kVisor);
  }
  s_dirtyPose = false;
}

// Copies `src` into `dst` at (dx, dy), clipped to `dst` and to the clip rect (cx, cy, cw, ch) of the
// destination's canvas: both are 16 bpp in the same byte order, so rows are plain memcpy (pushSprite's
// per-pixel conversion cost 8.5 ms for the frame copy alone).
void copyRows(M5Canvas& src, M5Canvas& dst, int dx, int dy, int cx, int cy, int cw, int ch)
{
  const uint8_t* s = static_cast<const uint8_t*>(src.getBuffer());
  uint8_t* d = static_cast<uint8_t*>(dst.getBuffer());
  if (s == nullptr || d == nullptr) { return; }
  const int sw = src.width(), sh = src.height(), dw = dst.width();
  const int x0 = fmaxf(fmaxf(0, cx - dx), 0), x1 = fminf(sw, fminf(cx + cw - dx, dw - dx));
  const int y0 = fmaxf(0, cy - dy), y1 = fminf(sh, cy + ch - dy);
  if (x1 <= x0 || y1 <= y0) { return; }
  for (int y = y0; y < y1; ++y) { memcpy(d + (static_cast<size_t>(y + dy) * dw + x0 + dx) * 2, s + (static_cast<size_t>(y) * sw + x0) * 2, static_cast<size_t>(x1 - x0) * 2); }
}

// The composed frame into the target. A canvas target (the round UI's framebuffer) takes the memcpy path.
void pushFrame()
{
  if (s_targetCanvas == nullptr) { s_frame.pushSprite(s_target, s_cx - kFrameW / 2, s_cy - kTopOff); return; }
  int32_t cx = 0, cy = 0, cw = 0, ch = 0;
  s_targetCanvas->getClipRect(&cx, &cy, &cw, &ch);
  copyRows(s_frame, *s_targetCanvas, s_cx - kFrameW / 2, s_cy - kTopOff, cx, cy, cw, ch);
}

void drawFrame(uint32_t now)
{
  s_lastUpright = false;
  float rot = 0, ty = 0, tx = 0;
  const bool overriding = s_overG != nullptr;
  if (!s_fading)
  {
    const Gesture& g = overriding ? *s_overG : curGesture();
    const bool running = overriding || s_gesturing;
    sampleGesture(g, running ? fminf(float(now - (overriding ? s_overAt : s_gestureAt)) / g.ms, 1.0f) : 1.0f, &rot, &ty, &tx, !s_legacy);
  }
  // A held touch leans Bob and squishes him a little (feet stay put); a spring settles it.
  const float sq = s_legacy ? 0.0f : life::clampf(s_squish.x, 0.0f, 1.2f);
  rot += kSquishLeanDeg * sq;
  const float zx = 1.0f + kSquishX * sq, zy = 1.0f - kSquishY * sq;
  const float breath = kBreathPx * sinf(6.2831853f * float(now % uint32_t(kBreathMs)) / kBreathMs);
  const float tyHeld = ty;
  ty += breath;
  // The pose rotates about its feet (50% x, 90% y): its centre swings on a radius of kPivotDy * zy.
  const float th = rot * 0.01745329f;
  const float arm = kPivotDy * zy;
  const float cx = kFrameCx + arm * sinf(th) + tx;
  const float cy = kFrameCy + kPivotDy - arm * cosf(th) + ty;
  const uint32_t t0 = micros();
  s_frame.fillSprite(kGround);
  const bool zoomed = fabsf(zx - 1.0f) > 0.002f || fabsf(zy - 1.0f) > 0.002f;
  const bool holding = (fabsf(rot) >= 0.05f || zoomed) && !s_gesturing && !overriding && !s_fading && s_holdReady;
  if (holding)
  {
    // A held tilt would re-run the 55-65 ms anti-aliased rotation every frame just to breathe. The
    // rotated pose is rendered once (breathing excluded) and each frame only copies it, shifted.
    if (s_holdSerial != s_poseSerial || s_holdRot != rot || s_holdTx != tx || s_holdTy != tyHeld || s_holdZx != zx || s_holdZy != zy)
    {
      s_hold.fillSprite(kGround);
      s_pose.pushRotateZoomWithAA(&s_hold, kFrameCx + arm * sinf(th) + tx, kFrameCy + kPivotDy - arm * cosf(th) + tyHeld, rot, zx, zy);
      s_holdSerial = s_poseSerial; s_holdRot = rot; s_holdTx = tx; s_holdTy = tyHeld; s_holdZx = zx; s_holdZy = zy;
    }
    copyRows(s_hold, s_frame, 0, int(lroundf(breath)), 0, 0, kFrameW, kFrameH);
  }
  else if (fabsf(rot) < 0.05f && !zoomed)
  {
    // No rotation (idle breathing): a plain copy at the rounded position, much cheaper than rotating.
    s_lastPoseX = int(lroundf(cx - kBobSize / 2.0f));
    s_lastPoseY = int(lroundf(cy - kBobSize / 2.0f));
    // Accents are drawn on the frame, not the pose: a visor-only redraw would erase the ones near the eyes, so only an accent-free Bob qualifies.
    s_lastUpright = !s_gesturing && !overriding && !s_fading && !s_reacting && s_micro != life::Micro::kHum && bobEmotionSpec(s_emo).accent == BobAccent::kNone;
    copyRows(s_pose, s_frame, s_lastPoseX, s_lastPoseY, 0, 0, kFrameW, kFrameH);
  }
  else if (kAaGesture) { s_pose.pushRotateZoomWithAA(&s_frame, cx, cy, rot, zx, zy); }
  else { s_pose.pushRotateZoom(&s_frame, cx, cy, rot, zx, zy); }
  if (!s_legacy)
  {
    const BobAccent acc = bobEmotionSpec(s_emo).accent;
    const uint32_t period = accentPeriod(acc);
    bobAccentDraw(s_frame, acc, float((now - s_emoAt) % period) / period, s_cur);
    if (s_reacting) { bobAccentOneHeart(s_frame, float(now - s_reactAt) / kReactMs, s_cur); }
    if (s_micro == life::Micro::kHum) { bobAccentDraw(s_frame, BobAccent::kNotes, float((now - s_microAt) % kHumMs) / kHumMs, s_cur); }
  }
  const uint32_t t1 = micros();
  pushFrame();
  s_stats.rotateUs += t1 - t0;
  s_stats.pushUs += micros() - t1;
}

// The rig move an emotion plays: a few feelings have their own (hand to ear, chin rub, wave ...), the rest map
// their gesture (bob_emotions.h) onto the library.
const moves::Move* moveFor(BobEmotion e)
{
  using namespace moves;
  switch (e)
  {
  case BobEmotion::kListening: return &kMoves[kMvHandToEar];
  case BobEmotion::kThinking: return &kMoves[kMvChinRub];
  case BobEmotion::kWakingUp: return &kMoves[kMvStretch];
  case BobEmotion::kHello:
  case BobEmotion::kReminder: return &kMoves[kMvWave];
  case BobEmotion::kError: return &kMoves[kMvShrug];
  case BobEmotion::kSuccess: return &kMoves[kMvArmsUp];
  case BobEmotion::kCelebrating: return &kMoves[kMvDance];
  case BobEmotion::kSleepy: return &kMoves[kMvYawn];
  case BobEmotion::kAmazed:
  case BobEmotion::kIdea: return &kMoves[kMvDelight];
  case BobEmotion::kFailed: return &kMoves[kMvDroop];
  default:
  {
    const int id = moveForGesture(static_cast<uint8_t>(bobEmotionSpec(e).gesture));
    return id < 0 ? nullptr : &kMoves[id];
  }
  }
}
uint32_t loopMsFor(BobEmotion e) { return e == BobEmotion::kThinking ? 3600u : uint32_t(bobEmotionSpec(e).loopMs); }

// Plays `m` now over the emotion's own move.
void playOver(const moves::Move* m, uint32_t now)
{
  s_overM = m;
  s_overAt = now;
  s_calmSince = now;
}

#if defined(BOB_RIG)
// One rig frame: sample the active move, run the follow-through springs, compose, push.
// A frame is composed in bands over several loop passes (one pass would be ~100 ms); this is the frame in flight.
int s_sliceNext = 0, s_sliceBands = 0; // next band to compose; 0 = no frame in flight
rig::Drive s_pendDrive;
rig::FaceState s_pendFace;
uint32_t s_pendNow = 0, s_pendUs = 0;

// The accents over the composed Bob, then the push of the finished frame.
void rigFinish()
{
  const uint32_t t0 = micros();
  const uint32_t now = s_pendNow;
  const BobAccent acc = bobEmotionSpec(s_emo).accent;
  const uint32_t period = accentPeriod(acc);
#if defined(BOBSIM_FREEZE)
  const float accPhase = s_freeze ? 0.0f : float((now - s_emoAt) % period) / period;
#else
  const float accPhase = float((now - s_emoAt) % period) / period;
#endif
  bobAccentDraw(s_frame, acc, accPhase, s_cur);
  if (s_reacting) { bobAccentOneHeart(s_frame, float(now - s_reactAt) / kReactMs, s_cur); }
  if (s_micro == life::Micro::kHum) { bobAccentDraw(s_frame, BobAccent::kNotes, float((now - s_microAt) % kHumMs) / kHumMs, s_cur); }
  const uint32_t t1 = micros();
  s_frame.pushSprite(s_target, s_cx - kFrameW / 2, s_cy - kTopOff);
  s_pendUs += t1 - t0;
  s_stats.rotateUs += s_pendUs;
  s_stats.pushUs += micros() - t1;
  if (s_pendUs > s_stats.composeMaxUs) { s_stats.composeMaxUs = s_pendUs; }
  if (s_pendUs > 15000) { s_stats.slowFrames++; }
  s_sliceNext = 0;
}

// Composes the next band; the last one finishes the frame. `all`: every remaining band now.
void rigSlice(bool all)
{
  do
  {
    const uint32_t t0 = micros();
    rig::compose(bob::Framebuffer{static_cast<uint8_t*>(s_frame.getBuffer()), s_frame.width(), s_frame.height()}, s_look, s_pendDrive, s_pendFace, s_cx - kFrameW / 2, s_cy - kTopOff, s_stageScale, s_stageRise, s_sliceNext, s_sliceBands);
    s_pendUs += micros() - t0;
    ++s_sliceNext;
  } while (all && s_sliceNext < s_sliceBands);
  if (s_sliceNext >= s_sliceBands) { rigFinish(); }
}

void rigDraw(uint32_t now, float dt, bool all)
{
  using namespace moves;
  float ch[kChCount];
  rig::Extras ex;
#if defined(BOBSIM_FREEZE)
  const int passes = s_freeze ? 40 : 1; // frozen: run the springs to rest so the same t always gives the same pixels
  if (s_freeze) { dt = 0.05f; }
#else
  const int passes = 1;
#endif
  for (int pass = 0; pass < passes; ++pass)
  {
  for (float& c : ch) { c = 0.0f; }
  const Move* active = nullptr;
  float t = 0;
#if defined(BOBSIM_FREEZE)
  if (s_freeze) { active = s_frzM; t = s_frzT; }
  else
#endif
  if (s_overM) { active = s_overM; t = float(now - s_overAt); }
  else if (s_baseM)
  {
    if (!(s_baseM->flags & kLoop) && s_baseLoopMs != 0 && now - s_gestureAt >= s_baseLoopMs) { s_gestureAt = now; }
    active = s_baseM;
    t = float(now - s_gestureAt);
  }
  if (active && (t < active->ms || (active->flags & (kHold | kLoop)))) { sampleMove(*active, t, ch); }
  else { active = nullptr; }
  // An explicit move (a scene, an idle delight, a key pose) plays in its own pose with its own arms, as the demo's playMove
  // swaps them; a feeling's own move and a reaction keep the feeling's pose and resting arms.
  const bool explicitMove = active && active != s_baseM && active->pose >= 0;
  s_look.pose = explicitMove ? static_cast<uint8_t>(active->pose) : s_restPose;
  const rig::PoseRig& pr = rig::kPoses[s_look.pose & 3];
  s_look.armsFront = explicitMove && (active->flags & kArmsFront);
  rig::Part wantL = s_restArmsDown ? rig::kArmLDown : pr.armL, wantR = s_restArmsDown ? rig::kArmRDown : pr.armR;
  if (explicitMove)
  {
    wantL = active->armL >= 0 ? rig::Part(active->armL) : pr.armL;
    wantR = active->armR >= 0 ? rig::Part(active->armR) : pr.armR;
  }
  rig::armSwap(&s_look.armL, wantL, dt * 1000.0f);
  rig::armSwap(&s_look.armR, wantR, dt * 1000.0f);

  ex = rig::Extras();
  ex.squish = s_held ? 1.0f : 0.0f;
#if defined(BOB_RIG)
  ex.speakLevel = playbackLevel01();
  if (ex.speakLevel < 0.04f) { ex.speakLevel = 0.0f; }
#endif
  ex.breathe = sinf(6.2831853f * float(now % 4200u) / 4200.0f);
  ex.gazeU = s_gazeU.x; // the touch gaze turns the head and visor a little; a move's own look moves only the eyes (as in the demo)
  ex.gazeV = s_gazeV.x;
#if defined(BOBSIM_FREEZE)
  if (s_freeze) { ex.breathe = 0.0f; ex.speakLevel = 0.0f; ex.squish = 0.0f; ex.gazeU = 0.0f; ex.gazeV = 0.0f; }
#endif
  s_drv.step(ch, ex, dt);
  }

  rig::FaceState face;
  face.eyes = (s_reacting || ch[kSquint] > 0.5f) ? BobEyes::kHappyArc : bobEmotionSpec(s_emo).eyes;
  face.style = rig::moveEyeStyle(ch[kEyeStyle]);
  const float blinkOpen = s_blinking ? life::blinkShape(now - s_blinkAt).open : 1.0f;
  face.open = life::clampf(blinkOpen + ch[kEyeOpen], 0.0f, 1.0f);
  face.gazeU = ex.gazeU + ch[kGazeU];
  face.gazeV = ex.gazeV + ch[kGazeV];
  face.lookU = 0.3f * face.gazeU;
  face.lookV = 0.3f * face.gazeV;
  face.tilt = s_drv.drive().rootRot + s_drv.drive().headRot;

  s_frame.fillSprite(kGround);
  s_pendDrive = s_drv.drive();
  s_pendFace = face;
  s_pendNow = now;
  s_pendUs = 0;
  s_sliceNext = 0;
#if defined(BOBSIM_FREEZE)
  const bool whole = all || s_freeze;
#else
  const bool whole = all;
#endif
  s_sliceBands = whole ? 1 : rig::composeBands(s_pendDrive);
  rigSlice(whole);
}
#endif // BOB_RIG
} // namespace

bool bobMotionBegin()
{
  for (auto* spr : {&s_pose, &s_frame})
  {
    spr->setPsram(true);
    spr->setColorDepth(16);
  }
  s_ready = s_pose.createSprite(kBobSize, kBobSize) && s_frame.createSprite(kFrameW, kFrameH);
  s_hold.setPsram(true);
  s_hold.setColorDepth(16);
  s_holdReady = s_ready && s_hold.createSprite(kFrameW, kFrameH);
  if (!s_ready) { s_pose.deleteSprite(); s_frame.deleteSprite(); }
#if defined(BOB_RIG)
  s_rigOk = s_ready && rig::begin(); // falls back to the whole-pose images when the rig cannot allocate
#endif
  return s_ready;
}

void bobMotionGesture()
{
  s_gesturing = true;
  s_gestureAt = millis();
}

namespace
{
void setPose(BobPose pose, int16_t cx, int16_t cy, bool legacy, BobEmotion emo)
{
#if defined(BOB_RIG)
  s_sliceNext = 0; // a frame half composed for the old pose is dropped
#endif
  const uint32_t now = millis();
  s_cx = cx;
  s_cy = cy;
  s_legacy = legacy;
  s_emo = emo;
  s_emoAt = now;
  if (!s_ready) { drawBob(pose, cx, cy); s_cur = pose; return; }
  s_fading = (pose != s_cur);
  s_prev = s_cur;
  s_cur = pose;
  s_fadeAt = now;
  s_blinking = false;
  s_dirtyPose = true;
  s_gesturing = false; // the old gesture's held offset must not leak into the new emotion
  if (!s_fading) { bobMotionGesture(); }
  s_nextBlink = now + 4000 + rnd() % 3000;
  s_overG = nullptr;
  s_reacting = false;
  s_micro = life::Micro::kNone;
  s_blinkAgain = s_secondBlink = s_forcePair = false;
  if (!legacy && emo == BobEmotion::kIdle) { s_idle.arm(now, rnd()); } else { s_idle.disarm(); }
  s_overM = nullptr;
  s_baseM = nullptr;
  if (s_rigOk && !legacy)
  {
    const bool poseChanged = s_fading;
    s_fading = false; // the rig swaps heads and bellies instantly: a blink hides the swap
    s_look.pose = s_restPose = static_cast<uint8_t>(pose);
    s_restArmsDown = emo == BobEmotion::kError; // the demo's error state rests with both arms down
    s_baseM = moveFor(emo);
    s_baseLoopMs = loopMsFor(emo);
    {
      // A new emotion starts with its arms in place (no ghost cross-fade from the previous feeling's arms).
      const rig::PoseRig& pr = rig::kPoses[static_cast<uint8_t>(pose) & 3];
      const rig::Part l = s_restArmsDown ? rig::kArmLDown : pr.armL, r = s_restArmsDown ? rig::kArmRDown : pr.armR;
      s_look.armL = rig::ArmSlot(l, l, 1.0f);
      s_look.armR = rig::ArmSlot(r, r, 1.0f);
    }
    s_gestureAt = s_calmSince = now;
    if (poseChanged) { s_blinking = true; s_blinkAt = now; }
    if (emo == BobEmotion::kCelebrating) { playOver(&moves::kMoves[moves::kMvBackflip], now); } // the featured celebration
  }
}
} // namespace

void bobMotionSet(BobPose pose, int16_t cx, int16_t cy) { setPose(pose, cx, cy, true, BobEmotion::kIdle); }

void bobMotionSetEmotion(BobEmotion e, int16_t cx, int16_t cy) { setPose(bobEmotionSpec(e).pose, cx, cy, false, e); }

void bobMotionSetTarget(lgfx::LovyanGFX* target)
{
  s_target = target ? target : &M5.Display;
  s_targetCanvas = nullptr;
}

void bobMotionSetTargetCanvas(M5Canvas* canvas)
{
  s_targetCanvas = canvas;
  s_target = canvas != nullptr ? static_cast<lgfx::LovyanGFX*>(canvas) : &M5.Display;
}

namespace
{
// A face-only change while Bob is upright: the visor region of the pose sprite goes back to the art, the eyes are drawn, and
// only that rectangle is pushed to the target (a clip on the target), then handed to the UI as a small dirty rect.
void drawVisorOnly(uint32_t now)
{
  const uint32_t t0 = micros();
  int16_t rx, ry, rw, rh;
  bobFaceRegion(s_cur, &rx, &ry, &rw, &rh);
  bobFaceReset(s_pose, s_cur);
  const BobEyes eyes = s_reacting ? BobEyes::kHappyArc : bobEmotionSpec(s_emo).eyes;
  const float open = s_blinking ? life::blinkShape(now - s_blinkAt).open : 1.0f;
  bobFaceDraw(s_pose, s_cur, eyes, open, 0.3f * s_gazeU.x, 0.3f * s_gazeV.x, s_gazeU.x, s_gazeV.x);
  s_drawnGu = s_gazeU.x;
  s_drawnGv = s_gazeV.x;
  ++s_poseSerial; // a later rotated frame must not reuse the held-tilt cache
  const int dx = s_cx - kFrameW / 2 + s_lastPoseX, dy = s_cy - kTopOff + s_lastPoseY; // the pose's origin on the target
  int32_t ox, oy, ow, oh;
  s_target->getClipRect(&ox, &oy, &ow, &oh);
  s_target->setClipRect(dx + rx, dy + ry, rw, rh);
  s_pose.pushSprite(s_target, dx, dy);
  s_target->setClipRect(ox, oy, ow, oh);
  s_vx = static_cast<int16_t>(dx + rx);
  s_vy = static_cast<int16_t>(dy + ry);
  s_vw = rw;
  s_vh = rh;
  s_visorDirty = true;
  s_stats.visorFrames++;
  s_stats.visorUs += micros() - t0;
}

void startMicro(uint32_t now)
{
  const life::Micro m = life::IdleScheduler::pick(rnd());
  s_microAt = now;
  if (s_rigOk && !s_legacy)
  {
    using namespace moves;
    switch (m)
    {
      case life::Micro::kLookAround: playOver(&kMoves[kMvLookAround], now); break;
      case life::Micro::kHum: s_micro = m; playOver(&kMoves[kMvHum], now); return; // the notes are the accent layer
      case life::Micro::kBlinkPair: s_forcePair = true; s_nextBlink = now; break;
      case life::Micro::kButtonWobble: playOver(&kMoves[rnd() % 3 == 0 ? kMvButtonSpin : kMvButtonWobble], now); break;
      case life::Micro::kHop: playOver(&kMoves[kMvFootTap], now); break; // the idle delight list has a foot tap, not a hop
      default: break;
    }
    s_idle.arm(now, rnd());
    return;
  }
  switch (m)
  {
    case life::Micro::kLookAround: s_micro = m; return;
    case life::Micro::kHum: s_micro = m; return;
    case life::Micro::kBlinkPair: s_forcePair = true; s_nextBlink = now; break;
    case life::Micro::kButtonWobble: s_overG = &kButtonWobble; s_overAt = now; break;
    case life::Micro::kHop: s_overG = &kHop; s_overAt = now; break;
    default: break;
  }
  s_idle.arm(now, rnd());
}

// Springs, the gaze target, the squish and the micro-behaviour clock for one frame.
void tickLife(uint32_t now, float dt)
{
  float tu = 0, tv = 0;
  if (static_cast<int32_t>(s_gazeUntil - now) > 0)
  {
    const life::Gaze g = life::gazeToward(s_gazeTx, s_gazeTy, float(s_cx), float(s_cy) - kVisorAboveCentre);
    tu = g.u;
    tv = g.v;
  }
  else if (s_micro == life::Micro::kLookAround)
  {
    const uint32_t e = now - s_microAt;
    tu = e < 700 ? -life::kGazeMaxU : e < 1400 ? life::kGazeMaxU : 0.0f;
  }
  s_gazeU.step(tu, dt);
  s_gazeV.step(tv, dt);
  s_squish.step(s_held ? 1.0f : 0.0f, dt, 14.0f);
  if (s_fading) { return; }
  if (roundf(s_gazeU.x) != roundf(s_drawnGu) || roundf(s_gazeV.x) != roundf(s_drawnGv)) { s_faceDirty = true; }
  if (s_overG && now - s_overAt >= s_overG->ms) { s_overG = nullptr; }
  if (s_overM && now - s_overAt >= (s_overM->flags & moves::kLoop ? kHumMs : s_overM->ms)) { s_overM = nullptr; }
  if (s_reacting && now - s_reactAt >= kReactMs) { s_reacting = false; s_dirtyPose = true; }
  // Micro-behaviours happen only while Bob idles in READY: never while speaking, reacting or held.
  const bool idle = s_emo == BobEmotion::kIdle && !s_reacting && !s_held && s_overG == nullptr && s_overM == nullptr;
  if (!idle)
  {
    if (s_micro != life::Micro::kNone && s_overM == nullptr) { s_micro = life::Micro::kNone; s_idle.arm(now, rnd()); }
    if (s_emo != BobEmotion::kIdle || s_reacting || s_held) { s_calmSince = now; }
    return;
  }
  // A long calm: after a minute of idling Bob yawns, once, then the minute starts again.
  if (s_rigOk && !s_legacy && s_micro == life::Micro::kNone && now - s_calmSince >= 60000)
  {
    playOver(&moves::kMoves[moves::kMvYawn], now);
    return;
  }
  if (s_micro != life::Micro::kNone)
  {
    if (now - s_microAt >= (s_micro == life::Micro::kHum ? kHumMs : kLookAroundMs)) { s_micro = life::Micro::kNone; s_idle.arm(now, rnd()); }
  }
  else if (!s_still && s_idle.due(now)) { startMicro(now); } // none while held still: a half-played hop would freeze until the next tick
}
// The squish blink of emotion mode (and its quick double), shared by the whole-pose and the rig renderers.
void emotionBlink(uint32_t now)
{
  if (!s_blinking && static_cast<int32_t>(now - s_nextBlink) >= 0)
  {
    s_blinking = true;
    s_blinkAt = now;
    if (!s_secondBlink) { s_blinkAgain = s_forcePair || rnd() % 100 < 18; } // now and then a quick double blink
  }
  else if (s_blinking && now - s_blinkAt >= life::kBlinkMs)
  {
    s_blinking = false;
    s_faceDirty = true;
    if (s_blinkAgain) { s_blinkAgain = false; s_secondBlink = true; s_nextBlink = now + 140; }
    else { s_secondBlink = false; s_forcePair = false; s_nextBlink = now + 4000 + rnd() % 3000; }
  }
  if (s_blinking) { s_faceDirty = true; } // every frame of the squish redraws the eyes (the visor only, while upright)
}

// One frame in rig mode: the springs and idle life, the blink, then the parts.
bool rigTick(uint32_t now, float dt, bool force)
{
#if defined(BOBSIM_FREEZE)
  if (!s_freeze)
#endif
  {
    tickLife(now, dt);
    emotionBlink(now);
  }
  const uint32_t t0 = micros();
#if defined(BOB_RIG)
  rigDraw(now, dt, force);
#endif
  const uint32_t us = micros() - t0;
  s_stats.frames++;
  s_stats.totalUs += us;
  if (us > s_stats.maxUs) { s_stats.maxUs = us; }
#if defined(BOB_RIG)
  uint32_t hits, misses;
  rig::takeCacheStats(&hits, &misses);
  s_stats.cacheHits += hits;
  s_stats.cacheMisses += misses;
  rig::takeBakeStats(&hits, &misses);
  s_stats.bakeHits += hits;
  s_stats.bakeMisses += misses;
  return s_sliceNext == 0; // false while the frame is still being composed band by band
#else
  return true;
#endif
}
} // namespace

bool bobMotionTick(uint32_t now, bool force)
{
#if defined(BOB_RIG)
  if (s_sliceNext > 0)
  {
    rigSlice(force);
    return s_sliceNext == 0;
  }
#endif
  if (!s_ready || (!force && now - s_lastFrame < kFrameMs)) { return false; }
  const float dt = life::clampf(float(now - s_lastFrame) / 1000.0f, 0.0f, 0.05f);
  s_lastFrame = now;
  if (s_rigOk && !s_legacy) { return rigTick(now, dt, force); }
  if (s_fading && now - s_fadeAt >= kFadeMs)
  {
    s_fading = false;
    s_dirtyPose = true;
    bobMotionGesture(); // the new pose plays its gesture once the fade is done
  }
  if (s_gesturing && now - s_gestureAt >= curGesture().ms) { s_gesturing = false; }
  if (!s_legacy && !s_fading && !s_gesturing)
  {
    const uint16_t loop = bobEmotionSpec(s_emo).loopMs;
    if (loop && now - s_gestureAt >= loop) { bobMotionGesture(); }
  }
  if (!s_legacy) { tickLife(now, dt); }
  if (!s_fading && (!s_legacy || kEyes[uint8_t(s_cur)].has))
  {
    if (s_legacy)
    {
      if (!s_blinking && static_cast<int32_t>(now - s_nextBlink) >= 0) { s_blinking = true; s_blinkAt = now; s_dirtyPose = true; }
      else if (s_blinking && now - s_blinkAt >= kBlinkMs) { s_blinking = false; s_nextBlink = now + 4000 + rnd() % 3000; s_dirtyPose = true; }
    }
    else { emotionBlink(now); }
  }
  if (s_faceDirty)
  {
    s_faceDirty = false;
    if (!s_legacy && !s_fading && s_lastUpright && !s_gesturing && s_overG == nullptr && !s_dirtyPose)
    {
      drawVisorOnly(now);
      return false; // no full frame: the UI marks only the visor rectangle dirty (bobMotionTakeVisorDirty)
    }
    s_dirtyPose = true;
  }
  const uint32_t t0 = micros();
  if (s_dirtyPose || s_fading) { loadPose(now); }
  drawFrame(now);
  const uint32_t us = micros() - t0;
  s_stats.frames++;
  s_stats.totalUs += us;
  if (us > s_stats.maxUs) { s_stats.maxUs = us; }
  return true;
}

void bobMotionTapReaction()
{
  if (!s_ready || s_legacy) { return; }
  const uint32_t now = millis();
  s_reacting = true;
  s_reactAt = now;
  if (s_rigOk) { playOver(&moves::kMoves[moves::kMvTapGiggle], now); }
  else
  {
    s_overG = &kGiggle;
    s_overAt = now;
  }
  s_micro = life::Micro::kNone;
  s_dirtyPose = true;
  s_idle.arm(now, rnd());
}

void bobMotionHold(bool held) { s_held = held; }

bool bobMotionSlicePending()
{
#if defined(BOB_RIG)
  return s_sliceNext > 0;
#else
  return false;
#endif
}

bool bobMotionRigActive() { return s_rigOk && !s_legacy; }

bool bobMotionPlayMove(const char* name)
{
  const moves::Move* m = bobMotionRigActive() ? moves::moveByName(name) : nullptr;
  if (m == nullptr) { return false; }
  const uint32_t now = millis();
  playOver(m, now);
  s_micro = life::Micro::kNone;
  s_idle.arm(now, rnd());
  return true;
}

#if defined(BOBSIM_FREEZE)
void bobMotionFreeze(bool on)
{
  s_freeze = on;
  s_frzM = nullptr;
  s_frzT = 0.0f;
  if (!on) { return; }
  s_overM = nullptr;
  s_overG = nullptr;
  s_micro = life::Micro::kNone;
  s_blinking = false;
  s_reacting = false;
  s_held = false;
  s_gazeU = life::Spring();
  s_gazeV = life::Spring();
  s_squish = life::Spring();
  s_idle.disarm();
  s_dirtyPose = true;
}

bool bobMotionPoseAt(const char* move, float t)
{
  const moves::Move* m = bobMotionRigActive() ? moves::moveByName(move) : nullptr;
  if (m == nullptr) { return false; }
  s_freeze = true;
  s_frzM = m;
  s_frzT = life::clampf(t, 0.0f, 1.0f) * float(m->ms);
  return true;
}
#endif


bool bobMotionTakeVisorDirty(int16_t* x, int16_t* y, int16_t* w, int16_t* h)
{
  if (!s_visorDirty) { return false; }
  s_visorDirty = false;
  *x = s_vx;
  *y = s_vy;
  *w = s_vw;
  *h = s_vh;
  return true;
}

void bobMotionSetStill(bool still) { s_still = still; }

void bobMotionRestArmsDown(bool down) { s_restArmsDown = down; }

bool bobMotionWantsFastTick() { return !s_legacy && s_blinking && s_lastUpright; }

// True when a blink or a look is due or moving, so a resting Bob (READY) still gets ticks for them. Only face changes: idle extras
// (wobble, hop, hum) are full frames and stay off Ready (bobMotionSetStill), where the wake word already saturates the CPU.
bool bobMotionNeedsTick(uint32_t now)
{
  if (!s_ready || s_legacy) { return false; }
  if (s_blinking || static_cast<int32_t>(now - s_nextBlink) >= 0 || static_cast<int32_t>(s_gazeUntil - now) > 0) { return true; }
  return fabsf(s_gazeU.x) > 0.05f || fabsf(s_gazeV.x) > 0.05f;
}

void bobMotionStage(float* scale, float* rise)
{
  *scale = s_stageScale;
  *rise = s_stageRise;
}

void bobMotionSetStage(float scale, float rise)
{
  s_stageScale = scale;
  s_stageRise = rise;
  s_dirtyPose = true;
#if defined(BOB_RIG)
  s_sliceNext = 0; // a frame half composed at the old stage is dropped
#endif
}

void bobMotionLookAt(int16_t x, int16_t y)
{
  s_gazeTx = x;
  s_gazeTy = y;
  s_gazeUntil = millis() + life::kGazeHoldMs;
}

BobMotionStats bobMotionTakeStats()
{
  BobMotionStats out = s_stats;
  out.windowMs = millis() - s_statsAt;
  s_stats = BobMotionStats();
  s_statsAt = millis();
  return out;
}

} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
