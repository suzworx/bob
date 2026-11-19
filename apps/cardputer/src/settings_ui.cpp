#include "chrome_identity.h"
// Bob Cardputer v2 — on-device Settings (see include/settings_ui.h).
#include "settings_ui.h"

#include <WiFi.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <strings.h>
#include <new>

#include "build_id.h"
#include "chrome.h"
#include "device_settings.h"
#include "device_token.h"
#include "display.h"
#include "journal.h"
#include "net_store.h"
#include "picker_window.h"
#include "text_field.h"
#include "types.h"
#include "settings.h"
#include "wifi_join.h"
#include "wifi_manager.h"
#include "ota_ui.h"

namespace bob {

namespace {

constexpr size_t kMaxScanEntries = 12;
// Choose Wi-Fi lists every scanned network plus its 3 fixed options, and
// the picker scrolls to the selected one (#728).
static_assert(kMaxScanEntries + 3 <= kMaxPickerEntries, "Choose Wi-Fi fits the picker");
constexpr size_t kLabelBytes = kPickerLabelBytes;

enum class Screen : uint8_t {
  kWelcome,
  kHome,
  kWakeWord,
  kConnection,
  kUpdates,
  kConfirmUpdate,
  kWifiList,
  kDetail,
  kConfirmForget,
  kScanning,
  kScanList,
  kNotListed,
  kName,
  kPassword,
  kJoining,
  kJoinFailed,
  kSaved,
  kReplacePick,
  kConfirmReplace,
  kAbout,
  kServer,
  kServerEdit,
  kHost,
  kPort,
  kConfirmSwitch,
  kReset,
  kConfirmReset,
  kFactory,
};

// Why a join test runs, so the result knows what to commit.
enum class JoinPurpose : uint8_t { kAdd, kChangePassword, kConnectNow };

enum class DetailAction : uint8_t { kConnect, kPassword, kUp, kDown, kForget };

struct ScanEntry {
  char ssid[kSsidMaxBytes + 1];
  int8_t rssi;
  bool open;
  bool enterprise;
};

struct Session {
  Screen screen;
  Screen drawn;          // last screen drawn (pickers reset on change)
  size_t selection;
  NetworkList list;
  ScanEntry scan[kMaxScanEntries];
  uint8_t scanCount;
  TextField field;
  char pendingSsid[kSsidMaxBytes + 1];
  char pendingPass[kPassMaxBytes + 1];
  bool pendingHidden;
  uint8_t detailSlot;
  uint8_t replaceSlot;
  uint8_t savedSlot;
  uint8_t savedOldRank;  // rank before "first in line", for [k] keep old order
  JoinPurpose purpose;
  JoinResult joinResult;
  DetailAction actions[5];
  uint8_t actionCount;
  uint8_t activeSlot;    // the network the device was on when Settings opened
  char held[kHeldKeysMax];
  uint8_t heldCount;
  bool enterHeld;
  bool tabHeld;
  uint32_t delHeldSinceMs;
  uint32_t lastRepeatMs;
  uint32_t lastInputMs;
  bool listChanged;
  bool linkChanged;      // a join test ran or the active network was forgotten
  uint32_t statusDrawAt;
  char updateVersion[32];
  bool socketUp;
  bool setup;           // the guided first-boot Setup (#678)
  // Server profiles (#679).
  Profile serverRows[kProfileCount];
  uint8_t serverRowCount;
  Profile editProfile;
  Endpoint editEndpoint;
  bool editUsed;         // the switch saves editEndpoint too
  bool serverChanged;
  bool wakeWordChanged;
  const char* serverError;
  ResetScope resetRows[4];
  uint8_t resetRowCount;
  ResetScope resetScope;
  bool resetDone;
  char aboutTyped[10];   // letters typed on About, for the unlock
  uint8_t aboutTypedLen;
  char deviceName[kDeviceNameBytes];
};

Session* g = nullptr;

// --- helpers ---------------------------------------------------------------

void wipeSecrets() {
  memset(g->pendingPass, 0, sizeof(g->pendingPass));
  memset(g->field.text, 0, sizeof(g->field.text));
}

void go(Screen screen) {
  g->screen = screen;
  g->selection = 0;
}

void saveList() {
  netSave(deviceStore(), g->list);
  g->listChanged = true;
}

void truncateInto(char* out, size_t outSize, const char* text, size_t maxChars) {
  const size_t cap = maxChars + 1 < outSize ? maxChars + 1 : outSize;
  strncpy(out, text, cap - 1);
  out[cap - 1] = '\0';
  for (char* p = out; *p; ++p) {
    if (*p < 0x20 || *p > 0x7e) *p = '?';  // the GLCD font draws ASCII only
  }
}

// 1..4 bars from RSSI; 0 when unknown.
uint8_t bars(int rssi) {
  if (rssi == 0) return 0;
  if (rssi >= -55) return 4;
  if (rssi >= -67) return 3;
  if (rssi >= -75) return 2;
  return 1;
}

const char* resultLabel(JoinResult result) {
  switch (result) {
    case JoinResult::kOk: return "ok";
    case JoinResult::kAuth: return "bad pass";
    case JoinResult::kNoAp: return "not found";
    case JoinResult::kTimeout: return "timeout";
    case JoinResult::kCaptive: return "sign-in";
    case JoinResult::kNoInternet: return "offline";
    case JoinResult::kNever: break;
  }
  return "";
}

void showPicker(const char* heading, const char* emptyText, char (*labels)[kLabelBytes],
                size_t count, const char* hint) {
  if (g->drawn != g->screen) endConversationList();
  const char* pointers[kMaxPickerEntries];
  const size_t n = count < kMaxPickerEntries ? count : kMaxPickerEntries;
  for (size_t i = 0; i < n; ++i) pointers[i] = labels[i];
  drawPickerList(PickerView{heading, emptyText, pointers, n}, g->selection);
  if (hint && hint[0] != '\0') drawConversationPickerHint(hint, 0xb0b0b0);
}

void showLines(const char* title, uint32_t color, const char* const* lines, size_t count) {
  if (g->drawn != g->screen) endConversationList();
  drawLinesScreen(title, color, lines, count);
}

void showField(const char* title, const char* subtitle, uint32_t nowMs, const char* error) {
  if (g->drawn != g->screen) endConversationList();
  char shown[40];
  size_t cursor = 0;
  fieldRender(g->field, nowMs, 36, shown, sizeof(shown), &cursor);
  char counter[12];
  snprintf(counter, sizeof(counter), "%u/%u", static_cast<unsigned>(g->field.length),
           static_cast<unsigned>(g->field.maxLength));
  drawFieldScreen(title, subtitle, shown, cursor, counter, error);
}

// --- screens ---------------------------------------------------------------

// Server is listed on developer builds, or once developer options are
// unlocked on About (#679).
bool serverVisible() { return kDevOptions || profileUnlocked(deviceStore()); }

enum class HomeRow : uint8_t { kWifi, kServer, kReset, kAbout, kWakeWord, kConnection, kUpdates };

size_t homeRows(HomeRow* rows) {
  size_t n = 0;
  rows[n++] = HomeRow::kWifi;
  if (serverVisible()) rows[n++] = HomeRow::kServer;
  rows[n++] = HomeRow::kReset;
  rows[n++] = HomeRow::kAbout;
  rows[n++] = HomeRow::kWakeWord;
  rows[n++] = HomeRow::kConnection;
  rows[n++] = HomeRow::kUpdates;
  return n;
}

size_t homeRowCount() {
  HomeRow rows[7];
  return homeRows(rows);
}

void drawHome() {
  HomeRow rows[7];
  const size_t n = homeRows(rows);
  char labels[7][kLabelBytes];
  for (size_t i = 0; i < n; ++i) {
    switch (rows[i]) {
      case HomeRow::kConnection: snprintf(labels[i], kLabelBytes, "Connection"); break;
      case HomeRow::kUpdates: snprintf(labels[i], kLabelBytes, "Updates"); break;
      case HomeRow::kWifi: snprintf(labels[i], kLabelBytes, "Wi-Fi networks"); break;
      case HomeRow::kServer:
        snprintf(labels[i], kLabelBytes, "Server       %s", profileDisplayName(activeProfile()));
        break;
      case HomeRow::kReset: snprintf(labels[i], kLabelBytes, "Reset"); break;
      case HomeRow::kAbout: snprintf(labels[i], kLabelBytes, "About"); break;
      case HomeRow::kWakeWord:
        snprintf(labels[i], kLabelBytes, "Wake word  %s", wakeModelSpec(settings().wakeWord).phrase);
        break;
    }
  }
  showPicker("SETTINGS", "", labels, n, "");
}

// --- reset (#680) -------------------------------------------------------------

void buildResetRows() {
  g->resetRowCount = 0;
  g->resetRows[g->resetRowCount++] = ResetScope::kWifi;
  if (serverVisible()) g->resetRows[g->resetRowCount++] = ResetScope::kServer;
  g->resetRows[g->resetRowCount++] = ResetScope::kUnpair;
  g->resetRows[g->resetRowCount++] = ResetScope::kFactory;
}

void drawReset() {
  buildResetRows();
  char labels[4][kLabelBytes];
  for (uint8_t i = 0; i < g->resetRowCount; ++i) {
    const char* text = "";
    switch (g->resetRows[i]) {
      case ResetScope::kWifi: text = "Forget all Wi-Fi"; break;
      case ResetScope::kServer: text = "Server back to Production"; break;
      case ResetScope::kUnpair: text = "Unpair this device"; break;
      case ResetScope::kFactory: text = "Factory reset"; break;
    }
    snprintf(labels[i], kLabelBytes, "%s", text);
  }
  showPicker("RESET", "", labels, g->resetRowCount, "Each option clears only what it says");
}

void drawConfirmReset() {
  switch (g->resetScope) {
    case ResetScope::kWifi: {
      const char* lines[] = {"Every saved network and its", "password is deleted from this",
                             "device. Setup starts again."};
      showLines("FORGET ALL WI-FI?", kColorRed, lines, 3);
      return;
    }
    case ResetScope::kServer: {
      const char* lines[] = {"Local dev and Custom are cleared", "and this device uses Production.",
                             "Every pairing is kept."};
      showLines("PRODUCTION?", kColorYellow, lines, 3);
      return;
    }
    case ResetScope::kUnpair: {
      char from[40];
      snprintf(from, sizeof(from), "Unpair from %s?", profileDisplayName(activeProfile()));
      const char* lines[] = {from, "You'll need a new code to use it.", "",
                             "Also remove it at app.heybob.xyz", "> Devices."};
      showLines("UNPAIR?", kColorRed, lines, 5);
      return;
    }
    case ResetScope::kFactory:
      return;
  }
}

// Wi-Fi, server and unpair apply here; factory reset is applied by the caller,
// which restarts the device right after.
SettingsExit applyReset(uint32_t nowMs) {
  const ResetScope scope = g->resetScope;
  g->resetDone = true;
  if (scope == ResetScope::kFactory) return SettingsExit::kClose;
  resetApply(deviceStore(), scope, activeProfile());
  journal("reset", State::kSettings, "", String("scope=") + resetScopeName(scope));
  switch (scope) {
    case ResetScope::kWifi:
      netLoad(deviceStore(), g->list);
      g->listChanged = true;
      g->linkChanged = true;
      return SettingsExit::kClose;  // the caller opens Setup
    case ResetScope::kServer:
      g->serverChanged = true;
      chromeToast("Server set to Production", nowMs);
      go(Screen::kHome);
      return SettingsExit::kStay;
    case ResetScope::kUnpair:
      journal("device_token_erased", State::kSettings, "",
              String("reason=unpair profile=") + profileName(activeProfile()));
      g->serverChanged = true;  // reconnect without a token: the server asks to pair
      return SettingsExit::kClose;
    case ResetScope::kFactory:
      break;
  }
  return SettingsExit::kClose;
}

// --- server profiles (#679) --------------------------------------------------

void buildServerRows() {
  g->serverRowCount = 0;
  for (uint8_t p = 0; p < kProfileCount; ++p) {
    const Profile profile = static_cast<Profile>(p);
    if (profileAvailable(deviceStore(), profile, kDevOptions)) g->serverRows[g->serverRowCount++] = profile;
  }
}

// The endpoint line for the screen only: never journaled.
void endpointText(Profile profile, char* out, size_t outSize) {
  if (profile == Profile::kProd) {
    snprintf(out, outSize, "Bob cloud (secure)");
    return;
  }
  Endpoint e{};
  if (!endpointLoad(deviceStore(), profile, kDevOptions, e)) {
    snprintf(out, outSize, "Not set up yet: [e] edit");
    return;
  }
  char host[25];
  truncateInto(host, sizeof(host), e.host, 24);
  snprintf(out, outSize, "%s:%u %s", host, static_cast<unsigned>(e.port), e.tls ? "" : "plain");
}

void drawServer() {
  buildServerRows();
  char labels[kProfileCount][kLabelBytes];
  for (uint8_t i = 0; i < g->serverRowCount; ++i) {
    const Profile p = g->serverRows[i];
    snprintf(labels[i], kLabelBytes, "%-10s %s %s", profileDisplayName(p),
             p == activeProfile() ? "*" : " ",
             tokenHas(deviceStore(), p) ? "paired" : "needs pairing");
  }
  char hint[40];
  endpointText(g->serverRows[g->selection < g->serverRowCount ? g->selection : 0], hint, sizeof(hint));
  showPicker("SERVER", "", labels, g->serverRowCount, hint);
}

void drawServerEdit() {
  char labels[4][kLabelBytes];
  char host[21];
  truncateInto(host, sizeof(host), g->editEndpoint.host[0] ? g->editEndpoint.host : "-", 20);
  snprintf(labels[0], kLabelBytes, "Host   %s", host);
  snprintf(labels[1], kLabelBytes, "Port   %u", static_cast<unsigned>(g->editEndpoint.port));
  snprintf(labels[2], kLabelBytes, "Secure (TLS)  %s", g->editEndpoint.tls ? "On" : "Off");
  snprintf(labels[3], kLabelBytes, "Save");
  const char* hint = g->serverError ? g->serverError
                     : !kDevOptions ? "This build connects securely only"
                     : g->editEndpoint.tls ? "" : "Plain works on developer builds only";
  showPicker(profileDisplayName(g->editProfile), "", labels, 4, hint);
}

void openServerEdit(Profile profile) {
  g->editProfile = profile;
  g->serverError = nullptr;
  if (!endpointLoad(deviceStore(), profile, kDevOptions, g->editEndpoint)) {
    memset(&g->editEndpoint, 0, sizeof(g->editEndpoint));
    g->editEndpoint.port = kDevOptions ? 7444 : 443;
    g->editEndpoint.tls = !kDevOptions;
  }
  go(Screen::kServerEdit);
}

const char* profileErrorText(ProfileError error) {
  switch (error) {
    case ProfileError::kInvalidHost: return "Use a name like host.example.com";
    case ProfileError::kInvalidPort: return "Port 1-65535";
    case ProfileError::kPlainRefused: return "This build needs TLS on";
    case ProfileError::kLocked: return "Not available on this build";
    case ProfileError::kImmutable: return "Production can't be changed";
    case ProfileError::kOk: break;
  }
  return "";
}

void applySwitch() {
  const ProfileError error =
      profileSave(deviceStore(), g->editProfile, g->editUsed ? &g->editEndpoint : nullptr, kDevOptions);
  if (error != ProfileError::kOk) {
    journal("profile_refused", State::kSettings, "",
            String("profile=") + profileName(g->editProfile) + " reason=" + static_cast<int>(error));
    g->serverError = profileErrorText(error);
    go(g->editUsed ? Screen::kServerEdit : Screen::kServer);
    return;
  }
  Endpoint e{};
  endpointLoad(deviceStore(), g->editProfile, kDevOptions, e);
  journal("profile_set", State::kSettings, "",
          String("profile=") + profileName(g->editProfile) + " tls=" + (e.tls ? 1 : 0));
  g->serverChanged = true;
  go(Screen::kServer);
}

size_t wifiRowCount() { return netListRows(g->list); }

void drawWifiList() {
  char labels[kMaxNetworks + 1][kLabelBytes];
  bool anyActive = false;
  for (uint8_t r = 0; r < g->list.count; ++r) {
    const uint8_t slot = g->list.order[r];
    const SavedNetwork& net = g->list.slot[slot];
    char name[17];
    truncateInto(name, sizeof(name), net.ssid, 16);
    const bool active = slot == g->activeSlot;
    anyActive = anyActive || active;
    snprintf(labels[r], kLabelBytes, "%u%c %-16s %s", static_cast<unsigned>(r + 1),
             active ? '*' : ' ', name, resultLabel(net.last));
  }
  snprintf(labels[g->list.count], kLabelBytes, "+ Add network (%u of %u)",
           static_cast<unsigned>(g->list.count), static_cast<unsigned>(kMaxNetworks));
  showPicker("WI-FI", "No saved networks", labels, wifiRowCount(),
             anyActive ? "* connected now" : "");
}

void buildDetailActions() {
  g->actionCount = 0;
  const uint8_t rank = netRank(g->list, g->detailSlot);
  if (g->detailSlot != g->activeSlot) g->actions[g->actionCount++] = DetailAction::kConnect;
  g->actions[g->actionCount++] = DetailAction::kPassword;
  if (rank > 0) g->actions[g->actionCount++] = DetailAction::kUp;
  if (rank + 1 < g->list.count) g->actions[g->actionCount++] = DetailAction::kDown;
  g->actions[g->actionCount++] = DetailAction::kForget;
}

void drawDetail() {
  buildDetailActions();
  char labels[5][kLabelBytes];
  for (uint8_t i = 0; i < g->actionCount; ++i) {
    const char* text = "";
    switch (g->actions[i]) {
      case DetailAction::kConnect: text = "Connect now"; break;
      case DetailAction::kPassword: text = "Change password"; break;
      case DetailAction::kUp: text = "Move up"; break;
      case DetailAction::kDown: text = "Move down"; break;
      case DetailAction::kForget: text = "Forget"; break;
    }
    snprintf(labels[i], kLabelBytes, "%s", text);
  }
  const SavedNetwork& net = g->list.slot[g->detailSlot];
  char heading[19];
  truncateInto(heading, sizeof(heading), net.ssid, 18);
  char hint[40];
  snprintf(hint, sizeof(hint), "Priority %u of %u  last: %s",
           static_cast<unsigned>(netRank(g->list, g->detailSlot) + 1),
           static_cast<unsigned>(g->list.count),
           net.last == JoinResult::kNever ? "-" : resultLabel(net.last));
  showPicker(heading, "", labels, g->actionCount, hint);
}

size_t scanRowCount() { return g->scanCount + 3u; }

void drawScanList() {
  char labels[kMaxScanEntries + 3][kLabelBytes];
  for (uint8_t i = 0; i < g->scanCount; ++i) {
    const ScanEntry& e = g->scan[i];
    char name[19];
    if (e.enterprise) {
      truncateInto(name, sizeof(name), e.ssid, 14);
      snprintf(labels[i], kLabelBytes, "%-14s not supported", name);
      continue;
    }
    truncateInto(name, sizeof(name), e.ssid, 18);
    const uint8_t b = bars(e.rssi);
    char meter[5] = "    ";
    for (uint8_t k = 0; k < b; ++k) meter[k] = '|';
    snprintf(labels[i], kLabelBytes, "%-18s %s %s", name, meter, e.open ? "open" : "lock");
  }
  snprintf(labels[g->scanCount], kLabelBytes, "+ Type a network name");
  snprintf(labels[g->scanCount + 1], kLabelBytes, "? My network isn't listed");
  snprintf(labels[g->scanCount + 2], kLabelBytes, "Scan again");
  showPicker("CHOOSE WI-FI", "", labels, scanRowCount(), "Only 2.4 GHz networks show here");
}

void drawReplacePick() {
  char labels[kMaxNetworks][kLabelBytes];
  for (uint8_t r = 0; r < g->list.count; ++r) {
    const SavedNetwork& net = g->list.slot[g->list.order[r]];
    char name[19];
    truncateInto(name, sizeof(name), net.ssid, 18);
    snprintf(labels[r], kLabelBytes, "%-18s %s", name, resultLabel(net.last));
  }
  showPicker("5 SAVED", "", labels, g->list.count, "Replace which one?");
}

void drawAbout() {
  char l0[40], l1[40], l2[40], l3[40], l4[40];
  snprintf(l0, sizeof(l0), "%s firmware %s", assistantDisplay(AssistantLabel::kName), kFirmwareNumericVersion);
  snprintf(l1, sizeof(l1), "Name    %s", g->deviceName[0] ? g->deviceName : "-");
  snprintf(l2, sizeof(l2), "Server  %s", profileDisplayName(activeProfile()));
  const WifiView view = wifiManagerView();
  if (wifiLinkUp() && g->activeSlot < kMaxNetworks && g->list.slot[g->activeSlot].used) {
    char name[19];
    truncateInto(name, sizeof(name), g->list.slot[g->activeSlot].ssid, 18);
    char meter[5] = "    ";
    for (uint8_t k = 0; k < bars(WiFi.RSSI()); ++k) meter[k] = '|';
    snprintf(l3, sizeof(l3), "Wi-Fi   %s %s", name, meter);
  } else {
    snprintf(l3, sizeof(l3), "Wi-Fi   not connected");
  }
  const bool internet = view.phase == WifiPhase::kOnline;
  snprintf(l4, sizeof(l4), "Online  %s   Server %s", internet ? "ok" : "--", g->socketUp ? "ok" : "--");
  const char* lines[] = {l0, l1, l2, l3, l4};
  showLines("ABOUT", kColorWhite, lines, 5);
}

void drawJoinFailed() {
  char name[33];
  truncateInto(name, sizeof(name), g->pendingSsid, 32);
  const char* why = "It didn't answer in time.";
  switch (g->joinResult) {
    case JoinResult::kAuth: why = "Check the password and try again."; break;
    case JoinResult::kNoAp: why = "Can't find it. Is it on and near?"; break;
    default: break;
  }
  const char* lines[] = {name, "", why, "", "Nothing was saved."};
  showLines("COULDN'T JOIN", kColorRed, lines, 5);
}

void drawSaved() {
  char name[33];
  truncateInto(name, sizeof(name), g->list.slot[g->savedSlot].ssid, 32);
  char count[40];
  snprintf(count, sizeof(count), "Saved (%u of %u).", static_cast<unsigned>(g->list.count),
           static_cast<unsigned>(kMaxNetworks));
  const bool first = netRank(g->list, g->savedSlot) == 0 && g->list.count > 1;
  const char* lines[] = {name, count, first ? "It's first in line now." : ""};
  showLines(g->purpose == JoinPurpose::kConnectNow ? "CONNECTED" : "SAVED", kColorGreen, lines, 3);
}

// --- scan ------------------------------------------------------------------

void startScan() {
  g->scanCount = 0;
  wifiManagerUserScan();
  go(Screen::kScanning);
}

void finishScan(int found) {
  g->scanCount = 0;
  for (int i = 0; i < found; ++i) {
    const String ssid = WiFi.SSID(i);
    if (ssid.length() == 0 || ssid.length() > kSsidMaxBytes) continue;
    const int rssi = WiFi.RSSI(i);
    bool merged = false;
    for (uint8_t k = 0; k < g->scanCount && !merged; ++k) {
      if (strcmp(g->scan[k].ssid, ssid.c_str()) != 0) continue;
      if (rssi > g->scan[k].rssi) g->scan[k].rssi = static_cast<int8_t>(rssi);
      merged = true;
    }
    if (merged) continue;
    // Keep the strongest kMaxScanEntries: replace the weakest when full.
    uint8_t at = g->scanCount;
    if (g->scanCount == kMaxScanEntries) {
      uint8_t weakest = 0;
      for (uint8_t k = 1; k < g->scanCount; ++k) {
        if (g->scan[k].rssi < g->scan[weakest].rssi) weakest = k;
      }
      if (g->scan[weakest].rssi >= rssi) continue;
      at = weakest;
    } else {
      ++g->scanCount;
    }
    ScanEntry& e = g->scan[at];
    strncpy(e.ssid, ssid.c_str(), sizeof(e.ssid) - 1);
    e.ssid[sizeof(e.ssid) - 1] = '\0';
    e.rssi = static_cast<int8_t>(rssi);
    const wifi_auth_mode_t auth = WiFi.encryptionType(i);
    e.open = auth == WIFI_AUTH_OPEN;
    e.enterprise = auth == WIFI_AUTH_WPA2_ENTERPRISE;
  }
  WiFi.scanDelete();
  // Strongest first.
  for (uint8_t a = 1; a < g->scanCount; ++a) {
    for (uint8_t b = a; b > 0 && g->scan[b].rssi > g->scan[b - 1].rssi; --b) {
      const ScanEntry tmp = g->scan[b];
      g->scan[b] = g->scan[b - 1];
      g->scan[b - 1] = tmp;
    }
  }
  journal("wifi_scan", State::kSettings, "",
          (found < 0 ? String("failed=1 listed=") : String("found=") + found + " listed=") + g->scanCount);
  go(Screen::kScanList);
}

// --- joins -----------------------------------------------------------------

void startJoin(JoinPurpose purpose, uint32_t nowMs) {
  g->purpose = purpose;
  g->linkChanged = true;
  wifiManagerTestJoin(g->pendingSsid, g->pendingPass, nowMs);
  go(Screen::kJoining);
}

void commitJoin() {
  uint8_t slot = kNoSlot;
  switch (g->purpose) {
    case JoinPurpose::kAdd: {
      // The network chosen now goes first in line.
      const NetError error = netCommitJoined(g->list, g->pendingSsid, g->pendingPass,
                                             g->pendingHidden ? kNetFlagHidden : 0, kNoSlot, &slot,
                                             &g->savedOldRank);
      if (error == NetError::kFull) {
        go(Screen::kReplacePick);  // ask which to replace, then commit
        return;
      }
      if (error != NetError::kOk) return;
      break;
    }
    case JoinPurpose::kChangePassword:
      slot = g->detailSlot;
      if (netUpdate(g->list, slot, nullptr, g->pendingPass) != NetError::kOk) return;
      journal("net_updated", State::kSettings, "", String("slot=") + slot + " fields=pass");
      break;
    case JoinPurpose::kConnectNow:
      slot = g->detailSlot;  // savedOldRank is for [k] after an add only
      break;
  }
  g->list.slot[slot].last = JoinResult::kOk;
  g->activeSlot = slot;
  g->savedSlot = slot;
  saveList();
  if (g->purpose == JoinPurpose::kAdd) {
    journal("net_saved", State::kSettings, "",
            String("slot=") + slot + " count=" + g->list.count);
  }
  wipeSecrets();
  go(Screen::kSaved);
}

void commitReplace() {
  const uint8_t victim = g->replaceSlot;
  if (netCommitJoined(g->list, g->pendingSsid, g->pendingPass, g->pendingHidden ? kNetFlagHidden : 0,
                      victim, nullptr, &g->savedOldRank) != NetError::kOk) {
    return;
  }
  journal("net_forgot", State::kSettings, "", String("slot=") + victim + " count=" + g->list.count);
  g->activeSlot = victim;
  g->savedSlot = victim;
  saveList();
  journal("net_saved", State::kSettings, "", String("slot=") + victim + " count=" + g->list.count);
  wipeSecrets();
  go(Screen::kSaved);
}

// --- key handling ----------------------------------------------------------

struct ListKeys {
  bool up;
  bool down;
  bool back;
  bool select;
  char letter;  // another printable key, or 0
};

ListKeys listKeys(const char* pressed, size_t count, bool enter) {
  ListKeys k{};
  k.select = enter;
  for (size_t i = 0; i < count; ++i) {
    switch (pressed[i]) {
      case ';': k.up = true; break;
      case '.': k.down = true; break;
      case '`': k.back = true; break;
      default: k.letter = pressed[i]; break;
    }
  }
  return k;
}

bool moveSelection(const ListKeys& k, size_t rows) {
  if (k.up && g->selection > 0) {
    --g->selection;
    return true;
  }
  if (k.down && g->selection + 1 < rows) {
    ++g->selection;
    return true;
  }
  return false;
}

void openField(Screen screen, uint8_t maxLength, bool masked) {
  fieldInit(g->field, maxLength, masked);
  go(screen);
}

SettingsExit onListKeys(const ListKeys& k, uint32_t nowMs) {
  switch (g->screen) {
    case Screen::kHome: {
      if (k.back) return SettingsExit::kClose;
      if (moveSelection(k, homeRowCount())) return SettingsExit::kStay;
      if (!k.select) return SettingsExit::kStay;
      HomeRow rows[7];
      homeRows(rows);
      switch (rows[g->selection]) {
        case HomeRow::kConnection: go(Screen::kConnection); break;
        case HomeRow::kUpdates: fsm::updateCancelManual(); go(Screen::kUpdates); break;
        case HomeRow::kWifi: go(Screen::kWifiList); break;
        case HomeRow::kServer: go(Screen::kServer); break;
        case HomeRow::kReset: go(Screen::kReset); break;
        case HomeRow::kWakeWord:
          go(Screen::kWakeWord);
          g->selection = static_cast<uint8_t>(settings().wakeWord);
          break;
        case HomeRow::kAbout:
          g->aboutTypedLen = 0;
          go(Screen::kAbout);
          break;
      }
      return SettingsExit::kStay;
    }

    case Screen::kConnection:
      if (k.back) go(Screen::kHome);
      else if (k.select && activeProfile() != Profile::kProd) {
        fsm::updateCancelManual();
        g->editProfile = Profile::kProd; g->editUsed = false; go(Screen::kConfirmSwitch);
      }
      return SettingsExit::kStay;
    case Screen::kUpdates:
      if (k.back) { fsm::updateCancelManual(); go(Screen::kHome); }
      else if (k.select) {
        const auto view = fsm::updateView();
        if (view.phase == ManualOtaPhase::kOffered) {
          snprintf(g->updateVersion, sizeof(g->updateVersion), "%s", view.version);
          go(Screen::kConfirmUpdate);
        } else if (view.phase != ManualOtaPhase::kChecking) fsm::updateCheckNow();
      }
      return SettingsExit::kStay;
    case Screen::kConfirmUpdate:
      if (k.back) { fsm::updateCancelManual(); go(Screen::kUpdates); }
      else if (k.select && fsm::updateConfirmNow(g->updateVersion)) return SettingsExit::kClose;
      return SettingsExit::kStay;
    case Screen::kWakeWord:
      if (k.back) { go(Screen::kHome); return SettingsExit::kStay; }
      if (moveSelection(k, kWakeModelCount)) return SettingsExit::kStay;
      if (k.select) {
        const WakeWord word = static_cast<WakeWord>(g->selection);
        if (settingsSetWakeWord(word)) {
          g->wakeWordChanged = true;
          journal("wake_word_changed", State::kSettings, "",
                  String("word=") + wakeModelSpec(word).name + ",source=settings");
        }
        go(Screen::kHome);
      }
      return SettingsExit::kStay;

    case Screen::kReset:
      buildResetRows();
      if (k.back) {
        go(Screen::kHome);
        return SettingsExit::kStay;
      }
      if (moveSelection(k, g->resetRowCount)) return SettingsExit::kStay;
      if (k.select) {
        g->resetScope = g->resetRows[g->selection];
        if (g->resetScope == ResetScope::kFactory) {
          fieldInit(g->field, 8, false);
          go(Screen::kFactory);
        } else {
          go(Screen::kConfirmReset);
        }
      }
      return SettingsExit::kStay;

    case Screen::kServer: {
      buildServerRows();
      if (k.back) {
        go(Screen::kHome);
        return SettingsExit::kStay;
      }
      if (moveSelection(k, g->serverRowCount)) return SettingsExit::kStay;
      const Profile p = g->serverRows[g->selection];
      if (k.letter == 'e' && p != Profile::kProd) {
        openServerEdit(p);
        return SettingsExit::kStay;
      }
      if (!k.select || p == activeProfile()) return SettingsExit::kStay;
      Endpoint e{};
      if (p != Profile::kProd && !endpointLoad(deviceStore(), p, kDevOptions, e)) {
        openServerEdit(p);  // nothing stored yet: set it up first
        return SettingsExit::kStay;
      }
      g->editProfile = p;
      g->editUsed = false;
      go(Screen::kConfirmSwitch);
      return SettingsExit::kStay;
    }

    case Screen::kServerEdit:
      if (k.back) {
        go(Screen::kServer);
        return SettingsExit::kStay;
      }
      if (moveSelection(k, 4)) return SettingsExit::kStay;
      if (!k.select) return SettingsExit::kStay;
      g->serverError = nullptr;
      if (g->selection == 0) {
        fieldInit(g->field, kHostMaxBytes, false, g->editEndpoint.host);
        go(Screen::kHost);
      } else if (g->selection == 1) {
        char port[6];
        snprintf(port, sizeof(port), "%u", static_cast<unsigned>(g->editEndpoint.port));
        fieldInit(g->field, 5, false, port);
        g->field.digitsOnly = true;
        go(Screen::kPort);
      } else if (g->selection == 2) {
        if (kDevOptions) g->editEndpoint.tls = !g->editEndpoint.tls;
      } else {
        const ProfileError error = endpointCheck(g->editProfile, g->editEndpoint, kDevOptions);
        if (error != ProfileError::kOk) {
          g->serverError = profileErrorText(error);
        } else {
          g->editUsed = true;
          go(Screen::kConfirmSwitch);
        }
      }
      return SettingsExit::kStay;

    case Screen::kWifiList:
      if (k.back) {
        go(Screen::kHome);
        return SettingsExit::kStay;
      }
      if (k.letter == 'a') {
        startScan();
        return SettingsExit::kStay;
      }
      if (moveSelection(k, wifiRowCount())) return SettingsExit::kStay;
      if (k.select) {
        if (g->selection < g->list.count) {
          g->detailSlot = g->list.order[g->selection];
          go(Screen::kDetail);
        } else {
          startScan();
        }
      }
      return SettingsExit::kStay;

    case Screen::kDetail: {
      if (k.back) {
        const uint8_t rank = netRank(g->list, g->detailSlot);
        go(Screen::kWifiList);
        g->selection = rank == kNoSlot ? 0 : rank;
        return SettingsExit::kStay;
      }
      if (moveSelection(k, g->actionCount)) return SettingsExit::kStay;
      if (!k.select) return SettingsExit::kStay;
      const SavedNetwork& net = g->list.slot[g->detailSlot];
      switch (g->actions[g->selection]) {
        case DetailAction::kConnect:
          strncpy(g->pendingSsid, net.ssid, sizeof(g->pendingSsid));
          strncpy(g->pendingPass, net.pass, sizeof(g->pendingPass));
          startJoin(JoinPurpose::kConnectNow, nowMs);
          break;
        case DetailAction::kPassword:
          strncpy(g->pendingSsid, net.ssid, sizeof(g->pendingSsid));
          g->purpose = JoinPurpose::kChangePassword;
          openField(Screen::kPassword, kPassMaxBytes, true);
          break;
        case DetailAction::kUp:
        case DetailAction::kDown: {
          const bool up = g->actions[g->selection] == DetailAction::kUp;
          netMove(g->list, g->detailSlot, up ? -1 : 1);
          saveList();
          String order;
          for (uint8_t r = 0; r < g->list.count; ++r) order += String(r ? "," : "") + g->list.order[r];
          journal("net_reordered", State::kSettings, "", String("order=") + order);
          buildDetailActions();
          g->selection = 0;
          break;
        }
        case DetailAction::kForget:
          go(Screen::kConfirmForget);
          break;
      }
      return SettingsExit::kStay;
    }

    case Screen::kScanList:
      if (k.back) {
        go(g->setup ? Screen::kWelcome : Screen::kWifiList);
        return SettingsExit::kStay;
      }
      if (moveSelection(k, scanRowCount())) return SettingsExit::kStay;
      if (!k.select) return SettingsExit::kStay;
      if (g->selection < g->scanCount) {
        const ScanEntry& e = g->scan[g->selection];
        if (e.enterprise) return SettingsExit::kStay;
        strncpy(g->pendingSsid, e.ssid, sizeof(g->pendingSsid));
        g->pendingHidden = false;
        g->purpose = JoinPurpose::kAdd;
        if (e.open) {
          g->pendingPass[0] = '\0';
          startJoin(JoinPurpose::kAdd, nowMs);
        } else {
          openField(Screen::kPassword, kPassMaxBytes, true);
        }
      } else if (g->selection == g->scanCount) {
        g->pendingHidden = true;
        g->purpose = JoinPurpose::kAdd;
        openField(Screen::kName, kSsidMaxBytes, false);
      } else if (g->selection == g->scanCount + 1u) {
        go(Screen::kNotListed);
      } else {
        startScan();
      }
      return SettingsExit::kStay;

    case Screen::kReplacePick:
      if (k.back) {
        wipeSecrets();
        go(Screen::kWifiList);
        return SettingsExit::kStay;
      }
      if (moveSelection(k, g->list.count)) return SettingsExit::kStay;
      if (k.select) {
        g->replaceSlot = g->list.order[g->selection];
        go(Screen::kConfirmReplace);
      }
      return SettingsExit::kStay;

    default:
      return SettingsExit::kStay;
  }
}

SettingsExit onScreenKeys(const char* pressed, size_t count, const Keyboard_Class::KeysState& keys,
                          uint32_t nowMs) {
  const ListKeys k = listKeys(pressed, count, keys.enter);
  switch (g->screen) {
    case Screen::kName:
    case Screen::kPassword: {
      const FieldKeys fk{pressed, count, keys.enter, keys.del, keys.tab, keys.fn};
      const FieldAction action = fieldApply(g->field, fk, nowMs);
      if (action == FieldAction::kCancel) {
        wipeSecrets();
        go(g->purpose == JoinPurpose::kChangePassword ? Screen::kDetail : Screen::kScanList);
      } else if (action == FieldAction::kSubmit) {
        if (g->screen == Screen::kName) {
          if (!ssidValid(g->field.text)) return SettingsExit::kStay;
          strncpy(g->pendingSsid, g->field.text, sizeof(g->pendingSsid));
          openField(Screen::kPassword, kPassMaxBytes, true);
        } else {
          if (!passValid(g->field.text)) return SettingsExit::kStay;
          // An empty password only for a network typed by name (an open one).
          if (g->field.length == 0 && !g->pendingHidden) return SettingsExit::kStay;
          strncpy(g->pendingPass, g->field.text, sizeof(g->pendingPass));
          memset(g->field.text, 0, sizeof(g->field.text));
          startJoin(g->purpose, nowMs);
        }
      }
      return SettingsExit::kStay;
    }

    case Screen::kHost:
    case Screen::kPort: {
      const FieldKeys fk{pressed, count, keys.enter, keys.del, keys.tab, keys.fn};
      const FieldAction action = fieldApply(g->field, fk, nowMs);
      if (action == FieldAction::kSubmit) {
        if (g->screen == Screen::kHost) {
          strncpy(g->editEndpoint.host, g->field.text, sizeof(g->editEndpoint.host) - 1);
          g->editEndpoint.host[sizeof(g->editEndpoint.host) - 1] = '\0';
          g->selection = 0;
        } else {
          const unsigned long port = strtoul(g->field.text, nullptr, 10);
          g->editEndpoint.port = port <= 65535 ? static_cast<uint16_t>(port) : 0;
        }
        const size_t row = g->screen == Screen::kHost ? 0 : 1;
        g->screen = Screen::kServerEdit;
        g->selection = row;
      } else if (action == FieldAction::kCancel) {
        const size_t row = g->screen == Screen::kHost ? 0 : 1;
        g->screen = Screen::kServerEdit;
        g->selection = row;
      }
      return SettingsExit::kStay;
    }

    case Screen::kConfirmReset:
      if (k.back) go(Screen::kReset);
      else if (k.select) return applyReset(nowMs);
      return SettingsExit::kStay;

    case Screen::kFactory: {
      const FieldKeys fk{pressed, count, keys.enter, keys.del, keys.tab, keys.fn};
      const FieldAction action = fieldApply(g->field, fk, nowMs);
      if (action == FieldAction::kCancel) {
        go(Screen::kReset);
      } else if (action == FieldAction::kSubmit && strcasecmp(g->field.text, "RESET") == 0) {
        return applyReset(nowMs);  // anything else typed does nothing
      }
      return SettingsExit::kStay;
    }

    case Screen::kConfirmSwitch:
      if (k.back) go(g->editUsed ? Screen::kServerEdit : Screen::kServer);
      else if (k.select) applySwitch();
      return SettingsExit::kStay;

    case Screen::kConfirmForget:
      if (k.back) {
        go(Screen::kDetail);
      } else if (k.select) {
        const uint8_t slot = g->detailSlot;
        netRemove(g->list, slot);
        saveList();
        if (slot == g->activeSlot) {
          g->linkChanged = true;
          g->activeSlot = kNoSlot;
        }
        journal("net_forgot", State::kSettings, "", String("slot=") + slot + " count=" + g->list.count);
        go(Screen::kWifiList);
      }
      return SettingsExit::kStay;

    case Screen::kConfirmReplace:
      if (k.back) {
        go(Screen::kReplacePick);
      } else if (k.select) {
        commitReplace();
      }
      return SettingsExit::kStay;

    case Screen::kNotListed:
      if (k.back) go(Screen::kScanList);
      else if (k.select) startScan();
      return SettingsExit::kStay;

    case Screen::kJoinFailed:
      if (k.back) {
        wipeSecrets();
        go(g->purpose == JoinPurpose::kAdd ? Screen::kScanList : Screen::kDetail);
      } else if (k.select && g->purpose != JoinPurpose::kConnectNow) {
        openField(Screen::kPassword, kPassMaxBytes, true);  // try again, typed fresh
      }
      return SettingsExit::kStay;

    case Screen::kSaved:
      if (k.letter == 'k' && g->purpose == JoinPurpose::kAdd) {
        const uint8_t now = netRank(g->list, g->savedSlot);
        netMove(g->list, g->savedSlot, static_cast<int>(g->savedOldRank) - static_cast<int>(now));
        saveList();
      }
      // Setup is done once a network is saved: connect, then pair.
      if (g->setup && (k.select || k.back)) return SettingsExit::kClose;
      if (k.select || k.back || k.letter == 'k') {
        go(Screen::kWifiList);
        g->selection = netRank(g->list, g->savedSlot);
      }
      return SettingsExit::kStay;

    case Screen::kAbout:
      if (k.back || k.select) {
        go(Screen::kHome);
        return SettingsExit::kStay;
      }
      // Typing `developer` here toggles developer options on a build
      // without them (#679): the Custom profile, TLS only.
      for (size_t i = 0; i < count; ++i) {
        if (!profileUnlockKey(g->aboutTypedLen, pressed[i]) || kDevOptions) continue;  // dev: already on
        const bool on = !profileUnlocked(deviceStore());
        profileSetUnlocked(deviceStore(), on);
        // Locked while on Custom: leaving Settings reloads, which falls back to
        // Production now instead of at the next boot.
        if (!on && activeProfile() != Profile::kProd) g->serverChanged = true;
        journal("dev_options", State::kSettings, "", String("unlocked=") + (on ? 1 : 0));
        chromeToast(on ? "Developer options on" : "Developer options off", nowMs);
      }
      return SettingsExit::kStay;

    case Screen::kWelcome:
      if (k.select) startScan();
      if (k.letter == 's') return SettingsExit::kClose;  // set up later: offline
      return SettingsExit::kStay;

    case Screen::kScanning:
    case Screen::kJoining:
      return SettingsExit::kStay;  // wait for the radio

    default:
      return onListKeys(k, nowMs);
  }
}

}  // namespace

bool settingsOpen(uint32_t nowMs, const char* deviceName, bool socketUp, SettingsEntry entry) {
  if (g) return true;
  g = new (std::nothrow) Session();
  if (!g) return false;
  memset(g, 0, sizeof(*g));
  netLoad(deviceStore(), g->list);
  const WifiView view = wifiManagerView();
  g->activeSlot = wifiLinkUp() ? view.slot : kNoSlot;
  g->detailSlot = kNoSlot;
  g->drawn = Screen::kAbout;  // anything but kHome: force a full first draw
  g->setup = entry == SettingsEntry::kSetup;
  g->screen = entry == SettingsEntry::kSetup     ? Screen::kWelcome
              : entry == SettingsEntry::kWifiList ? Screen::kWifiList
                                                  : Screen::kHome;
  g->lastInputMs = nowMs;
  g->socketUp = socketUp;
  if (deviceName) strncpy(g->deviceName, deviceName, sizeof(g->deviceName) - 1);
  return true;
}

SettingsOutcome settingsClose() {
  fsm::updateSettingsClosed();
  SettingsOutcome outcome{};
  if (!g) return outcome;
  outcome.serverChanged = g->serverChanged;
  outcome.wakeWordChanged = g->wakeWordChanged;
  outcome.reset = g->resetDone;
  outcome.scope = g->resetScope;
  // The saved list changed while the device had no link, the active network
  // was forgotten, or a join test moved the radio: re-plan from a scan.
  outcome.replan = g->linkChanged || (g->listChanged && !wifiLinkUp());
  memset(g, 0, sizeof(*g));
  delete g;
  g = nullptr;
  endConversationList();
  return outcome;
}

bool settingsIsOpen() { return g != nullptr; }

bool settingsYieldsTo(bool ring) {
  if (!g) return false;
  const bool radioBusy = g->screen == Screen::kScanning || g->screen == Screen::kJoining;
  return settingsYieldsToAnnouncement(ring, g->setup, radioBusy);
}

const char* settingsChangedName() {
  if (!g) return "none";
  const bool wifi = g->listChanged || g->linkChanged;
  if (wifi && g->serverChanged) return "wifi+server";
  if (g->serverChanged) return "server";
  return wifi ? "wifi" : "none";
}

const char* settingsStrip() {
  if (!g) return "";
  switch (g->screen) {
    case Screen::kWelcome: return "[Enter] start  [s] set up later";
    case Screen::kHome: return "[;] up  [.] down  [Enter] open  [`] back to Ready";
    case Screen::kConnection: return activeProfile() == Profile::kProd ? "[`] back" : "[Enter] use Production  [`] back";
    case Screen::kUpdates: return "[Enter] check / review  [`] cancel";
    case Screen::kConfirmUpdate: return "[Enter] install  [`] cancel";
    case Screen::kWakeWord: return "[;][.] move  [Enter] select  [`] back";
    case Screen::kWifiList: return "[Enter] open  [a] add  [;][.] move  [`] back";
    case Screen::kDetail:
    case Screen::kScanList:
    case Screen::kReplacePick: return "[;] up  [.] down  [Enter] select  [`] back";
    case Screen::kConfirmForget: return "[Enter] forget  [`] keep";
    case Screen::kConfirmReplace: return "[Enter] replace  [`] back";
    case Screen::kScanning: return "Looking for Wi-Fi...";
    case Screen::kNotListed: return "[Enter] scan again  [`] back";
    case Screen::kName: return "[Enter] next  [Fn+`] cancel  [Fn+,][Fn+/] move";
    case Screen::kPassword: return "[Enter] connect  [Tab] show  [Fn+`] cancel";
    case Screen::kJoining: return "Connecting...";
    case Screen::kJoinFailed:
      return g->purpose == JoinPurpose::kConnectNow ? "[`] back" : "[Enter] try again  [`] back";
    case Screen::kSaved:
      if (g->setup) return "[Enter] continue";
      return g->purpose == JoinPurpose::kAdd ? "[Enter] ok  [k] keep old order" : "[Enter] ok";
    case Screen::kAbout: return "[`] back";
    case Screen::kServer: return "[Enter] use  [e] edit  [;][.] move  [`] back";
    case Screen::kServerEdit: return "[Enter] edit  [;][.] move  [`] back without saving";
    case Screen::kHost: return "[Enter] ok  [Fn+`] cancel  [Fn+,][Fn+/] move";
    case Screen::kPort: return "[Enter] ok  [Fn+`] cancel";
    case Screen::kConfirmSwitch: return "[Enter] switch  [`] back";
    case Screen::kReset: return "[;] up  [.] down  [Enter] select  [`] back";
    case Screen::kConfirmReset: return "[Enter] yes  [`] no";
    case Screen::kFactory: return "[Enter] confirm  [Fn+`] cancel";
  }
  return "";
}

void settingsDraw(uint32_t nowMs) {
  if (!g) return;
  chromeSetVisible(true);
  switch (g->screen) {
    case Screen::kWelcome: {
      const char* lines[] = {"Let's get you online.", "It takes about 2 minutes.", "",
                             "You'll need your Wi-Fi password", "and your phone."};
      showLines(assistantDisplay(AssistantLabel::kGreeting), kColorGreen, lines, 5);
      break;
    }
    case Screen::kHome: drawHome(); break;
    case Screen::kConnection: {
      char profile[40]; snprintf(profile, sizeof(profile), "Server: %s", profileDisplayName(activeProfile()));
      const auto view = fsm::updateView();
      const char* lines[] = {profile, wifiLinkUp() ? "Wi-Fi connected" : "Wi-Fi not connected",
        view.connected ? "Server connected" : "Server not connected",
        hasDeviceToken() ? "Pairing saved" : "Needs pairing",
        activeEndpoint().tls ? "Encrypted connection" : "Local unencrypted connection"};
      showLines("CONNECTION", kColorWhite, lines, 5); break;
    }
    case Screen::kUpdates: {
      char installed[40], offered[40], numeric[24];
      const auto view = fsm::updateView();
      snprintf(installed, sizeof(installed), "Installed: %s", kFirmwareNumericVersion);
      otaNumericVersionText(view.version, numeric, sizeof(numeric));
      snprintf(offered, sizeof(offered), "Available: %s", numeric);
      const char* lines[] = {installed, view.phase == ManualOtaPhase::kOffered ? offered : "",
        view.message, view.privateBuild ? "Bob: automatic updates off" : "Signed public updates"};
      showLines("UPDATES", kColorWhite, lines, 4); break;
    }
    case Screen::kConfirmUpdate: {
      char title[40], numeric[24];
      otaNumericVersionText(g->updateVersion, numeric, sizeof(numeric));
      snprintf(title, sizeof(title), "INSTALL %s?", numeric);
      const auto view = fsm::updateView();
      const char* lines[] = {view.privateBuild ? "Bob-only firmware" : "Signed firmware update",
        view.privateBuild ? "This removes Bob." : "The device will restart.", view.message, "Keep power connected."};
      showLines(title, kColorYellow, lines, 4); break;
    }
    case Screen::kWakeWord: {
      char labels[kWakeModelCount][kLabelBytes];
      for (size_t i = 0; i < kWakeModelCount; ++i) {
        snprintf(labels[i], kLabelBytes, "%s%s", kWakeModels[i].phrase,
                 i == static_cast<uint8_t>(settings().wakeWord) ? "  (selected)" : "");
      }
      showPicker("WAKE WORD", "", labels, kWakeModelCount, "Used in Always awake mode");
      break;
    }
    case Screen::kServer: drawServer(); break;
    case Screen::kReset: drawReset(); break;
    case Screen::kConfirmReset: drawConfirmReset(); break;
    case Screen::kFactory:
      showField("FACTORY RESET", "Erases everything. Type RESET:", nowMs,
                "Giving it away? Remove it on the web");
      break;
    case Screen::kServerEdit: drawServerEdit(); break;
    case Screen::kHost: showField("SERVER HOST", "A name or an IP, no http://", nowMs, ""); break;
    case Screen::kPort: showField("PORT", "1-65535", nowMs, ""); break;
    case Screen::kConfirmSwitch: {
      char use[40];
      snprintf(use, sizeof(use), "Use %s?", profileDisplayName(g->editProfile));
      const char* lines[] = {use, "", "The device reconnects on leaving", "Settings. Your other pairings",
                             "are kept."};
      showLines("SWITCH SERVER?", kColorYellow, lines, 5);
      break;
    }
    case Screen::kWifiList: drawWifiList(); break;
    case Screen::kDetail: drawDetail(); break;
    case Screen::kScanList: drawScanList(); break;
    case Screen::kReplacePick: drawReplacePick(); break;
    case Screen::kAbout: drawAbout(); break;
    case Screen::kJoinFailed: drawJoinFailed(); break;
    case Screen::kSaved: drawSaved(); break;
    case Screen::kScanning: {
      const char* lines[] = {"Looking for Wi-Fi..."};
      showLines("LOOKING", kColorYellow, lines, 1);
      break;
    }
    case Screen::kNotListed: {
      const char* lines[] = {"This device uses 2.4 GHz Wi-Fi.", "Turn on 2.4 GHz on your router,",
                             "or pick \"Type a network name\"", "for a hidden network."};
      showLines("NOT LISTED?", kColorYellow, lines, 4);
      break;
    }
    case Screen::kJoining: {
      char name[33];
      truncateInto(name, sizeof(name), g->pendingSsid, 32);
      const char* lines[] = {name, "", "Joining Wi-Fi..."};
      showLines("CONNECTING", kColorYellow, lines, 3);
      break;
    }
    case Screen::kConfirmForget: {
      char name[33];
      truncateInto(name, sizeof(name), g->list.slot[g->detailSlot].ssid, 32);
      const bool active = g->detailSlot == g->activeSlot;
      const char* lines[] = {name, "", "The password is deleted from",
                             "this device.", active ? "You're on it now: it will" : "",
                             active ? "switch to your other networks." : ""};
      showLines("FORGET?", kColorRed, lines, active ? 6 : 4);
      break;
    }
    case Screen::kConfirmReplace: {
      char oldName[33], newName[33];
      truncateInto(oldName, sizeof(oldName), g->list.slot[g->replaceSlot].ssid, 32);
      truncateInto(newName, sizeof(newName), g->pendingSsid, 32);
      const char* lines[] = {"Forget", oldName, "and save", newName, "in its place?"};
      showLines("REPLACE?", kColorRed, lines, 5);
      break;
    }
    case Screen::kName:
      showField("NETWORK NAME", "Exactly as it appears on your router", nowMs, "");
      break;
    case Screen::kPassword: {
      char subtitle[40];
      char name[27];
      truncateInto(name, sizeof(name), g->pendingSsid, 26);
      snprintf(subtitle, sizeof(subtitle), "for %s", name);
      const char* error = "";
      if (g->field.length > 0 && g->field.length < kPassMinPassphrase) error = "At least 8 characters";
      if (g->field.length == 0 && g->pendingHidden) error = "Empty = open network";
      showField("PASSWORD", subtitle, nowMs, error);
      break;
    }
  }
  g->drawn = g->screen;
  chromeSetShortcuts(settingsStrip(), nowMs);
}

SettingsExit settingsKeys(const Keyboard_Class::KeysState& keys, uint32_t nowMs) {
  if (!g) return SettingsExit::kClose;
  char now[kHeldKeysMax];
  const size_t nowCount = keys.word.size() < kHeldKeysMax ? keys.word.size() : kHeldKeysMax;
  for (size_t i = 0; i < nowCount; ++i) now[i] = keys.word[i];
  char pressed[kHeldKeysMax];
  const size_t pressedCount = fieldNewlyPressed(g->held, g->heldCount, now, nowCount, pressed, kHeldKeysMax);
  memcpy(g->held, now, nowCount);
  g->heldCount = static_cast<uint8_t>(nowCount);
  // Enter, Tab and Del count once per press: a change while one is held
  // (another key, or a release) must not repeat it.
  const bool delPressed = keys.del && g->delHeldSinceMs == 0;
  const bool enterPressed = keys.enter && !g->enterHeld;
  const bool tabPressed = keys.tab && !g->tabHeld;
  g->delHeldSinceMs = keys.del ? (g->delHeldSinceMs ? g->delHeldSinceMs : nowMs) : 0;
  g->enterHeld = keys.enter;
  g->tabHeld = keys.tab;
  g->lastRepeatMs = 0;
  if (pressedCount == 0 && !enterPressed && !delPressed && !tabPressed) return SettingsExit::kStay;
  g->lastInputMs = nowMs;

  Keyboard_Class::KeysState edge = keys;
  edge.del = delPressed;
  edge.enter = enterPressed;
  edge.tab = tabPressed;
  const Screen before = g->screen;
  const size_t selectionBefore = g->selection;
  const SettingsExit exit = onScreenKeys(pressed, pressedCount, edge, nowMs);
  if (exit == SettingsExit::kClose) return exit;
  const bool fieldScreen = g->screen == Screen::kName || g->screen == Screen::kPassword;
  if (g->screen != before || g->selection != selectionBefore || fieldScreen ||
      g->screen == Screen::kDetail || g->screen == Screen::kWifiList ||
      g->screen == Screen::kServer || g->screen == Screen::kServerEdit ||
      g->screen == Screen::kReset || g->screen == Screen::kUpdates || g->screen == Screen::kConfirmUpdate) {
    settingsDraw(nowMs);
  }
  return SettingsExit::kStay;
}

SettingsExit settingsTick(uint32_t nowMs, const Keyboard_Class::KeysState& held, bool anyHeld) {
  if (!g) return SettingsExit::kClose;
  if ((g->screen == Screen::kConnection || g->screen == Screen::kUpdates || g->screen == Screen::kConfirmUpdate) &&
      nowMs - g->statusDrawAt >= 500) { g->statusDrawAt = nowMs; settingsDraw(nowMs); }
  switch (g->screen) {
    case Screen::kScanning: {
      const int found = wifiManagerUserScanPoll();
      if (found != WIFI_SCAN_RUNNING) {
        finishScan(found);
        settingsDraw(nowMs);
      }
      return SettingsExit::kStay;
    }
    case Screen::kJoining: {
      JoinResult result = JoinResult::kNever;
      const TestJoin status = wifiManagerTestPoll(nowMs, &result);
      if (status == TestJoin::kRunning) return SettingsExit::kStay;
      g->joinResult = result;
      if (status == TestJoin::kJoined) {
        commitJoin();
      } else {
        wipeSecrets();
        go(Screen::kJoinFailed);
      }
      g->lastInputMs = nowMs;
      settingsDraw(nowMs);
      return SettingsExit::kStay;
    }
    case Screen::kName:
    case Screen::kPassword: {
      // Del held: erase again after 400 ms, then every 60 ms.
      if (anyHeld && held.del && g->delHeldSinceMs != 0 &&
          fieldRepeatDue(nowMs, g->delHeldSinceMs, g->lastRepeatMs)) {
        g->lastRepeatMs = nowMs;
        const FieldKeys fk{nullptr, 0, false, true, false, false};
        if (fieldApply(g->field, fk, nowMs) == FieldAction::kChanged) settingsDraw(nowMs);
      }
      // The masked character's reveal ended: draw it as '*'.
      if (g->field.revealUntilMs != 0 && static_cast<int32_t>(nowMs - g->field.revealUntilMs) >= 0) {
        g->field.revealUntilMs = 0;
        settingsDraw(nowMs);
      }
      break;
    }
    default:
      break;
  }
  if (settingsIdleClose(nowMs, g->lastInputMs, g->setup)) return SettingsExit::kClose;
  return SettingsExit::kStay;
}

}  // namespace bob
