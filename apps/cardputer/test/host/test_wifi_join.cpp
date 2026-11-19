// How the device picks and judges Wi-Fi joins (include/wifi_join.h, #676):
// priority order over what a scan saw, hidden networks always tried, captive
// networks last, disconnect reasons, back-off, and the internet check.
#include <memory>
#include <string>

#include "doctest.h"
#include "net_store.h"
#include "wifi_join.h"

using namespace bob;

namespace {

std::unique_ptr<NetworkList> listOf(std::initializer_list<const char*> names) {
  auto list = std::make_unique<NetworkList>();
  netClear(*list);
  for (const char* name : names) netAdd(*list, name, "password1", 0, nullptr);
  return list;
}

std::string plan(const NetworkList& list, uint8_t visible) {
  uint8_t out[kMaxNetworks];
  const size_t n = joinPlan(list, visible, out);
  std::string s;
  for (size_t i = 0; i < n; ++i) s += static_cast<char>('0' + out[i]);
  return s;
}

constexpr uint8_t bit(uint8_t slot) { return static_cast<uint8_t>(1u << slot); }

}  // namespace

TEST_CASE("plan: priority order, only networks a scan saw") {
  auto list = listOf({"A", "B", "C"});
  CHECK(plan(*list, bit(0) | bit(1) | bit(2)) == "012");
  CHECK(plan(*list, bit(1) | bit(2)) == "12");  // the first one is down: try the next
  CHECK(plan(*list, 0).empty());
}

TEST_CASE("plan: follows a reordered priority, not slot ids") {
  auto list = listOf({"A", "B", "C"});
  netMove(*list, 2, -2);
  CHECK(plan(*list, bit(0) | bit(1) | bit(2)) == "201");
}

TEST_CASE("plan: a hidden network is tried even when no scan shows it") {
  auto list = listOf({"A", "B"});
  list->slot[1].flags |= kNetFlagHidden;
  CHECK(plan(*list, bit(0)) == "01");
  CHECK(plan(*list, 0) == "1");
}

TEST_CASE("plan: captive networks go last") {
  auto list = listOf({"Hotel", "Home", "Phone"});
  list->slot[0].last = JoinResult::kCaptive;
  CHECK(plan(*list, bit(0) | bit(1) | bit(2)) == "120");
}

TEST_CASE("plan: a forgotten network is never tried") {
  auto list = listOf({"A", "B", "C"});
  netRemove(*list, 1);
  CHECK(plan(*list, bit(0) | bit(1) | bit(2)) == "02");
}

// #707: boot joins the top saved network with no scan first.
TEST_CASE("direct try: the top slot by priority, not by slot id or by what a scan saw") {
  auto list = listOf({"A", "B", "C"});
  DirectTry first = directTryStart(*list);
  CHECK(first.active);
  CHECK(first.slot == 0);
  netMove(*list, 2, -2);  // C is now first in line
  first = directTryStart(*list);
  CHECK(first.active);
  CHECK(first.slot == 2);
}

TEST_CASE("direct try: a captive network is not the first try while another is saved") {
  auto list = listOf({"Hotel", "Home"});
  list->slot[0].last = JoinResult::kCaptive;
  CHECK(directTryStart(*list).slot == 1);
}

TEST_CASE("direct try: a failure falls back to a scan, never to the next network blind") {
  auto list = listOf({"A", "B", "C"});
  DirectTry attempt = directTryStart(*list);
  CHECK(directTryEnd(attempt, false) == DirectStep::kScan);
  CHECK_FALSE(attempt.active);
  CHECK(attempt.slot == kNoSlot);
  // Ending it again (the scanned round's attempts) never asks for a second blind try.
  CHECK(directTryEnd(attempt, false) == DirectStep::kScan);
}

TEST_CASE("direct try: success ends it, and later attempts are ordinary ones") {
  auto list = listOf({"A", "B"});
  DirectTry attempt = directTryStart(*list);
  CHECK(directTryEnd(attempt, true) == DirectStep::kDone);
  CHECK_FALSE(attempt.active);
  CHECK(attempt.slot == kNoSlot);
}

TEST_CASE("direct try: nothing saved means no try (idle, as before)") {
  auto list = listOf({});
  const DirectTry none = directTryStart(*list);
  CHECK_FALSE(none.active);
  CHECK(none.slot == kNoSlot);
  auto forgotten = listOf({"A"});
  netRemove(*forgotten, 0);
  CHECK_FALSE(directTryStart(*forgotten).active);
}

TEST_CASE("direct try: a hidden top network is tried directly like any other") {
  auto list = listOf({"A", "B"});
  list->slot[0].flags |= kNetFlagHidden;
  CHECK(directTryStart(*list).slot == 0);
}

TEST_CASE("disconnect reasons: wrong password, not found, anything else") {
  CHECK(classifyDisconnect(201) == JoinResult::kNoAp);
  for (uint8_t auth : {2, 15, 202, 203, 204, 205}) {
    CAPTURE(auth);
    CHECK(classifyDisconnect(auth) == JoinResult::kAuth);
  }
  CHECK(classifyDisconnect(8) == JoinResult::kTimeout);
  CHECK(classifyDisconnect(0) == JoinResult::kTimeout);
}

namespace {

// The manager's counter contract: joins of one network until the policy says
// stop, with every disconnect carrying `reason`. Returns the number of joins.
int joinsUntilFailed(uint8_t reason) {
  uint8_t retries = 0;  // reset for each new network (tryCurrent)
  int joins = 1;
  while (joinRetrySameSlot(reason, retries)) {
    ++retries;
    ++joins;
  }
  return joins;
}

}  // namespace

