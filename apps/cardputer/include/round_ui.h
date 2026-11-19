// Bob — the native round UI of the Waveshare 360x360 screen: layout constants, the
// state-to-pose table, the shortcut chips and the helpers shared by round_ui.cpp and
// round_ui_cards.cpp. Implements display.h, chrome.h, cards.h and the timers band.
#pragma once

#if defined(BOB_BOARD_WAVESHARE_185C)

#include <stddef.h>
#include <stdint.h>

#include <M5Unified.h>

#include "bob_art.h"
#include "bob_emotions.h"
#include "bob_tokens.h"
#include "chrome.h"
#include "types.h"

namespace bob
{

// Bob brand palette and placement grid: design/bob/tokens.json via the generated bob_tokens.h. Change values there.
constexpr uint32_t kRuiGround = bobtok::kInk;
constexpr uint32_t kRuiText = bobtok::kPaper;
constexpr uint32_t kRuiAccent = bobtok::kYellow;
constexpr uint32_t kRuiSky = bobtok::kSky;
constexpr uint32_t kRuiOk = bobtok::kGrass;
constexpr uint32_t kRuiDim = bobtok::kDim;
constexpr uint32_t kRuiBad = bobtok::kCoral; // down / error

// Circle geometry: usable half-width at height y is sqrt(R^2 - (y-R)^2) - margin.
constexpr int16_t kRuiSize = bobtok::kSize;
constexpr int16_t kRuiCenter = bobtok::kCenter;
constexpr int16_t kRuiRadius = bobtok::kRadius;
constexpr int16_t kRuiMargin = bobtok::kMargin;
constexpr int16_t kRuiRingRadius = 172;

// Bob sits in a fixed zone; bob_motion's 232x240 frame is clipped to it so it can never
// overwrite the status arc above (y < kRuiBobClipTop) or the text below.
constexpr int16_t kRuiBobCx = bobtok::kBobCx;
constexpr int16_t kRuiBobCy = bobtok::kBobCy;
constexpr int16_t kRuiBobClipTop = bobtok::kBobClipTop;
constexpr int16_t kRuiBobClipBottom = bobtok::kBobClipBottom;
constexpr int16_t kRuiReadyClipBottom = bobtok::kBobClipBottom;
constexpr int16_t kRuiBodyTop = bobtok::kBodyTop;   // cards, pickers and lists start here
constexpr int16_t kRuiBodyBottom = bobtok::kBodyBottom;
constexpr int16_t kRuiCaptionY = bobtok::kCaptionY; // the one caption line under Bob

// What Bob shows, decided from fsm::state and the screen being drawn, never from text.
// One table: mood -> Bob emotion (bob_emotions.h).
enum class UiMood : uint8_t { kIdle, kListening, kThinking, kSpeaking, kSleeping, kOffline, kError, kUpdating, kHello, kCount };

constexpr BobEmotion kMoodEmotion[static_cast<size_t>(UiMood::kCount)] = {
    BobEmotion::kIdle,      // kIdle: Ready
    BobEmotion::kListening, // kListening
    BobEmotion::kThinking,  // kThinking: awaiting the reply
    BobEmotion::kSpeaking,  // kSpeaking: the reply is playing
    BobEmotion::kSleeping,  // kSleeping
    BobEmotion::kOffline,   // kOffline, denied
    BobEmotion::kError,     // kError
    BobEmotion::kUpdating,  // kUpdating
    BobEmotion::kHello,     // kHello: boot, pairing, paired
};

// State -> mood for the plain status screen. `warn` is true when the caller's title colour
// is red or yellow (an error, offline or denied screen).
inline UiMood moodForState(State state, bool warn)
{
  if (warn) { return state == State::kError ? UiMood::kError : UiMood::kOffline; }
  switch (state)
  {
    case State::kCapturing: return UiMood::kListening;
    case State::kAwaiting:
    case State::kNewConversation: return UiMood::kThinking;
    case State::kUpdating: return UiMood::kUpdating;
    case State::kReady: return UiMood::kIdle;
    case State::kBoot:
    case State::kWifi:
    case State::kSocket:
    case State::kPairing: return UiMood::kHello;
    default: return UiMood::kIdle;
  }
}

// One tappable shortcut chip, in screen coordinates at the current scroll position.
struct RoundChip
{
  int16_t x, y, w, h;
  char key[12];   // the key as the strip text names it ("GO", "c", "n")
  char label[20]; // what it does ("talk")
};

// A finger is on the screen: the shortcut chips show for three seconds.
void roundUiTouch(uint32_t nowMs);

// Shows or hides the info view on the Ready screen (the Cardputer's details: paired name,
// conversation, Space, mode, volume, battery, link state). It closes by itself after 8 s.
void roundUiToggleInfo(uint32_t nowMs);


// Fills up to `max` chips that are at least partly visible; returns how many.
size_t roundUiChips(RoundChip* out, size_t max);

// Touch support. Chips are hidden until a touch: reveal them for 3 s from `nowMs`; they cannot be
// tapped while hidden (or while a toast or the volume pill covers the strip).
void roundUiRevealChips(uint32_t nowMs);
bool roundUiChipsShown(uint32_t nowMs);
// Lights the chip whose key text is `key` for a moment (the press feedback).
void roundUiPressChip(const char* key, uint32_t nowMs);

// The visible rows of the picker or Settings list on screen (one drawPickerList screen).
struct RoundRows
{
  int16_t x, w, firstTop, rowH; // row i spans y firstTop + i * rowH, x .. x + w
  uint8_t visible, top, selection;
};
// False when no picker list is the current screen. Implemented next to drawPickerList.
bool roundUiRows(RoundRows* out);

namespace roundui
{

// The framebuffer: one 360x360 RGB565 PSRAM canvas. Everything draws into it (never to
// M5.Display) and marks what it touched; present() pushes the dirty rects to the panel.
bool fbBegin();
M5Canvas& fb();
void dirty(int16_t x, int16_t y, int16_t w, int16_t h);
void dirtyAll();
void dirtyArc(int from, int to); // the ring annulus between two angles (degrees, 0 = right)
void present(uint32_t nowMs);    // at most 30 Hz, only when something is dirty
void demoHold(bool on);
void demoReplyPages(size_t pages); // `T ui reply`: show at least this many page dots (the demo has three replies)
void demoChips(bool noMic);     // `T ui`: hide the Ready mic chip (a screen that is not Ready)
void demoWifi(int mode);         // `T ui wifi-*`: force the Wi-Fi/server glyph state (0 = real)          // `T ui`: keeps the Ready timer line from repainting over a demo screen
#ifdef BOB_TEST_CONSOLE
void dumpFramebuffer(); // `T screenshot`: the framebuffer as base64 lines over serial
bool demoScreen(const char* name); // `T ui <name>`: one screen with sample data
#endif

// Full width available for text centred at height y (0 outside the circle).
int16_t chordWidth(int16_t y);
// Fills the screen with the ground colour and resets chrome and indicator tracking.
void clearScreen(bool keepBob = false);
// Changes on every clearScreen(): lets a screen's cached layout (picker rows) tell it is stale.
uint32_t screenSerial();
// drawFieldScreen calls this after its clearScreen(): a text field is shown (the on-screen keyboard
// follows). `counter` is its "typed/max" text; a max of 5 or less is a port, so digits only.
void noteFieldScreen(const char* counter);
bool fieldScreen(bool* digitsOnly);
// Shows Bob in `mood` (crossfades when the pose changes) and keeps him animating.
void showBob(UiMood mood, int16_t cy = kRuiBobCy, int16_t clipTop = kRuiBobClipTop,
             int16_t clipBottom = kRuiBobClipBottom);
void hideBob();
bool bobVisible();
// True when (x, y) is on Bob's body as drawn now (full size, or small and high on the reply views): his touch target.
bool bobHit(int16_t x, int16_t y);
// The Ready info view is up (a tap on Bob opened it; it stays until a tap or a swipe right closes it).
bool infoOpen();
// The screen on show takes any key (pairing denied: any key retries), so a tap is Enter. Cleared by clearScreen().
void setTapAnyKey(bool on);
bool tapAnyKey();
// True while a reply plays (the speaker chip shows its waves dimmed, the demo's live speaker at rest).
bool playbackActive();
// The top row Bob may paint (his clip); above kRuiBobClipTop he overlaps the status arc, which is then repainted over him.
int16_t bobClipTop();
// True while Bob steps at 30 fps (a visor-only blink on screen and not paused for playback).
bool bobFastTick();
bool bobForcePending();
bool takeBobFrameDone();  // true once after a whole Bob frame was painted (the status discs under his frame are then repainted)
bool bobSlicePending(); // a Bob frame is half composed: continue it on the next pass
// Scenes (scene_engine.cpp): Bob takes the scene's emotion, then goes back to the current mood's.
void sceneBob(BobEmotion e);
void sceneBobEnd();
// The Ready screen has no room for the chip row: its last line replaces them.
void setReadyScreen(bool on);
// Centred text at y (its middle) in the font; truncated with "..." to the chord (or maxW).
void textCentered(const char* text, int16_t y, uint32_t color, const void* font, int16_t maxW = 0);
// Word-wraps `text` into `out` line spans of at most `maxW` px in the font set on the display.
struct Span
{
  uint16_t start;
  uint8_t length;
};
size_t wrapSpans(const char* text, int16_t maxW, Span* out, size_t max);
// Fonts as opaque pointers so this header stays free of M5GFX.
// Nunito smooth fonts (round_fonts.cpp). fontsBegin() parses them once at boot; until then,
// or if that fails, the accessors return built-in fonts of a similar size.
void fontsBegin();
const void* smallFont();  // caption, 15 px SemiBold
const void* detailFont(); // body, 17 px SemiBold
const void* titleFont();  // title, 24 px ExtraBold
const void* heroFont();   // hero, 40 px ExtraBold
const void* urlFont();    // the pairing address, 14 px SemiBold
const void* microFont();  // the pairing countdown, 12 px SemiBold
const void* codeFont();   // the pairing code, 32 px ExtraBold
void drawDot(int16_t x, int16_t y, uint32_t color);
// "WiFi"/"Server" style label-and-dot pair, centred on one line at y.
void dotsLine(int16_t y, const char* a, uint32_t colorA, const char* b, uint32_t colorB);
// Green when ok, yellow while connecting (Wi-Fi up), red when down.
uint32_t linkColor(bool ok, bool wifiOk);
void resetIndicators();
void infoReset();              // a redraw closed the info view
void infoTick(uint32_t nowMs); // closes it after its time
const StatusLineView& status(); // the last status the chrome was given
// Server (WebSocket) link state for the status icons; Wi-Fi comes from the StatusLineView.
void setServerOk(bool ok);
// Advances Bob and composes his frame into the framebuffer (called from chromeTick).
void tickBob(uint32_t nowMs);

} // namespace roundui

} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
