// Audio level meters (include/level_meter.h): normalisation against the floor, the playback RMS scale,
// the 80 ms smoothing, stale sources. Pure math; the audio paths only call update().
#include <cmath>
#include <cstdint>

#include "doctest.h"
#include "level_meter.h"

using namespace bob::level;

TEST_CASE("level: capture is 0 at the floor, 1 at floor + 30 dB, clamped, and 0 while the floor is unmeasured") {
  CHECK(captureTarget01(20.0f, 20.0f) == doctest::Approx(0.0f));
  CHECK(captureTarget01(35.0f, 20.0f) == doctest::Approx(0.5f));
  CHECK(captureTarget01(50.0f, 20.0f) == doctest::Approx(1.0f));
  CHECK(captureTarget01(90.0f, 20.0f) == doctest::Approx(1.0f));
  CHECK(captureTarget01(10.0f, 20.0f) == doctest::Approx(0.0f));
  CHECK(captureTarget01(60.0f, -1.0f) == doctest::Approx(0.0f));
}

TEST_CASE("level: playback scale runs from -50 dBFS (0) to -5 dBFS (1), silence is 0") {
  CHECK(playbackTarget01(0.0f) == doctest::Approx(0.0f));
  CHECK(playbackTarget01(32768.0f * std::pow(10.0f, -50.0f / 20.0f)) == doctest::Approx(0.0f).epsilon(0.001));
  CHECK(playbackTarget01(32768.0f * std::pow(10.0f, -5.0f / 20.0f)) == doctest::Approx(1.0f).epsilon(0.001));
  CHECK(playbackTarget01(32768.0f) == doctest::Approx(1.0f));
  const float mid = playbackTarget01(32768.0f * std::pow(10.0f, -27.5f / 20.0f));
  CHECK(mid == doctest::Approx(0.5f).epsilon(0.01));
}

TEST_CASE("level: rms of a block") {
  const int16_t dc[4] = {1000, -1000, 1000, -1000};
  CHECK(rmsOf(dc, 4) == doctest::Approx(1000.0f));
  CHECK(rmsOf(dc, 0) == doctest::Approx(0.0f));
  const int16_t zero[3] = {0, 0, 0};
  CHECK(rmsOf(zero, 3) == doctest::Approx(0.0f));
}

TEST_CASE("level: the filter reaches 63% of a step after one time constant and settles") {
  float v = 0.0f;
  for (uint32_t t = 0; t < kSmoothMs; t += 10) v = smooth(v, 1.0f, 10);
  CHECK(v > 0.55f);
  CHECK(v < 0.70f);
  for (int i = 0; i < 100; ++i) v = smooth(v, 1.0f, 10);
  CHECK(v > 0.99f);
  CHECK(smooth(0.4f, 1.0f, 0) == doctest::Approx(0.4f));  // no time, no change
  float down = 1.0f;
  for (int i = 0; i < 100; ++i) down = smooth(down, 0.0f, 10);
  CHECK(down < 0.01f);
}

TEST_CASE("level: a meter follows updates, reads 0 when the source goes quiet") {
  Meter m;
  CHECK(m.level(5000) == doctest::Approx(0.0f));  // never updated
  uint32_t t = 10000;
  for (int i = 0; i < 30; ++i, t += 10) m.update(1.0f, t);
  CHECK(m.level(t) > 0.9f);
  const uint32_t lastUpdate = t - 10;
  CHECK(m.level(lastUpdate + kStaleMs) > 0.9f);   // within the stale window the last value stands
  CHECK(m.level(lastUpdate + kStaleMs + 1) == doctest::Approx(0.0f));
  m.update(0.0f, t + 1000);                       // after a gap it restarts from 0, not from the old level
  CHECK(m.level(t + 1000) < 0.6f);
}

TEST_CASE("level: a loud burst then silence decays smoothly") {
  Meter m;
  uint32_t t = 1;
  for (int i = 0; i < 20; ++i, t += 10) m.update(1.0f, t);
  const float loud = m.level(t);
  float last = loud;
  for (int i = 0; i < 20; ++i, t += 10) {
    m.update(0.0f, t);
    const float now = m.level(t);
    CHECK(now <= last + 0.001f);
    last = now;
  }
  CHECK(last < loud * 0.5f);
}

TEST_CASE("level: the meter handles the millisecond counter wrapping") {
  Meter m;
  uint32_t t = 0xFFFFFFF0u;
  for (int i = 0; i < 6; ++i, t += 10) m.update(1.0f, t);  // wraps past 0
  CHECK(m.level(t) > 0.3f);
}

TEST_CASE("level: a reply's level keeps the loudest block and the mean; digital silence reads 0 (#1063)") {
  ReplyLevel silent;
  CHECK(silent.peak() == doctest::Approx(0.0f));
  CHECK(silent.mean() == doctest::Approx(0.0f));
  const int16_t zero[4] = {0, 0, 0, 0};
  silent.add(playbackTarget01(rmsOf(zero, 4)));
  CHECK(silent.blocks() == 1);
  CHECK(silent.peak() == doctest::Approx(0.0f));  // HIL asserts playback_level01_peak > 0

  ReplyLevel reply;
  reply.add(0.2f);
  reply.add(0.8f);
  reply.add(0.5f);
  reply.add(1.7f);  // clamped like the meter
  CHECK(reply.peak() == doctest::Approx(1.0f));
  CHECK(reply.mean() == doctest::Approx((0.2f + 0.8f + 0.5f + 1.0f) / 4.0f));
  reply.clear();
  CHECK(reply.blocks() == 0);
  CHECK(reply.peak() == doctest::Approx(0.0f));
}
