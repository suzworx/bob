// Bob Cardputer v2 — persisted device settings, battery level, and the
// debounced device_state report.
#include "settings.h"

#include "board.h"

#include <M5Cardputer.h>
#include <Preferences.h>
#include <cstdlib>
#include "persist_policy.h"

namespace bob {

namespace {

// Separate from device_token.cpp's "bob" namespace, so a settings write can
// never touch the pairing token.
constexpr const char* kNamespace = kSettingsNamespace;
constexpr char kKeyVolume[] = "vol";
constexpr char kKeyMuted[] = "muted";
constexpr char kKeyMode[] = "mode";
constexpr char kKeyDnd[] = "dnd";
constexpr char kKeyWakeWord[] = "wake";
constexpr char kKeySettingsVersion[] = "sver";
// 1: the Waveshare board defaults to Hey Bob; a word stored by an older build is the old default and is replaced once.
constexpr uint8_t kSettingsVersion = 1;
constexpr char kKeyRingSeconds[] = "ring_s";
constexpr char kKeyRingSound[] = "ring_snd";

constexpr uint32_t kDeviceStateDebounceMs = 500;
// NVS commits: 2 s after the last change, and never more often than every
// 2 s, so holding - or = (or a burst of device_control) wears one flash
// write, not one per step.
constexpr uint32_t kPersistQuietMs = 2000;
constexpr uint32_t kPersistMinIntervalMs = 2000;
constexpr uint32_t kBatteryPollMs = 30000;
constexpr int kBatteryReportStep = 5;

DeviceSettings g_settings;
uint8_t g_dirtyFields = 0;  // SettingsField bits not yet in NVS.
uint32_t g_lastChangeAt = 0;
uint32_t g_lastCommitAt = 0;
bool g_committed = false;  // a commit has happened since boot.
bool g_statePending = false;
uint32_t g_stateDueAt = 0;

int g_batteryPct = -1;
int g_charging = -1;
int g_reportedPct = -1;
int g_reportedCharging = -2;  // forces the first poll to count as a change.
bool g_batteryPolled = false;
uint32_t g_lastBatteryPollAt = 0;

void markChanged(uint8_t field) {
  g_dirtyFields |= field;
  g_lastChangeAt = millis();
  markDeviceStateDirty(g_lastChangeAt);
}

}  // namespace

void settingsLoad() {
  Preferences prefs;
  if (prefs.begin(kNamespace, false)) {  // read-write creates it on first boot.
    const uint8_t volume = prefs.getUChar(kKeyVolume, kVolumeDefault);
    g_settings.volume = volume <= kVolumeMax ? volume : kVolumeDefault;
    g_settings.muted = prefs.getBool(kKeyMuted, false);
    const uint8_t mode = prefs.getUChar(kKeyMode, 0);
    g_settings.mode = mode <= static_cast<uint8_t>(DeviceMode::kAnnounceOnly)
                          ? static_cast<DeviceMode>(mode)
                          : DeviceMode::kPtt;
    g_settings.dnd = prefs.getBool(kKeyDnd, false);
    g_settings.wakeWord = wakeWordFromStored(
        prefs.getUChar(kKeyWakeWord, static_cast<uint8_t>(kWakeWordDefault)));
#if defined(BOB_BOARD_WAVESHARE_185C) && defined(BOB_DEFAULT_WAKE_BOB)
    // Flashing keeps NVS: a Waveshare that ran an older build still holds its default (Alexa). Once, set Hey Bob; after that the user's choice stands.
    if (prefs.getUChar(kKeySettingsVersion, 0) < kSettingsVersion) {
      g_settings.wakeWord = WakeWord::kBob;
      prefs.putUChar(kKeyWakeWord, static_cast<uint8_t>(WakeWord::kBob));
      prefs.putUChar(kKeySettingsVersion, kSettingsVersion);
    }
#endif
    const uint8_t ringSeconds = prefs.getUChar(kKeyRingSeconds, kRingSecondsDefault);
    g_settings.ringSeconds = ringSecondsValid(ringSeconds) ? ringSeconds : kRingSecondsDefault;
    const uint8_t ringSound = prefs.getUChar(kKeyRingSound, 0);
    g_settings.ringSound = ringSound <= static_cast<uint8_t>(RingSound::kPulse)
                               ? static_cast<RingSound>(ringSound)
                               : RingSound::kClassic;
    prefs.end();
  }
  applySpeakerGain();
}

const DeviceSettings& settings() { return g_settings; }

bool settingsSetVolume(uint8_t level) {
  if (level > kVolumeMax) level = kVolumeMax;
  if (level == g_settings.volume) return false;
  g_settings.volume = level;
  applySpeakerGain();
  markChanged(kSettingVolume);
  return true;
}

bool settingsSetMuted(bool muted) {
  if (muted == g_settings.muted) return false;
  g_settings.muted = muted;
  applySpeakerGain();
  markChanged(kSettingMuted);
  return true;
}

bool settingsSetMode(DeviceMode mode) {
  if (mode == g_settings.mode) return false;
  g_settings.mode = mode;
  markChanged(kSettingMode);
  return true;
}

bool settingsSetDnd(bool dnd) {
  if (dnd == g_settings.dnd) return false;
  g_settings.dnd = dnd;
  markChanged(kSettingDnd);
  return true;
}

bool settingsSetWakeWord(WakeWord word) {
  if (static_cast<uint8_t>(word) >= kWakeModelCount) return false;
  if (word == g_settings.wakeWord) return false;
  g_settings.wakeWord = word;
  // Not markChanged(): device_state does not carry the wake word.
  g_dirtyFields |= kSettingWakeWord;
  g_lastChangeAt = millis();
  return true;
}

bool settingsSetRingSeconds(uint8_t seconds) {
  if (!ringSecondsValid(seconds) || seconds == g_settings.ringSeconds) return false;
  g_settings.ringSeconds = seconds;
  markChanged(kSettingRingSeconds);
  return true;
}

bool settingsSetRingSound(RingSound sound) {
  if (sound == g_settings.ringSound) return false;
  g_settings.ringSound = sound;
  markChanged(kSettingRingSound);
  return true;
}

uint8_t speakerGain() { return g_settings.muted ? 0 : gainForLevel(g_settings.volume); }

// Speaker_Class::setVolume only stores the master gain, which the mixer task
// applies to every later sample, so this takes effect mid-reply.
void applySpeakerGain() { M5Cardputer.Speaker.setVolume(speakerGain()); }

uint8_t settingsPersistIfDue(uint32_t nowMs) {
  if (!persistDue(g_dirtyFields != 0, nowMs, g_lastChangeAt, g_committed, g_lastCommitAt,
                  kPersistQuietMs, kPersistMinIntervalMs)) {
    return 0;
  }
  // A failed open is retried after the same interval, not on every loop.
  g_committed = true;
  g_lastCommitAt = nowMs;
  Preferences prefs;
  if (!prefs.begin(kNamespace, false)) return 0;
  const uint8_t fields = g_dirtyFields;
  if (fields & kSettingVolume) prefs.putUChar(kKeyVolume, g_settings.volume);
  if (fields & kSettingMuted) prefs.putBool(kKeyMuted, g_settings.muted);
  if (fields & kSettingMode) prefs.putUChar(kKeyMode, static_cast<uint8_t>(g_settings.mode));
  if (fields & kSettingDnd) prefs.putBool(kKeyDnd, g_settings.dnd);
  if (fields & kSettingWakeWord) {
    prefs.putUChar(kKeyWakeWord, static_cast<uint8_t>(g_settings.wakeWord));
  }
  if (fields & kSettingRingSeconds) prefs.putUChar(kKeyRingSeconds, g_settings.ringSeconds);
  if (fields & kSettingRingSound) {
    prefs.putUChar(kKeyRingSound, static_cast<uint8_t>(g_settings.ringSound));
  }
  prefs.end();
  g_dirtyFields = 0;
  return fields;
}

String settingsFieldNames(uint8_t fields) {
  String names;
  const auto add = [&names](const char* name) {
    if (!names.isEmpty()) names += '+';
    names += name;
  };
  if (fields & kSettingVolume) add("volume");
  if (fields & kSettingMuted) add("muted");
  if (fields & kSettingMode) add("mode");
  if (fields & kSettingDnd) add("dnd");
  if (fields & kSettingWakeWord) add("wake_word");
  if (fields & kSettingRingSeconds) add("ring_seconds");
  if (fields & kSettingRingSound) add("ring_sound");
  return names;
}

bool batteryPoll(uint32_t nowMs) {
  if (g_batteryPolled && nowMs - g_lastBatteryPollAt < kBatteryPollMs) return false;
  g_batteryPolled = true;
  g_lastBatteryPollAt = nowMs;
  g_batteryPct = board::batteryPct();
  g_charging = board::charging();
  const bool knownFlipped = (g_batteryPct < 0) != (g_reportedPct < 0);
  const bool moved = std::abs(g_batteryPct - g_reportedPct) >= kBatteryReportStep;
  if (g_charging == g_reportedCharging && !knownFlipped && !moved) return false;
  g_reportedPct = g_batteryPct;
  g_reportedCharging = g_charging;
  return true;
}

int batteryPct() { return g_batteryPct; }

int batteryCharging() { return g_charging; }

void markDeviceStateDirty(uint32_t nowMs) {
  g_statePending = true;
  g_stateDueAt = nowMs + kDeviceStateDebounceMs;
}

bool deviceStateDue(uint32_t nowMs) {
  if (!g_statePending || static_cast<int32_t>(nowMs - g_stateDueAt) < 0) return false;
  g_statePending = false;
  return true;
}

void deviceStateSent() { g_statePending = false; }

}  // namespace bob
