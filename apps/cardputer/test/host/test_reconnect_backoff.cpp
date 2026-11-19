// CP-709-BACKOFF: the WebSocket reconnect back-off (include/reconnect_backoff.h).
// superviseConnections() waits exactly the retry_ms socket_closed journals, so
// a server that stays down is retried at 2, 4, 8, 16, 30 s, never every 1 s.
#include <cstdint>
#include <vector>

#include "config.h"
#include "doctest.h"
#include "reconnect_backoff.h"

using bob::nextReconnectDelayMs;
using bob::ReconnectBackoff;
using bob::config::kSocketReconnectInitialMs;
using bob::config::kSocketReconnectMaxMs;

namespace {

ReconnectBackoff deviceBackoff() {
  return ReconnectBackoff(kSocketReconnectInitialMs, kSocketReconnectMaxMs);
}

// What state.cpp does: on a failed socket_closed it calls fail() and journals
// delayMs(); superviseConnections() then waits until reconnectDue().
struct Cadence {
  std::vector<uint32_t> logged;  // socket_closed retry_ms values.
  std::vector<uint32_t> waited;  // ms from that close to the next start().
};

void failedConnect(ReconnectBackoff& backoff, Cadence& cadence) {
  backoff.fail();
  cadence.logged.push_back(backoff.delayMs());
}

}  // namespace

TEST_CASE("backoff: starts at the initial delay") {
  CHECK(kSocketReconnectInitialMs == 1000);
  CHECK(kSocketReconnectMaxMs == 30000);
  CHECK(deviceBackoff().delayMs() == 1000);
}

TEST_CASE("backoff: doubles on each failure and clamps at the max") {
  ReconnectBackoff backoff = deviceBackoff();
  const uint32_t expected[] = {2000, 4000, 8000, 16000, 30000, 30000, 30000};
  for (uint32_t want : expected) {
    backoff.fail();
    CHECK(backoff.delayMs() == want);
  }
}

TEST_CASE("backoff: the next delay never overflows or passes the max") {
  CHECK(nextReconnectDelayMs(1000, 30000) == 2000);
  CHECK(nextReconnectDelayMs(15000, 30000) == 30000);
  CHECK(nextReconnectDelayMs(16000, 30000) == 30000);
  CHECK(nextReconnectDelayMs(30000, 30000) == 30000);
  CHECK(nextReconnectDelayMs(0xFFFFFFFFu, 30000) == 30000);
  CHECK(nextReconnectDelayMs(0x80000000u, 0xFFFFFFFFu) == 0xFFFFFFFFu);
}

TEST_CASE("backoff: a successful connect resets to the initial delay") {
  ReconnectBackoff backoff = deviceBackoff();
  for (int i = 0; i < 10; ++i) backoff.fail();
  REQUIRE(backoff.delayMs() == 30000);
  backoff.reset();  // welcome / WStype_CONNECTED
  CHECK(backoff.delayMs() == 1000);
  backoff.fail();  // a later server restart starts the ladder again
  CHECK(backoff.delayMs() == 2000);
}

TEST_CASE("backoff: the supervisor waits exactly the retry_ms it logged") {
  ReconnectBackoff backoff = deviceBackoff();
  Cadence cadence;
  uint32_t now = 5000;
  for (int i = 0; i < 8; ++i) {
    // A failed connect: socket_closed journals retry_ms and marks the close.
    const uint32_t closedAt = now;
    failedConnect(backoff, cadence);
    // superviseConnections() polls every millisecond until the start is due.
    while (!bob::reconnectDue(now, closedAt, backoff.delayMs())) ++now;
    cadence.waited.push_back(now - closedAt - 1);  // due on the first ms past it
  }
  CHECK(cadence.waited == cadence.logged);
  CHECK(cadence.logged == std::vector<uint32_t>{2000, 4000, 8000, 16000, 30000, 30000, 30000,
                                               30000});
}

TEST_CASE("backoff: a start is never due early, even across the millis() wrap") {
  CHECK_FALSE(bob::reconnectDue(1000, 1000, 2000));
  CHECK_FALSE(bob::reconnectDue(3000, 1000, 2000));
  CHECK(bob::reconnectDue(3001, 1000, 2000));
  const uint32_t closedAt = 0xFFFFFF00u;  // 256 ms before the wrap
  CHECK_FALSE(bob::reconnectDue(closedAt + 2000u, closedAt, 2000));
  CHECK(bob::reconnectDue(closedAt + 2001u, closedAt, 2000));
}

