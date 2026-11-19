// Bob Cardputer v2 — volume, mute, mode and device_control (#314, #330).
#include "state_internal.h"
#include "volume_policy.h"

namespace bob {

namespace fsm {

// device_control mode/dnd that arrive mid-turn are held until READY.
static DeviceControl g_heldControl;
static bool g_heldControlValid = false;

// Reports what actually applies: while Always awake has fallen back to
// push-to-talk the device says mode=ptt, but the stored setting stays wake so
// the next entry into the mode (or a reboot) tries the wake word again.
void sendDeviceState() {
  DeviceSettings applied = settings();
  if (wakeFallback()) applied.mode = DeviceMode::kPtt;
  network.sendControl(buildDeviceState(applied, batteryPct(), batteryCharging()));
  deviceStateSent();
  journalEvent("device_state_sent",
               String("volume=") + applied.volume + ",muted=" + (applied.muted ? 1 : 0) +
                   ",mode=" + deviceModeName(applied.mode) + ",wake_fallback=" + (wakeFallback() ? 1 : 0) +
                   ",dnd=" + (applied.dnd ? 1 : 0) + ",ring_s=" + applied.ringSeconds +
                   ",sound=" + ringSoundName(applied.ringSound) + ",battery=" + batteryPct() +
                   ",charging=" + batteryCharging());
}

// --- Volume, mute, mode (#314, #330) ---

void onVolumeKey(int delta) {
  const uint8_t next = volumeStep(settings().volume, delta);
  settingsSetMuted(false);  // changing the level always unmutes.
  settingsSetVolume(next);
  chromeVolumeBar(settings().volume, false, millis());
  if (!playback.active()) playEarcon(Earcon::kVolume);
  journalEvent("volume_changed",
               String("level=") + settings().volume + ",source=key");
}

void onMuteKey() {
  settingsSetMuted(!settings().muted);
  chromeVolumeBar(settings().volume, settings().muted, millis());
  if (!settings().muted && !playback.active()) playEarcon(Earcon::kVolume);
  journalEvent("mute_changed",
               String("muted=") + (settings().muted ? 1 : 0) + ",source=key");
}

static const char* modeToast(DeviceMode mode) {
  switch (mode) {
    case DeviceMode::kPtt: return boardText("Push to talk: hold GO", "Push to talk: tap to talk");
    case DeviceMode::kWake: {
      if (g_wakeFailed) return boardText("Wake word failed. Hold GO to talk", "Wake word off. Tap to talk");
      enterReady();  // redraw the selected assistant name immediately.
  static char toast[40];  // chrome.cpp kToastBytes.
      snprintf(toast, sizeof(toast), "Always awake. Say %s", wakePhrase());
      return toast;
    }
    case DeviceMode::kAnnounceOnly: return "Announcements only. Mic off";
  }
  return "";
}

static void applyMode(DeviceMode mode, const char* source) {
  const bool enteringWake = mode == DeviceMode::kWake && settings().mode != mode;
  settingsSetMode(mode);
  if (enteringWake) {
    g_wakeFailed = false;  // a fresh entry retries wakeWordBegin().
    if (wakeWanted()) startWakeListening();
  }
  chromeToast(modeToast(mode), millis());
  if (state == State::kReady) enterReady();  // the strip follows the mode.
  journalEvent("mode_changed",
               String("mode=") + deviceModeName(mode) + ",wake_fallback=" +
                   (wakeFallback() ? 1 : 0) + ",source=" + source);
}

void onModeKey() {
  applyMode(nextDeviceMode(settings().mode), "key");
}

// w in READY: the other wake word (wake_models.h), persisted in NVS and kept
// on the device (not in device_state). One arena holds one model, so a running
// model is freed here and wakeTick() starts the new one on the next loop.
void onWakeWordKey() {
  settingsSetWakeWord(nextWakeWord(settings().wakeWord));
  stopWakeListening();
  if (g_wakeFailed) {  // the other model gets a fresh try.
    g_wakeFailed = false;
    markDeviceStateDirty(millis());  // no longer the mode=ptt fallback.
    refreshStatusLine();
  }
  enterReady();  // redraw the selected assistant name immediately.
  static char toast[40];  // chrome.cpp kToastBytes.
  snprintf(toast, sizeof(toast), "Wake word: %s", wakePhrase());
  chromeToast(toast, millis());
  chromeSetShortcuts(readyStrip(), millis());
  journalEvent("wake_word_changed",
               String("word=") + wakeModelSpec(settings().wakeWord).name + ",source=key");
}

static void applyModeAndDnd(const DeviceControl& control) {
  if (control.hasMode) applyMode(control.mode, "server");
  if (control.hasDnd && settingsSetDnd(control.dnd)) {
    journalEvent("dnd_changed",
                 String("dnd=") + (control.dnd ? 1 : 0) + ",source=server");
  }
}

// Volume and mute apply at once, even mid-reply; mode and DND wait for READY
// when a turn or an announcement is on. Answers with a fresh device_state.
void handleDeviceControl(const String& text) {
  DeviceControl control;
  if (!parseDeviceControl(text, control)) {
    journalEvent("device_control_bad");
    return;
  }
  if (control.hasMuted) settingsSetMuted(control.muted);
  // Ring settings apply at once: they only shape the next ring.
  if (control.hasRingSeconds) settingsSetRingSeconds(control.ringSeconds);
  if (control.hasRingSound) settingsSetRingSound(control.ringSound);
  if (control.hasWakeWord) applyWakeWord(control.wakeWord, "server");  // a word this build lacks is ignored
  if (control.hasVolume) settingsSetVolume(control.volume);
  if (control.hasVolume || control.hasMuted) {
    chromeVolumeBar(settings().volume, settings().muted, millis());
  }
  if ((control.hasMode || control.hasDnd) && modeAndDndWait(state)) {
    holdModeAndDnd(g_heldControl, control);
    g_heldControlValid = true;
    journalEvent("device_control_held");
  } else {
    applyModeAndDnd(control);
  }
  journalEvent("device_control_applied",
               String("volume=") + (control.hasVolume ? String(control.volume) : String("-")) +
                   ",muted=" + (control.hasMuted ? String(control.muted ? 1 : 0) : String("-")) +
                   ",mode=" + (control.hasMode ? deviceModeName(control.mode) : "-") +
                   ",dnd=" + (control.hasDnd ? String(control.dnd ? 1 : 0) : String("-")) +
                   ",ring_s=" + (control.hasRingSeconds ? String(control.ringSeconds) : String("-")) +
                   ",sound=" + (control.hasRingSound ? ringSoundName(control.ringSound) : "-") +
                   ",wake_word=" + (control.hasWakeWord ? wakeWordWireName(control.wakeWord) : "-"));
  sendDeviceState();
}

// On READY: the mode and DND held back during a turn or an announcement.
void applyHeldControl() {
  if (!g_heldControlValid) return;
  g_heldControlValid = false;
  applyModeAndDnd(g_heldControl);
  g_heldControl = DeviceControl();
}

}  // namespace fsm

}  // namespace bob
