// Estimates the Bob rig compose cost on the ESP32-S3 from host measurements of the real rasteriser (bob_raster.h).
//
//   g++ -O2 -std=c++17 -I libs/bob-device/src tools/bob-sim/bench/bench_rig_cost.cpp -o bench_rig_cost && ./bench_rig_cost
//
// It draws the rig's real part sizes (bob_rig_data.h) with synthetic blobs (opaque interior, a 2 px soft rim) the way
// libs/bob-device/src/bob_rig.cpp does in four situations, times each on the host, and multiplies by a device factor. The factor is an
// ASSUMPTION (LX7 at 240 MHz, in-order, no SIMD in this code, vs a desktop core): 25x to 50x. The number that matters comes from
// the device: the `bob_motion` journal event reports compose_avg_us / compose_max_us / bake_hit / bake_miss the moment we flash.
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <vector>

#include "bob_raster.h"
#include "bob_rig_data.h"

using namespace bob::raster;
using namespace bob::rig;

static double nowUs() { return std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

int main() {
  std::vector<std::vector<uint8_t>> blobs(kPartCount);
  for (int p = 0; p < kPartCount; p++) {
    const int w = kParts[p].w, h = kParts[p].h;
    blobs[p].assign(static_cast<size_t>(w) * h * 3, 0);
    for (int i = 0; i < w * h; i++) {
      const int x = i % w, y = i / w, d = std::min(std::min(x, w - 1 - x), std::min(y, h - 1 - y));
      blobs[p][i * 2] = static_cast<uint8_t>(rand());
      blobs[p][i * 2 + 1] = static_cast<uint8_t>(rand());
      blobs[p][static_cast<size_t>(w) * h * 2 + i] = d < 2 ? (d == 0 ? 0 : 128) : 255;
    }
  }
  // Pose 0 (helper) layers, back to front, as buildLayers orders them.
  const int order[] = {kFootL, kFootR, kArmLDown, kArmRWave, kBellyHelper, kHeadHelper, kVisor, kButton};
  const int n = sizeof(order) / sizeof(order[0]);
  std::vector<uint8_t> fb(240 * 240 * 2);
  FrameSink sink{fb.data(), 240 * 2};
  const Clip clip{0, 0, 240, 232 > 240 ? 240 : 240};
  std::vector<uint8_t> bake(232 * 240 * 3);
  auto layerAt = [&](int i, bool moving, int rep) {
    const int p = order[i];
    const float fx = 30.3f + 7 * i, fy = 20.7f + 9 * i;
    return moving ? translate(fx, fy + (rep & 1) * 0.4f) * rotate(2.0f + (rep & 3) * 0.2f) : translate(fx + 0.3f, fy + 0.7f);
  };
  auto bench = [&](const char* name, int moveMask, bool useBake, int reps) {
    const double t0 = nowUs();
    for (int r = 0; r < reps; r++) {
      if (useBake) {  // baked static run blit (bbox of the figure) + the moving layers
        Clip box{20, 10, 215, 215};
        drawBlob(sink, box, bake.data(), 232, 240, translate(0, 0), 255);
      }
      for (int i = 0; i < n; i++) {
        const bool moving = (moveMask >> i) & 1;
        if (useBake && !moving) continue;
        const int p = order[i];
        const bool big = kParts[p].w * kParts[p].h >= 6000;
        drawBlob(sink, clip, blobs[p].data(), kParts[p].w, kParts[p].h, layerAt(i, moving, r), 255, !(moving && big));
      }
    }
    const double us = (nowUs() - t0) / reps;
    std::printf("%-46s host %7.0f us   ESP32-S3 est. %5.1f - %5.1f ms\n", name, us, us * 25 / 1000, us * 50 / 1000);
  };
  const int all = (1 << n) - 1;
  std::printf("Bob rig compose cost model (parts of pose 'helper', %d layers)\n", n);
  bench("rest, baked run blit", 0, true, 400);
  bench("wave: right arm moves, rest baked", 1 << 3, true, 400);
  bench("hop: everything moves (big parts nearest)", all, false, 400);
  bench("re-bake / settle frame: all bilinear, still", 0, false, 400);
  std::printf("Budget: compose + present <= 15 ms. Present (SPI/DMA push of the frame) is not modelled.\n");
  return 0;
}