TEST_CASE("join retry: a transient AUTH_FAIL (202) is retried twice, then fails") {
  CHECK(kJoinTransientRetries == 2);
  CHECK(joinRetrySameSlot(202, 0));
  CHECK(joinRetrySameSlot(202, 1));
  CHECK_FALSE(joinRetrySameSlot(202, 2));
  CHECK_FALSE(joinRetrySameSlot(202, 200));
}

TEST_CASE("join retry: handshake timeouts (15, 204) and the rest of the auth class the same") {
  for (uint8_t reason : {2, 15, 203, 204, 205}) {
    CAPTURE(reason);
    CHECK(joinRetrySameSlot(reason, 0));
    CHECK(joinRetrySameSlot(reason, 1));
    CHECK_FALSE(joinRetrySameSlot(reason, 2));
  }
}

TEST_CASE("join retry: not found (201) and timeouts are never retried") {
  CHECK_FALSE(joinRetrySameSlot(201, 0));
  CHECK_FALSE(joinRetrySameSlot(0, 0));  // the 15 s limit
  CHECK_FALSE(joinRetrySameSlot(8, 0));
}

TEST_CASE("join retry: a wrong password still ends as auth, after three joins per network") {
  CHECK(joinsUntilFailed(202) == 3);
  CHECK(classifyDisconnect(202) == JoinResult::kAuth);
  CHECK(joinsUntilFailed(201) == 1);
  CHECK(joinsUntilFailed(0) == 1);
  // The count resets per network: the next one gets its full retries again.
  CHECK(joinsUntilFailed(204) == 3);
}

TEST_CASE("back-off after every network failed: 60 s, 120 s, then 300 s") {
  CHECK(allFailedBackoffMs(1) == 60000);
  CHECK(allFailedBackoffMs(2) == 120000);
  CHECK(allFailedBackoffMs(3) == 300000);
  CHECK(allFailedBackoffMs(200) == 300000);
}

constexpr uint32_t kAtTimeout = kCoreScanTimeoutMs + 1;  // the core's own "failed"

TEST_CASE("a scan the core timed out is waited on, in case SCAN_DONE comes late") {
  CHECK(scanFailStep(true, kAtTimeout, 0, 0) == ScanFailStep::kWait);
  CHECK(scanFailStep(true, kAtTimeout, kScanLateGraceMs - 1, 0) == ScanFailStep::kWait);
  CHECK(scanFailStep(true, kAtTimeout, kScanLateGraceMs, 0) == ScanFailStep::kRescan);
  // The rescan gets the same grace before it counts.
  CHECK(scanFailStep(true, kAtTimeout, 10, 1) == ScanFailStep::kWait);
}

// #686 c2: r1 waited 4 s on any "failed", even one seen seconds before the
// core's 6 s timeout could have fired. That early failure means the scan state
// is gone (no bits set, WiFiScan.cpp:153-157); waiting on it only delays.
TEST_CASE("a failure before the core's timeout is never waited on") {
  CHECK(scanFailStep(true, 0, 0, 0) == ScanFailStep::kRescan);
  CHECK(scanFailStep(true, 276, 0, 0) == ScanFailStep::kRescan);
  CHECK(scanFailStep(true, kCoreScanTimeoutMs - 1, 0, 0) == ScanFailStep::kRescan);
  CHECK(scanFailStep(true, kCoreScanTimeoutMs - 1, 0, 1) == ScanFailStep::kFailRound);
}

TEST_CASE("a scan that never started has nothing to wait for") {
  CHECK(scanFailStep(false, kAtTimeout, 0, 0) == ScanFailStep::kRescan);
  CHECK(scanFailStep(false, 0, 0, 1) == ScanFailStep::kFailRound);
}

TEST_CASE("one immediate rescan, then the round fails with the usual back-off") {
  CHECK(scanFailStep(true, kAtTimeout, kScanLateGraceMs, 0) == ScanFailStep::kRescan);
  CHECK(scanFailStep(true, kAtTimeout, kScanLateGraceMs, 1) == ScanFailStep::kFailRound);
  CHECK(scanFailStep(true, kAtTimeout, 60000, 200) == ScanFailStep::kFailRound);
  // A round that ends this way still waits 60 s first.
  CHECK(allFailedBackoffMs(1) == 60000);
}

TEST_CASE("result names are short and log-safe") {
  CHECK(std::string(joinResultName(JoinResult::kAuth)) == "auth");
  CHECK(std::string(joinResultName(JoinResult::kNoAp)) == "no_ap");
  CHECK(std::string(probeResultName(ProbeResult::kCaptive)) == "captive");
}

TEST_CASE("probe: verified HTTPS means online") {
  CHECK(classifyProbe({true, true, false, 0, false}) == ProbeResult::kOnline);
}

TEST_CASE("probe: no DNS, or nothing answers, means no internet") {
  CHECK(classifyProbe({false, false, false, 0, false}) == ProbeResult::kNoDns);
  CHECK(classifyProbe({true, false, false, 0, false}) == ProbeResult::kNoRoute);
  CHECK(classifyProbe({true, false, true, 0, false}) == ProbeResult::kNoRoute);
}

TEST_CASE("probe: a sign-in page or a redirect elsewhere means a captive portal") {
  CHECK(classifyProbe({true, false, true, 200, false}) == ProbeResult::kCaptive);
  CHECK(classifyProbe({true, false, true, 302, false}) == ProbeResult::kCaptive);
  CHECK(classifyProbe({true, false, true, 511, false}) == ProbeResult::kCaptive);
}

TEST_CASE("probe: our own https redirect with a failing TLS check is a TLS problem, not a portal") {
  CHECK(classifyProbe({true, false, true, 301, true}) == ProbeResult::kTlsFail);
}
