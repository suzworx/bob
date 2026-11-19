// Bob Cardputer v2 — status screen drawing helpers.
#include "display.h"

#include <M5Cardputer.h>
#include <cmath>
#include <cstdint>
#include <cstring>
#include "chrome.h"
#include "picker_window.h"
#include "timers_view.h"

namespace bob {

namespace {

// Shared bounding box for the listening/playback activity indicator, placed
// top-right of the title text, below the chrome status line, so it never
// overlaps the detail/WiFi lines drawn below. Every incremental redraw only
// touches this small box (and, for playback, the frame-counter line), so
// per-tick cost stays low.
constexpr int16_t kIndicatorCenterX = 208;
constexpr int16_t kIndicatorCenterY = 32;
constexpr int16_t kIndicatorHalfBox = 18;  // bounding box is 36x36 px.
constexpr uint32_t kIndicatorIntervalMs = 60;  // ~16 Hz repaint cap.

constexpr int16_t kCounterX = 8;
constexpr int16_t kCounterY = 68;
constexpr int16_t kCounterWidth = 180;
constexpr int16_t kCounterHeight = 12;

constexpr float kTwoPi = 6.28318530718f;

// On-device conversation picker geometry. Row height is ~10 px at textSize 1.
constexpr int16_t kPickerHeaderY = 16;
constexpr int16_t kPickerItemYStart = 40;
constexpr int16_t kPickerRowHeight = 12;
constexpr int16_t kPickerHintY = 110;  // clears the chrome strip at y 124.

// Maximum number of list rows that fit on screen at once, derived from the
// geometry: only rows whose bottom edge stays at or above the hint line
// (drawn at kPickerHintY) minus a 2 px gap are visible. Kept in lockstep with
// the row constants above so a geometry tweak cannot silently overdraw the
// hint with a 7th row.
constexpr size_t kPickerVisibleRows =
    static_cast<size_t>((kPickerHintY - 2 - kPickerItemYStart) / kPickerRowHeight);

// Picker repaint tracking: which rows were last drawn, at what selection, so
// drawConversationList can repaint only what changed after the first full
// clear. resetPickerTracking() (via endConversationList) starts the next
// picker session from a clean slate.
bool pickerActive = false;
size_t pickerLastSelection = 0;
size_t pickerLastCount = 0;
size_t pickerLastTop = 0;
char pickerLastTitles[kPickerVisibleRows][kPickerLabelBytes] = {};  // on-screen rows only

void resetPickerTracking() {
  pickerActive = false;
  pickerLastSelection = 0;
  pickerLastCount = 0;
  pickerLastTop = 0;
  memset(pickerLastTitles, 0, sizeof(pickerLastTitles));
}

int16_t pickerItemY(size_t index) {
  return kPickerItemYStart + static_cast<int16_t>(index) * kPickerRowHeight;
}

size_t pickerCapacity() { return kPickerVisibleRows; }

// First entry index shown for a given selection: stays at 0 while the
// selection is within the first screenful, otherwise scrolls to keep the
// selection as the last visible row.
size_t pickerTopFor(size_t count, size_t selection) {
  return pickerWindowTop(count, selection, pickerCapacity());
}

void drawPickerRow(const char* label, size_t index, bool selected) {
  const int16_t y = pickerItemY(index);
  const int16_t w = M5Cardputer.Display.width();
  if (selected) {
    M5Cardputer.Display.fillRect(0, y, w, kPickerRowHeight, kColorWhite);
    M5Cardputer.Display.setTextColor(kColorBlack);
  } else {
    M5Cardputer.Display.fillRect(0, y, w, kPickerRowHeight, kColorBlack);
    M5Cardputer.Display.setTextColor(kColorWhite);
  }
  M5Cardputer.Display.setCursor(8, y);
  M5Cardputer.Display.print(label);
}

void drawPickerHeader(const char* heading) {
  M5Cardputer.Display.fillScreen(kColorBlack);
  chromeInvalidate();
  M5Cardputer.Display.setTextSize(2);
  M5Cardputer.Display.setTextColor(kColorYellow);
  M5Cardputer.Display.setCursor(8, kPickerHeaderY);
  M5Cardputer.Display.println(heading);
  M5Cardputer.Display.setTextSize(1);
}

// Draws a "n/m" position indicator in the top-right of the header so the user
// knows more items exist off-screen. Only drawn when there is more than one.
void drawPickerPosition(size_t position, size_t count) {
  if (count <= 1) return;
  M5Cardputer.Display.setTextSize(1);
  M5Cardputer.Display.setTextColor(kColorYellow);
  M5Cardputer.Display.setCursor(M5Cardputer.Display.width() - 40, kPickerHeaderY + 2);
  M5Cardputer.Display.printf("%u/%u", static_cast<unsigned int>(position),
                             static_cast<unsigned int>(count));
}

// Tracks what was last painted so redraws only happen when the animated
// value actually changes, and so a fresh drawStatus() (full-screen clear)
// forces the next indicator call to repaint rather than skip on stale state.
uint32_t lastIndicatorDrawAt = 0;
int16_t lastRadius = -1;
int16_t lastBarX = -1;
uint32_t lastFrameCountShown = UINT32_MAX;

void resetIndicatorTracking() {
  lastIndicatorDrawAt = 0;
  lastRadius = -1;
  lastBarX = -1;
  lastFrameCountShown = UINT32_MAX;
}

void eraseIndicatorBox() {
  M5Cardputer.Display.fillRect(kIndicatorCenterX - kIndicatorHalfBox,
                               kIndicatorCenterY - kIndicatorHalfBox,
                               kIndicatorHalfBox * 2, kIndicatorHalfBox * 2,
                               kColorBlack);
}

}  // namespace

void drawStatus(const char* title, const char* detail, uint32_t titleColor,
                bool wifiConnected, bool websocketConnected) {
  M5Cardputer.Display.fillScreen(kColorBlack);
  chromeInvalidate();
  M5Cardputer.Display.setTextSize(2);
  M5Cardputer.Display.setTextColor(titleColor);
  M5Cardputer.Display.setCursor(8, 16);
  M5Cardputer.Display.println(title);
  M5Cardputer.Display.setTextSize(1);
  M5Cardputer.Display.setTextColor(kColorWhite);
  M5Cardputer.Display.setCursor(8, 54);
  M5Cardputer.Display.println(detail);
  M5Cardputer.Display.setCursor(8, 82);
  M5Cardputer.Display.printf("WiFi: %s  WS: %s",
                             wifiConnected ? "OK" : "--",
                             websocketConnected ? "OK" : "--");
  // The screen was just wiped; force the next indicator call to repaint
  // instead of assuming its cached value is still on screen.
  resetIndicatorTracking();
}

void drawFieldScreen(const char* title, const char* subtitle, const char* shown,
                     size_t cursorColumn, const char* counter, const char* error) {
  constexpr int16_t kFrameX = 8;
  constexpr int16_t kFrameY = 58;
  constexpr int16_t kFrameH = 16;
  constexpr int16_t kTextY = kFrameY + 4;
  constexpr int16_t kCharW = 6;
  auto& d = M5Cardputer.Display;
  d.fillScreen(kColorBlack);
  chromeInvalidate();
  d.setTextSize(2);
  d.setTextColor(kColorYellow);
  d.setCursor(8, 16);
  d.println(title);
  d.setTextSize(1);
  d.setTextColor(kColorWhite);
  d.setCursor(8, 40);
  d.print(subtitle);
  d.drawRect(kFrameX, kFrameY, d.width() - 2 * kFrameX, kFrameH, kColorWhite);
  d.setCursor(kFrameX + 4, kTextY);
  d.print(shown);
  const int16_t cursorX = kFrameX + 4 + static_cast<int16_t>(cursorColumn) * kCharW;
  d.drawFastHLine(cursorX, kTextY + 9, kCharW - 1, kColorCyan);
  d.setTextColor(0xb0b0b0);
  d.setCursor(d.width() - kFrameX - static_cast<int16_t>(strlen(counter)) * kCharW, kFrameY + kFrameH + 4);
  d.print(counter);
  if (error && error[0] != '\0') {
    d.setTextColor(kColorRed);
    d.setCursor(8, 96);
    d.print(error);
  }
  resetIndicatorTracking();
}

void drawLinesScreen(const char* title, uint32_t titleColor, const char* const* lines,
                     size_t count) {
  auto& d = M5Cardputer.Display;
  d.fillScreen(kColorBlack);
  chromeInvalidate();
  d.setTextSize(2);
  d.setTextColor(titleColor);
  d.setCursor(8, 16);
  d.println(title);
  d.setTextSize(1);
  d.setTextColor(kColorWhite);
  const size_t shown = count < kLinesScreenMax ? count : kLinesScreenMax;
  for (size_t i = 0; i < shown; ++i) {
    d.setCursor(8, 40 + static_cast<int16_t>(i) * 12);
    d.print(lines[i]);
  }
  resetIndicatorTracking();
}

void drawBuildTag(const char* version) {
  constexpr uint32_t kColorBuildTag = 0x808080;
  M5Cardputer.Display.setTextSize(1);
  M5Cardputer.Display.setTextColor(kColorBuildTag, kColorBlack);
  M5Cardputer.Display.setCursor(8, 110);
  M5Cardputer.Display.printf("Firmware %s", version);
}

void updateListeningIndicator(uint32_t nowMs) {
  if (nowMs - lastIndicatorDrawAt < kIndicatorIntervalMs) return;
  lastIndicatorDrawAt = nowMs;

  // Pulsing filled circle: radius breathes between 6 and 18 px on a ~1.2s
  // cycle. Distinct from the playback indicator in both shape and color.
  const float phase = static_cast<float>(nowMs % 1200) / 1200.0f * kTwoPi;
  const int16_t radius =
      static_cast<int16_t>(6.0f + 12.0f * (0.5f + 0.5f * sinf(phase)));
  if (radius == lastRadius) return;
  lastRadius = radius;

  eraseIndicatorBox();
  M5Cardputer.Display.fillCircle(kIndicatorCenterX, kIndicatorCenterY, radius,
                                 kColorGreen);
}

void updatePlaybackIndicator(uint32_t nowMs, uint32_t downFrameCount) {
  if (nowMs - lastIndicatorDrawAt >= kIndicatorIntervalMs) {
    lastIndicatorDrawAt = nowMs;

    // Sweeping vertical bar bouncing left-right across the box (triangle
    // wave). Shape, motion, and color are all distinct from the listening
    // circle so the two states are unmistakable at a glance.
    const int16_t travel = kIndicatorHalfBox * 2 - 4;  // bar is 4px wide.
    const uint32_t cyclePos = nowMs % static_cast<uint32_t>(travel * 2);
    const int16_t offset = cyclePos < static_cast<uint32_t>(travel)
                               ? static_cast<int16_t>(cyclePos)
                               : static_cast<int16_t>(travel * 2 - cyclePos);
    const int16_t barX = kIndicatorCenterX - kIndicatorHalfBox + offset;
    if (barX != lastBarX) {
      lastBarX = barX;
      eraseIndicatorBox();
      M5Cardputer.Display.fillRect(barX, kIndicatorCenterY - kIndicatorHalfBox,
                                   4, kIndicatorHalfBox * 2, kColorMagenta);
    }
  }

  // Live downlink frame counter, redrawn only when the count changes so
  // idle ticks (no new frame yet) don't cost a draw call.
  if (downFrameCount != lastFrameCountShown) {
    lastFrameCountShown = downFrameCount;
    M5Cardputer.Display.fillRect(kCounterX, kCounterY, kCounterWidth,
                                 kCounterHeight, kColorBlack);
    M5Cardputer.Display.setTextSize(1);
    M5Cardputer.Display.setTextColor(kColorMagenta);
    M5Cardputer.Display.setCursor(kCounterX, kCounterY);
    M5Cardputer.Display.printf("Frames: %lu",
                               static_cast<unsigned long>(downFrameCount));
  }
}

void drawPickerList(const PickerView& view, size_t selection) {
  const size_t count = view.count < kMaxPickerEntries ? view.count : kMaxPickerEntries;
  if (count == 0) {
    drawPickerHeader(view.heading);
    M5Cardputer.Display.setTextColor(kColorWhite);
    M5Cardputer.Display.setCursor(8, kPickerItemYStart);
    M5Cardputer.Display.println(view.emptyText);
    resetPickerTracking();
    pickerActive = true;
    return;
  }

  const size_t top = pickerTopFor(count, selection);
  const size_t rows = pickerCapacity();
  const size_t visible = rows < count - top ? rows : count - top;

  if (!pickerActive || top != pickerLastTop) {
    drawPickerHeader(view.heading);
    for (size_t i = 0; i < visible; ++i) {
      drawPickerRow(view.labels[top + i], i, (top + i) == selection);
      strncpy(pickerLastTitles[i], view.labels[top + i], kPickerLabelBytes - 1);
      pickerLastTitles[i][kPickerLabelBytes - 1] = '\0';
    }
    pickerActive = true;
    pickerLastSelection = selection;
    pickerLastTop = top;
    pickerLastCount = visible;
    drawPickerPosition(selection + 1, count);
    return;
  }

  for (size_t i = 0; i < visible; ++i) {
    const size_t index = top + i;
    const bool selectionChanged = (index == selection) != (index == pickerLastSelection);
    const bool titleChanged =
        strncmp(pickerLastTitles[i], view.labels[index], kPickerLabelBytes - 1) != 0;
    if (selectionChanged || titleChanged) {
      drawPickerRow(view.labels[index], i, index == selection);
      strncpy(pickerLastTitles[i], view.labels[index], kPickerLabelBytes - 1);
      pickerLastTitles[i][kPickerLabelBytes - 1] = '\0';
    }
  }
  pickerLastSelection = selection;
  pickerLastCount = visible;
  drawPickerPosition(selection + 1, count);
}

void drawConversationList(const ListedConversation* entries, size_t count, size_t selection) {
  const char* labels[kMaxListedConversations];
  const size_t shown = count < kMaxListedConversations ? count : kMaxListedConversations;
  for (size_t i = 0; i < shown; ++i) labels[i] = entries[i].title;
  drawPickerList(PickerView{"CONVERSATIONS", "No conversations", labels, shown}, selection);
}

void endConversationList() { resetPickerTracking(); }

void drawConversationPickerHint(const char* message, uint32_t color) {
  // Clear the hint line first so a newer hint never overprints an older one.
  M5Cardputer.Display.fillRect(0, kPickerHintY, M5Cardputer.Display.width(),
                               kPickerRowHeight, kColorBlack);
  M5Cardputer.Display.setTextSize(1);
  M5Cardputer.Display.setTextColor(color);
  M5Cardputer.Display.setCursor(8, kPickerHintY);
  M5Cardputer.Display.println(message);
}

// --- Pairing screens ---

namespace {

constexpr int16_t kPairingTitleY = 10;
constexpr int16_t kPairingCodeY = 26;
constexpr int16_t kPairingStepsY = 52;
constexpr int16_t kPairingUriY = 64;
constexpr int16_t kPairingCountdownY = 96;
constexpr int16_t kPairingHintY = 116;
// The QR code (#678) fills the right third; text stays left of it.
constexpr int16_t kPairingQrX = 146;
constexpr int16_t kPairingQrY = 20;
constexpr int16_t kPairingQrSize = 88;
constexpr int16_t kPairingTextWidth = kPairingQrX - 12;
constexpr size_t kPairingUriDisplayChars = 22;  // 132 px left of the QR, 6 px per char.
constexpr size_t kNameDisplayChars = 20;        // 240 px / 12 px per char at size 2.

uint32_t g_pairingExpiresAtMs = 0;
int32_t g_lastCountdownSecond = -1;

void printTruncated(const char* text, size_t maxChars) {
  size_t len = 0;
  while (text && text[len] != '\0' && len < maxChars) ++len;
  M5Cardputer.Display.printf("%.*s", static_cast<int>(len), text ? text : "");
}

void drawPairingCountdown(uint32_t nowMs) {
  const uint32_t remainingMs = g_pairingExpiresAtMs > nowMs ? g_pairingExpiresAtMs - nowMs : 0;
  const uint32_t totalSec = (remainingMs + 999) / 1000;
  const uint32_t minutes = totalSec / 60;
  const uint32_t seconds = totalSec % 60;
  M5Cardputer.Display.fillRect(8, kPairingCountdownY - 4, kPairingTextWidth, 12, kColorBlack);
  M5Cardputer.Display.setTextSize(1);
  M5Cardputer.Display.setTextColor(kColorCyan);
  M5Cardputer.Display.setCursor(8, kPairingCountdownY);
  M5Cardputer.Display.printf("Expires in %02lu:%02lu", static_cast<unsigned long>(minutes),
                             static_cast<unsigned long>(seconds));
}

}  // namespace

void drawPairingScreen(const PairingInfo& info, uint32_t nowMs) {
  M5Cardputer.Display.fillScreen(kColorBlack);
  M5Cardputer.Display.setTextSize(1);
  M5Cardputer.Display.setTextColor(kColorYellow);
  M5Cardputer.Display.setCursor(8, kPairingTitleY);
  M5Cardputer.Display.println("PAIR YOUR BOB");

  // Size 2, not 3: the 9-character code (108 px) must fit left of the QR.
  M5Cardputer.Display.setTextSize(2);
  M5Cardputer.Display.setTextColor(kColorWhite);
  M5Cardputer.Display.setCursor(8, kPairingCodeY);
  M5Cardputer.Display.println(info.userCode[0] != '\0' ? info.userCode : "---------");

  M5Cardputer.Display.setTextSize(1);
  M5Cardputer.Display.setTextColor(kColorWhite);
  M5Cardputer.Display.setCursor(8, kPairingStepsY);
  M5Cardputer.Display.print("On your phone, open");
  M5Cardputer.Display.setCursor(8, kPairingUriY);
  printTruncated(info.verificationUri, kPairingUriDisplayChars);
  M5Cardputer.Display.setCursor(8, kPairingUriY + 12);
  M5Cardputer.Display.print("or scan the code");

  // The page to open, as a QR code (#678): black modules on a white quiet zone.
  if (info.verificationUri[0] != '\0') {
    M5Cardputer.Display.fillRect(kPairingQrX - 4, kPairingQrY - 4, kPairingQrSize + 8,
                                 kPairingQrSize + 8, kColorWhite);
    M5Cardputer.Display.qrcode(info.verificationUri, kPairingQrX, kPairingQrY, kPairingQrSize);
  }

  g_pairingExpiresAtMs = info.expiresAtMs;
  g_lastCountdownSecond = -1;
  drawPairingCountdown(nowMs);

  M5Cardputer.Display.setCursor(8, kPairingHintY);
  M5Cardputer.Display.setTextColor(kColorWhite);
  M5Cardputer.Display.println("Approve on your phone");
}

void updatePairingCountdown(uint32_t nowMs) {
  if (g_pairingExpiresAtMs == 0) return;
  const uint32_t totalSec =
      g_pairingExpiresAtMs > nowMs ? (g_pairingExpiresAtMs - nowMs + 999) / 1000 : 0;
  if (static_cast<int32_t>(totalSec) == g_lastCountdownSecond) return;
  g_lastCountdownSecond = static_cast<int32_t>(totalSec);
  drawPairingCountdown(nowMs);
}

void drawPairingDenied() {
  M5Cardputer.Display.fillScreen(kColorBlack);
  M5Cardputer.Display.setTextSize(2);
  M5Cardputer.Display.setTextColor(kColorRed);
  M5Cardputer.Display.setCursor(8, 40);
  M5Cardputer.Display.println("PAIRING");
  M5Cardputer.Display.setCursor(8, 62);
  M5Cardputer.Display.println("DENIED");
  M5Cardputer.Display.setTextSize(1);
  M5Cardputer.Display.setTextColor(kColorWhite);
  M5Cardputer.Display.setCursor(8, 100);
  M5Cardputer.Display.println("Press any key to retry");
}

void drawPairedAs(const char* name) {
  M5Cardputer.Display.fillScreen(kColorBlack);
  chromeInvalidate();
  M5Cardputer.Display.setTextSize(2);
  M5Cardputer.Display.setTextColor(kColorYellow);
  M5Cardputer.Display.setCursor(8, 40);
  M5Cardputer.Display.println("PAIRED AS");
  M5Cardputer.Display.setTextColor(kColorWhite);
  M5Cardputer.Display.setCursor(8, 64);
  printTruncated(name, kNameDisplayChars);
  M5Cardputer.Display.setTextSize(1);
  M5Cardputer.Display.setCursor(8, 100);
  M5Cardputer.Display.println("Reconnecting...");
}

void drawReadyScreen(const char* deviceName, const char* activeTitle,
                     const char* spaceName, bool wifiConnected,
                     bool websocketConnected, const char* serverLabel, const char* readyTitle) {
  M5Cardputer.Display.fillScreen(kColorBlack);
  chromeInvalidate();
  M5Cardputer.Display.setTextSize(2);
  M5Cardputer.Display.setTextColor(kColorGreen);
  M5Cardputer.Display.setCursor(8, 16);
  M5Cardputer.Display.println(readyTitle);

  M5Cardputer.Display.setTextSize(1);
  const bool hasName = deviceName != nullptr && deviceName[0] != '\0';
  if (hasName) {
    M5Cardputer.Display.setTextColor(kColorWhite);
    M5Cardputer.Display.setCursor(8, 50);
    M5Cardputer.Display.print("paired as ");
    printTruncated(deviceName, kNameDisplayChars);
  }
  const int16_t titleY = hasName ? 66 : 50;
  M5Cardputer.Display.setCursor(8, titleY);
  if (activeTitle != nullptr && activeTitle[0] != '\0') {
    M5Cardputer.Display.setTextColor(kColorYellow);
    printTruncated(activeTitle, kConversationTitleBytes - 1);
  } else {
    M5Cardputer.Display.setTextColor(kColorWhite);
    M5Cardputer.Display.print("New conversation");
  }
  // Space line 12 px below the title (y 62 or 78, 8 px tall) clears the WiFi
  // line at y 90; "Space: " + 28 chars is 35 * 6 = 210 px from x 8, < 240.
  M5Cardputer.Display.setCursor(8, titleY + 12);
  M5Cardputer.Display.setTextColor(kColorWhite);
  M5Cardputer.Display.print("Space: ");
  if (spaceName != nullptr && spaceName[0] != '\0') {
    M5Cardputer.Display.setTextColor(kColorCyan);
    printTruncated(spaceName, kSpaceNameBytes - 1);
  } else {
    M5Cardputer.Display.print("none");
  }
  M5Cardputer.Display.setCursor(8, 90);
  if (serverLabel != nullptr) {
    M5Cardputer.Display.setTextColor(kColorCyan);
    M5Cardputer.Display.printf("Server: %s", serverLabel);
  } else {
    M5Cardputer.Display.setTextColor(kColorWhite);
    M5Cardputer.Display.printf("WiFi: %s  WS: %s", wifiConnected ? "OK" : "--",
                               websocketConnected ? "OK" : "--");
  }
  resetIndicatorTracking();
  // The running-timer band below (timers_view.h) repaints on its next update.
  timersBandInvalidate();
}

}  // namespace bob
