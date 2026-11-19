// Bob's visor derived from the art (include/bob_visor.h), checked against the real pose images in lib/bob_art.
// Escaped defect, Waveshare 2026-10-16: the procedural eyes sat outside the visor and over the raised hand, with
// the art's own eyes still showing behind them, because the visor was a hand-picked capsule. Now the visor is the
// art's dark region, the original eyes are cleared inside exactly that region and everything is clipped to it.
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <initializer_list>
#include <string>
#include <vector>

#include "bob_visor.h"
#include "doctest.h"

using namespace bob::visor;

namespace {

const char* const kNames[4] = {"welcome", "curious", "thoughtful", "playful"};

std::vector<uint8_t> loadArt(int pose) {
  std::ifstream in(std::string("lib/bob_art/bob_") + kNames[pose] + ".rgb565", std::ios::binary);
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  return bytes;
}

}  // namespace

TEST_CASE("visor: the art loads and every pose has a visor mask of plausible size") {
  for (int p = 0; p < 4; ++p) {
    INFO("pose " << std::string(kNames[p]));
    const std::vector<uint8_t> art = loadArt(p);
    REQUIRE(art.size() == static_cast<size_t>(kArt) * kArt * 2);
    Mask m;
    buildMask(art.data(), kPoses[p], &m);
    CHECK(m.count > 600);
    CHECK(m.count < kMaxW * kMaxH);
  }
}

TEST_CASE("visor: the mask matches the visor measured from the art, including a hand covering one end") {
  // Bounding boxes of the visor pixels per pose, generated from the images with the art (bob_visor_poses.h); the mask
  // may be a little smaller because it leaves the anti-aliased rim to the art.
  const auto& expected = kVisorBox;
  for (int p = 0; p < 4; ++p) {
    INFO("pose " << std::string(kNames[p]));
    const std::vector<uint8_t> art = loadArt(p);
    Mask m;
    buildMask(art.data(), kPoses[p], &m);
    int x0 = 999, y0 = 999, x1 = -1, y1 = -1;
    for (int y = m.y; y < m.y + m.h; ++y) {
      for (int x = m.x; x < m.x + m.w; ++x) {
        if (!m.has(x, y)) continue;
        x0 = x < x0 ? x : x0;
        y0 = y < y0 ? y : y0;
        x1 = x > x1 ? x : x1;
        y1 = y > y1 ? y : y1;
      }
    }
    CHECK(x0 >= expected[p][0] - 2);
    CHECK(x0 <= expected[p][0] + 6);
    CHECK(y0 >= expected[p][1] - 2);
    CHECK(y0 <= expected[p][1] + 6);
    CHECK(x1 >= expected[p][2] - 6);
    CHECK(x1 <= expected[p][2] + 2);
    CHECK(y1 >= expected[p][3] - 6);
    CHECK(y1 <= expected[p][3] + 2);
  }
}

TEST_CASE("visor: the mask is the visor (enclosed holes filled, a small share) and the shell below it is never in it") {
  for (int p = 0; p < 4; ++p) {
    INFO("pose " << std::string(kNames[p]));
    const std::vector<uint8_t> art = loadArt(p);
    Mask m;
    buildMask(art.data(), kPoses[p], &m);
    int filled = 0;
    for (int y = m.y; y < m.y + m.h; ++y) {
      for (int x = m.x; x < m.x + m.w; ++x) {
        if (m.has(x, y) && !isVisorPixel(pixelBE(art.data(), x, y))) ++filled;
      }
    }
    CHECK(filled * 12 < m.count);  // holes (the art's eyes and glints) are a small part of the visor
    float bx, by;
    toArt(kPoses[p], 0.0f, 22.0f, &bx, &by);  // the "bob" logo area, well below the visor
    CHECK_FALSE(m.has(static_cast<int>(bx), static_cast<int>(by)));
  }
}

TEST_CASE("visor: both eyes fit the visor at rest and stay inside it at every gaze extreme (no pose hides or loses an eye)") {
  const float gu[] = {-3.0f, 0.0f, 3.0f}, gv[] = {-1.5f, 0.0f, 1.5f};
  for (int p = 0; p < 4; ++p) {
    const std::vector<uint8_t> art = loadArt(p);
    Mask m;
    buildMask(art.data(), kPoses[p], &m);
    for (int side = -1; side <= 1; side += 2) {
      for (float u : gu) {
        for (float v : gv) {
          // At rest the widest eye (radius 5) fits whole; at a gaze extreme its centre and a 2 px ring stay inside.
          const float r = (u == 0.0f && v == 0.0f) ? 5.0f : 2.0f;
          const float offsets[5][2] = {{0, 0}, {r, 0}, {-r, 0}, {0, r}, {0, -r}};
          for (const auto& o : offsets) {
            float x, y;
            toArt(kPoses[p], side * kEyeX + u + o[0], v + o[1], &x, &y);
            INFO("pose " << std::string(kNames[p]) << " eye " << side << " gaze " << u << "," << v << " offset " << o[0] << "," << o[1]);
            CHECK(m.has(static_cast<int>(lroundf(x)), static_cast<int>(lroundf(y))));
          }
        }
      }
    }
  }
}

