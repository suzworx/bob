// Bob — the bob::Board descriptor of this build's ESP32 board (libs/bob-device/src/bob_hal.h, ADR 0004). One build has
// one board; every operation is a function the firmware already has (board.h, round_ui.h, ws185_hw.h, the audio meters).
#include "bob_hal.h"

#include <Arduino.h>
#include <M5Unified.h>
#include <esp_heap_caps.h>

#include "audio_capture.h"
#include "audio_playback.h"
#include "board.h"
#if defined(BOB_BOARD_WAVESHARE_185C)
#include "round_ui.h"
#include "ws185_hw.h"
#endif

namespace
{
using namespace bob;

void* espAlloc(size_t bytes, bob::Mem where) { return heap_caps_malloc(bytes, where == bob::Mem::kLarge ? MALLOC_CAP_SPIRAM : MALLOC_CAP_8BIT); }
uint32_t espNowMs() { return millis(); }
bool btnAHeld() { return M5.BtnA.isPressed(); }

#if defined(BOB_BOARD_WAVESHARE_185C)
bob::Framebuffer roundFb()
{
  M5Canvas& c = roundui::fb();
  return bob::Framebuffer{static_cast<uint8_t*>(c.getBuffer()), c.width(), c.height()};
}
void roundDirty(bob::Rect r) { roundui::dirty(r.x, r.y, r.w, r.h); }
#endif
} // namespace

const bob::Board& bob::hal()
{
#if defined(BOB_BOARD_WAVESHARE_185C)
  // The 360 px round glass drawn through the round UI's PSRAM framebuffer; touch, BOOT as the talk button.
  static const Board b{board::id(), kRuiSize, kRuiSize, true, true, false, roundFb, roundDirty, roundui::present, ws185::touchPoint,
                       btnAHeld, captureLevel01, playbackLevel01, espNowMs, espAlloc};
#else
  // The Cardputer's 240 x 135 landscape LCD, drawn directly (no framebuffer); keyboard, G0 as the talk button.
  static const Board b{board::id(), 240, 135, false, false, true, nullptr, nullptr, nullptr, nullptr,
                       btnAHeld, captureLevel01, playbackLevel01, espNowMs, espAlloc};
#endif
  return b;
}
