// CP-710-TLS-LOOP: the internet probe runs on its own task and the main loop
// polls it (include/probe_task.h); ws_net shares core 1 while connecting.
#include "doctest.h"
#include "probe_task.h"

using bob::ProbePhase;
using bob::ProbePoll;
using bob::ProbeResult;
using bob::ProbeTaskSlot;
using bob::wsNetPriority;

TEST_CASE("ws_net priority: 2 once connected, 1 while connecting") {
  CHECK(wsNetPriority(true) == 2);
  CHECK(wsNetPriority(false) == 1);
}

TEST_CASE("probe: start, poll while running, done, consume") {
  ProbeTaskSlot slot;
  ProbeResult result = ProbeResult::kOnline;
  uint32_t ms = 0;
  CHECK(slot.phase() == ProbePhase::kIdle);
  CHECK(slot.poll(result, ms) == ProbePoll::kIdle);
  REQUIRE(slot.start());
  CHECK(slot.phase() == ProbePhase::kRunning);
  CHECK(slot.poll(result, ms) == ProbePoll::kRunning);
  slot.finish(ProbeResult::kCaptive, 640, 1800);  // on the probe task
  CHECK(slot.phase() == ProbePhase::kDone);
  CHECK(slot.poll(result, ms) == ProbePoll::kResult);
  CHECK(result == ProbeResult::kCaptive);
  CHECK(ms == 640);
  CHECK(slot.stackFree() == 1800);
  CHECK(slot.phase() == ProbePhase::kIdle);  // consumed
  CHECK(slot.poll(result, ms) == ProbePoll::kIdle);  // only once
}

TEST_CASE("probe: never two at once") {
  ProbeTaskSlot slot;
  REQUIRE(slot.start());
  CHECK_FALSE(slot.start());
  CHECK_FALSE(slot.start());
  slot.finish(ProbeResult::kOnline, 10, 0);
  CHECK(slot.start());  // the task is gone: a new probe may start
}

TEST_CASE("probe: a reload mid-probe makes its result stale, and a new probe waits") {
  ProbeTaskSlot slot;
  ProbeResult result = ProbeResult::kOnline;
  uint32_t ms = 0;
  REQUIRE(slot.start());
  slot.discard();  // wifiManagerReload / pause while the task still runs
  CHECK(slot.phase() == ProbePhase::kRunning);  // the task is not touched
  CHECK_FALSE(slot.start());                    // the new join's probe waits
  CHECK(slot.poll(result, ms) == ProbePoll::kRunning);
  slot.finish(ProbeResult::kNoDns, 5000, 0);
  CHECK(slot.poll(result, ms) == ProbePoll::kStale);
  CHECK(result == ProbeResult::kNoDns);
  CHECK(slot.phase() == ProbePhase::kIdle);
  // The next probe is fresh, not stale.
  REQUIRE(slot.start());
  slot.finish(ProbeResult::kOnline, 700, 0);
  CHECK(slot.poll(result, ms) == ProbePoll::kResult);
  CHECK(result == ProbeResult::kOnline);
}

TEST_CASE("probe: a discard after the task finished drops the result") {
  ProbeTaskSlot slot;
  ProbeResult result = ProbeResult::kOnline;
  uint32_t ms = 0;
  REQUIRE(slot.start());
  slot.finish(ProbeResult::kTlsFail, 900, 0);
  slot.discard();
  CHECK(slot.phase() == ProbePhase::kIdle);
  CHECK(slot.poll(result, ms) == ProbePoll::kIdle);
}

TEST_CASE("probe: a failed task create leaves the slot idle") {
  ProbeTaskSlot slot;
  REQUIRE(slot.start());
  slot.abort();
  CHECK(slot.phase() == ProbePhase::kIdle);
  CHECK(slot.start());
}

TEST_CASE("probe: a start drops an unconsumed result") {
  ProbeTaskSlot slot;
  ProbeResult result = ProbeResult::kOnline;
  uint32_t ms = 0;
  REQUIRE(slot.start());
  slot.finish(ProbeResult::kCaptive, 1, 0);
  REQUIRE(slot.start());
  CHECK(slot.poll(result, ms) == ProbePoll::kRunning);
}
