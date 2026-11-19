// Bob Cardputer v2 — persisted device settings, battery level, and the
// debounced device_state report (#314 volume, #330 modes, #326 battery).
#pragma once

#include <WString.h>
#include <cstdint>
#include "types.h"

namespace bob {

// The NVS namespace of these settings (factory reset clears it, #680).
constexpr char kSettingsNamespace[] = "bob_cfg";

// Loads settings from NVS (their own namespace, never the token's); missing
// or out-of-range values fall back to the defaults. Applies the speaker gain.
void settingsLoad();

const DeviceSettings& settings();

// Each setter clamps, applies the speaker gain live (even mid-playback), and
// marks the settings dirty for the debounced device_state and NVS write.
// Returns true when the value actually changed.
bool settingsSetVolume(uint8_t level);
bool settingsSetMuted(bool muted);
bool settingsSetMode(DeviceMode mode);
bool settingsSetDnd(bool dnd);
// Device-local: debounced to NVS like the others, but no device_state report.
bool settingsSetWakeWord(WakeWord word);
// #389: how long a timer/alarm rings (10..120 s; out of range is ignored) and
// its sound. They apply to the next ring; one already ringing keeps its own.
bool settingsSetRingSeconds(uint8_t seconds);
bool settingsSetRingSound(RingSound sound);

// Speaker master gain (0..255) for the current level; 0 while muted.
uint8_t speakerGain();
void applySpeakerGain();

// Setting bits for settingsPersistIfDue() / settingsFieldNames().
constexpr uint8_t kSettingVolume = 1 << 0;
constexpr uint8_t kSettingMuted = 1 << 1;
constexpr uint8_t kSettingMode = 1 << 2;
constexpr uint8_t kSettingDnd = 1 << 3;
constexpr uint8_t kSettingWakeWord = 1 << 4;
constexpr uint8_t kSettingRingSeconds = 1 << 5;
constexpr uint8_t kSettingRingSound = 1 << 6;

// Writes the changed settings to NVS once they have been quiet for 2 s, and
// at most once every 2 s. Returns the kSetting* bits written (0 = nothing
// written). Call outside capture and playback: an NVS write stalls the flash
// cache for a few ms.
uint8_t settingsPersistIfDue(uint32_t nowMs);

// "volume+mode" (or "ring_seconds+ring_sound") for settings_saved.
String settingsFieldNames(uint8_t fields);

// Polls battery level/charging at most every 30 s. Returns true when the
// values moved enough (5 points, or charging flipped) to report.
bool batteryPoll(uint32_t nowMs);
int batteryPct();       // 0..100, or -1 when unknown.
int batteryCharging();  // 1 / 0, or -1 when unknown.

// device_state pacing: a local change restarts a 500 ms window and
// deviceStateDue() returns true once when it elapses. deviceStateSent()
// cancels a pending report after an immediate send.
void markDeviceStateDirty(uint32_t nowMs);
bool deviceStateDue(uint32_t nowMs);
void deviceStateSent();

}  // namespace bob
