// Bob Cardputer v2 — pairing (contract F3).
#include "state_internal.h"

namespace bob {

namespace fsm {

// Pairing state (contract §F3).
PairingInfo g_pairing;
char g_pairedName[kDeviceNameBytes] = {};   // transient PAIRED AS confirmation.
uint32_t g_pairingRetryAtMs = 0;            // PAIRING_RATE_LIMITED backoff deadline.
constexpr uint32_t kPairingRateLimitBackoffMs = 30000;

static void sendPairRequest();

void enterPairing() {
  if (g_pairing.claim[0] == '\0') {
    generateClaim(g_pairing.claim, sizeof(g_pairing.claim));
  }
  g_pairing.active = false;
  g_pairing.denied = false;
  g_pairing.userCode[0] = '\0';
  transitionTo(State::kPairing, "PAIRING", "Requesting code...", kColorYellow,
               "Approve on the web to pair");
  sendPairRequest();
  journalEvent("pairing_started");
}

static void sendPairRequest() {
  network.sendControl(buildPairRequest(g_pairing.claim, g_pairing.resumePairingId));
  journalEvent("pair_request_sent");
}

void handlePairingRequired(const String& text) {
  char reason[16];
  if (!extractPairingRequiredReason(text, reason, sizeof(reason))) return;
  // Erase the NVS token ONLY on unknown|revoked (contract obligations 2 and
  // 12): never on close code 4003, a 401 upgrade rejection, or reboot.
  if (strcmp(reason, "unknown") == 0 || strcmp(reason, "revoked") == 0) {
    // Only the active profile's token: a dev server that does not know the
    // production token must not erase it (#675).
    eraseDeviceToken();
    journalEvent("device_token_erased",
                 String("reason=") + reason + " profile=" + profileName(activeProfile()));
  }
  journalEvent("pairing_required",
               String("reason=") + reason);
  // Settings stays up; leaving it asks for the code (#679).
  if (state == State::kSettings) {
    g_settingsFrom = State::kPairing;
    g_pairing.active = false;
    g_pairing.denied = false;
    return;
  }
  enterPairing();
}

void handlePairCode(const String& text) {
  if (!parsePairCode(text, g_pairing)) return;
  strncpy(g_pairing.resumePairingId, g_pairing.pairingId, kPairingIdBytes - 1);
  g_pairing.resumePairingId[kPairingIdBytes - 1] = '\0';
  g_pairing.active = true;
  g_pairing.denied = false;
  g_pairingRetryAtMs = 0;
  // Settings stays up; leaving it shows this code (#679).
  if (state != State::kSettings) {
    transitionTo(State::kPairing, "PAIRING", "Pairing...", kColorYellow, "");
  }
  journalEvent("pair_code_received");
}

void handlePaired(const String& text) {
  char token[kDeviceTokenBytes];
  char name[kDeviceNameBytes];
  if (!parsePaired(text, token, sizeof(token), name, sizeof(name))) return;
  if (!saveDeviceToken(token)) {
    journalEvent("device_token_save_failed");
    return;
  }
  journalEvent("device_token_saved");
  g_allSetPending = true;
  strncpy(g_pairedName, name, kDeviceNameBytes - 1);
  g_pairedName[kDeviceNameBytes - 1] = '\0';
  g_pairing = PairingInfo();
  g_pendingActiveValid = false;
  g_pendingSpaceValid = false;
  g_pairingRetryAtMs = 0;
  // Close the socket and reconnect immediately with the new NVS token
  // (contract obligation 5 — no reboot needed, FR-013).
  network.resetReconnectDelay();
  network.start();
  if (state == State::kSettings) {
    g_settingsFrom = State::kSocket;  // Settings stays up (#679).
    return;
  }
  transitionTo(State::kSocket, "PAIRED", "Reconnecting...", kColorGreen, "");
}

void onPairExpired() {
  g_pairing.active = false;
  g_pairing.userCode[0] = '\0';
  g_pairing.resumePairingId[0] = '\0';
  journalEvent("pair_expired");
  if (state != State::kPairing) return;
  if (g_pairingRetryAtMs == 0) {
    transitionTo(State::kPairing, "PAIRING", "Requesting code...", kColorYellow,
                 "Approve on the web to pair");
    sendPairRequest();
  } else {
    transitionTo(State::kPairing, "PAIRING", "Rate limited - retrying...",
                 kColorYellow, "");
  }
}

void onPairDenied() {
  g_pairing.active = false;
  g_pairing.denied = true;
  g_pairing.resumePairingId[0] = '\0';
  g_pairingRetryAtMs = 0;
  if (state == State::kSettings) {
    // Settings stays up; leaving it shows the denial (#679).
  } else {
    if (state != State::kPairing) {
      transitionTo(State::kPairing, "PAIRING", "Denied", kColorRed,
                   "Press a key to retry");
    }
    drawPairingDenied();
  }
  journalEvent("pair_denied");
}

void onPairingRateLimited() {
  journalEvent("pairing_rate_limited");
  g_pairingRetryAtMs = millis() + kPairingRateLimitBackoffMs;
}

// Back to the pairing screen as it stood: a live code or a denial shows again
// (no second pair_request), a rate-limit backoff keeps waiting, anything else
// asks for a fresh code.
void resumePairing() {
  if (g_pairing.denied) {
    transitionTo(State::kPairing, "PAIRING", "Denied", kColorRed, "Press a key to retry");
    drawPairingDenied();
  } else if (g_pairing.active || g_pairingRetryAtMs != 0) {
    transitionTo(State::kPairing, "PAIRING",
                 g_pairing.active ? "Pairing..." : "Rate limited - retrying...",
                 kColorYellow, "");
  } else {
    enterPairing();
  }
}

// pair_denied waits for a key press before a fresh pair_request — the
// device must not loop automatically (contract obligation 7, S-9).
void pairingKeys(const Keyboard_Class::KeysState& keys) {
  if (g_pairing.denied &&
      (!keys.word.empty() || keys.enter || keys.del || keys.space || keys.tab)) {
    g_pairing.denied = false;
    journalEvent("pair_request_after_deny");
    sendPairRequest();
  }
}

// Pairing housekeeping: refresh the countdown once a second, resend a fresh
// pair_request when the local deadline passes (defensive — the server also
// pushes pair_expired), and honour the PAIRING_RATE_LIMITED backoff.
void pairingTick(uint32_t loopStart) {
  if (state != State::kPairing) return;
  if (g_pairing.active) {
    updatePairingCountdown(loopStart);
    if (g_pairing.expiresAtMs != 0 && millis() >= g_pairing.expiresAtMs) {
      journalEvent("pair_code_expired_local");
      onPairExpired();
    }
  } else if (g_pairingRetryAtMs != 0 && !g_pairing.denied &&
             millis() >= g_pairingRetryAtMs) {
    g_pairingRetryAtMs = 0;
    sendPairRequest();
  }
}

}  // namespace fsm

}  // namespace bob
