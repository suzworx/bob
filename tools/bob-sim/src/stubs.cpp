// bob-sim stubs for what the firmware's state machine provides to the round UI: the current
// state and the journal, plus the simulator's bob::Board (libs/bob-device/src/bob_hal.h). Audio,
// network and board code is not linked at all.
#include <cstdio>
#include <cstdlib>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h" // the single implementation of the vendored PNG writer
#include "types.h"
#include "WString.h"

#include "bob_hal.h"
#include "round_ui.h" // M5Unified.h and Arduino.h (the fake clock) come with it
#include "settings.h"

namespace bob
{
// Factory defaults: the sim never loads NVS.
const DeviceSettings& settings()
{
  static const DeviceSettings s{};
  return s;
}

namespace fsm
{
State state = State::kBoot;

// Journal lines go to stderr only when BOBSIM_JOURNAL is set (they never carry audio or text).
void journalEvent(const char* event, const String& detail)
{
  if (std::getenv("BOBSIM_JOURNAL") != nullptr) { std::fprintf(stderr, "v2.%s %s\n", event, detail.c_str()); }
}
} // namespace fsm

// The ring's audio levels (audio_capture.cpp / audio_playback.cpp on the device): a quiet room in the simulator.
float captureLevel01() { return 0.0f; }
float playbackLevel01() { return 0.0f; }
} // namespace bob

namespace
{
bob::Framebuffer simFb()
{
  M5Canvas& c = bob::roundui::fb();
  return bob::Framebuffer{static_cast<uint8_t*>(c.getBuffer()), c.width(), c.height()};
}
void simDirty(bob::Rect r) { bob::roundui::dirty(r.x, r.y, r.w, r.h); }
uint32_t simNowMs() { return millis(); }
void* simAlloc(size_t bytes, bob::Mem) { return std::malloc(bytes); } // PSRAM is plain heap on the desktop
} // namespace

// The Waveshare round glass as the device describes it, on the fake clock; no touch or button is read.
const bob::Board& bob::hal()
{
  static const Board b{"sim", bob::kRuiSize, bob::kRuiSize, true, true, false, simFb, simDirty, bob::roundui::present, nullptr, nullptr,
                       bob::captureLevel01, bob::playbackLevel01, simNowMs, simAlloc};
  return b;
}
