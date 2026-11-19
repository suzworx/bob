// Bob's "alive" maths (libs/bob-device/src/bob_life.h): spring easing, the squish blink, gaze and its spring, the idle
// micro-behaviour scheduler.
#include <cmath>
#include <cstdint>
#include <initializer_list>

#include "bob_life.h"
#include "doctest.h"

using namespace bob::life;

TEST_CASE("life: spring easing starts at 0, ends at 1, overshoots a little once, then settles") {
  CHECK(springEase(0.0f) == doctest::Approx(0.0f));
  CHECK(springEase(1.0f) == doctest::Approx(1.0f));
  CHECK(springEase(-1.0f) == doctest::Approx(0.0f));
  CHECK(springEase(2.0f) == doctest::Approx(1.0f));
  float peak = 0.0f;
  for (int i = 0; i <= 100; ++i) peak = fmaxf(peak, springEase(i / 100.0f));
  CHECK(peak > 1.02f);   // a visible overshoot...
  CHECK(peak < 1.12f);   // ...but a small one
  CHECK(springEase(0.99f) == doctest::Approx(1.0f).epsilon(0.01));  // settled before the end
  CHECK(springEase(0.1f) > 0.0f);
  CHECK(springEase(0.1f) < springEase(0.3f));  // moves forward at first
}

TEST_CASE("life: the squish blink shuts fast, opens slower and widens the eye while low") {
  CHECK(blinkShape(0).open == doctest::Approx(1.0f));
  CHECK(blinkShape(0).widen == doctest::Approx(1.0f));
  CHECK(blinkShape(kBlinkMs).open == doctest::Approx(1.0f));
  CHECK(blinkShape(kBlinkMs + 500).widen == doctest::Approx(1.0f));
  const uint32_t shutAt = static_cast<uint32_t>(kBlinkMs * 0.45f);
  CHECK(blinkShape(shutAt).open < 0.05f);
  CHECK(blinkShape(shutAt).widen > 1.13f);
  CHECK(blinkShape(shutAt / 2).open > blinkShape(shutAt).open);  // closing
  CHECK(blinkShape(kBlinkMs - 20).open > blinkShape(shutAt + 20).open);  // opening
  CHECK(shutAt < kBlinkMs - shutAt);  // closing takes less time than opening
  for (uint32_t ms = 0; ms <= kBlinkMs; ms += 5) {
    CHECK(blinkShape(ms).open >= 0.0f);
    CHECK(blinkShape(ms).open <= 1.0f);
  }
}

TEST_CASE("life: gaze points toward the target and stays inside the visor") {
  Gaze g = gazeToward(180.0f, 140.0f, 180.0f, 140.0f);  // looking at the visor: straight ahead
  CHECK(g.u == doctest::Approx(0.0f));
  CHECK(g.v == doctest::Approx(0.0f));
  g = gazeToward(280.0f, 140.0f, 180.0f, 140.0f);  // far right: full deflection, not more
  CHECK(g.u == doctest::Approx(kGazeMaxU));
  g = gazeToward(1000.0f, -500.0f, 180.0f, 140.0f);
  CHECK(g.u == doctest::Approx(kGazeMaxU));
  CHECK(g.v == doctest::Approx(-kGazeMaxV));
  g = gazeToward(155.0f, 140.0f, 180.0f, 140.0f);  // half way left
  CHECK(g.u == doctest::Approx(-0.5f * kGazeMaxU));
}

TEST_CASE("life: the gaze spring approaches its target without overshooting") {
  Spring s;
  float peak = 0.0f;
  for (int i = 0; i < 60; ++i) {  // two seconds at 30 fps
    s.step(3.0f, 1.0f / 30.0f);
    peak = fmaxf(peak, s.x);
  }
  CHECK(peak <= 3.0f + 0.01f);
  CHECK(s.x == doctest::Approx(3.0f).epsilon(0.02));
  for (int i = 0; i < 60; ++i) s.step(0.0f, 1.0f / 30.0f);
  CHECK(fabsf(s.x) < 0.1f);
  Spring slow;
  slow.step(3.0f, 1.0f / 30.0f);
  CHECK(slow.x < 1.0f);  // it glides, it does not jump
}

TEST_CASE("life: idle micro-behaviours are 10 to 25 s apart and one of five kinds") {
  IdleScheduler sch;
  CHECK_FALSE(sch.due(100000));  // not armed
  for (uint32_t r : {0u, 1u, 7777u, 14999u, 15000u, 0xFFFFFFFFu}) {
    sch.arm(1000, r);
    CHECK(sch.nextAt() >= 1000 + kMicroMinMs);
    CHECK(sch.nextAt() <= 1000 + kMicroMinMs + kMicroSpanMs);
  }
  sch.arm(5000, 0);
  CHECK_FALSE(sch.due(5000 + kMicroMinMs - 1));
  CHECK(sch.due(5000 + kMicroMinMs));
  sch.disarm();
  CHECK_FALSE(sch.due(1000000));
  bool seen[6] = {};
  for (uint32_t r = 0; r < 50; ++r) {
    const Micro m = IdleScheduler::pick(r);
    CHECK(m != Micro::kNone);
    seen[static_cast<int>(m)] = true;
  }
  for (int i = 1; i <= 5; ++i) CHECK(seen[i]);
}

TEST_CASE("life: the scheduler survives the millisecond counter wrapping") {
  IdleScheduler sch;
  sch.arm(0xFFFFF000u, 0);
  CHECK_FALSE(sch.due(0xFFFFF000u + 100));
  CHECK(sch.due(0xFFFFF000u + kMicroMinMs));  // wraps past zero
}
