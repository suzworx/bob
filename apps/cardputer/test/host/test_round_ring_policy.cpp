// The round screen's light ring: mood table and animation math (libs/bob-device/src/round_ring_policy.h).
#include <cstdint>

#include "doctest.h"
#include "round_ring_policy.h"

using bob::RingMode;

TEST_CASE("light ring: every mood maps to the pattern the brief names") {
  CHECK(bob::ringModeForMood(0, false) == RingMode::kOff);        // Idle
  CHECK(bob::ringModeForMood(1, false) == RingMode::kListening);  // Listening
  CHECK(bob::ringModeForMood(2, false) == RingMode::kThinking);   // Thinking
  CHECK(bob::ringModeForMood(3, false) == RingMode::kSpeaking);   // Speaking
  CHECK(bob::ringModeForMood(4, false) == RingMode::kSleep);      // Sleeping
  CHECK(bob::ringModeForMood(5, false) == RingMode::kOff);        // Offline: soft rim like the demo
  CHECK(bob::ringModeForMood(6, false) == RingMode::kError);      // Error
  CHECK(bob::ringModeForMood(7, false) == RingMode::kThinking);   // Updating
  CHECK(bob::ringModeForMood(8, false) == RingMode::kOff);        // Hello
  CHECK(bob::ringModeForMood(200, false) == RingMode::kOff);      // out of range is dark
}

TEST_CASE("light ring: do-not-disturb dims only the dark states") {
  CHECK(bob::ringModeForMood(0, true) == RingMode::kDnd);
  CHECK(bob::ringModeForMood(8, true) == RingMode::kDnd);
  CHECK(bob::ringModeForMood(1, true) == RingMode::kListening);
  CHECK(bob::ringModeForMood(6, true) == RingMode::kError);
}

TEST_CASE("light ring: smoothing attacks fast, releases slowly, and never overshoots") {
  float v = 0.0f;
  for (int i = 0; i < 10; ++i) v = bob::ringSmooth(v, 1.0f, 33, 40, 200);
  CHECK(v > 0.9f);
  CHECK(v <= 1.0f);
  float down = 1.0f;
  for (int i = 0; i < 3; ++i) down = bob::ringSmooth(down, 0.0f, 33, 40, 200);
  CHECK(down > 0.4f);  // 100 ms into a 200 ms release is still lit
  CHECK(bob::ringSmooth(0.2f, 0.7f, 33, 0, 200) == doctest::Approx(0.7f));  // zero attack snaps
}

TEST_CASE("light ring: breathe, sweep and comet stay in range and wrap") {
  for (uint32_t t = 0; t < 4000; t += 97) {
    const float b = bob::ringBreathe(t, 1600);
    CHECK(b >= 0.0f);
    CHECK(b <= 1.0f);
    const float a = bob::ringCometAngle(t, 1200);
    CHECK(a >= 0.0f);
    CHECK(a < 360.0f);
  }
  CHECK(bob::ringSweep(0, 600) == doctest::Approx(0.0f));
  CHECK(bob::ringSweep(600, 600) == doctest::Approx(1.0f));
  CHECK(bob::ringSweep(5000, 600) == doctest::Approx(1.0f));
  CHECK(bob::ringSweep(300, 600) > 0.5f);  // eased out: past halfway at half time
  CHECK(bob::ringCometAngle(1200, 1200) == doctest::Approx(0.0f));
  CHECK(bob::ringCometAngle(600, 1200) == doctest::Approx(180.0f));
}

TEST_CASE("light ring: the error pulse is a double bump then a dim rest") {
  CHECK(bob::ringErrorPulse(110) > 0.95f);   // first bump peaks
  CHECK(bob::ringErrorPulse(410) > 0.95f);   // second bump, 300 ms later
  CHECK(bob::ringErrorPulse(250) == doctest::Approx(0.15f));  // gap between the bumps
  CHECK(bob::ringErrorPulse(1500) == doctest::Approx(0.15f)); // rest
  CHECK(bob::ringErrorPulse(2110) > 0.95f);  // repeats every 2 s
}

TEST_CASE("light ring: the notification pulse fires every 1.5 s") {
  CHECK(bob::ringNotifyPulse(250) > 0.95f);
  CHECK(bob::ringNotifyPulse(1000) == doctest::Approx(0.0f));
  CHECK(bob::ringNotifyPulse(1750) > 0.95f);
}
