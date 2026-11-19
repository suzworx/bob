// Bob Cardputer v2 — status line and shortcut strip.
#include "chrome.h"
#include "chrome_scroll.h"

#include <M5Cardputer.h>
#include <cstdio>
#include <cstring>
#include "display.h"

namespace bob {

namespace {

constexpr int16_t kScreenWidth = 240;
constexpr int16_t kCharWidth = 6;  // built-in font at text size 1.
constexpr int16_t kTextInset = 4;
constexpr int16_t kTextY = 2;
constexpr int16_t kGapPx = 6;
constexpr uint32_t kColorDim = 0x505050;
constexpr uint32_t kColorLabel = 0xb0b0b0;

// Motion follows elapsed time (chrome_scroll.h); redraw at most 25 fps.
constexpr uint32_t kStripFrameMs = 40;
constexpr int16_t kLoopGapPx = 36;
constexpr uint32_t kOverlayMs = 1500;
constexpr size_t kShortcutBytes = 160;
constexpr size_t kToastBytes = 40;

// Palette indices of the 2 bpp strip sprite.
constexpr uint8_t kInkBackground = 0;
constexpr uint8_t kInkLabel = 1;
constexpr uint8_t kInkKey = 2;
constexpr uint8_t kInkAccent = 3;

enum class Overlay : uint8_t { kNone, kToast, kVolume };

M5Canvas g_strip(&M5Cardputer.Display);
bool g_stripReady = false;
bool g_visible = true;
bool g_statusDirty = true;
bool g_stripDirty = true;
bool g_statusValid = false;
StatusLineView g_status;

char g_shortcuts[kShortcutBytes] = "";
int16_t g_shortcutsWidth = 0;  // px, [ ] markers excluded.
uint32_t g_stillSince = 0;
int16_t g_scrollOffset = 0;
uint32_t g_lastFrameAt = 0;

Overlay g_overlay = Overlay::kNone;
uint32_t g_overlayUntil = 0;
char g_toast[kToastBytes] = "";
uint8_t g_volumeLevel = 0;
bool g_volumeMuted = false;

// Adjacent keys ("[-][=]") are drawn with a space between them; without it
// the brackets vanish and "-=" reads as one key.
bool keysTouch(const char* text, const char* p) { return p != text && p[0] == '[' && p[-1] == ']'; }

int16_t markedWidth(const char* text) {
  int16_t chars = 0;
  for (const char* p = text; *p != '\0'; ++p) {
    if (*p != '[' && *p != ']') ++chars;
    if (keysTouch(text, p)) ++chars;
  }
  return chars * kCharWidth;
}

// The short forms leave room for the server badge (#679).
const char* modeLabel(const StatusLineView& view, bool shortForm) {
  switch (view.mode) {
    case DeviceMode::kPtt: return shortForm ? "PTT" : "Push to talk";
    case DeviceMode::kWake:
      if (view.wakeFallback) return shortForm ? "PTT" : "PTT (no wake)";
      return shortForm ? "Wake" : "Always awake";
    case DeviceMode::kAnnounceOnly: return shortForm ? "Ann." : "Announce only";
  }
  return "";
}

// Right-aligned segment ending at *right; moves *right left past it.
void drawRightSegment(const char* text, uint32_t color, int16_t* right) {
  const int16_t width = static_cast<int16_t>(strlen(text)) * kCharWidth;
  *right -= width;
  M5Cardputer.Display.setTextColor(color);
  M5Cardputer.Display.setCursor(*right, kTextY);
  M5Cardputer.Display.print(text);
  *right -= kGapPx;
}

// Left: mic dot (red while the mic is open, hollow when it never opens in
// this mode) and the mode. Right: Wi-Fi, DND, volume, battery.
void drawStatusLine() {
  auto& d = M5Cardputer.Display;
  d.fillRect(0, 0, kScreenWidth, kStatusLineHeight, kColorBlack);
  d.drawFastHLine(0, kStatusLineHeight - 1, kScreenWidth, kColorDim);
  d.setTextSize(1);
  if (g_status.mode == DeviceMode::kAnnounceOnly) {
    d.drawCircle(5, 5, 3, kColorDim);
  } else {
    d.fillCircle(5, 5, 3, g_status.micOpen ? kColorRed : kColorDim);
  }
  d.setTextColor(g_status.micOpen ? kColorWhite : kColorLabel);
  d.setCursor(12, kTextY);
  const bool badge = g_status.serverBadge != nullptr;
  d.print(modeLabel(g_status, badge));

  int16_t right = kScreenWidth - kTextInset;
  if (badge) {
    // Black on a yellow block, rightmost, so nobody mistakes dev for prod.
    const int16_t width = static_cast<int16_t>(strlen(g_status.serverBadge)) * kCharWidth + 4;
    right -= width;
    d.fillRect(right, 0, width, kStatusLineHeight - 1, kColorYellow);
    d.setTextColor(kColorBlack);
    d.setCursor(right + 2, kTextY);
    d.print(g_status.serverBadge);
    right -= kGapPx;
  }
  char text[12];
  if (g_status.batteryPct >= 0) {
    snprintf(text, sizeof(text), "%d%%%s", g_status.batteryPct,
             g_status.charging == 1 ? "+" : "");
    drawRightSegment(text, g_status.batteryPct <= 15 ? kColorRed : kColorWhite, &right);
  }
  if (g_status.muted) {
    drawRightSegment("Muted", kColorYellow, &right);
  } else {
    snprintf(text, sizeof(text), "Vol %u", static_cast<unsigned int>(g_status.volume));
    drawRightSegment(text, kColorWhite, &right);
  }
  if (g_status.dnd) drawRightSegment("DND", kColorMagenta, &right);
  if (!g_status.wifiOk) drawRightSegment("Offline", kColorRed, &right);
}

// Draws `text` into the strip from x; runs inside [ ] use the key ink.
void drawMarked(const char* text, int16_t x) {
  char run[kShortcutBytes];
  size_t n = 0;
  uint8_t ink = kInkLabel;
  auto flush = [&]() {
    if (n == 0) return;
    run[n] = '\0';
    g_strip.setTextColor(ink);
    g_strip.drawString(run, x, kTextY);
    x += static_cast<int16_t>(n) * kCharWidth;
    n = 0;
  };
  for (const char* p = text; *p != '\0'; ++p) {
    if (keysTouch(text, p) && n + 1 < sizeof(run)) run[n++] = ' ';
    if (*p == '[' || *p == ']') {
      flush();
      ink = *p == '[' ? kInkKey : kInkLabel;
    } else if (n + 1 < sizeof(run)) {
      run[n++] = *p;
    }
  }
  flush();
}

// "Vol" + ten segments + the level, or the outline and "Muted".
void drawVolumeBar() {
  constexpr int16_t kSegmentX = 34;
  constexpr int16_t kSegmentW = 14;
  constexpr int16_t kSegmentPitch = 16;
  g_strip.setTextColor(kInkLabel);
  g_strip.drawString("Vol", kTextInset, kTextY);
  for (uint8_t i = 0; i < kVolumeMax; ++i) {
    const int16_t x = kSegmentX + i * kSegmentPitch;
    if (!g_volumeMuted && i < g_volumeLevel) {
      g_strip.fillRect(x, 2, kSegmentW, kStripHeight - 4, kInkAccent);
    } else {
      g_strip.drawRect(x, 2, kSegmentW, kStripHeight - 4, kInkLabel);
    }
  }
  char text[8];
  snprintf(text, sizeof(text), "%u", static_cast<unsigned int>(g_volumeLevel));
  g_strip.setTextColor(g_volumeMuted ? kInkKey : kInkAccent);
  g_strip.drawString(g_volumeMuted ? "Muted" : text, kSegmentX + kVolumeMax * kSegmentPitch + 4,
                     kTextY);
}

void renderStrip() {
  g_strip.fillSprite(kInkBackground);
  if (g_overlay == Overlay::kToast) {
    g_strip.setTextColor(kInkAccent);
    const int16_t width = static_cast<int16_t>(strlen(g_toast)) * kCharWidth;
    g_strip.drawString(g_toast, width < kScreenWidth ? (kScreenWidth - width) / 2 : 0, kTextY);
  } else if (g_overlay == Overlay::kVolume) {
    drawVolumeBar();
  } else {
    const int16_t x = kTextInset - g_scrollOffset;
    drawMarked(g_shortcuts, x);
    if (g_scrollOffset > 0) drawMarked(g_shortcuts, x + g_shortcutsWidth + kLoopGapPx);
  }
  g_strip.pushSprite(0, kStripY);
}

void startOverlay(Overlay overlay, uint32_t nowMs) {
  g_overlay = overlay;
  g_overlayUntil = nowMs + kOverlayMs;
  g_stripDirty = true;
}

}  // namespace

bool StatusLineView::operator==(const StatusLineView& o) const {
  return mode == o.mode && wakeFallback == o.wakeFallback && micOpen == o.micOpen &&
         muted == o.muted && volume == o.volume && dnd == o.dnd &&
         batteryPct == o.batteryPct && charging == o.charging && wifiOk == o.wifiOk &&
         serverBadge == o.serverBadge;
}

void chromeBegin() {
  g_strip.setColorDepth(2);
  g_stripReady = g_strip.createSprite(kScreenWidth, kStripHeight) != nullptr;
  if (!g_stripReady) return;
  g_strip.setPaletteColor(kInkBackground, kColorBlack);
  g_strip.setPaletteColor(kInkLabel, kColorLabel);
  g_strip.setPaletteColor(kInkKey, kColorYellow);
  g_strip.setPaletteColor(kInkAccent, kColorCyan);
  g_strip.setTextSize(1);
}

void chromeSetVisible(bool visible) {
  if (visible && !g_visible) chromeInvalidate();
  g_visible = visible;
}

void chromeInvalidate() {
  g_statusDirty = true;
  g_stripDirty = true;
}

void chromeSetStatus(const StatusLineView& view) {
  if (g_statusValid && view == g_status) return;
  g_status = view;
  g_statusValid = true;
  g_statusDirty = true;
}

void chromeSetShortcuts(const char* text, uint32_t nowMs) {
  if (strncmp(text, g_shortcuts, sizeof(g_shortcuts)) == 0) return;
  strncpy(g_shortcuts, text, sizeof(g_shortcuts) - 1);
  g_shortcuts[sizeof(g_shortcuts) - 1] = '\0';
  g_shortcutsWidth = markedWidth(g_shortcuts);
  g_scrollOffset = 0;
  g_stillSince = nowMs;
  g_stripDirty = true;
}

void chromeToast(const char* text, uint32_t nowMs) {
  strncpy(g_toast, text, sizeof(g_toast) - 1);
  g_toast[sizeof(g_toast) - 1] = '\0';
  startOverlay(Overlay::kToast, nowMs);
}

void chromeVolumeBar(uint8_t level, bool muted, uint32_t nowMs) {
  g_volumeLevel = level;
  g_volumeMuted = muted;
  startOverlay(Overlay::kVolume, nowMs);
}

void chromeTick(uint32_t nowMs) {
  if (!g_visible) return;
  if (g_statusDirty && g_statusValid) {
    drawStatusLine();
    g_statusDirty = false;
  }
  if (!g_stripReady) return;
  if (g_overlay != Overlay::kNone && static_cast<int32_t>(nowMs - g_overlayUntil) >= 0) {
    g_overlay = Overlay::kNone;
    g_stillSince = nowMs;
    g_scrollOffset = 0;
    g_stripDirty = true;
  }
  const bool scrolls = g_overlay == Overlay::kNone &&
                       g_shortcutsWidth > kScreenWidth - 2 * kTextInset;
  if (scrolls && nowMs - g_lastFrameAt >= kStripFrameMs) {
    const int16_t offset = stripScrollOffset(nowMs - g_stillSince,
                                             g_shortcutsWidth + kLoopGapPx);
    if (offset != g_scrollOffset) {
      g_scrollOffset = offset;
      g_stripDirty = true;
    }
  }
  if (!g_stripDirty) return;
  renderStrip();
  g_lastFrameAt = nowMs;
  g_stripDirty = false;
}

}  // namespace bob
