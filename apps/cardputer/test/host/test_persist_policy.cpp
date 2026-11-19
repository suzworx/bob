// When settings are written to NVS (include/persist_policy.h): 2 s after the
// last change, at most once every 2 s, and wrap-safe.
#include <cstdint>

#include "doctest.h"
#include "persist_policy.h"

namespace {
constexpr uint32_t kQuiet = 2000;
constexpr uint32_t kInterval = 2000;

bool due(uint32_t now, uint32_t lastChange, bool committed = false, uint32_t lastCommit = 0) {
  return bob::persistDue(true, now, lastChange, committed, lastCommit, kQuiet, kInterval);
}
}  // namespace

TEST_CASE("nothing changed: never due") {
  CHECK_FALSE(bob::persistDue(false, 100000, 0, false, 0, kQuiet, kInterval));
}

TEST_CASE("due only after 2 s of quiet") {
  CHECK_FALSE(due(10000, 9000));
  CHECK_FALSE(due(10999, 9000));
  CHECK(due(11000, 9000));
}

TEST_CASE("a change stamped after the loop's start time is not 49 days old") {
  // The loop starts at 10000; a key press later in the same iteration
  // stamps 10003. Unsigned, 10000 - 10003 wraps to ~4.29e9 and would commit.
  CHECK_FALSE(due(10000, 10003));
  CHECK_FALSE(due(10000, 10003, true, 5000));
}

TEST_CASE("holding a key keeps postponing the write") {
  // A change every 150 ms (auto-repeat): the quiet period never elapses.
  for (uint32_t t = 10000; t < 20000; t += 150) CHECK_FALSE(due(t + 10, t + 12));
  CHECK(due(20000 + 2000, 20000));
}

TEST_CASE("at most one commit every 2 s") {
  CHECK_FALSE(due(15000, 12000, true, 14000));
  CHECK(due(16000, 12000, true, 14000));
}

TEST_CASE("wrap-safe across the millis() rollover") {
  const uint32_t before = 0xFFFFFF00u;
  CHECK_FALSE(due(before + 1000, before));
  CHECK(due(before + 2100, before));  // now has wrapped past zero.
  CHECK_FALSE(due(before + 2100, before, true, before + 1500));
}
