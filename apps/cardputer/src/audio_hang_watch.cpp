// Watcher for audio-driver calls that never return (include/audio_hang.h). A blocked
// Speaker.end() or Mic.end() cannot be unblocked from another task, so the recovery is a journaled
// restart: the device comes back to READY in seconds instead of sitting on LISTENING forever.
#include "audio_hang.h"

#include <Arduino.h>
#include <esp_system.h>
#include <esp_timer.h>

namespace bob {
namespace {

constexpr uint64_t kWatchPeriodUs = 250000;

void onWatchTick(void*) {
  const AudioStage stage = audioHang().check(millis());
  if (stage == AudioStage::kNone) return;
  // Same shape as the journal lines; the serial tee and data/device.log keep it across the restart.
  Serial.printf("%lu INFO v2.audio_hang stage=%s recovery=restart\n", static_cast<unsigned long>(millis()),
                audioStageName(stage));
  Serial.flush();
  esp_restart();
}

}  // namespace

void startAudioHangWatch() {
#if defined(BOB_BOARD_WAVESHARE_185C)  // the shared I2S port is where the hang was measured
  static bool started = false;
  if (started) return;
  started = true;
  esp_timer_create_args_t args = {};
  args.callback = onWatchTick;
  args.name = "audio_hang";
  esp_timer_handle_t timer = nullptr;
  if (esp_timer_create(&args, &timer) == ESP_OK) esp_timer_start_periodic(timer, kWatchPeriodUs);
#endif
}

}  // namespace bob
