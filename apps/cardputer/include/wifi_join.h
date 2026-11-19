// Bob Cardputer v2 — how the device picks and judges Wi-Fi joins (#676;
// pure, host-tested). The runtime (src/wifi_manager.cpp) scans, then tries
// the saved networks this plan names, one at a time, and never reboots.
#pragma once

#include <cstddef>
#include <cstdint>

#include "net_store.h"

namespace bob {

constexpr uint32_t kJoinAttemptTimeoutMs = 15000;
// After a drop, the device first waits this long for the same access point.
constexpr uint32_t kSameApGraceMs = 30000;
// A captive or no-internet network is re-checked this often.
constexpr uint32_t kProbeRetryMs = 300000;

// The saved networks to try, in order: priority order, keeping those a scan
// saw (bit `slot` of visibleMask) and hidden ones (a scan never shows them).
// Networks whose last result was "captive" go last. Returns the count.
size_t joinPlan(const NetworkList& list, uint8_t visibleMask, uint8_t* outSlots);

// The boot / re-plan fast path (#707): a full scan before the first join costs
// 7 s or more, while the driver's own connect scan stops at the first channel
// with the network. So the top network of the plan (every saved network
// treated as visible) is joined straight away, with no scan. Only that one:
// when it fails for any reason the manager falls back to the normal
// scan-and-plan round, never to the next network blind. A direct failure
// is not stored as the network's result (the scanned round judges it).
struct DirectTry {
  bool active;   // the current attempt is the direct one
  uint8_t slot;  // the network it joins; kNoSlot when none
};

// The direct try for this list: active with the top slot, or inactive with
// kNoSlot when nothing is saved (the manager stays idle, as before).
DirectTry directTryStart(const NetworkList& list);

enum class DirectStep : uint8_t {
  kDone,  // it joined: carry on as after any join
  kScan,  // it failed: start the normal scan-and-plan round
};

// The direct try ended (`joined` or not); clears it, so later attempts are
// ordinary scanned ones.
DirectStep directTryEnd(DirectTry& attempt, bool joined);

// ESP-IDF wifi_err_reason_t (ARDUINO_EVENT_WIFI_STA_DISCONNECTED) to a result:
// 201 no AP found; 2, 15, 202, 204 (and 203, 205) an auth or handshake failure,
// usually a wrong password; anything else a timeout.
JoinResult classifyDisconnect(uint8_t reason);

// An access point that still holds the previous association (after a reset)
// often answers the first join with one auth or handshake failure. The same
// network is joined again this many extra times before it counts as failed,
// after a short settle; a wrong password still fails, after 1 + this many tries.
constexpr uint8_t kJoinTransientRetries = 2;
constexpr uint32_t kJoinRetrySettleMs = 400;

// Whether a disconnect with this reason, after `retriesSoFar` retries of the
// current network, should join the same network again instead of failing it.
// Only the auth/handshake class is retried; 201 (not found) and timeouts never.
bool joinRetrySameSlot(uint8_t reason, uint8_t retriesSoFar);

// The Arduino core gives up on an async scan after 20 x its per-channel time
// (6 s here) and reports it failed, but the driver's SCAN_DONE can still come
// later, and then scanComplete() returns the real results. A scan that really
// started is waited on this long past that failure before it counts as failed.
constexpr uint32_t kScanLateGraceMs = 4000;
// The core's async-scan timeout: scanNetworks' default 300 ms per channel x 20
// (WiFiScan.cpp:63). Only a failure at or after it is the core giving up; an
// earlier one means the scan's state is gone and no late SCAN_DONE will help.
constexpr uint32_t kCoreScanTimeoutMs = 6000;
// A failed scan is started again at once this many times (no radio reset)
// before the round fails and waits allFailedBackoffMs().
constexpr uint8_t kScanFailRescans = 1;

enum class ScanFailStep : uint8_t {
  kWait,       // keep polling: a late SCAN_DONE may still bring results
  kRescan,     // start a new scan now
  kFailRound,  // the round failed: back off
};

// What to do while the core reports the scan failed. `started`: the scan
// really began (scanNetworks did not fail at once); `failedAfterMs`: scan start
// to the core's first "failed"; `sinceFailedMs`: time since then;
// `rescansSoFar`: immediate rescans in this round. Only the core's own timeout
// (failedAfterMs >= kCoreScanTimeoutMs) is waited on.
ScanFailStep scanFailStep(bool started, uint32_t failedAfterMs, uint32_t sinceFailedMs,
                          uint8_t rescansSoFar);

// Wait before the next round after every saved network failed:
// 60 s, 120 s, then 300 s.
uint32_t allFailedBackoffMs(uint8_t failedRounds);

// Short, log-safe names ("ok", "auth", "no_ap", ...).
const char* joinResultName(JoinResult result);

// The internet check after a join (Production only).
enum class ProbeResult : uint8_t { kOnline, kCaptive, kNoDns, kNoRoute, kTlsFail };

struct ProbeFacts {
  bool dnsOk;              // the production host resolved
  bool httpsOk;            // HTTPS /health answered with a verified certificate
  bool plainConnected;     // a plain-HTTP connection to port 80 opened
  int plainStatus;         // its HTTP status, 0 when none was read
  bool plainRedirectsHome; // a 3xx whose Location is the production host
};

ProbeResult classifyProbe(const ProbeFacts& facts);
const char* probeResultName(ProbeResult result);

}  // namespace bob
