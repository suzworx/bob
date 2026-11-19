// Bob's rig (libs/bob-device/src: bob_rig.h, bob_moves.h, bob_raster.h): keyframe interpolation, pivot maths, draw order, the
// lean limit, follow-through springs and the rasteriser. Pure maths; the renderer is libs/bob-device/src/bob_rig.cpp.
#include <cmath>
#include <cstdint>
#include <cstring>
#include <set>
#include <string>
#include <vector>

#include "bob_rig.h"
#include "doctest.h"

using namespace bob;
using namespace bob::moves;
using namespace bob::rig;
using raster::Affine;

namespace {
constexpr float kEps = 0.02f;

Affine layerMatrix(const Layer* l, int n, uint8_t part) {
  for (int i = 0; i < n; i++) {
    if (l[i].part == part) return l[i].m;
  }
  FAIL("layer missing");
  return Affine();
}

int indexOf(const Layer* l, int n, uint8_t part) {
  for (int i = 0; i < n; i++) {
    if (l[i].part == part) return i;
  }
  return -1;
}
}  // namespace

// ---- keyframes -------------------------------------------------------------------------------------------------------

TEST_CASE("moves: a track returns its keys exactly and holds outside them") {
  const Key k[] = {{100, 2.0f, kLin}, {300, 10.0f, kLin}, {500, -4.0f, kLin}};
  const Track t = tr(kRootRot, k);
  CHECK(sampleTrack(t, 0) == doctest::Approx(2.0f));
  CHECK(sampleTrack(t, 100) == doctest::Approx(2.0f));
  CHECK(sampleTrack(t, 200) == doctest::Approx(6.0f));  // linear midpoint
  CHECK(sampleTrack(t, 300) == doctest::Approx(10.0f));
  CHECK(sampleTrack(t, 500) == doctest::Approx(-4.0f));
  CHECK(sampleTrack(t, 9999) == doctest::Approx(-4.0f));
}

TEST_CASE("moves: eased segments keep their ends and the house ease is monotonic") {
  float prev = 0;
  for (int i = 0; i <= 100; i++) {
    const float e = houseEase(i / 100.0f);
    CHECK(e >= prev - 1e-4f);
    prev = e;
  }
  CHECK(houseEase(0.0f) == doctest::Approx(0.0f));
  CHECK(houseEase(1.0f) == doctest::Approx(1.0f));
  CHECK(houseEase(0.5f) == doctest::Approx(0.5f).epsilon(0.02));
  const Key k[] = {{0, 0.0f, kSoft}, {400, 8.0f, kSpring}};
  const Track t = tr(kHeadRot, k);
  CHECK(sampleTrack(t, 400) == doctest::Approx(8.0f));
  float peak = 0;
  for (int ms = 0; ms <= 400; ms += 10) peak = fmaxf(peak, sampleTrack(t, static_cast<float>(ms)));
  CHECK(peak > 8.0f);   // the spring arrives with a small overshoot...
  CHECK(peak < 9.5f);   // ...never a big one
}

TEST_CASE("moves: every channel without a track stays at 0 and unknown moves are rejected") {
  float ch[kChCount];
  sampleMove(moveById(kMvWave), 500, ch);
  CHECK(ch[kFlip] == 0.0f);
  CHECK(ch[kFootLDy] == 0.0f);
  CHECK(ch[kArmRRot] != 0.0f);
  CHECK(moveByName("backflip") == &kMoves[kMvBackflip]);
  CHECK(moveByName("sleepy-yawn") == &kMoves[kMvYawn]);
  CHECK(moveByName("nope") == nullptr);
}

