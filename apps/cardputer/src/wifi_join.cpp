// Bob Cardputer v2 — how the device picks and judges Wi-Fi joins (see include/wifi_join.h).
#include "wifi_join.h"

namespace bob {

size_t joinPlan(const NetworkList& list, uint8_t visibleMask, uint8_t* outSlots) {
  size_t count = 0;
  // Two passes: everything but captive networks, then the captive ones.
  for (int pass = 0; pass < 2; ++pass) {
    for (uint8_t r = 0; r < list.count; ++r) {
      const uint8_t slot = list.order[r];
      if (slot >= kMaxNetworks || !list.slot[slot].used) continue;
      const SavedNetwork& net = list.slot[slot];
      const bool captive = net.last == JoinResult::kCaptive;
      if (captive != (pass == 1)) continue;
      const bool visible = (visibleMask & (1u << slot)) != 0;
      if (visible || (net.flags & kNetFlagHidden) != 0) outSlots[count++] = slot;
    }
  }
  return count;
}

DirectTry directTryStart(const NetworkList& list) {
  uint8_t plan[kMaxNetworks];
  const uint8_t everySlot = static_cast<uint8_t>((1u << kMaxNetworks) - 1);
  if (joinPlan(list, everySlot, plan) == 0) return {false, kNoSlot};
  return {true, plan[0]};
}

DirectStep directTryEnd(DirectTry& attempt, bool joined) {
  attempt = {false, kNoSlot};
  return joined ? DirectStep::kDone : DirectStep::kScan;
}

JoinResult classifyDisconnect(uint8_t reason) {
  switch (reason) {
    case 201:  // NO_AP_FOUND
      return JoinResult::kNoAp;
    case 2:    // AUTH_EXPIRE
    case 15:   // 4WAY_HANDSHAKE_TIMEOUT
    case 202:  // AUTH_FAIL
    case 203:  // ASSOC_FAIL
    case 204:  // HANDSHAKE_TIMEOUT
    case 205:  // CONNECTION_FAIL
      return JoinResult::kAuth;
    default:
      return JoinResult::kTimeout;
  }
}

bool joinRetrySameSlot(uint8_t reason, uint8_t retriesSoFar) {
  return classifyDisconnect(reason) == JoinResult::kAuth && retriesSoFar < kJoinTransientRetries;
}

ScanFailStep scanFailStep(bool started, uint32_t failedAfterMs, uint32_t sinceFailedMs,
                          uint8_t rescansSoFar) {
  const bool coreTimedOut = started && failedAfterMs >= kCoreScanTimeoutMs;
  if (coreTimedOut && sinceFailedMs < kScanLateGraceMs) return ScanFailStep::kWait;
  return rescansSoFar < kScanFailRescans ? ScanFailStep::kRescan : ScanFailStep::kFailRound;
}

uint32_t allFailedBackoffMs(uint8_t failedRounds) {
  if (failedRounds <= 1) return 60000;
  if (failedRounds == 2) return 120000;
  return 300000;
}

const char* joinResultName(JoinResult result) {
  switch (result) {
    case JoinResult::kNever: return "never";
    case JoinResult::kOk: return "ok";
    case JoinResult::kAuth: return "auth";
    case JoinResult::kNoAp: return "no_ap";
    case JoinResult::kTimeout: return "timeout";
    case JoinResult::kCaptive: return "captive";
    case JoinResult::kNoInternet: return "no_internet";
  }
  return "never";
}

ProbeResult classifyProbe(const ProbeFacts& facts) {
  if (!facts.dnsOk) return ProbeResult::kNoDns;
  if (facts.httpsOk) return ProbeResult::kOnline;
  if (!facts.plainConnected) return ProbeResult::kNoRoute;
  // HTTPS failed but plain HTTP answers. Our own server only ever redirects to
  // itself; a portal answers with its own page or sends us elsewhere.
  const bool redirect = facts.plainStatus >= 300 && facts.plainStatus < 400;
  if (redirect && facts.plainRedirectsHome) return ProbeResult::kTlsFail;
  if (facts.plainStatus == 0) return ProbeResult::kNoRoute;
  return ProbeResult::kCaptive;
}

const char* probeResultName(ProbeResult result) {
  switch (result) {
    case ProbeResult::kOnline: return "online";
    case ProbeResult::kCaptive: return "captive";
    case ProbeResult::kNoDns: return "no_dns";
    case ProbeResult::kNoRoute: return "no_route";
    case ProbeResult::kTlsFail: return "tls_fail";
  }
  return "no_route";
}

}  // namespace bob
