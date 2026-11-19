// Host tests for the Ready-screen timer band's view model (#457): countdown
// math and format, ordering, "+N more", reaching zero, and the millis() wrap.
#include <cstdint>
#include <cstring>
#include <string>

#include "doctest.h"
#include "protocol.h"
#include "support.h"
#include "timers_view.h"

namespace {

bob::TimersMessage message(std::initializer_list<std::pair<const char*, uint32_t>> timers) {
  bob::TimersMessage out;
  for (const auto& [label, firesIn] : timers) {
    bob::TimerEntry& entry = out.entries[out.count++];
    std::strncpy(entry.label, label, sizeof(entry.label) - 1);
    entry.firesInMs = firesIn;
  }
  return out;
}

std::string clockFor(uint32_t remainingMs) {
  char clock[bob::kTimerClockBytes];
  bob::formatCountdown(remainingMs, clock, sizeof(clock));
  return clock;
}

}  // namespace

TEST_CASE("countdown format: m:ss under an hour, h:mm from an hour, seconds round up") {
  CHECK(clockFor(0) == "0:00");
  CHECK(clockFor(1) == "0:01");
  CHECK(clockFor(1000) == "0:01");
  CHECK(clockFor(1001) == "0:02");
  CHECK(clockFor(272000) == "4:32");
  CHECK(clockFor(3599000) == "59:59");
  CHECK(clockFor(3600000) == "1:00");
  CHECK(clockFor(5400000) == "1:30");
  CHECK(clockFor(30600000) == "8:30");
  CHECK(clockFor(bob::kTimerFiresInMaxMs) == "596:31");
  char clock[bob::kTimerClockBytes];
  CHECK_FALSE(bob::formatCountdown(3599000, clock, sizeof(clock)));
  CHECK(bob::formatCountdown(3600000, clock, sizeof(clock)));
}

TEST_CASE("the band counts down locally from receipt, one step per second") {
  bob::TimersModel model;
  bob::timersApply(model, message({{"Pasta", 272000}}), 10000);
  bob::TimerBandView view = bob::timerBandView(model, 10000);
  CHECK(view.visible);
  CHECK(std::string(view.label) == "Pasta");
  CHECK(std::string(view.clock) == "4:32");
  CHECK(view.more == 0);
  CHECK(bob::timerBandView(model, 10999) == view);  // same second: nothing to repaint.
  view = bob::timerBandView(model, 11000);
  CHECK(std::string(view.clock) == "4:31");
}

TEST_CASE("soonest first, and +N more for the others") {
  bob::TimersModel model;
  bob::timersApply(model, message({{"Laundry", 5400000}, {"Pasta", 272000}, {"Tea", 180000}}), 0);
  CHECK(std::string(model.timers.entries[0].label) == "Tea");
  CHECK(std::string(model.timers.entries[1].label) == "Pasta");
  CHECK(std::string(model.timers.entries[2].label) == "Laundry");
  const bob::TimerBandView view = bob::timerBandView(model, 0);
  CHECK(std::string(view.label) == "Tea");
  CHECK(view.more == 2);
}

TEST_CASE("an unlabelled timer or alarm reads Timer or Alarm") {
  bob::TimersModel model;
  bob::TimersMessage alarm = message({{"", 60000}});
  alarm.entries[0].kind = bob::TimerKind::kAlarm;
  bob::timersApply(model, alarm, 0);
  CHECK(std::string(bob::timerBandView(model, 0).label) == "Alarm");
  bob::timersApply(model, message({{"", 60000}}), 0);
  CHECK(std::string(bob::timerBandView(model, 0).label) == "Timer");
}

TEST_CASE("at zero it holds 0:00 until the server's ring and new list arrive") {
  bob::TimersModel model;
  bob::timersApply(model, message({{"Pasta", 2000}}), 500);
  CHECK_FALSE(bob::timerBandView(model, 1500).reached);
  for (uint32_t now : {2500u, 3000u, 600000u}) {
    const bob::TimerBandView view = bob::timerBandView(model, now);
    CHECK(view.visible);
    CHECK(view.reached);
    CHECK(std::string(view.clock) == "0:00");
  }
  bob::TimersMessage empty;
  REQUIRE(bob::parseTimersState(hosttest::fixture("timers_state_empty"), empty));
  bob::timersApply(model, empty, 600000);
  CHECK_FALSE(bob::timerBandView(model, 600000).visible);
}

TEST_CASE("the countdown is right across the millis() wrap") {
  bob::TimersModel model;
  const uint32_t received = UINT32_MAX - 1000;  // 1 s before the wrap.
  bob::timersApply(model, message({{"Pasta", 10000}}), received);
  CHECK(bob::timerRemainingMs(model.timers.entries[0], received, 4000) == 4999);
  CHECK(std::string(bob::timerBandView(model, 4000).clock) == "0:05");
  CHECK(bob::timerBandView(model, 9000).reached);
}

TEST_CASE("the fixture drives the band; clear hides it") {
  bob::TimersMessage parsed;
  REQUIRE(bob::parseTimersState(hosttest::fixture("timers_state"), parsed));
  bob::TimersModel model;
  bob::timersApply(model, parsed, 0);
  const bob::TimerBandView view = bob::timerBandView(model, 0);
  CHECK(std::string(view.label) == "Pasta");
  CHECK(std::string(view.clock) == "4:32");
  CHECK(view.more == 2);
  bob::timersClear(model);
  CHECK_FALSE(bob::timerBandView(model, 0).visible);
}
