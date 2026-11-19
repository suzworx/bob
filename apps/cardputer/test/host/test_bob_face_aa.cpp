// Bob's rig eyes (libs/bob-device/src/bob_face_aa.h): the demo's shapes, anti-aliased, clipped to the visor glass.
#include <cmath>
#include <cstdint>
#include <vector>

#include "bob_face_aa.h"
#include "doctest.h"

using namespace bob;

namespace {
constexpr int kW = rig::kParts[rig::kVisor].w, kH = rig::kParts[rig::kVisor].h;
const float kCx = rig::kParts[rig::kVisor].pivotX, kCy = rig::kParts[rig::kVisor].pivotY;

std::vector<uint8_t> draw(const face::Params& p) {
  std::vector<uint8_t> blob(static_cast<size_t>(kW) * kH * 3, 0xAA);
  face::render(blob.data(), kW, kH, kCx, kCy, p);
  return blob;
}
uint8_t alphaAt(const std::vector<uint8_t>& b, int x, int y) { return b[static_cast<size_t>(kW) * kH * 2 + static_cast<size_t>(y) * kW + x]; }
uint16_t colourAt(const std::vector<uint8_t>& b, int x, int y) {
  const size_t i = (static_cast<size_t>(y) * kW + x) * 2;
  return static_cast<uint16_t>(b[i] | (b[i + 1] << 8));
}
}  // namespace

TEST_CASE("face: open eyes are the demo's 13u discs at +-44 art px, with soft edges") {
  const auto b = draw(face::Params());
  const float r = 13.0f * face::kUnit;
  for (int s = -1; s <= 1; s += 2) {
    const float ex = kCx + s * face::kSep;
    // centroid of the eye's coverage sits on the eye centre
    double sx = 0, sy = 0, sa = 0;
    for (int y = 0; y < kH; y++)
      for (int x = 0; x < kW; x++)
        if (std::fabs(x + 0.5f - ex) < r + 2) {
          sx += alphaAt(b, x, y) * (x + 0.5);
          sy += alphaAt(b, x, y) * (y + 0.5);
          sa += alphaAt(b, x, y);
        }
    CHECK(sx / sa == doctest::Approx(ex).epsilon(0.02));
    CHECK(sy / sa == doctest::Approx(kCy).epsilon(0.05));
    CHECK(alphaAt(b, static_cast<int>(ex + 0.3f * r), static_cast<int>(kCy + 0.3f * r)) == 255);
  }
  // anti-aliased rim: some pixels are partly covered
  int partial = 0;
  for (int i = 0; i < kW * kH; i++) partial += b[static_cast<size_t>(kW) * kH * 2 + i] > 0 && b[static_cast<size_t>(kW) * kH * 2 + i] < 255;
  CHECK(partial > 20);
  // yellow body, paper catch-light up and to the inside-left
  const uint16_t yellow = static_cast<uint16_t>(((bobtok::kYellow >> 19) << 11) | (((bobtok::kYellow >> 10) & 63) << 5) | ((bobtok::kYellow >> 3) & 31));
  CHECK(colourAt(b, static_cast<int>(kCx + face::kSep + 0.4f * r), static_cast<int>(kCy + 0.3f * r)) == yellow);
}

TEST_CASE("face: nothing is drawn outside the visor glass, however far the gaze goes") {
  face::Params p;
  p.lookX = 40.0f;  // clamped to the demo's 12 units, then clipped by the glass
  p.lookY = -40.0f;
  p.left.style = p.right.style = face::EyeStyle::kWide;
  const auto b = draw(p);
  for (int y = 0; y < kH; y++)
    for (int x = 0; x < kW; x++) {
      // a pixel whose four corners are all outside the polygon must stay clear
      const bool corners = face::detail::inClip(x, y) || face::detail::inClip(x + 1, y) || face::detail::inClip(x, y + 1) || face::detail::inClip(x + 1, y + 1);
      if (!corners) CHECK(alphaAt(b, x, y) == 0);
    }
}

TEST_CASE("face: the blink squishes the eyes flat about their centre") {
  face::Params p;
  const auto open = draw(p);
  p.squish = 0.2f;
  const auto shut = draw(p);
  int a = 0, c = 0;
  for (int i = 0; i < kW * kH; i++) {
    a += open[static_cast<size_t>(kW) * kH * 2 + i];
    c += shut[static_cast<size_t>(kW) * kH * 2 + i];
  }
  CHECK(c < a / 3);
  CHECK(c > 0);
}