TEST_CASE("visor: clearing runs cover exactly the mask") {
  const std::vector<uint8_t> art = loadArt(1);
  Mask m;
  buildMask(art.data(), kPoses[1], &m);
  int covered = 0;
  forEachRun(m, [&](int x, int y, int len) {
    for (int i = 0; i < len; ++i) {
      CHECK(m.has(x + i, y));
      ++covered;
    }
  });
  CHECK(covered == m.count);
}

TEST_CASE("visor: the clip puts the art back everywhere outside the mask, so nothing can be drawn over the hand or shell") {
  for (int p = 0; p < 4; ++p) {
    INFO("pose " << std::string(kNames[p]));
    const std::vector<uint8_t> art = loadArt(p);
    Mask m;
    buildMask(art.data(), kPoses[p], &m);
    std::vector<uint8_t> sprite = art;
    // A face drawn too big for the visor: scribble over the whole search region, a margin beyond it, and every pixel in it.
    for (int y = m.y - 4; y < m.y + m.h + 4; ++y) {
      for (int x = m.x - 4; x < m.x + m.w + 4; ++x) {
        const size_t i = 2u * (static_cast<size_t>(y) * kArt + x);
        sprite[i] = 0xF5;
        sprite[i + 1] = 0xB8;
      }
    }
    restoreOutside(sprite.data(), art.data(), m);
    int changedInside = 0, changedOutside = 0;
    for (int y = m.y; y < m.y + m.h; ++y) {
      for (int x = m.x; x < m.x + m.w; ++x) {
        const size_t i = 2u * (static_cast<size_t>(y) * kArt + x);
        const bool same = sprite[i] == art[i] && sprite[i + 1] == art[i + 1];
        if (m.has(x, y)) changedInside += same ? 0 : 1;
        else changedOutside += same ? 0 : 1;
      }
    }
    CHECK(changedOutside == 0);  // outside the visor the pixels are the art's again
    CHECK(changedInside > m.count / 2);  // inside the visor the drawing stays
  }
}

TEST_CASE("visor: eye positions follow the pose tilt, so a rotated head carries its eyes with it") {
  // The face is drawn in pose space before the sprite is rotated, so rotating the pose rotates mask and eyes together;
  // containment cannot change. Rotating the art-space points of both eyes by +-8 degrees about the pose pivot and
  // rotating the mask the same way keeps every eye centre inside it.
  const float pivotX = 96.0f, pivotY = 172.8f;  // 50% x, 90% y of the 192 px image
  for (int p = 0; p < 4; ++p) {
    const std::vector<uint8_t> art = loadArt(p);
    Mask m;
    buildMask(art.data(), kPoses[p], &m);
    for (float deg : {-8.0f, 8.0f}) {
      const float a = deg * 0.01745329f;
      for (int side = -1; side <= 1; side += 2) {
        float x, y;
        toArt(kPoses[p], side * kEyeX, 0.0f, &x, &y);
        const float rx = pivotX + (x - pivotX) * cosf(a) - (y - pivotY) * sinf(a);
        const float ry = pivotY + (x - pivotX) * sinf(a) + (y - pivotY) * cosf(a);
        // Rotate back by -deg to compare with the unrotated mask: the same point, so inside iff the unrotated one was.
        const float bx = pivotX + (rx - pivotX) * cosf(-a) - (ry - pivotY) * sinf(-a);
        const float by = pivotY + (rx - pivotX) * sinf(-a) + (ry - pivotY) * cosf(-a);
        INFO("pose " << std::string(kNames[p]) << " tilt " << deg);
        CHECK(m.has(static_cast<int>(lroundf(bx)), static_cast<int>(lroundf(by))));
      }
    }
  }
}

TEST_CASE("visor: during a crossfade the clip puts the blended frame back outside the visor, not the new art") {
  for (int p = 0; p < 4; ++p) {
    INFO("pose " << std::string(kNames[p]));
    const std::vector<uint8_t> art = loadArt(p);
    Mask m;
    buildMask(art.data(), kPoses[p], &m);
    // A stand-in for a crossfade blend: the art with every byte nudged, so it differs from the art everywhere.
    std::vector<uint8_t> blend = art;
    for (uint8_t& b : blend) b = static_cast<uint8_t>(b ^ 0x21);
    std::vector<uint8_t> snap(kSnapBytes);
    saveRegion(blend.data(), m, snap.data());
    std::vector<uint8_t> sprite = blend;
    for (int y = m.y; y < m.y + m.h; ++y) {  // the face scribbles over the whole region
      for (int x = m.x; x < m.x + m.w; ++x) {
        const size_t i = 2u * (static_cast<size_t>(y) * kArt + x);
        sprite[i] = 0xF5;
        sprite[i + 1] = 0xB8;
      }
    }
    restoreOutsideFromSnap(sprite.data(), snap.data(), m);
    int wrongOutside = 0, drawnInside = 0;
    for (int y = m.y; y < m.y + m.h; ++y) {
      for (int x = m.x; x < m.x + m.w; ++x) {
        const size_t i = 2u * (static_cast<size_t>(y) * kArt + x);
        const bool isBlend = sprite[i] == blend[i] && sprite[i + 1] == blend[i + 1];
        if (m.has(x, y)) drawnInside += (sprite[i] == 0xF5) ? 1 : 0;
        else wrongOutside += isBlend ? 0 : 1;
      }
    }
    CHECK(wrongOutside == 0);       // outside the visor the blend is intact (not the art)
    CHECK(drawnInside == m.count);  // inside the visor the face stays
  }
}
