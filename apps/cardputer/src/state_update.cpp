// Bob Cardputer v2 — firmware updates (epic #343, OTA-5B): the offer, the idle
// check, the countdown, the install, and the health gate that confirms a new
// image. The rules live in include/ota_policy.h; this file feeds them the
// device's facts and acts on the verdict. Postponements and failed attempts are
// held in RAM, so a reboot starts them over (the device has no wall clock).
#include "board.h"
#include "state_internal.h"

#include <esp_ota_ops.h>

#include "ota_client.h"
#include "ota_build.h"
#include "ota_policy.h"
#include "ota_record.h"
#include "ota_ui.h"

// Arduino-ESP32 confirms a new image at boot unless this says otherwise; the
// health gate below confirms it only after a welcome and a quiet minute.
extern "C" bool verifyRollbackLater() { return true; }

namespace bob {
namespace fsm {

namespace {

constexpr uint32_t kCheckEveryMs = 3600000;  // the server answers at most once a minute.

enum class Phase : uint8_t { kNone, kCountdown, kInstalling };

ManualOta g_manual;
const char* g_manualMessage = "Check for updates";
uint32_t g_manualLastCheck = 0;
bool g_manualChecked = false;
OtaOffer g_offer;
bool g_offerValid = false;
uint32_t g_offerSeenAt = 0;
uint32_t g_postponedUntil = 0;  // millis(); 0 = not postponed.
uint32_t g_nextAttemptAt = 0;
uint32_t g_lastActivityAt = 0;
uint32_t g_lastCheckAt = 0;
uint32_t g_countdownStartedAt = 0;
uint8_t g_postpones = 0;
uint8_t g_failedAttempts = 0;
Phase g_phase = Phase::kNone;
bool g_gatePending = false;
bool g_welcomeSeen = false;
OtaLast g_last;

uint32_t secondsSince(uint32_t thenMs, uint32_t nowMs) { return (nowMs - thenMs) / 1000; }

int runningSlot() {
  const esp_partition_t* running = esp_ota_get_running_partition();
  if (running == nullptr) return -1;
  const int slot = static_cast<int>(running->subtype) - static_cast<int>(ESP_PARTITION_SUBTYPE_APP_OTA_0);
  return slot == 0 || slot == 1 ? slot : -1;
}

void setOffer(const OtaOffer& offer, uint32_t nowMs) {
  if (!kAcceptStandardOta) return;
  if (!g_offerValid || strcmp(g_offer.version, offer.version) != 0) {
    g_offerSeenAt = nowMs;
    g_failedAttempts = 0;
    g_nextAttemptAt = 0;
    journalEvent("ota_offer", String("to=") + offer.version + ",mandatory=" + offer.mandatory);
  }
  g_offer = offer;
  g_offerValid = true;
}

uint32_t secondsToNextTimer(uint32_t nowMs) {
  if (g_timers.timers.count == 0) return kOtaNoTimer;
  return timerRemainingMs(g_timers.timers.entries[0], g_timers.receivedAtMs, nowMs) / 1000;
}

OtaContext contextAt(uint32_t nowMs) {
  OtaContext c;
  c.runningVersion = kFirmwareVersion;
  c.offer = g_offer;
  c.idleS = secondsSince(g_lastActivityAt, nowMs);
  c.batteryPct = batteryPct() < 0 ? 100 : static_cast<uint8_t>(batteryPct());
  c.charging = batteryCharging() == 1;
  c.secToNextTimer = secondsToNextTimer(nowMs);
  c.wifiUp = network.wifiStatus() == WL_CONNECTED && welcomed;
  c.sinceOfferSeenS = secondsSince(g_offerSeenAt, nowMs);
  c.inTurn = state == State::kCapturing || state == State::kAwaiting || playback.active() || capture.active() ||
             g_followUp.isOpen();
  c.inPairing = state == State::kPairing;
  c.inSettings = state == State::kSettings;
  c.inSetup = !configured() || g_allSetPending;
  if (g_postponedUntil != 0 && static_cast<int32_t>(g_postponedUntil - nowMs) > 0) {
    c.postponedForS = (g_postponedUntil - nowMs) / 1000 + 1;
  }
  c.failedAttempts24h = g_failedAttempts;
  return c;
}

bool anyInput() { return board::anyKeyPressed() || M5Cardputer.BtnA.isPressed(); }

void showCountdown(uint8_t secondsLeft, bool canPostpone) {
  char title[40];
  char detail[40];
  snprintf(title, sizeof(title), "UPDATE %s", g_offer.version);
  snprintf(detail, sizeof(detail), "Installing in %us", secondsLeft);
  transitionTo(State::kUpdating, title, detail, kColorYellow, canPostpone ? "ANY KEY: later" : "Please wait");
}

void onProgress(uint32_t done, uint32_t total) {
  char detail[40];
  snprintf(detail, sizeof(detail), "Downloading %u%%", static_cast<unsigned>(total == 0 ? 0 : (uint64_t)done * 100 / total));
  transitionTo(State::kUpdating, "UPDATING", detail, kColorYellow, "Do not power off");
}

void install(uint32_t nowMs) {
  g_phase = Phase::kInstalling;
  journalEvent("ota_start", String("to=") + g_offer.version + ",slot=" + runningSlot());
  network.sendControl(buildOtaProgress("start", g_offer.version, nullptr));
  transitionTo(State::kUpdating, "UPDATING", "Downloading 0%", kColorYellow, "Do not power off");
  OtaHooks hooks;
  hooks.progress = onProgress;
  const OtaResult result = otaRun(g_offer, board::id(), kFirmwareVersion, hooks);
  g_phase = Phase::kNone;
  if (g_manual.phase == ManualOtaPhase::kConfirmed) { g_manual.disconnected(); g_offerValid = false; }
  if (result == OtaResult::kOk) {
    otaWritePending(deviceStore(), kFirmwareVersion, g_offer.version);
    journalEvent("ota_reboot", String("to=") + g_offer.version);
    transitionTo(State::kUpdating, "UPDATED", "Restarting...", kColorGreen, "");
    delay(500);
    ESP.restart();
    return;
  }
  const char* reason = otaReasonCode(result);
  otaWriteFailed(deviceStore(), g_offer.version, reason);
  otaReadLast(deviceStore(), &g_last);
  if (g_failedAttempts < 255) ++g_failedAttempts;
  g_nextAttemptAt = nowMs + otaRetryDelayMs(g_failedAttempts);
  journalEvent("ota_failed", String("to=") + g_offer.version + ",reason=" + reason + ",attempt=" + g_failedAttempts);
  network.sendControl(buildOtaProgress("failed", g_offer.version, reason));
  enterReady();
}

void runCountdown(uint32_t nowMs) {
  if (g_manual.phase == ManualOtaPhase::kConfirmed) {
    OtaContext context = contextAt(nowMs);
    context.idleS = kOtaIdleMinS;
    if (otaShouldStart(context).verdict != OtaVerdict::Start) {
      updateCancelManual(); enterReady(); return;
    }
  }
  OtaCountdown c;
  c.elapsedMs = nowMs - g_countdownStartedAt;
  c.keyPressed = anyInput();
  c.postponesUsed = g_manual.phase == ManualOtaPhase::kConfirmed ? 0 : g_postpones;
  c.mandatory = g_manual.phase == ManualOtaPhase::kConfirmed ? false : g_offer.mandatory;
  c.sinceOfferSeenS = secondsSince(g_offerSeenAt, nowMs);
  const OtaCountdownStep step = otaCountdownStep(c);
  static uint8_t shown = 0;
  if (step.action == OtaCountdownAction::Postpone) {
    if (g_manual.phase == ManualOtaPhase::kConfirmed) updateCancelManual();
    ++g_postpones;
    g_postponedUntil = nowMs + kOtaPostponeS * 1000UL;
    g_lastActivityAt = nowMs;
    g_phase = Phase::kNone;
    shown = 0;
    journalEvent("ota_postponed", String("n=") + g_postpones);
    enterReady();
  } else if (step.action == OtaCountdownAction::Start) {
    shown = 0;
    install(nowMs);
  } else if (step.secondsLeft != shown) {
    shown = step.secondsLeft;
    showCountdown(step.secondsLeft, g_postpones < kOtaMaxPostpones);
  }
}

void runGate(uint32_t nowMs) {
  OtaHealth h;
  h.bootOk = true;
  h.wifiUp = network.wifiStatus() == WL_CONNECTED;
  h.welcomeSeen = g_welcomeSeen;
  h.msSinceBoot = nowMs;
  h.networklessHealthyBoots = configured() ? 0 : kOtaNetlessBoots;
  if (otaHealthDecision(h) != OtaHealthAction::MarkValid) return;
  g_gatePending = false;
  const bool ok = esp_ota_mark_app_valid_cancel_rollback() == ESP_OK;
  journalEvent(ok ? "ota_valid" : "ota_valid_failed", String("fw=") + kFirmwareVersion);
  if (ok) {
    otaSettleBoot(deviceStore(), kFirmwareVersion);
    otaReadLast(deviceStore(), &g_last);
  }
}

void maybeBegin(uint32_t nowMs) {
  const bool manual = g_manual.phase == ManualOtaPhase::kConfirmed;
  if (manual && anyInput()) return;  // wait for the confirming Enter to be released.
  if (manual && state == State::kReady) { g_offer = g_manual.offer; g_offerValid = true; }
  if (!g_offerValid || state != State::kReady || g_phase != Phase::kNone) return;
  OtaContext context = contextAt(nowMs);
  if (manual) context.idleS = kOtaIdleMinS;  // explicit consent replaces only the idle wait.
  const OtaDecision decision = otaShouldStart(context);
  if (decision.verdict == OtaVerdict::Refuse) {
    g_offerValid = false;
    journalEvent("ota_refused", String("reason=") + static_cast<int>(decision.reason));
    return;
  }
  if (decision.verdict != OtaVerdict::Start || static_cast<int32_t>(nowMs - g_nextAttemptAt) < 0) {
    if (manual) updateCancelManual();  // changed safety conditions need fresh consent.
    return;
  }
  g_phase = Phase::kCountdown;
  g_countdownStartedAt = nowMs;
  runCountdown(nowMs);  // enters kUpdating now; updateTick cancels a countdown it finds outside that state.
}

void maybeCheck(uint32_t nowMs) {
  if (!kAcceptStandardOta || !welcomed || state != State::kReady ||
      nowMs - g_lastCheckAt < kCheckEveryMs) return;
  g_lastCheckAt = nowMs;
  network.sendControl(buildCheckUpdate());
}

}  // namespace

void updateBoot() {
  if (!kAcceptStandardOta) journalEvent("ota_private", "reason=private_model");
  const esp_partition_t* running = esp_ota_get_running_partition();
  esp_ota_img_states_t imageState;
  g_gatePending = running != nullptr && esp_ota_get_state_partition(running, &imageState) == ESP_OK &&
                  imageState == ESP_OTA_IMG_PENDING_VERIFY;
  otaSettleBoot(deviceStore(), kFirmwareVersion, g_gatePending);
  otaReadLast(deviceStore(), &g_last);
  journalEvent("ota_boot",
               String("slot=") + runningSlot() + ",gate=" + g_gatePending + ",last=" + g_last.result);
#ifdef BOB_OTA_TEST_CRASH
  // HIL only (scripts/hil/ota-bundle.mjs): an image that dies before the health gate, to prove the rollback.
  if (g_gatePending) {
    Serial.flush();
    abort();
  }
#endif
}

HelloOta updateHelloFields() {
  HelloOta ota;
  ota.board = board::id();
  ota.slot = runningSlot();
  if (g_last.result[0] != '\0') {
    ota.lastResult = g_last.result;
    ota.lastTo = g_last.to;
    ota.lastReason = g_last.reason[0] != '\0' ? g_last.reason : nullptr;
  }
  return ota;
}

void updateOnWelcome(const String& text) {
  updateCancelManual();
  g_manual.disconnected();
  g_welcomeSeen = true;
  if (g_last.result[0] != '\0') {
    otaClearLast(deviceStore());
    g_last = OtaLast();
  }
  OtaOffer offer;
  if (parseWelcomeUpdateOffer(text, offer)) setOffer(offer, millis());
}

void handleUpdateOffer(const String& text) {
  OtaOffer offer;
  const bool present = parseUpdateOffer(text, offer);
  if (g_manual.receive(present ? &offer : nullptr, kFirmwareVersion)) return;
  if (present) {
    setOffer(offer, millis());
  } else {
    g_offerValid = false;
  }
}

void updateTick(uint32_t nowMs) {
  if (!welcomed) { updateCancelManual(); g_manual.disconnected(); }
  g_manual.tick(nowMs);
  if (g_manual.phase == ManualOtaPhase::kConfirmed && state != State::kReady && state != State::kUpdating) updateCancelManual();
  if (anyInput() || (state != State::kReady && state != State::kUpdating) || playback.active() ||
      capture.active()) {
    g_lastActivityAt = nowMs;
  }
  if (g_gatePending) runGate(nowMs);
  if (g_phase == Phase::kCountdown && state != State::kUpdating) g_phase = Phase::kNone;
  if (g_phase == Phase::kCountdown) {
    runCountdown(nowMs);
    return;
  }
  maybeBegin(nowMs);
  maybeCheck(nowMs);
}

const char* manualBlocker(const OtaContext& context) {
  const OtaDecision decision = otaShouldStart(context);
  switch (decision.reason) {
    case OtaReason::Ok: return nullptr;
    case OtaReason::LowBattery: return "Charge to 40% first";
    case OtaReason::TimerSoon: return "A timer is due soon";
    case OtaReason::NoWifi: return "Connect and pair first";
    case OtaReason::TooEarly: return "Update not ready yet";
    case OtaReason::PostponedByUser: return "Update postponed";
    default: return "Cannot install right now";
  }
}

OtaContext manualContext() {
  OtaContext context = contextAt(millis());
  context.offer = g_manual.offer;
  context.sinceOfferSeenS = (millis() - g_manual.startedAt) / 1000;
  context.idleS = kOtaIdleMinS;
  context.inSettings = false;  // confirm closes Settings before maybeBegin.
  return context;
}

UpdateView updateView() {
  const char* message = g_manualMessage;
  switch (g_manual.phase) {
    case ManualOtaPhase::kChecking: message = "Checking..."; break;
    case ManualOtaPhase::kNoOffer: message = "No update offered"; break;
    case ManualOtaPhase::kFailed: message = "Could not check"; break;
    case ManualOtaPhase::kOffered: {
      const char* blocker = manualBlocker(manualContext());
      message = blocker ? blocker : "Enter to review install";
      break;
    }
    default: break;
  }
  return {g_manual.phase, g_manual.offer.version, message, welcomed, !kAcceptStandardOta};
}

void updateCheckNow() {
  if (!welcomed || !hasDeviceToken()) { g_manualMessage = "Connect and pair first"; return; }
  const uint32_t now = millis();
  if (g_manualChecked && now - g_manualLastCheck < 60000) { g_manual.cancel(); g_manualMessage = "Try again shortly"; return; }
  g_manualChecked = true; g_manualLastCheck = now;
  g_manual.begin(now);
  network.sendControl(buildCheckUpdate());
}

bool updateConfirmNow(const char* version) {
  if (!welcomed || !hasDeviceToken() || manualBlocker(manualContext()) != nullptr) return false;
  if (!g_manual.confirm(version)) return false;
  g_offerSeenAt = g_manual.startedAt;
  return true;
}

void updateCancelManual() {
  if (g_manual.phase == ManualOtaPhase::kConfirmed) { g_offerValid = false; g_phase = Phase::kNone; }
  g_manual.cancel();
  g_manualMessage = "Check for updates";
}

void updateSettingsClosed() {
  if (g_manual.phase != ManualOtaPhase::kConfirmed) updateCancelManual();
}

bool updateBusy() { return g_phase != Phase::kNone || g_manual.phase == ManualOtaPhase::kConfirmed; }

}  // namespace fsm
}  // namespace bob
