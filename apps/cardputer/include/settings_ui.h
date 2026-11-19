// Bob Cardputer v2 — on-device Settings (#677): Wi-Fi networks (add by scan
// or by name, change password, reorder, forget, connect now) and About.
// Every screen lives in one heap-allocated session that exists only while
// Settings is open (static RAM is nearly full). A network is saved only after
// the device joined it (verify-then-commit); a failed join keeps nothing.
// While Settings is open the Wi-Fi manager is paused and voice is off.
#pragma once

#include <M5Cardputer.h>
#include <cstdint>

#include "reset_actions.h"

namespace bob {

enum class SettingsExit : uint8_t { kStay, kClose };

// Where Settings opens: its home ([,] on Ready), the Wi-Fi list (the Fn+Esc
// boot rescue), or the guided first-boot Setup (#678: Welcome, then pick a
// network, type its password, join; it closes itself once a network is saved
// and never times out).
enum class SettingsEntry : uint8_t { kHome, kWifiList, kSetup };

// Allocates the session and shows the entry screen. False when the heap has
// no room (the caller stays where it was).
bool settingsOpen(uint32_t nowMs, const char* deviceName, bool socketUp,
                  SettingsEntry entry = SettingsEntry::kHome);

// What happened in Settings, for the caller to act on when it closes.
struct SettingsOutcome {
  bool replan;         // the link or the saved networks changed: re-plan Wi-Fi
  bool serverChanged;  // another server profile, or its token was cleared (#679, #680)
  bool wakeWordChanged;  // retry the selected local model after leaving Settings
  bool reset;          // a reset ran (or, for kFactory, was confirmed) (#680)
  ResetScope scope;
};

// Frees the session and says what the caller must do.
SettingsOutcome settingsClose();

bool settingsIsOpen();

// True when an announcement that `ring`s may close Settings now (see
// settingsYieldsToAnnouncement): not in Setup, no scan or join test running.
bool settingsYieldsTo(bool ring);

// Journal detail for settings_closed: "wifi" or "none".
const char* settingsChangedName();

void settingsDraw(uint32_t nowMs);
const char* settingsStrip();

// A keyboard change while Settings is open.
SettingsExit settingsKeys(const Keyboard_Class::KeysState& keys, uint32_t nowMs);

// Every loop: scans and join tests in flight, Del auto-repeat, the masked
// character reveal, and the 2-minute idle close.
SettingsExit settingsTick(uint32_t nowMs, const Keyboard_Class::KeysState& held, bool anyHeld);

}  // namespace bob
