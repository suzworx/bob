// Bob Cardputer v2 — Cardputer board implementation (see board.h).
#if !defined(BOB_BOARD_WAVESHARE_185C)

#include "board.h"
#include "types.h"

#include "types.h"

namespace bob {
namespace board {

void begin() {
  auto config = M5.config();
  M5Cardputer.begin(config);
  M5Cardputer.Display.setRotation(1);
}

void update() { M5Cardputer.update(); }

bool keysChanged() { return M5Cardputer.Keyboard.isChange(); }

const Keyboard_Class::KeysState& keys() { return M5Cardputer.Keyboard.keysState(); }

bool anyKeyPressed() { return M5Cardputer.Keyboard.isPressed() > 0; }

const char* id() { return "cardputer"; }

const char* model() { return kDeviceModel; }

// Both Cardputer boards read the cell through an ADC divider; M5Unified returns -1
// when it cannot, and charging is usually charge_unknown.
int batteryPct() {
  const int32_t level = M5.Power.getBatteryLevel();
  return (level >= 0 && level <= 100) ? static_cast<int>(level) : -1;
}

int charging() {
  const auto state = M5.Power.isCharging();
  return state == m5::Power_Class::is_charging      ? 1
         : state == m5::Power_Class::is_discharging ? 0
                                                    : -1;
}

}  // namespace board
}  // namespace bob

#endif  // !defined(BOB_BOARD_WAVESHARE_185C)