TEST_CASE("moves: the library has the whole spec and well-formed tracks") {
  const char* required[] = {"wave", "hand-to-ear", "chin-rub", "arms-up", "clap", "point", "shrug", "foot-tap", "hop", "happy-wiggle", "sway", "dance",
                            "bow", "look-around", "button-spin", "shiver", "droop", "sleepy-yawn", "stretch", "press-squish", "tap-giggle", "hum", "backflip"};
  for (const char* name : required) CHECK_MESSAGE(moveByName(name) != nullptr, name);
  std::set<std::string> seen;
  for (int i = 0; i < kMoveCount; i++) {
    const Move& m = kMoves[i];
    CHECK_MESSAGE(seen.insert(m.name).second, m.name);  // unique names
    CHECK_MESSAGE((m.nTracks > 0) != (m.fn != nullptr), m.name);  // keyframes or the demo's function, never both
    CHECK(m.ms >= 500);
    CHECK(m.ms <= 2400);
    for (int t = 0; t < m.nTracks; t++) {
      const Track& tk = m.tracks[t];
      for (int k = 1; k < tk.n; k++) CHECK_MESSAGE(tk.keys[k].ms >= tk.keys[k - 1].ms, m.name);
      CHECK_MESSAGE(tk.keys[tk.n - 1].ms <= m.ms, m.name);
    }
  }
}

TEST_CASE("moves: a keyframe move ends where it began so moves chain without a jump") {
  for (int i = 0; i < kMoveCount; i++) {
    const Move& m = kMoves[i];
    if (m.flags & (kHold | kLoop)) continue;  // held and looping moves end elsewhere on purpose
    if (m.fn != nullptr) continue;            // the demo's moves end where the demo ends them (the hand-over spring blends)
    float end[kChCount];
    sampleMove(m, static_cast<float>(m.ms), end);
    for (int c = 0; c < kChCount; c++) {
      const float v = c == kFlip ? fmodf(end[c], 360.0f) : (c == kButtonSpin ? fmodf(end[c], 360.0f) : end[c]);
      CHECK_MESSAGE(fabsf(v) < 0.001f, m.name, " channel ", c);
    }
  }
}

TEST_CASE("moves: looping moves are seamless") {
  for (int i = 0; i < kMoveCount; i++) {
    const Move& m = kMoves[i];
    if (!(m.flags & kLoop)) continue;
    float a[kChCount], b[kChCount];
    sampleMove(m, 0.0f, a);
    sampleMove(m, static_cast<float>(m.ms), b);
    for (int c = 0; c < kChCount; c++) CHECK_MESSAGE(fabsf(a[c] - b[c]) < 0.01f, m.name);
    sampleMove(m, static_cast<float>(m.ms) * 3.0f + 5.0f, b);  // wraps around
    sampleMove(m, 5.0f, a);
    for (int c = 0; c < kChCount; c++) CHECK_MESSAGE(fabsf(a[c] - b[c]) < 0.01f, m.name);
  }
}

TEST_CASE("moves: the backflip turns the whole rig through 360 degrees counter-clockwise, anticipated and landed") {
  const Move& m = moveById(kMvBackflip);
  CHECK((m.flags & kFlipMove) != 0);
  float ch[kChCount];
  sampleMove(m, 0, ch);
  CHECK(ch[kFlip] == doctest::Approx(0.0f).epsilon(0.01));
  sampleMove(m, 160, ch);
  CHECK(ch[kRootSy] < -0.1f);  // crouch before the launch (anticipation, squash)
  CHECK(ch[kRootSx] > 0.05f);
  sampleMove(m, 450, ch);
  CHECK(ch[kRootDy] < -20.0f);  // airborne
  CHECK(ch[kFlip] < -120.0f);   // counter-clockwise
  CHECK(ch[kRootSy] > 0.0f);    // stretch in the air
  sampleMove(m, 700, ch);
  CHECK(ch[kRootSy] < -0.1f);  // landing squash
  sampleMove(m, 900, ch);
  CHECK(ch[kFlip] == doctest::Approx(-360.0f));
  float worst = 0;  // the rotation never reverses on the way round
  float prev = 0;
  for (int ms = 0; ms <= 900; ms += 10) {
    sampleMove(m, static_cast<float>(ms), ch);
    worst = fmaxf(worst, ch[kFlip] - prev);
    prev = ch[kFlip];
  }
  CHECK(worst < 0.01f);
}

