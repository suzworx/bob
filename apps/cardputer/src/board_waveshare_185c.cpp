// Bob — Waveshare ESP32-S3-Touch-LCD-1.85C board implementation (see board.h).
#if defined(BOB_BOARD_WAVESHARE_185C)

#include "board.h"

#include <Arduino.h>

#include "journal.h"
#include "round_touch.h"
#include "round_ui.h"
#include "ws185_hw.h"

namespace bob {
namespace board {
namespace {

// The native round UI (round_ui.cpp) draws on the whole 360x360 glass.
constexpr int16_t kViewW = 360, kViewH = 360;

constexpr int kBatteryPin = 8;                // ADC1, behind a x3 divider.
constexpr uint32_t kBatteryReadMs = 10000;    // throttle: analog reads are slow.
constexpr int kBatteryMinMv = 3300, kBatteryMaxMv = 4200;
constexpr int kBatterySamples = 8;

int g_batteryPct = -1;
uint32_t g_batteryAt = 0;
bool g_batteryRead = false;

const char* okFail(bool ok) { return ok ? "ok" : "fail"; }

}  // namespace

void begin() {
  auto config = M5.config();
  config.clear_display = false;
  config.internal_spk = false;  // the codecs are configured by ws185::beginAudio().
  config.internal_mic = false;
  config.output_power = false;
  M5.begin(config);

  const bool bus = ws185::beginBus();
  const bool display = ws185::attachDisplay(kViewW, kViewH);
  const bool audio = ws185::beginAudio();
  // M5Unified keeps the speaker's enable callback protected, so earcons.cpp switches the
  // amplifier (GPIO15) with the speaker driver: on at restartSpeaker(), off when it ends.
  ws185::ampEnable(false);
  char codec[96] = "";
  ws185::codecState(codec, sizeof(codec));  // the DAC's output path as it stands after init (P0 #1063)
  journal("board_boot", State::kBoot, "",
          String("board=") + id() + ",bus=" + okFail(bus) + ",display=" + okFail(display) +
              ",audio=" + okFail(audio) + ",view=" + kViewW + "x" + kViewH + "," + codec);
}

void update() {
  M5.update();
  // Touch is the round screen's own model (a tap is GO, round_touch.cpp) and otherwise the Cardputer
  // keyboard (keysChanged/keys/anyKeyPressed below). BOOT (GPIO0) is BtnA: hold to talk, stop, retry.
  roundtouch::poll(millis());
  M5.BtnA.setRawState(millis(), ws185::bootPressed());
}

bool keysChanged() { return roundtouch::keysChanged(); }

const Keyboard_Class::KeysState& keys() { return roundtouch::keys(); }

bool anyKeyPressed() { return roundtouch::anyKeyPressed(); }

const char* id() { return "waveshare-s3-185c"; }

const char* model() { return "Waveshare ESP32-S3 Round"; }

int batteryPct() {
  const uint32_t now = millis();
  if (g_batteryRead && now - g_batteryAt < kBatteryReadMs) return g_batteryPct;
  g_batteryRead = true;
  g_batteryAt = now;
  uint32_t sum = 0;
  for (int i = 0; i < kBatterySamples; i++) sum += analogReadMilliVolts(kBatteryPin);
  const int mv = static_cast<int>(sum / kBatterySamples) * 3;
  if (mv < 1500) {  // no cell on the divider (USB only): report unknown.
    g_batteryPct = -1;
  } else {
    const int pct = (mv - kBatteryMinMv) * 100 / (kBatteryMaxMv - kBatteryMinMv);
    g_batteryPct = pct < 0 ? 0 : pct > 100 ? 100 : pct;
  }
  return g_batteryPct;
}

int charging() { return -1; }

}  // namespace board
}  // namespace bob

#endif  // BOB_BOARD_WAVESHARE_185C
