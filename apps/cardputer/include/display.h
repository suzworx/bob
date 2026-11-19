// Bob Cardputer v2 — status screen drawing helpers.
#pragma once

#include <cstdint>
#include <WString.h>
#include "types.h"

namespace bob {

// Colors used by status screens.
constexpr uint32_t kColorBlack = 0x000000;
constexpr uint32_t kColorWhite = 0xffffff;
constexpr uint32_t kColorRed = 0xff0000;
constexpr uint32_t kColorGreen = 0x00ff00;
constexpr uint32_t kColorYellow = 0xffff00;
constexpr uint32_t kColorCyan = 0x00ffff;
constexpr uint32_t kColorMagenta = 0xff00ff;

// Clears the screen and draws the standard status layout. The shortcut hint
// lives in the chrome strip (chrome.h), so every full-screen draw here marks
// the chrome for repaint.
void drawStatus(const char* title, const char* detail, uint32_t titleColor,
                bool wifiConnected, bool websocketConnected);

// Numeric firmware version, small and dim above the strip, so the owner can
// see what is flashed. Drawn after drawStatus() on the boot/connecting screens.
void drawBuildTag(const char* version);

// Refreshes the pulsing "listening" indicator (a growing/shrinking green
// circle) in its fixed screen region. Call every loop tick while capturing;
// internally throttled and only repaints its own small bounding box, so it
// is cheap to call on every iteration of the main loop.
void updateListeningIndicator(uint32_t nowMs);

// Refreshes the "playback" indicator (a sweeping magenta bar, visually
// distinct from the listening circle) plus the live downlink frame counter.
// Call every loop tick while awaiting/playing a reply; internally throttled
// and only repaints the small regions that actually changed.
void updatePlaybackIndicator(uint32_t nowMs, uint32_t downFrameCount);

// One on-device picker screen: a heading, the text shown when there are no
// rows, and up to kMaxPickerEntries row labels (it scrolls; already truncated to
// kPickerLabelBytes-1 by the parser).
struct PickerView {
  const char* heading;
  const char* emptyText;
  const char* const* labels;
  size_t count;
};

// Renders a picker (conversations or Spaces). Full clear on first call; on
// subsequent calls only repaints rows whose selection or label changed.
void drawPickerList(const PickerView& view, size_t selection);

// Renders the on-device conversation picker through drawPickerList.
void drawConversationList(const ListedConversation* entries, size_t count, size_t selection);

// Clears the picker's repaint tracking so the next picker session starts with
// a full clear. Called when leaving kSelecting.
void endConversationList();

// Draws a single-line status hint (e.g. "CONVERSATION NOT FOUND") at the
// bottom of the picker, replacing any earlier hint, without disturbing rows.
void drawConversationPickerHint(const char* message, uint32_t color);

// Settings screens (#677). A text field: title (size 2), a subtitle, a framed
// field showing `shown` with a cursor at `cursorColumn`, a counter at the right
// ("9/63"), and an error line in red when non-empty.
void drawFieldScreen(const char* title, const char* subtitle, const char* shown,
                     size_t cursorColumn, const char* counter, const char* error);

// A titled screen of up to kLinesScreenMax plain lines (About, confirmations,
// join results). Size-1 white text from y 40, 12 px apart.
constexpr size_t kLinesScreenMax = 6;
void drawLinesScreen(const char* title, uint32_t titleColor, const char* const* lines,
                     size_t count);

// Pairing screens. drawPairingScreen is a full clear on entry; the countdown
// is then refreshed once per second by updatePairingCountdown (cheap partial
// repaint). Neither is ever called while a reply is playing back.
void drawPairingScreen(const PairingInfo& info, uint32_t nowMs);
void updatePairingCountdown(uint32_t nowMs);
void drawPairingDenied();
void drawPairedAs(const char* name);

// READY screen with the "paired as <name>" line, the active-conversation
// title line ("New conversation" when there is no pointer, contract P-31) and
// the active-Space line ("Space: none" when spaceName is null or empty).
// serverLabel: the server's name on a non-production server (#679), shown in
// cyan in place of the WiFi/WS line; nullptr on Production.
void drawReadyScreen(const char* deviceName, const char* activeTitle,
                     const char* spaceName, bool wifiConnected,
                     bool websocketConnected, const char* serverLabel, const char* readyTitle);

}  // namespace bob