// c2: one lost CONNECTED/DISCONNECTED must never stop reconnects for good.
using bob::attemptExpired;
using bob::ConnectAttempt;
using bob::kConnectAttemptMaxMs;

TEST_CASE("attempt: expires only past the bound, even across the millis() wrap") {
  CHECK(kConnectAttemptMaxMs >= 161000);  // DNS 31 s + TCP 5 s + TLS 120 s + WS 5 s
  CHECK_FALSE(attemptExpired(1000, 1000, kConnectAttemptMaxMs));
  CHECK_FALSE(attemptExpired(1000, 1000 + kConnectAttemptMaxMs, kConnectAttemptMaxMs));
  CHECK(attemptExpired(1000, 1001 + kConnectAttemptMaxMs, kConnectAttemptMaxMs));
  const uint32_t started = 0xFFFFF000u;  // 4096 ms before the wrap
  CHECK_FALSE(attemptExpired(started, started + kConnectAttemptMaxMs, kConnectAttemptMaxMs));
  CHECK(attemptExpired(started, started + kConnectAttemptMaxMs + 1u, kConnectAttemptMaxMs));
}

TEST_CASE("attempt: an end event before the bound closes it, and expiry never fires") {
  ConnectAttempt attempt;
  const uint32_t id = attempt.begin(5000);
  CHECK(id != 0);
  CHECK(attempt.open());
  uint32_t elapsed = 0;
  CHECK_FALSE(attempt.expire(5000 + kConnectAttemptMaxMs, kConnectAttemptMaxMs, elapsed));
  CHECK(attempt.end(id));  // the DISCONNECTED of a refused connect
  CHECK_FALSE(attempt.open());
  CHECK_FALSE(attempt.expire(5000 + 10 * kConnectAttemptMaxMs, kConnectAttemptMaxMs, elapsed));
  CHECK(elapsed == 0);  // untouched: nothing expired
}

TEST_CASE("attempt: a lost end event expires it once, and the late event is stale") {
  ConnectAttempt attempt;
  const uint32_t id = attempt.begin(0xFFFFFF00u);  // across the wrap as well
  uint32_t elapsed = 0;
  const uint32_t past = 0xFFFFFF00u + kConnectAttemptMaxMs + 1u;
  REQUIRE(attempt.expire(past, kConnectAttemptMaxMs, elapsed));
  CHECK(elapsed == kConnectAttemptMaxMs + 1u);
  CHECK_FALSE(attempt.open());
  CHECK_FALSE(attempt.expire(past + 1000u, kConnectAttemptMaxMs, elapsed));  // only once
  CHECK_FALSE(attempt.end(id));  // the late DISCONNECTED: ignored, not a 2nd failure
  // The next start opens a new attempt; the old id still cannot end it.
  const uint32_t next = attempt.begin(past + 2000u);
  CHECK(next != id);
  CHECK_FALSE(attempt.end(id));
  CHECK(attempt.open());
  CHECK(attempt.end(next));
}

TEST_CASE("attempt: an expiry is one failed connect on the same back-off ladder") {
  ReconnectBackoff backoff = deviceBackoff();
  ConnectAttempt attempt;
  int failures = 0;
  uint32_t now = 1000;
  for (int i = 0; i < 3; ++i) {
    const uint32_t id = attempt.begin(now);
    uint32_t elapsed = 0;
    now += kConnectAttemptMaxMs + 1u;
    if (attempt.expire(now, kConnectAttemptMaxMs, elapsed)) {  // what the main loop does
      backoff.fail();
      ++failures;
    }
    if (attempt.end(id)) {  // the late event: must not count again
      backoff.fail();
      ++failures;
    }
  }
  CHECK(failures == 3);
  CHECK(backoff.delayMs() == 8000);
}

TEST_CASE("attempt: ids start at 1, id 0 never ends one, and cancel closes it") {
  ConnectAttempt attempt;
  uint32_t id = 0;
  for (int i = 0; i < 3; ++i) id = attempt.begin(0);
  CHECK(id == 3);
  attempt.cancel();
  CHECK_FALSE(attempt.open());
  CHECK_FALSE(attempt.end(0));
}
