// The wake_stats window (include/wake_stats.h): frames and frame rate over the
// window, the largest model output and the loudest frame, reset per window.
#include <cstdint>

#include "doctest.h"
#include "wake_stats.h"

using bob::WakeStatsWindow;

TEST_CASE("frame rate is frames per second of elapsed time, rounded") {
  CHECK(bob::framesPerSecond(500, 5000) == 100);
  CHECK(bob::framesPerSecond(426, 5000) == 85);  // 85.2
  CHECK(bob::framesPerSecond(428, 5000) == 86);  // 85.6
  CHECK(bob::framesPerSecond(10, 0) == 0);
}

TEST_CASE("a window is not due before its period has passed") {
  WakeStatsWindow window;
  window.begin(1000);
  CHECK_FALSE(window.due(5999, 5000));
  CHECK(window.due(6000, 5000));
}

TEST_CASE("the window reports frames, fps, the max model output and the peak frame") {
  WakeStatsWindow window;
  window.begin(1000);
  for (int i = 0; i < 500; ++i) window.addFrame(i == 7 ? 71.5f : 30.0f);
  window.addProbability(12);
  window.addProbability(201);
  window.addProbability(90);
  const bob::WakeStats stats = window.take(6000);
  CHECK(stats.frames == 500);
  CHECK(stats.fps == 100);
  CHECK(stats.maxProbability == 201);
  CHECK(stats.peakDb == doctest::Approx(71.5f));
}

TEST_CASE("taking the stats starts a fresh window") {
  WakeStatsWindow window;
  window.begin(0);
  window.addFrame(60.0f);
  window.addProbability(250);
  window.take(5000);
  CHECK_FALSE(window.due(9999, 5000));
  window.addFrame(20.0f);
  const bob::WakeStats next = window.take(10000);
  CHECK(next.frames == 1);
  CHECK(next.maxProbability == 0);
  CHECK(next.peakDb == doctest::Approx(20.0f));
}

TEST_CASE("the period survives the millis() wrap") {
  WakeStatsWindow window;
  window.begin(UINT32_MAX - 1000);
  CHECK_FALSE(window.due(2000, 5000));
  CHECK(window.due(4000, 5000));
}