TEST_CASE("moves: the demo's key poses reach the rig channels as the demo draws them") {
  float ch[kChCount];
  const Move* hop = moveByName("hop");
  REQUIRE(hop != nullptr);
  CHECK(hop->pose == kPlayful);
  sampleMove(*hop, 0.47f * hop->ms, ch);  // the apex: air = sin(pi * seg(t, .22, .72)) = 1
  CHECK(ch[kRootDy] == doctest::Approx(-46.0f * rig::kArtScale).epsilon(0.01));
  CHECK(ch[kFootLDy] == doctest::Approx(ch[kRootDy]));
  CHECK(ch[kArmLRot] == doctest::Approx(-34.0f + 20.0f).epsilon(0.01));  // -34 * air + 20 * crouch
  CHECK(ch[kArmRRot] == doctest::Approx(-34.0f + 20.0f).epsilon(0.01));  // the right arm mirrored to "outward positive"
  CHECK(rig::moveEyeStyle(ch[kEyeStyle]) == static_cast<int8_t>(demo::Eyes::kSquint) - 1);
  const Move* clapM = moveByName("clap");
  REQUIRE(clapM != nullptr);
  sampleMove(*clapM, 0.0f, ch);  // k = 1: both arms swung in 52 degrees, in front
  CHECK(ch[kArmLRot] == doctest::Approx(-52.0f));
  CHECK(ch[kArmRRot] == doctest::Approx(-52.0f));
  CHECK((clapM->flags & kArmsFront) != 0);
  CHECK(moveByName("tap-giggle")->pose == kKeepPose);  // a reaction keeps the pose
}

TEST_CASE("moves: gestures map to moves") {
  CHECK(moveForGesture(0) == -1);
  CHECK(moveForGesture(1) == kMvNod);
  CHECK(moveForGesture(4) == kMvShiver);
  CHECK(moveForGesture(5) == kMvBow);
  CHECK(moveForGesture(10) == kMvSway);
  CHECK(moveForGesture(200) == -1);
}

// ---- follow-through --------------------------------------------------------------------------------------------------

TEST_CASE("follow: a spring trails its target, overshoots a little and settles") {
  Follow f;
  float peak = 0;
  f.step(10.0f, 0.016f, kHandOverOmega, kHandOverZeta);
  CHECK(f.x > 0.0f);
  CHECK(f.x < 5.0f);  // still on its way after one short frame: it lags by tens of ms
  for (int i = 0; i < 90; i++) {
    f.step(10.0f, 0.033f, kHandOverOmega, kHandOverZeta);
    peak = fmaxf(peak, f.x);
  }
  CHECK(peak < 10.5f);  // barely any overshoot: it only hands one move over to the next
  CHECK(f.x == doctest::Approx(10.0f).epsilon(0.01));
}

TEST_CASE("driver: every channel hands over smoothly, the belly pulses with the speech level") {
  Driver d;
  float ch[kChCount] = {};
  Extras ex;
  ch[kArmRRot] = 30.0f;
  ch[kButtonRot] = 20.0f;
  ch[kRootRot] = 6.0f;
  d.step(ch, ex, 0.016f);
  CHECK(d.drive().armRRot < 30.0f);
  CHECK(d.drive().armRRot > 0.0f);
  CHECK(d.drive().rootRot > 0.0f);
  for (int i = 0; i < 60; i++) d.step(ch, ex, 0.033f);
  CHECK(d.drive().armRRot == doctest::Approx(30.0f).epsilon(0.03));
  CHECK(d.drive().rootRot == doctest::Approx(6.0f).epsilon(0.03));
  CHECK(d.drive().belly == doctest::Approx(0.0f).epsilon(0.01));
  ex.speakLevel = 1.0f;
  for (int i = 0; i < 30; i++) d.step(ch, ex, 0.033f);
  CHECK(d.drive().belly > 0.03f);
  CHECK(d.drive().belly < 0.05f);  // up to 3.5%
  CHECK(d.drive().headDy < 0.0f);  // the head bobs up a little
}

