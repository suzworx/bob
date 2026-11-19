// Bob Cardputer v2 — the Ready screen's running-timer band (#457).
#include "timers_view.h"

#include <M5Cardputer.h>
#include <cstring>
#include "chrome.h"
#include "display.h"

namespace bob {

namespace {

// The band fills the gap between the Ready screen's WiFi line (y 90, 8 px)
// and the shortcut strip: size-3 digits (18x24 px) right-aligned, the label
// and "+N more" small on the left. Nothing else is drawn there.
constexpr int16_t kBandY = 99;
constexpr int16_t kBandHeight = kStripY - kBandY;  // 25 px, ends above the strip.
constexpr int16_t kBandLeft = 8;
constexpr int16_t kBandRight = 232;
constexpr int16_t kDigitsY = kBandY + 1;
constexpr int16_t kDigitWidth = 18;   // 6 px glyph cell at size 3.
constexpr int16_t kSmallWidth = 6;    // size 1.
constexpr int16_t kSuffixGap = 3;
constexpr uint32_t kColorDim = 0x808080;
constexpr uint32_t kEvaluateIntervalMs = 100;

bool g_drawn = false;
uint32_t g_evaluatedAt = 0;
TimerBandView g_shown;

int16_t digitsX(const TimerBandView& view) {
  const int16_t suffix = view.hours ? kSuffixGap + 2 * kSmallWidth : 0;
  return kBandRight - suffix - static_cast<int16_t>(strlen(view.clock)) * kDigitWidth;
}

void drawDigits(const TimerBandView& view) {
  M5Cardputer.Display.setTextSize(3);
  M5Cardputer.Display.setTextColor(view.reached ? kColorYellow : kColorWhite, kColorBlack);
  M5Cardputer.Display.setCursor(digitsX(view), kDigitsY);
  M5Cardputer.Display.print(view.clock);
  M5Cardputer.Display.setTextSize(1);
}

void drawBand(const TimerBandView& view) {
  M5Cardputer.Display.fillRect(0, kBandY, M5Cardputer.Display.width(), kBandHeight, kColorBlack);
  if (!view.visible) return;
  drawDigits(view);
  const int16_t x = digitsX(view);
  if (view.hours) {
    M5Cardputer.Display.setTextColor(kColorDim, kColorBlack);
    M5Cardputer.Display.setCursor(x + static_cast<int16_t>(strlen(view.clock)) * kDigitWidth + kSuffixGap,
                                  kDigitsY + 16);
    M5Cardputer.Display.print("hr");
  }
  // The label stops one glyph short of the digits; it never runs under them.
  const int chars = (x - kBandLeft - kSmallWidth) / kSmallWidth;
  M5Cardputer.Display.setTextColor(kColorWhite, kColorBlack);
  M5Cardputer.Display.setCursor(kBandLeft, kDigitsY + 2);
  M5Cardputer.Display.printf("%.*s", chars > 0 ? chars : 0, view.label);
  if (view.more > 0) {
    M5Cardputer.Display.setTextColor(kColorDim, kColorBlack);
    M5Cardputer.Display.setCursor(kBandLeft, kDigitsY + 14);
    M5Cardputer.Display.printf("+%u more", static_cast<unsigned int>(view.more));
  }
}

// Same layout: only the digits change, and they repaint in place (each glyph
// cell overwrites its background), so a tick never blanks the band.
bool sameLayout(const TimerBandView& a, const TimerBandView& b) {
  return a.visible && b.visible && a.hours == b.hours && a.reached == b.reached &&
         a.more == b.more && strcmp(a.label, b.label) == 0 && strlen(a.clock) == strlen(b.clock);
}

}  // namespace

void timersBandUpdate(const TimersModel& model, uint32_t nowMs) {
  if (g_drawn && nowMs - g_evaluatedAt < kEvaluateIntervalMs) return;
  g_evaluatedAt = nowMs;
  const TimerBandView view = timerBandView(model, nowMs);
  if (g_drawn && view == g_shown) return;
  // After an invalidate the band is always repainted, even empty: whatever
  // covered the screen may not have cleared it.
  if (g_drawn && sameLayout(view, g_shown)) {
    drawDigits(view);
  } else {
    drawBand(view);
  }
  g_shown = view;
  g_drawn = true;
}

void timersBandInvalidate() { g_drawn = false; }

}  // namespace bob
