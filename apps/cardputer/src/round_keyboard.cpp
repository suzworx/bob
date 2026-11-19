// The on-screen keyboard of text-field screens (Wi-Fi name and password, server host and port, the RESET
// confirmation) on the Waveshare. It draws into the framebuffer canvas through round_ui's API, never to
// M5.Display, in the lower part of the circle: y 204..316, directly above the chip row. The layout (rects,
// layers, hit testing) is touch_policy.h, shared with the host tests; this file only paints it.
#if defined(BOB_BOARD_WAVESHARE_185C)

#include <Arduino.h>
#include <M5Unified.h>
#include <string.h>

#include "round_touch.h"
#include "round_ui.h"

namespace bob
{
namespace roundtouch
{
namespace
{
constexpr uint32_t kKeyColor = 0x2A5775, kHotMs = 120, kNewFieldGapMs = 10000;
constexpr int16_t kKbClearX = 20, kKbClearW = 320;

touch::KbLayer g_layer = touch::KbLayer::kLower;
bool g_hotOn = false;
touch::KbRect g_hotRect{};
touch::KbKind g_hotKind = touch::KbKind::kNone;
char g_hotCh = 0;
uint32_t g_hotUntil = 0, g_lastFieldAt = 0;

const char* labelFor(touch::KbKind kind, char ch, char* one)
{
  switch (kind)
  {
    case touch::KbKind::kShift: return "Aa";
    case touch::KbKind::kLayer: return g_layer == touch::KbLayer::kSymbols ? "abc" : "123";
    case touch::KbKind::kDel: return "Del";
    case touch::KbKind::kEnter: return "OK";
    case touch::KbKind::kSpace: return "";
    default: one[0] = ch; one[1] = '\0'; return one;
  }
}

void drawKey(const touch::KbRect& r, touch::KbKind kind, char ch, bool hot)
{
  auto& d = roundui::fb();
  const bool shiftOn = kind == touch::KbKind::kShift && g_layer == touch::KbLayer::kUpper;
  uint32_t bg = kind == touch::KbKind::kEnter ? kRuiOk : kKeyColor;
  if (shiftOn || hot) { bg = kRuiAccent; }
  d.fillRoundRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2, 5, bg);
  d.setFont(static_cast<const lgfx::IFont*>(roundui::smallFont()));
  d.setTextDatum(middle_center);
  d.setTextColor(shiftOn || hot ? kRuiGround : kRuiText);
  char one[2];
  const char* label = labelFor(kind, ch, one);
  if (kind == touch::KbKind::kSpace) { d.fillRoundRect(r.x + 14, r.y + r.h / 2 - 1, r.w - 28, 3, 1, hot ? kRuiGround : kRuiDim); }
  else { d.drawString(label, r.x + r.w / 2, r.y + r.h / 2); }
  d.setTextDatum(middle_left);
}

void drawKeyboard()
{
  roundui::fb().fillRect(kKbClearX, touch::kKbTop, kKbClearW, 4 * touch::kKbPitch, kRuiGround);
  touch::kbForEach(g_layer, [](const touch::KbRect& r, touch::KbKind kind, char ch) { drawKey(r, kind, ch, false); });
  roundui::dirty(kKbClearX, touch::kKbTop, kKbClearW, 4 * touch::kKbPitch);
}
} // namespace

void keyboardOnFieldScreen(bool digitsOnly)
{
  const uint32_t now = millis();
  const bool wasDigits = g_layer == touch::KbLayer::kDigits;
  if (digitsOnly) { g_layer = touch::KbLayer::kDigits; }
  else if (wasDigits || now - g_lastFieldAt > kNewFieldGapMs) { g_layer = touch::KbLayer::kLower; }
  g_lastFieldAt = now;
  g_hotOn = false;
  drawKeyboard();
}

bool keyboardVisible() { return roundui::fieldScreen(nullptr); }

touch::KbLayer keyboardLayer() { return g_layer; }

void keyboardToggleShift()
{
  if (g_layer == touch::KbLayer::kDigits) { return; }
  g_layer = g_layer == touch::KbLayer::kUpper ? touch::KbLayer::kLower : touch::KbLayer::kUpper;
  drawKeyboard();
}

void keyboardToggleLayer()
{
  if (g_layer == touch::KbLayer::kDigits) { return; }
  g_layer = g_layer == touch::KbLayer::kSymbols ? touch::KbLayer::kLower : touch::KbLayer::kSymbols;
  drawKeyboard();
}

void keyboardTyped()
{
  if (g_layer != touch::KbLayer::kUpper) { return; }
  g_layer = touch::KbLayer::kLower;
  drawKeyboard();
}

void keyboardPressAt(int16_t x, int16_t y, uint32_t nowMs)
{
  if (!keyboardVisible()) { return; }
  touch::kbForEach(g_layer, [&](const touch::KbRect& r, touch::KbKind kind, char ch) {
    if (x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) { return; }
    g_hotOn = true;
    g_hotRect = r;
    g_hotKind = kind;
    g_hotCh = ch;
    g_hotUntil = nowMs + kHotMs;
    drawKey(r, kind, ch, true);
    roundui::dirty(r.x, r.y, r.w, r.h);
  });
}

void keyboardTick(uint32_t nowMs)
{
  if (!g_hotOn || static_cast<int32_t>(nowMs - g_hotUntil) < 0) { return; }
  g_hotOn = false;
  if (!keyboardVisible()) { return; }
  drawKey(g_hotRect, g_hotKind, g_hotCh, false);
  roundui::dirty(g_hotRect.x, g_hotRect.y, g_hotRect.w, g_hotRect.h);
}

} // namespace roundtouch
} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