TEST_CASE("driver: a held touch squashes and leans Bob") {
  Driver d;
  float ch[kChCount] = {};
  Extras ex;
  ex.squish = 1.0f;
  for (int i = 0; i < 40; i++) d.step(ch, ex, 0.033f);
  CHECK(d.drive().rootSy < 0.95f);
  CHECK(d.drive().rootSx > 1.03f);
  CHECK(d.drive().rootRot < -2.0f);
  CHECK(d.drive().cheeks > 0.5f);
  ex.squish = 0.0f;
  for (int i = 0; i < 60; i++) d.step(ch, ex, 0.033f);
  CHECK(d.drive().rootSy == doctest::Approx(1.0f).epsilon(0.01));
}

// ---- pivots and lean -------------------------------------------------------------------------------------------------

TEST_CASE("rig: the body leans at most 8 degrees; only the flip goes further") {
  Drive d;
  d.rootRot = 25.0f;
  const Affine m = rootInner(d);
  const float deg = atan2f(m.b, m.a) * 57.29578f;
  CHECK(deg == doctest::Approx(8.0f).epsilon(0.01));
  d.rootRot = -25.0f;
  CHECK(atan2f(rootInner(d).b, rootInner(d).a) * 57.29578f == doctest::Approx(-8.0f).epsilon(0.01));
  CHECK(clampLean(3.0f) == 3.0f);
  Drive f;
  f.flip = -360.0f * 0.5f;  // half way round: the figure's top point is now at the bottom
  float x, y;
  stagePoint(f, kFigureCx, kFigureCy - 50.0f, &x, &y);
  CHECK(x == doctest::Approx(kFigureCx).epsilon(0.001));
  CHECK(y == doctest::Approx(kFigureCy + 50.0f).epsilon(0.001));
}

TEST_CASE("rig: the root turns and squashes about the feet") {
  Drive d;
  d.rootRot = 7.0f;
  d.rootSy = 0.85f;
  d.rootSx = 1.1f;
  float x, y;
  stagePoint(d, kRootPivotX, kRootPivotY, &x, &y);
  CHECK(x == doctest::Approx(kRootPivotX).epsilon(0.0005));
  CHECK(y == doctest::Approx(kRootPivotY).epsilon(0.0005));
  stagePoint(d, kRootPivotX, kRootPivotY - 100.0f, &x, &y);
  CHECK(y > kRootPivotY - 100.0f);  // squash pulls the head down
}

