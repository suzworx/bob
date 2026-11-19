// Bob Cardputer v2 — the rules behind the volume, mute and mode keys and a
// device_control push (#314, #330): pure, header-only and host-tested
// (test/host/test_volume_policy.cpp). src/state_volume.cpp applies them.
#pragma once

#include <cstdint>
#include "types.h"

namespace bob {

// One press of [-] (delta < 0) or [=] (delta > 0): one level, within 0..kVolumeMax.
inline uint8_t volumeStep(uint8_t level, int delta) {
  if (delta < 0) return level > 0 ? level - 1 : 0;
  return level < kVolumeMax ? level + 1 : kVolumeMax;
}

// [k]: push-to-talk -> Always awake -> Announcements only -> push-to-talk.
inline DeviceMode nextDeviceMode(DeviceMode mode) {
  return mode == DeviceMode::kPtt    ? DeviceMode::kWake
         : mode == DeviceMode::kWake ? DeviceMode::kAnnounceOnly
                                     : DeviceMode::kPtt;
}

// A device_control's mode and DND wait for READY while a turn or an
// announcement is on screen; volume, mute and ring settings never wait.
inline bool modeAndDndWait(State state) {
  return state == State::kCapturing || state == State::kAwaiting || state == State::kAnnounce;
}

// Folds a waiting control's mode and DND into the ones already held: the
// newest value of each field wins, and a field it does not carry stays held.
inline void holdModeAndDnd(DeviceControl& held, const DeviceControl& control) {
  if (control.hasMode) held.mode = control.mode;
  if (control.hasDnd) held.dnd = control.dnd;
  held.hasMode = held.hasMode || control.hasMode;
  held.hasDnd = held.hasDnd || control.hasDnd;
}

}  // namespace bob
