// Bob Cardputer v2 — joining Wi-Fi from the saved networks (#676).
// Scans, tries the saved networks in the order include/wifi_join.h plans
// (15 s each, recording why each failed), checks the internet on Production,
// and when everything fails waits 60 s / 120 s / 300 s and tries again. It
// never reboots and never gives up. Journal lines name slot ids, never SSIDs.
#pragma once

#include <cstddef>
#include <cstdint>

#include "wifi_join.h"

namespace bob {

enum class WifiPhase : uint8_t {
  kIdle,        // nothing saved
  kScanning,
  kTrying,      // joining plan[rank]
  kProbing,     // joined; checking the internet (Production only)
  kOnline,      // joined, internet ok (or not checked on dev/custom)
  kDropped,     // was online; waiting kSameApGraceMs for the same AP
  kAllFailed,   // every planned network failed; retrying later
  kCaptive,     // joined, but a sign-in page stands in the way
  kNoInternet,  // joined, but no internet
};

struct WifiView {
  WifiPhase phase;
  uint8_t slot;       // network being tried or joined; kNoSlot when none
  uint8_t rank;       // 0-based position in the plan
  uint8_t planLen;
  JoinResult lastResult;  // of the last failed attempt
  int8_t rssi;        // from the last scan, 0 when unknown
};

// The internet check (Network::probeInternet on the device). It runs on its
// own short-lived task (#710, include/probe_task.h), never on the caller's.
using ProbeFn = ProbeResult (*)();
// True while the probe must not start (a socket connect is open: one TLS
// context at a time). Called from wifiManagerLoop.
using ProbeHoldFn = bool (*)();

// Call once in setup, after deviceSettingsBegin(): station mode (driver
// persistence off), events, and the direct try of the top saved network (#707;
// a scan only when it fails). `probe` runs after each join on Production,
// once `hold` (when given) returns false.
void wifiManagerBegin(ProbeFn probe, ProbeHoldFn hold = nullptr);

// Advances the manager. Returns true when the view changed, so the caller
// redraws. Never blocks for the internet check: kProbing polls its task.
bool wifiManagerLoop(uint32_t nowMs);

// Skip the wait and start again from a fresh scan ([Enter] on the Wi-Fi screen).
void wifiManagerRetryNow();

// The saved networks changed (Settings): leave any link, then (after a 400 ms
// settle) try the top saved network directly, falling back to a fresh scan.
void wifiManagerReload();

// Settings owns the radio while open (#677): the manager stands still, so a
// user scan or a join test never races it. Resume with wifiManagerReload()
// when the saved networks or the link changed, else wifiManagerPause(false).
void wifiManagerPause(bool paused);

// A scan for the Settings list (the manager must be paused).
void wifiManagerUserScan();
// WIFI_SCAN_RUNNING (-1) while scanning, else the number of results
// (WiFi.SSID(i) / RSSI(i) / encryptionType(i)); call WiFi.scanDelete() after.
int wifiManagerUserScanPoll();

// Verify-then-commit: join these credentials now (the manager must be
// paused). Poll until it is no longer kRunning.
enum class TestJoin : uint8_t { kRunning, kJoined, kFailed };
void wifiManagerTestJoin(const char* ssid, const char* pass, uint32_t nowMs);
TestJoin wifiManagerTestPoll(uint32_t nowMs, JoinResult* result);

// True while the radio is associated (whatever the manager thinks).
bool wifiLinkUp();

bool wifiManagerOnline();
WifiView wifiManagerView();

// The saved network's name, for the screen only (never the journal).
bool savedNetworkName(uint8_t slot, char* out, size_t outSize);

}  // namespace bob