TEST_CASE("rig: each part turns about its own pivot") {
  Look look;
  look.pose = 0;
  Drive d;
  d.headRot = 8.0f;
  d.armLRot = 40.0f;
  d.armRRot = -30.0f;
  d.buttonRot = 25.0f;
  d.footLDy = -5.0f;
  Layer layers[kMaxLayers];
  const int n = buildLayers(look, d, layers);
  const PoseRig& pr = kPoses[0];
  float x, y;
  // head: the seam point of the head part stays where the neck is
  layerMatrix(layers, n, pr.head).apply(kParts[pr.head].pivotX, kParts[pr.head].pivotY, &x, &y);
  CHECK(fabsf(x - pr.seamX) < 0.2f);  // rig.json rounds the seam to 0.1 px
  CHECK(fabsf(y - pr.seamY) < 0.2f);
  // arms: the shoulder stays put whatever the swing; the arm's tip moves
  const Shoulder& sl = kShoulders[kArmLDown];
  layerMatrix(layers, n, kArmLDown).apply(kParts[kArmLDown].pivotX, kParts[kArmLDown].pivotY, &x, &y);
  CHECK(x == doctest::Approx(sl.x).epsilon(0.001));
  CHECK(y == doctest::Approx(sl.y).epsilon(0.001));
  float tx0, ty0, tx1, ty1;
  Drive rest;
  Layer l0[kMaxLayers];
  const int n0 = buildLayers(look, rest, l0);
  layerMatrix(l0, n0, kArmLDown).apply(0, static_cast<float>(kParts[kArmLDown].h), &tx0, &ty0);
  layerMatrix(layers, n, kArmLDown).apply(0, static_cast<float>(kParts[kArmLDown].h), &tx1, &ty1);
  CHECK(hypotf(tx1 - tx0, ty1 - ty0) > 10.0f);
  // the right arm is mirrored: outward (positive) swings it the opposite way to the left one
  d.armRRot = 30.0f;
  d.armLRot = 30.0f;
  Layer l2[kMaxLayers];
  const int n2 = buildLayers(look, d, l2);
  const float la = atan2f(layerMatrix(l2, n2, kArmLDown).b, layerMatrix(l2, n2, kArmLDown).a);
  const float ra = atan2f(layerMatrix(l2, n2, kArmRWave).b, layerMatrix(l2, n2, kArmRWave).a);
  CHECK(la > 0.0f);
  CHECK(ra < 0.0f);
  // button: its base stays where it is registered on the head, then lifts by the pop
  d.buttonPop = -3.0f;
  d.headRot = 0.0f;
  Layer l3[kMaxLayers];
  const int n3 = buildLayers(look, d, l3);
  layerMatrix(l3, n3, kButton).apply(kParts[kButton].pivotX, kParts[kButton].pivotY, &x, &y);
  CHECK(x == doctest::Approx(pr.button.x).epsilon(0.001));
  CHECK(y == doctest::Approx(pr.button.y - 3.0f).epsilon(0.001));
  // belly: scaled about its base, the base does not move
  d.belly = 0.035f;
  Layer l4[kMaxLayers];
  const int n4 = buildLayers(look, d, l4);
  layerMatrix(l4, n4, pr.belly).apply(kParts[pr.belly].pivotX, kParts[pr.belly].pivotY, &x, &y);
  CHECK(x == doctest::Approx(pr.bellyX + kParts[pr.belly].pivotX).epsilon(0.001));
  CHECK(y == doctest::Approx(pr.bellyY + kParts[pr.belly].pivotY).epsilon(0.001));
}

TEST_CASE("rig: the head carries the visor, face and button with it") {
  Look look;
  look.pose = 3;
  Drive d;
  d.headRot = 8.0f;
  Layer layers[kMaxLayers];
  const int n = buildLayers(look, d, layers);
  const PoseRig& pr = kPoses[3];
  float vx0, vy0, vx1, vy1;
  Drive rest;
  Layer l0[kMaxLayers];
  const int n0 = buildLayers(look, rest, l0);
  layerMatrix(l0, n0, kVisor).apply(kParts[kVisor].pivotX, kParts[kVisor].pivotY, &vx0, &vy0);
  layerMatrix(layers, n, kVisor).apply(kParts[kVisor].pivotX, kParts[kVisor].pivotY, &vx1, &vy1);
  CHECK(hypotf(vx1 - vx0, vy1 - vy0) > 2.0f);  // the visor swings with the head
  // visor and face share one transform
  const Affine v = layerMatrix(layers, n, kVisor), f = layerMatrix(layers, n, kLayerFace);
  CHECK(v.a == f.a);
  CHECK(v.tx == f.tx);
  // at rest the visor pivot lands on its registered place
  CHECK(vx0 == doctest::Approx(pr.visor.x).epsilon(0.001));
  CHECK(vy0 == doctest::Approx(pr.visor.y).epsilon(0.001));
}

// ---- draw order ------------------------------------------------------------------------------------------------------

