// Bob Cardputer v2 — joining Wi-Fi from the saved networks (see include/wifi_manager.h).
#include "wifi_manager.h"

#include <WiFi.h>
#include <esp_heap_caps.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <cstring>
#include <memory>
#include <new>

#include "device_settings.h"
#include "journal.h"
#include "net_store.h"
#include "probe_task.h"
#include "reset_actions.h"

namespace bob {

namespace {

WifiPhase g_phase = WifiPhase::kIdle;
uint8_t g_plan[kMaxNetworks];
uint8_t g_planLen = 0;
uint8_t g_rank = 0;
int8_t g_rssi[kMaxNetworks] = {};
uint32_t g_deadlineMs = 0;       // attempt timeout, or the next retry
uint8_t g_joinRetries = 0;       // same-network re-joins in this attempt
bool g_retrySettling = false;    // kTrying: waiting to join the same network again
uint32_t g_scanStartMs = 0;
uint8_t g_failedRounds = 0;
JoinResult g_lastResult = JoinResult::kNever;
bool g_retryNow = false;
bool g_paused = false;
uint32_t g_testDeadlineMs = 0;
ProbeFn g_probe = nullptr;

// Written by the Wi-Fi event task, read by the loop.
volatile bool g_disconnected = false;
volatile uint8_t g_disconnectReason = 0;

void onWifiDisconnected(arduino_event_id_t, arduino_event_info_t info) {
  g_disconnectReason = info.wifi_sta_disconnected.reason;
  g_disconnected = true;
}

std::unique_ptr<NetworkList> loadList() {
  std::unique_ptr<NetworkList> list(new (std::nothrow) NetworkList);
  if (list) netLoad(deviceStore(), *list);
  return list;
}

void wipe(NetworkList& list) { memset(&list, 0, sizeof(list)); }

uint8_t currentSlot() {
  return g_rank < g_planLen ? g_plan[g_rank] : kNoSlot;
}

// Stores a slot's last result only when it changed (no NVS write per retry).
void recordResult(uint8_t slot, JoinResult result) {
  std::unique_ptr<NetworkList> list = loadList();
  if (!list || slot >= kMaxNetworks || !list->slot[slot].used) return;
  if (list->slot[slot].last != result) {
    list->slot[slot].last = result;
    netSave(deviceStore(), *list);
  }
  wipe(*list);
}

bool g_scanStarted = false;     // scanNetworks did not fail at once
bool g_scanTimedOut = false;    // the core has called this scan failed
uint32_t g_scanFailedAtMs = 0;  // when it first did
uint8_t g_scanRescans = 0;      // immediate rescans in this round
// Written by the Wi-Fi event task: when the driver's SCAN_DONE was handled
// (the core runs _scanDone just before, WiFiGeneric.cpp:1041), 0 = not yet.
volatile uint32_t g_scanDoneAtMs = 0;

void onWifiScanDone(arduino_event_id_t, arduino_event_info_t) {
  const uint32_t now = millis();
  g_scanDoneAtMs = now != 0 ? now : 1;
}

// " done_ms=<n>": scan start to the driver's SCAN_DONE; "none" when it never came.
String scanDoneField() {
  const uint32_t doneAt = g_scanDoneAtMs;
  return doneAt != 0 ? String(" done_ms=") + (doneAt - g_scanStartMs) : String(" done_ms=none");
}

// The boot / re-plan direct try (#707, include/wifi_join.h).
DirectTry g_direct = {false, kNoSlot};

// At scan start: the last disconnect reason and WiFi.status(), for the journal
// (a driver still connecting on its own shows here, #707).
uint8_t g_scanDisc = 0;
int g_scanStatus = 0;

String scanStateFields() { return String(" disc=") + g_scanDisc + " st=" + g_scanStatus; }

// `rescan`: the round's scan failed and is started again at once.
void startScan(bool rescan = false) {
  if (!rescan) g_scanRescans = 0;
  g_direct = {false, kNoSlot};
  g_scanDisc = g_disconnectReason;
  g_scanStatus = static_cast<int>(WiFi.status());
  WiFi.disconnect(false, false);
  WiFi.scanDelete();
  g_scanStartMs = millis();  // for the journal's ms= (before the scan can finish)
  g_scanDoneAtMs = 0;
  g_scanStarted = WiFi.scanNetworks(true, true) != WIFI_SCAN_FAILED;
  g_scanTimedOut = false;
  g_phase = WifiPhase::kScanning;
}

void enterAllFailed(uint32_t nowMs) {
  if (g_failedRounds < 255) ++g_failedRounds;
  const uint32_t wait = allFailedBackoffMs(g_failedRounds);
  g_deadlineMs = nowMs + wait;
  g_phase = WifiPhase::kAllFailed;
  journal("wifi_all_failed", State::kWifi, "",
          String("tried=") + g_planLen + " next_retry_ms=" + wait);
}

// The core says the scan failed. Past its 6 s async timeout scanComplete()
// keeps returning WIFI_SCAN_FAILED while _scanStarted stays set; the driver's
// late SCAN_DONE (_scanDone, from the event task) clears it and sets
// WIFI_SCAN_DONE_BIT, and scanComplete() then returns the real count. So only
// that timeout is polled a little longer; any failure (after the grace, or one
// seen before the timeout, when no late SCAN_DONE can help) is rescanned once
// at once (no radio reset); a second failure ends the round, told apart from
// an empty scan. Never blocks: kWait just returns to the loop.
void scanFailed(uint32_t nowMs) {
  if (!g_scanTimedOut) {
    g_scanTimedOut = true;
    g_scanFailedAtMs = nowMs;
  }
  const ScanFailStep step = scanFailStep(g_scanStarted, g_scanFailedAtMs - g_scanStartMs,
                                         nowMs - g_scanFailedAtMs, g_scanRescans);
  if (step == ScanFailStep::kWait) return;
  const bool rescan = step == ScanFailStep::kRescan;
  journal("wifi_scan", State::kWifi, "",
          String("failed=1 ms=") + (nowMs - g_scanStartMs) +
              " failed_at_ms=" + (g_scanFailedAtMs - g_scanStartMs) + scanDoneField() +
              " started=" + (g_scanStarted ? 1 : 0) + " rescan=" + (rescan ? 1 : 0) +
              scanStateFields());
  WiFi.scanDelete();
  if (rescan) {
    ++g_scanRescans;
    startScan(true);
    return;
  }
  g_planLen = 0;
  g_rank = 0;
  enterAllFailed(nowMs);
}

// #717: the next join is pinned to this node (channel 0 = not pinned); set by
// roamToStrongerNode, used once by beginSlot.
uint8_t g_pinBssid[6] = {};
uint8_t g_pinChannel = 0;
bool g_roamChecked = false;  // this join already looked for a stronger node

// Starts a join of `slot` with a fresh attempt timeout; false when it is gone.
bool beginSlot(uint8_t slot, uint32_t nowMs) {
  std::unique_ptr<NetworkList> list = loadList();
  if (!list || !list->slot[slot].used) return false;
  const SavedNetwork& net = list->slot[slot];
  g_disconnected = false;
  g_retrySettling = false;
  const bool pinned = g_pinChannel != 0;
  WiFi.begin(net.ssid, net.pass[0] != '\0' ? net.pass : nullptr, g_pinChannel,
             pinned ? g_pinBssid : nullptr);
  g_pinChannel = 0;
  g_roamChecked = pinned;  // a pinned join is the move itself
  wipe(*list);
  g_phase = WifiPhase::kTrying;
  g_deadlineMs = nowMs + kJoinAttemptTimeoutMs;
  return true;
}

void journalTry(uint8_t slot) {
  journal("wifi_try", State::kWifi, "",
          String("slot=") + slot + " rank=" + g_rank + " rssi=" + g_rssi[slot] +
              (g_direct.active ? " direct=1" : ""));
}

void tryCurrent(uint32_t nowMs) {
  const uint8_t slot = currentSlot();
  if (slot == kNoSlot) {
    // The direct try's plan is only its one network: past it, scan (#707).
    if (g_direct.active && directTryEnd(g_direct, false) == DirectStep::kScan) {
      startScan();
      return;
    }
    enterAllFailed(nowMs);
    return;
  }
  g_joinRetries = 0;
  if (!beginSlot(slot, nowMs)) {
    ++g_rank;
    tryCurrent(nowMs);
    return;
  }
  journalTry(slot);
}

void finishScan(int found, uint32_t nowMs) {
  std::unique_ptr<NetworkList> list = loadList();
  uint8_t visible = 0;
  uint8_t savedVisible = 0;
  memset(g_rssi, 0, sizeof(g_rssi));
  if (list) {
    for (int i = 0; i < found; ++i) {
      const uint8_t slot = netFind(*list, WiFi.SSID(i).c_str());
      if (slot == kNoSlot) continue;
      if ((visible & (1u << slot)) == 0) ++savedVisible;
      visible |= static_cast<uint8_t>(1u << slot);
      // The strongest access point of a saved name.
      const int rssi = WiFi.RSSI(i);
      if (g_rssi[slot] == 0 || rssi > g_rssi[slot]) g_rssi[slot] = static_cast<int8_t>(rssi);
    }
    g_planLen = static_cast<uint8_t>(joinPlan(*list, visible, g_plan));
    wipe(*list);
  } else {
    g_planLen = 0;
  }
  WiFi.scanDelete();
  journal("wifi_scan", State::kWifi, "",
          String("found=") + (found > 0 ? found : 0) + " saved_visible=" + savedVisible +
              " ms=" + (nowMs - g_scanStartMs) + scanDoneField() + scanStateFields() +
              (g_scanTimedOut ? String(" late=1 failed_at_ms=") + (g_scanFailedAtMs - g_scanStartMs)
                              : String()));
  g_rank = 0;
  tryCurrent(nowMs);
}

// #717: the driver's connect scan joins the first node of a mesh it hears, not
// the strongest (on the device: -72 dBm while a -31 dBm node shared its
// channel). Once per join, scan the joined channel for the same network
// (~0.3 s) and, when another node is kRoamMarginDb stronger, re-join pinned to
// it through the usual settle. True when that re-join is under way.
constexpr int kRoamMarginDb = 8;

bool roamToStrongerNode(uint32_t nowMs) {
  if (g_roamChecked) return false;
  g_roamChecked = true;
  const uint8_t slot = currentSlot();
  std::unique_ptr<NetworkList> list = loadList();
  if (!list || slot >= kMaxNetworks || !list->slot[slot].used) return false;
  const int rssi = WiFi.RSSI();
  const uint8_t channel = WiFi.channel();
  uint8_t current[6] = {};
  if (const uint8_t* bssid = WiFi.BSSID()) memcpy(current, bssid, sizeof(current));
  const int found = WiFi.scanNetworks(false, false, false, 300, channel, list->slot[slot].ssid);
  wipe(*list);
  int best = -1;
  for (int i = 0; i < found; ++i) {
    const uint8_t* bssid = WiFi.BSSID(i);
    if (!bssid || memcmp(bssid, current, sizeof(current)) == 0) continue;
    if (best < 0 || WiFi.RSSI(i) > WiFi.RSSI(best)) best = i;
  }
  const int bestRssi = best >= 0 ? WiFi.RSSI(best) : 0;
  const bool move = best >= 0 && bestRssi >= rssi + kRoamMarginDb;
  if (move) {
    memcpy(g_pinBssid, WiFi.BSSID(best), sizeof(g_pinBssid));
    g_pinChannel = channel;
  }
  WiFi.scanDelete();
  journal("wifi_roam", State::kWifi, "",
          String("from=") + rssi + " to=" + bestRssi + " ch=" + channel + " found=" + found +
              " moved=" + (move ? 1 : 0));
  if (!move) return false;
  WiFi.disconnect(false, false);
  g_joinRetries = 0;
  g_retrySettling = true;
  g_phase = WifiPhase::kTrying;
  g_deadlineMs = nowMs + kJoinRetrySettleMs;
  return true;
}

void joined(uint32_t nowMs) {
  const uint8_t slot = currentSlot();
  journal("wifi_joined", State::kWifi, "",
          String("slot=") + slot + " rssi=" + WiFi.RSSI() + " channel=" + WiFi.channel());
  // Before the direct try ends: a failed re-join still falls back to a scan.
  if (roamToStrongerNode(nowMs)) return;
  g_failedRounds = 0;
  if (g_direct.active) directTryEnd(g_direct, true);
  recordResult(slot, JoinResult::kOk);
  g_phase = activeProfile() == Profile::kProd ? WifiPhase::kProbing : WifiPhase::kOnline;
  g_deadlineMs = nowMs;
}

void failAttempt(JoinResult result, uint8_t reason, uint32_t nowMs) {
  const uint8_t slot = currentSlot();
  const bool direct = g_direct.active;
  journal("wifi_join_failed", State::kWifi, "",
          String("slot=") + slot + " result=" + joinResultName(result) + " reason=" + reason +
              (direct ? " direct=1" : ""));
  // A direct try joined blind, before any scan: its failure is not the
  // network's result; the scanned round that follows judges it (#707).
  if (!direct) {
    g_lastResult = result;
    recordResult(slot, result);
  }
  WiFi.disconnect(false, false);
  ++g_rank;
  tryCurrent(nowMs);
}

// The probe is DNS plus a full TLS handshake (~0.6 s of software ECC) plus an
// HTTP read of up to 5 s: on its own task, so the loop keeps polling keys and
// the screen (#710). Priority 1 on core 1: it shares the core with loopTask.
ProbeTaskSlot g_probeSlot;
ProbeHoldFn g_probeHold = nullptr;
// Measured (#710, 3 Production boots on 6144 B): net_probe stack= 1088-1304 B
// never used, so a 5056 B peak. 7168 B leaves ~2.1 KiB for a longer
// certificate chain; net_probe keeps journaling stack= to watch it.
constexpr uint32_t kProbeTaskStackBytes = 7168;

void probeTask(void*) {
  const uint32_t started = millis();
  const ProbeResult result = g_probe ? g_probe() : ProbeResult::kOnline;
  g_probeSlot.finish(result, millis() - started, uxTaskGetStackHighWaterMark(nullptr));
  vTaskDelete(nullptr);
}

void startProbe() {
  // One TLS context at a time: never while a socket connect is open.
  if (g_probeHold && g_probeHold()) return;
  if (!g_probeSlot.start()) return;  // an old probe still runs; wait for it.
  if (xTaskCreatePinnedToCore(probeTask, "net_probe", kProbeTaskStackBytes, nullptr, 1, nullptr,
                              1) == pdPASS) {
    return;
  }
  // No heap for the task: probe on the loop as before, rather than retry
  // (and journal) every pass.
  journal("net_probe_inline", State::kWifi, "",
          String("free=") + heap_caps_get_free_size(MALLOC_CAP_8BIT) +
              " largest=" + heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
  const uint32_t started = millis();
  const ProbeResult result = g_probe ? g_probe() : ProbeResult::kOnline;
  g_probeSlot.finish(result, millis() - started, 0);
}

void probe(uint32_t nowMs) {
  ProbeResult result = ProbeResult::kOnline;
  uint32_t ms = 0;
  switch (g_probeSlot.poll(result, ms)) {
    case ProbePoll::kRunning:
      return;
    case ProbePoll::kStale:
      // Started before a reload or pause: the link it checked may be gone.
      journal("net_probe_stale", State::kWifi, "",
              String("result=") + probeResultName(result) + " ms=" + ms);
      startProbe();
      return;
    case ProbePoll::kIdle:
      startProbe();
      return;
    case ProbePoll::kResult:
      break;
  }
  // stack=: the probe task's unused stack (bytes; 0 when it ran inline).
  // heap_min=: the lowest free heap since boot, so a probe that set it shows.
  journal("net_probe", State::kWifi, "",
          String("result=") + probeResultName(result) + " ms=" + ms +
              " stack=" + g_probeSlot.stackFree() +
              " heap_min=" + heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT));
  const uint8_t slot = currentSlot();
  switch (result) {
    case ProbeResult::kOnline:
      g_phase = WifiPhase::kOnline;
      recordResult(slot, JoinResult::kOk);
      break;
    case ProbeResult::kCaptive:
      g_phase = WifiPhase::kCaptive;
      recordResult(slot, JoinResult::kCaptive);
      break;
    default:
      g_phase = WifiPhase::kNoInternet;
      recordResult(slot, JoinResult::kNoInternet);
      break;
  }
  g_deadlineMs = nowMs + kProbeRetryMs;
}

bool linkUp() { return WiFi.status() == WL_CONNECTED; }

// Erases the driver's station config in RAM and flash (#707 c1; the reset
// actions' eraser). Under persistent(false) the core keeps the driver on
// WIFI_STORAGE_RAM (WiFiGeneric.cpp:693-694), so a config set then never
// reaches flash; flash storage is switched on for this one empty write only.
bool eraseDriverStaConfig() {
  wifi_config_t empty;
  memset(&empty, 0, sizeof(empty));
  if (esp_wifi_set_storage(WIFI_STORAGE_FLASH) != ESP_OK) return false;
  const bool ok = esp_wifi_set_config(WIFI_IF_STA, &empty) == ESP_OK;
  const bool back = esp_wifi_set_storage(WIFI_STORAGE_RAM) == ESP_OK;
  return ok && back;
}

// Builds before #707 let the driver persist the station network. esp_wifi_init
// loads it from flash (nvs_enable is on, and the core only switches to RAM
// storage after init, WiFiGeneric.cpp:683-695), and nothing of ours has set a
// config yet, so a name here is that stray copy: erase it. Only then is flash
// written, so it happens once per device and every later boot just reads RAM.
void clearStrayDriverConfig() {
  wifi_config_t conf;
  if (esp_wifi_get_config(WIFI_IF_STA, &conf) != ESP_OK) return;
  const bool stray = conf.sta.ssid[0] != 0;
  memset(&conf, 0, sizeof(conf));  // it held a password
  if (!stray) return;
  const bool ok = eraseDriverStaConfig();
  journal("wifi_driver_cfg_cleared", State::kWifi, "", String("ok=") + (ok ? 1 : 0));
}

// Boot (`boot`) or a re-plan (Settings): join the top saved network straight
// away, with no scan first (the direct try, #707); a failure falls back to
// the scan-and-plan round (tryCurrent). Idle when nothing is saved.
void replan(bool boot) {
  g_probeSlot.discard();  // a probe still in flight checked the old link
  g_failedRounds = 0;
  g_planLen = 0;
  g_rank = 0;
  std::unique_ptr<NetworkList> list = loadList();
  const DirectTry first = list ? directTryStart(*list) : DirectTry{false, kNoSlot};
  if (list) wipe(*list);
  g_direct = first;
  if (!first.active) {
    WiFi.disconnect(false, false);
    g_phase = WifiPhase::kIdle;
    return;
  }
  const uint32_t nowMs = millis();
  memset(g_rssi, 0, sizeof(g_rssi));  // no scan behind this try
  g_plan[0] = first.slot;
  g_planLen = 1;
  if (boot) {
    tryCurrent(nowMs);
    return;
  }
  // A re-plan may find the radio joined (Settings' join test): leave that
  // first, and join after the usual settle, so the disconnect it fires is
  // gone (beginSlot clears it) before the new join starts.
  WiFi.disconnect(false, false);
  g_joinRetries = 0;
  g_retrySettling = true;
  g_phase = WifiPhase::kTrying;
  g_deadlineMs = nowMs + kJoinRetrySettleMs;
  journalTry(first.slot);
}

}  // namespace

void wifiManagerBegin(ProbeFn probe, ProbeHoldFn hold) {
  g_probe = probe;
  g_probeHold = hold;
  // The credentials live in our own store (net_store.h). The driver's
  // persisted copy only fed the core's own re-join on the first disconnect,
  // which could queue its connect scan in front of ours (#707).
  // Persistence off does not stop the driver loading the old flash copy at
  // init, so that copy is erased here, before the first join (#707 c1).
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  clearStrayDriverConfig();
  resetSetDriverWifiEraser(eraseDriverStaConfig);
  // The manager decides what to join next; the driver must not reconnect on
  // its own behind it.
  // #676: the core's one-shot first-drop re-join (WiFiGeneric.cpp:1079) is cancelled by our disconnect.
  WiFi.setAutoReconnect(false);
  WiFi.onEvent(onWifiDisconnected, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.onEvent(onWifiScanDone, ARDUINO_EVENT_WIFI_SCAN_DONE);
  replan(true);
}

void wifiManagerReload() { replan(false); }

void wifiManagerRetryNow() { g_retryNow = true; }

bool wifiManagerLoop(uint32_t nowMs) {
  if (g_paused) return false;
  const WifiPhase before = g_phase;
  const uint8_t rankBefore = g_rank;
  const bool retry = g_retryNow;
  g_retryNow = false;

  switch (g_phase) {
    case WifiPhase::kIdle:
      break;

    case WifiPhase::kScanning: {
      const int found = WiFi.scanComplete();
      if (found == WIFI_SCAN_RUNNING) break;
      if (found < 0) {
        scanFailed(nowMs);
        break;
      }
      finishScan(found, nowMs);
      break;
    }

    case WifiPhase::kTrying:
      // The settle comes first: a link still going down after our own
      // disconnect (a re-plan's direct try) is not a join.
      if (g_retrySettling) {
        // The settle is over: join the same network again (a fresh 15 s).
        if (static_cast<int32_t>(nowMs - g_deadlineMs) >= 0 && !beginSlot(currentSlot(), nowMs)) {
          ++g_rank;
          tryCurrent(nowMs);
        }
      } else if (linkUp()) {
        joined(nowMs);
      } else if (g_disconnected) {
        g_disconnected = false;
        const uint8_t reason = g_disconnectReason;
        if (joinRetrySameSlot(reason, g_joinRetries)) {
          ++g_joinRetries;
          journal("wifi_join_retry", State::kWifi, "",
                  String("slot=") + currentSlot() + " reason=" + reason + " retry=" + g_joinRetries);
          WiFi.disconnect(false, false);
          g_retrySettling = true;
          g_deadlineMs = nowMs + kJoinRetrySettleMs;
        } else {
          failAttempt(classifyDisconnect(reason), reason, nowMs);
        }
      } else if (static_cast<int32_t>(nowMs - g_deadlineMs) >= 0) {
        failAttempt(JoinResult::kTimeout, 0, nowMs);
      }
      break;

    case WifiPhase::kProbing:
      probe(nowMs);
      break;

    case WifiPhase::kOnline:
      if (!linkUp()) {
        journal("wifi_dropped", State::kWifi, "", String("slot=") + currentSlot());
        WiFi.reconnect();
        g_phase = WifiPhase::kDropped;
        g_deadlineMs = nowMs + kSameApGraceMs;
      }
      break;

    case WifiPhase::kDropped:
      if (linkUp()) {
        joined(nowMs);
      } else if (retry || static_cast<int32_t>(nowMs - g_deadlineMs) >= 0) {
        startScan();
      }
      break;

    case WifiPhase::kAllFailed:
      if (retry || static_cast<int32_t>(nowMs - g_deadlineMs) >= 0) startScan();
      break;

    case WifiPhase::kCaptive:
    case WifiPhase::kNoInternet:
      if (!linkUp()) {
        startScan();
      } else if (retry || static_cast<int32_t>(nowMs - g_deadlineMs) >= 0) {
        g_phase = WifiPhase::kProbing;
      }
      break;
  }
  return g_phase != before || (g_phase == WifiPhase::kTrying && g_rank != rankBefore);
}

void wifiManagerPause(bool paused) {
  // Settings may test a join or scan while paused: a probe in flight is
  // checking a link that may not survive it, so its result goes stale and
  // kProbing starts a fresh one on resume.
  if (paused) g_probeSlot.discard();
  g_paused = paused;
}

// Settings scans while connected (the manager is paused), which runs past the
// core's 6 s async timeout; the driver's late SCAN_DONE still brings the
// results, so the same grace as the manager's scan applies (scanFailed).
void wifiManagerUserScan() {
  WiFi.scanDelete();
  g_scanStartMs = millis();
  g_scanDoneAtMs = 0;
  g_scanStarted = WiFi.scanNetworks(true, false) != WIFI_SCAN_FAILED;
  g_scanTimedOut = false;
}

int wifiManagerUserScanPoll() {
  const int found = WiFi.scanComplete();
  if (found != WIFI_SCAN_FAILED) return found;
  const uint32_t nowMs = millis();
  if (!g_scanTimedOut) {
    g_scanTimedOut = true;
    g_scanFailedAtMs = nowMs;
  }
  // No automatic rescan here (as if the one rescan were spent): the list
  // offers "Scan again".
  const ScanFailStep step = scanFailStep(g_scanStarted, g_scanFailedAtMs - g_scanStartMs,
                                         nowMs - g_scanFailedAtMs, kScanFailRescans);
  return step == ScanFailStep::kWait ? WIFI_SCAN_RUNNING : WIFI_SCAN_FAILED;
}

void wifiManagerTestJoin(const char* ssid, const char* pass, uint32_t nowMs) {
  WiFi.disconnect(false, false);
  g_disconnected = false;
  WiFi.begin(ssid, pass && pass[0] != '\0' ? pass : nullptr);
  g_testDeadlineMs = nowMs + kJoinAttemptTimeoutMs;
  journal("wifi_test", State::kSettings, "", "started=1");
}

TestJoin wifiManagerTestPoll(uint32_t nowMs, JoinResult* result) {
  JoinResult outcome = JoinResult::kOk;
  TestJoin status = TestJoin::kRunning;
  uint8_t reason = 0;
  if (linkUp()) {
    status = TestJoin::kJoined;
  } else if (g_disconnected) {
    g_disconnected = false;
    reason = g_disconnectReason;
    outcome = classifyDisconnect(reason);
    status = TestJoin::kFailed;
  } else if (static_cast<int32_t>(nowMs - g_testDeadlineMs) >= 0) {
    outcome = JoinResult::kTimeout;
    status = TestJoin::kFailed;
  }
  if (status == TestJoin::kRunning) return status;
  if (status == TestJoin::kFailed) WiFi.disconnect(false, false);
  if (result) *result = outcome;
  journal("wifi_test", State::kSettings, "",
          String("result=") + joinResultName(outcome) +
              (status == TestJoin::kFailed ? String(" reason=") + reason : String()));
  return status;
}

bool wifiLinkUp() { return linkUp(); }

// Not while a probe task still runs (a stale one, after a reload to a
// profile that skips the probe): the socket then starts once it has ended,
// so its TLS handshake never overlaps the probe's (one TLS context at a time).
bool wifiManagerOnline() {
  return g_phase == WifiPhase::kOnline && linkUp() &&
         g_probeSlot.phase() != ProbePhase::kRunning;
}

WifiView wifiManagerView() {
  WifiView view{};
  view.phase = g_phase;
  view.slot = currentSlot();
  view.rank = g_rank;
  view.planLen = g_planLen;
  view.lastResult = g_lastResult;
  view.rssi = view.slot < kMaxNetworks ? g_rssi[view.slot] : 0;
  return view;
}

bool savedNetworkName(uint8_t slot, char* out, size_t outSize) {
  if (!out || outSize == 0) return false;
  out[0] = '\0';
  std::unique_ptr<NetworkList> list = loadList();
  if (!list || slot >= kMaxNetworks || !list->slot[slot].used) return false;
  strncpy(out, list->slot[slot].ssid, outSize - 1);
  out[outSize - 1] = '\0';
  wipe(*list);
  return true;
}

}  // namespace bob
