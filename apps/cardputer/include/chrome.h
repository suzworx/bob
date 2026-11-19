// Bob Cardputer v2 — screen chrome: the top status line (mode, mic, volume,
// DND, battery, Wi-Fi) and the bottom shortcut strip, which also carries the
// 1.5 s toasts and the volume level bar.
#pragma once

#include <cstdint>
#include "types.h"

namespace bob {

// Rows owned by the chrome; content screens draw between them.
constexpr int16_t kStatusLineHeight = 11;
constexpr int16_t kStripY = 124;
constexpr int16_t kStripHeight = 11;

// Everything the status line shows. Compared field by field, so the line only
// repaints when something visible changed.
struct StatusLineView {
  DeviceMode mode = DeviceMode::kPtt;
  bool wakeFallback = false;  // mode is wake, but no wake engine: acting as ptt.
  bool micOpen = false;
  bool muted = false;
  uint8_t volume = 0;
  bool dnd = false;
  int batteryPct = -1;  // -1 unknown.
  int charging = -1;    // -1 unknown.
  bool wifiOk = false;
  // "DEV" / "CUSTOM" while a non-production server is in use (#679): drawn as
  // a yellow block right of the mode, always. Production shows none.
  const char* serverBadge = nullptr;

  bool operator==(const StatusLineView& other) const;
};

// Allocates the strip sprite (240x11 at 2 bpp: 660 bytes). Call once after
// the display is up.
void chromeBegin();

// Hides both rows; the pairing screens own the whole display.
void chromeSetVisible(bool visible);

// Forces both rows to repaint on the next tick. Call after a full-screen clear.
void chromeInvalidate();

void chromeSetStatus(const StatusLineView& view);

// Sets the strip's shortcut list; text inside [ ] is a key and is drawn
// highlighted. A new list stays still for 0.6 s, then scrolls at 100 px/s right to left
// if it does not fit. Setting the same text again keeps the scroll position.
void chromeSetShortcuts(const char* text, uint32_t nowMs);

// Transient overlays on the strip, shown for 1.5 s.
void chromeToast(const char* text, uint32_t nowMs);
void chromeVolumeBar(uint8_t level, bool muted, uint32_t nowMs);

// Repaints whatever changed. The strip scroll redraws at most 25 fps and only
// while it scrolls or an overlay starts or ends, so an idle screen costs
// nothing.
void chromeTick(uint32_t nowMs);

}  // namespace bob