TEST_CASE("rig: draw order is feet, back arms, belly, head, visor, face, cheeks, button, front arms") {
  Look look;
  look.pose = 1;  // curious: the left arm is the ear arm, drawn in front
  look.armL = ArmSlot(kArmLEar, kArmLEar, 1.0f);
  look.armR = ArmSlot(kArmRDown, kArmRDown, 1.0f);
  Drive d;
  d.cheeks = 0.6f;
  Layer l[kMaxLayers];
  const int n = buildLayers(look, d, l);
  const PoseRig& pr = kPoses[1];
  const int ifl = indexOf(l, n, kFootL), ifr = indexOf(l, n, kFootR), iar = indexOf(l, n, kArmRDown), ib = indexOf(l, n, pr.belly),
            ih = indexOf(l, n, pr.head), iv = indexOf(l, n, kVisor), iface = indexOf(l, n, kLayerFace), ich = indexOf(l, n, kLayerCheeks),
            ibt = indexOf(l, n, kButton), iear = indexOf(l, n, kArmLEar);
  CHECK(ifl == 0);
  CHECK(ifr == 1);
  CHECK(ifr < iar);
  CHECK(iar < ib);
  CHECK(ib < ih);
  CHECK(ih < iv);
  CHECK(iv < iface);
  CHECK(iface < ich);
  CHECK(ich < ibt);
  CHECK(ibt < iear);
  CHECK(iear == n - 1);
  // clapping puts both arms in front
  look.armsFront = true;
  look.armL = ArmSlot(kArmLDown, kArmLDown, 1.0f);
  const int m = buildLayers(look, d, l);
  CHECK(indexOf(l, m, kArmLDown) > indexOf(l, m, kButton));
  CHECK(indexOf(l, m, kArmRDown) > indexOf(l, m, kButton));
  // no cheeks, no layer
  d.cheeks = 0.0f;
  const int k = buildLayers(look, d, l);
  CHECK(indexOf(l, k, kLayerCheeks) == -1);
  CHECK(k <= kMaxLayers);
}

TEST_CASE("rig: an arm swap cross-fades the old and new variant") {
  Look look;
  look.armR = ArmSlot(kArmRWave, kArmRWave, 1.0f);
  armSwap(&look.armR, kArmRDown, 0.0f);
  CHECK(look.armR.cur == kArmRDown);
  CHECK(look.armR.prev == kArmRWave);
  CHECK(look.armR.mix == 0.0f);
  Drive d;
  Layer l[kMaxLayers];
  int n = buildLayers(look, d, l);
  CHECK(indexOf(l, n, kArmRWave) >= 0);   // at mix 0 the old variant is still fully shown...
  CHECK(indexOf(l, n, kArmRDown) == -1);  // ...and the new one is skipped at alpha 0
  armSwap(&look.armR, kArmRDown, 70.0f);
  n = buildLayers(look, d, l);
  const int a = indexOf(l, n, kArmRWave), b = indexOf(l, n, kArmRDown);
  CHECK(a >= 0);
  CHECK(b >= 0);
  CHECK(l[a].alpha + l[b].alpha >= 250);
  CHECK(l[a].alpha + l[b].alpha <= 260);
  armSwap(&look.armR, kArmRDown, 100.0f);
  CHECK(look.armR.mix == 1.0f);
}

TEST_CASE("rig: an arm variant hangs from the pose's own shoulder on its side, as in the demo") {
  Look look;
  look.pose = 0;  // helper: its right shoulder is armR_wave's
  look.armR = ArmSlot(kArmRDown, kArmRDown, 1.0f);
  Layer l[kMaxLayers];
  const int n = buildLayers(look, Drive(), l);
  int i = -1;
  for (int k = 0; k < n; k++)
    if (l[k].part == kArmRDown) i = k;
  REQUIRE(i >= 0);
  float x, y;
  l[i].m.apply(kParts[kArmRDown].pivotX, kParts[kArmRDown].pivotY, &x, &y);
  CHECK(x == doctest::Approx(kShoulders[kArmRWave].x));
  CHECK(y == doctest::Approx(kShoulders[kArmRWave].y));
}

TEST_CASE("rig: the shadow narrows and fades as Bob rises, like the demo's") {
  Drive d;
  const Shadow s0 = shadowFor(d);
  CHECK(s0.cx == doctest::Approx(98.5f));
  CHECK(s0.cy == doctest::Approx(192.5f));
  CHECK(s0.alpha == doctest::Approx(0.55f));
  d.rootDy = -kShadowLiftPx;
  d.rootDx = 7.0f;  // the shadow stays on the ground: no sway
  const Shadow s1 = shadowFor(d);
  CHECK(s1.rx == doctest::Approx(s0.rx * 0.72f));
  CHECK(s1.ry == doctest::Approx(s0.ry));
  CHECK(s1.alpha == doctest::Approx(0.55f * 0.6f));
  CHECK(s1.cx == doctest::Approx(s0.cx));
  d.rootDy = 5.0f;
  CHECK(shadowFor(d).rx == doctest::Approx(s0.rx));
}

