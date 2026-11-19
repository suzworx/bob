// The volume, mute and mode key rules and device_control's hold-until-READY
// (#314, #330, include/volume_policy.h).
#include <cstdint>

#include "doctest.h"
#include "volume_policy.h"

using bob::DeviceControl;
using bob::DeviceMode;
using bob::State;

TEST_CASE("volume: one step per key, clamped to 0..kVolumeMax") {
  CHECK(bob::volumeStep(5, 1) == 6);
  CHECK(bob::volumeStep(5, -1) == 4);
  CHECK(bob::volumeStep(0, -1) == 0);
  CHECK(bob::volumeStep(bob::kVolumeMax, 1) == bob::kVolumeMax);
  CHECK(bob::volumeStep(bob::kVolumeMax - 1, 1) == bob::kVolumeMax);
  CHECK(bob::volumeStep(1, -1) == 0);
}

TEST_CASE("mode: [k] cycles push-to-talk, Always awake, Announcements only") {
  CHECK(bob::nextDeviceMode(DeviceMode::kPtt) == DeviceMode::kWake);
  CHECK(bob::nextDeviceMode(DeviceMode::kWake) == DeviceMode::kAnnounceOnly);
  CHECK(bob::nextDeviceMode(DeviceMode::kAnnounceOnly) == DeviceMode::kPtt);
}

TEST_CASE("device_control: mode and DND wait during a turn or an announcement") {
  CHECK(bob::modeAndDndWait(State::kCapturing));
  CHECK(bob::modeAndDndWait(State::kAwaiting));
  CHECK(bob::modeAndDndWait(State::kAnnounce));
  CHECK_FALSE(bob::modeAndDndWait(State::kReady));
  CHECK_FALSE(bob::modeAndDndWait(State::kHelp));
  CHECK_FALSE(bob::modeAndDndWait(State::kSelecting));
  CHECK_FALSE(bob::modeAndDndWait(State::kSettings));
}

TEST_CASE("device_control: held mode and DND merge, newest value per field") {
  DeviceControl held;
  DeviceControl mode;
  mode.hasMode = true;
  mode.mode = DeviceMode::kWake;
  bob::holdModeAndDnd(held, mode);
  CHECK(held.hasMode);
  CHECK_FALSE(held.hasDnd);
  CHECK(held.mode == DeviceMode::kWake);

  DeviceControl dnd;
  dnd.hasDnd = true;
  dnd.dnd = true;
  bob::holdModeAndDnd(held, dnd);
  CHECK(held.hasMode);  // a control without a mode keeps the held one.
  CHECK(held.mode == DeviceMode::kWake);
  CHECK(held.hasDnd);
  CHECK(held.dnd);

  DeviceControl later;
  later.hasMode = true;
  later.mode = DeviceMode::kPtt;
  later.hasVolume = true;  // volume applies at once, never held.
  later.volume = 3;
  bob::holdModeAndDnd(held, later);
  CHECK(held.mode == DeviceMode::kPtt);
  CHECK(held.dnd);
  CHECK_FALSE(held.hasVolume);
}