// ---- rasteriser ------------------------------------------------------------------------------------------------------

namespace {
// w*h opaque blob, pixel (x,y) holds the value x + 16*y (low 16 bits), little endian.
std::vector<uint8_t> makeBlob(int w, int h, bool opaque = true) {
  std::vector<uint8_t> b(static_cast<size_t>(w) * h * 3, 0);
  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      const uint16_t v = static_cast<uint16_t>(x + 16 * y + 1);
      memcpy(&b[(static_cast<size_t>(y) * w + x) * 2], &v, 2);
      b[static_cast<size_t>(w) * h * 2 + static_cast<size_t>(y) * w + x] = opaque ? 255 : 0;
    }
  }
  return b;
}
uint16_t at(const std::vector<uint8_t>& surf, int stride, int x, int y) {
  uint16_t v;
  memcpy(&v, &surf[static_cast<size_t>(y) * stride + x * 2], 2);
  return raster::bswap(v);
}
}  // namespace

TEST_CASE("raster: a whole-pixel translation copies the blob") {
  const auto blob = makeBlob(6, 5);
  std::vector<uint8_t> surf(20 * 20 * 2, 0);
  raster::FrameSink sink{surf.data(), 40};
  raster::drawBlob(sink, raster::Clip{0, 0, 20, 20}, blob.data(), 6, 5, raster::translate(7, 9));
  CHECK(at(surf, 40, 7, 9) == 1);
  CHECK(at(surf, 40, 12, 13) == 5 + 16 * 4 + 1);
  CHECK(at(surf, 40, 6, 9) == 0);
  CHECK(at(surf, 40, 13, 9) == 0);
}

TEST_CASE("raster: a rotation about a pivot keeps the pivot pixel in place") {
  const auto blob = makeBlob(9, 9);
  std::vector<uint8_t> surf(30 * 30 * 2, 0);
  raster::FrameSink sink{surf.data(), 60};
  // pivot = centre pixel (4,4) of the blob, placed at (15,15); turn it 90 degrees clockwise
  const Affine m = raster::translate(15.5f, 15.5f) * raster::rotate(90.0f) * raster::translate(-4.5f, -4.5f);
  raster::drawBlob(sink, raster::Clip{0, 0, 30, 30}, blob.data(), 9, 9, m);
  CHECK(at(surf, 60, 15, 15) == 4 + 16 * 4 + 1);  // the centre
  // 90 degrees clockwise on a y-down screen: the blob's right edge (x=8) lands on the bottom
  CHECK(at(surf, 60, 15, 19) == 8 + 16 * 4 + 1);
  CHECK(at(surf, 60, 11, 15) == 4 + 16 * 8 + 1);  // the bottom edge goes to the left
}

TEST_CASE("raster: scaling and clipping stay inside the clip") {
  const auto blob = makeBlob(8, 8);
  std::vector<uint8_t> surf(16 * 16 * 2, 0);
  raster::FrameSink sink{surf.data(), 32};
  raster::drawBlob(sink, raster::Clip{4, 4, 12, 12}, blob.data(), 8, 8, raster::translate(8, 8) * raster::scale(2.0f, 2.0f) * raster::translate(-4, -4));
  CHECK(at(surf, 32, 3, 8) == 0);
  CHECK(at(surf, 32, 12, 8) == 0);
  CHECK(at(surf, 32, 8, 8) != 0);
  CHECK(at(surf, 32, 4, 4) != 0);
}

TEST_CASE("raster: alpha blends over the surface and a transparent pixel leaves it alone") {
  std::vector<uint8_t> blob(1 * 1 * 3, 0);
  const uint16_t white = 0xFFFF;
  memcpy(blob.data(), &white, 2);
  blob[2] = 128;
  std::vector<uint8_t> surf(4 * 4 * 2, 0);
  raster::FrameSink sink{surf.data(), 8};
  raster::drawBlob(sink, raster::Clip{0, 0, 4, 4}, blob.data(), 1, 1, raster::translate(1, 1));
  const uint16_t half = at(surf, 8, 1, 1);
  CHECK(((half >> 11) & 31) > 12);
  CHECK(((half >> 11) & 31) < 20);
  blob[2] = 0;
  raster::drawBlob(sink, raster::Clip{0, 0, 4, 4}, blob.data(), 1, 1, raster::translate(2, 2));
  CHECK(at(surf, 8, 2, 2) == 0);
  blob[2] = 255;
  raster::drawBlob(sink, raster::Clip{0, 0, 4, 4}, blob.data(), 1, 1, raster::translate(3, 3), 128);  // gain halves the alpha
  const uint16_t faded = at(surf, 8, 3, 3);
  CHECK(((faded >> 11) & 31) > 12);
  CHECK(((faded >> 11) & 31) < 20);
}

TEST_CASE("raster: blending darkens as well as lightens, per channel") {
  const uint16_t half = raster::blend565(0xFFFF, 0x0000, 16);  // black over white
  CHECK(((half >> 11) & 31) >= 15);
  CHECK(((half >> 11) & 31) <= 16);
  CHECK(((half >> 5) & 63) >= 31);
  CHECK(((half >> 5) & 63) <= 32);
  CHECK((half & 31) >= 15);
  CHECK((half & 31) <= 16);
  CHECK(raster::blend565(0x1234, 0xABCD, 0) == 0x1234);
  const uint16_t ground = 0x11EA;
  const uint16_t shadow = raster::blend565(ground, 0x0000, 10);  // a shadow over the ground colour
  CHECK(((shadow >> 11) & 31) <= ((ground >> 11) & 31));
  CHECK((shadow & 31) <= (ground & 31));
}

TEST_CASE("raster: the surface blit skips the key colour") {
  const uint16_t key = 0x11EB;
  std::vector<uint8_t> src(4 * 4 * 2);
  for (int i = 0; i < 16; i++) {
    const uint16_t v = raster::bswap(i == 5 ? static_cast<uint16_t>(0x1234) : key);
    memcpy(&src[static_cast<size_t>(i) * 2], &v, 2);
  }
  std::vector<uint8_t> dst(8 * 8 * 2, 0);
  raster::FrameSink sink{dst.data(), 16};
  raster::drawSurface(sink, raster::Clip{0, 0, 8, 8}, src.data(), 4, 4, raster::translate(2, 2), key);
  CHECK(at(dst, 16, 3, 3) == 0x1234);  // source pixel 5 = (1,1)
  CHECK(at(dst, 16, 2, 2) == 0);
}

TEST_CASE("raster: composing one pose from the real part sizes stays inside the stage") {
  // every part of every pose, at rest, lies inside the 197 px stage (a cut or a pivot gone wrong would stick out)
  for (int p = 0; p < 4; p++) {
    Look look;
    look.pose = static_cast<uint8_t>(p);
    look.armL = ArmSlot(kPoses[p].armL, kPoses[p].armL, 1.0f);
    look.armR = ArmSlot(kPoses[p].armR, kPoses[p].armR, 1.0f);
    Drive d;
    d.cheeks = 0.5f;
    Layer l[kMaxLayers];
    const int n = buildLayers(look, d, l);
    CHECK(n >= 9);
    for (int i = 0; i < n; i++) {
      if (l[i].part >= kPartCount) continue;
      raster::Clip box;
      CHECK(raster::transformedBounds(l[i].m, kParts[l[i].part].w, kParts[l[i].part].h, raster::Clip{-30, -30, kStage + 30, kStage + 30}, &box));
      CHECK_MESSAGE(box.x0 > -12, kParts[l[i].part].name);
      CHECK_MESSAGE(box.x1 < kStage + 12, kParts[l[i].part].name);
      CHECK_MESSAGE(box.y1 < kStage + 12, kParts[l[i].part].name);
    }
  }
}
