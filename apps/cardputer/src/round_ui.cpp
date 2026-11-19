// Bob — native round UI, part 1: shared drawing helpers, Bob, the activity rings and
// the status screens (display.h). The chrome is below, the cards in round_ui_cards.cpp.
#if defined(BOB_BOARD_WAVESHARE_185C)

#include "round_ui.h"
#include "round_fonts_adv.h"

#include <M5Unified.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "bob_motion.h"
#include "chrome.h"
#include "chrome_scroll.h"
#include "display.h"
#include "picker_window.h"
#include "round_ring.h"
#include "round_touch.h"
#include "scene_engine.h"
#include "timers_view.h"
#include "turn_trouble.h"

namespace bob
{
namespace fsm
{
extern State state;                                          // state_core.cpp
void journalEvent(const char* event, const String& detail); // state_core.cpp
}

namespace roundui
{
namespace
{
// Continuous motion next to wake-word listening stretched the main loop from 118 ms to 450-960 ms
// (bob_motion journal event). On Ready Bob therefore stays still and only plays a short burst
// (the entry fade) and then holds, except for blinks and looks, which are visor-only redraws; other moods animate at 15 fps.
constexpr bool kIdleStill = true, kPauseWhilePlaying = true;
constexpr uint32_t kMotionIntervalMs = 40; // 25 fps; the rig compose budget is 15 ms (bob_motion journal event)
uint32_t g_playingAt = 0; // last updatePlaybackIndicator call: Bob holds still while a reply plays
uint32_t g_motionAt = 0, g_burstUntil = 0;

bool g_bobOn = false;
bool g_bobFrameDone = false; // a whole Bob frame reached the framebuffer since the chrome last looked
bool g_bobDrawn = false; // Bob's frame is on the framebuffer
bool g_bobKept = false;  // the last clearScreen(true) left that frame in place
int16_t g_keepY0 = 0, g_keepY1 = 0;
uint32_t g_screenSerial = 1; // changes on every clearScreen(): picker rows from an older screen are stale
bool g_fieldScreen = false, g_fieldDigits = false;
bool g_readyScreen = false; // the Ready screen has no room for chips: its hint line replaces them
bool g_tapAnyKey = false;   // the screen takes any key: a tap is Enter
UiMood g_mood = UiMood::kCount;
int16_t g_bobCy = kRuiBobCy, g_clipTop = kRuiBobClipTop, g_clipBottom = kRuiBobClipBottom;

const lgfx::IFont* asFont(const void* f) { return static_cast<const lgfx::IFont*>(f); }
} // namespace

int16_t chordWidth(int16_t y)
{
  const int dy = y - kRuiCenter;
  const int half = kRuiRadius * kRuiRadius - dy * dy;
  if (half <= 0) { return 0; }
  const int w = 2 * (static_cast<int>(sqrtf(static_cast<float>(half))) - kRuiMargin);
  return static_cast<int16_t>(w > 0 ? w : 0);
}

void resetIndicators()
{
  g_playingAt = 0;
}

// keepBob: the screen that follows is a status screen with Bob in the same place, so his last frame stays until the next one (composed band
// by band over the next loop passes) replaces it, instead of a blank hole and a whole-frame compose in one pass.
void clearScreen(bool keepBob)
{
  constexpr int16_t kX0 = kRuiBobCx - 116, kW = 232;
  const bool keep = keepBob && g_bobOn && g_bobDrawn && g_bobCy == kRuiBobCy && g_clipTop == kRuiBobClipTop && g_clipBottom == kRuiBobClipBottom;
  if (keep)
  {
    constexpr int16_t kHalf = bobtok::kBobCy - bobtok::kBobFrameTop;
    const int16_t y0 = g_bobCy - kHalf > g_clipTop ? g_bobCy - kHalf : g_clipTop;
    const int16_t y1 = g_bobCy - kHalf + bobtok::kBobFrameH < g_clipBottom ? g_bobCy - kHalf + bobtok::kBobFrameH : g_clipBottom;
    g_keepY0 = y0;
    g_keepY1 = y1;
    fb().fillRect(0, 0, kRuiSize, y0, kRuiGround);
    fb().fillRect(0, y1, kRuiSize, kRuiSize - y1, kRuiGround);
    fb().fillRect(0, y0, kX0, y1 - y0, kRuiGround);
    fb().fillRect(kX0 + kW, y0, kRuiSize - kX0 - kW, y1 - y0, kRuiGround);
  }
  else { fb().fillScreen(kRuiGround); }
  g_bobKept = keep;
  g_bobDrawn = keep;
  dirtyAll();
  chromeInvalidate();
  timersBandInvalidate();
  resetIndicators();
  g_bobOn = false;
  g_readyScreen = false;
  g_tapAnyKey = false;
  infoReset();
  ringLightInvalidate();
  ++g_screenSerial;
  g_fieldScreen = false;
}

uint32_t screenSerial() { return g_screenSerial; }

void noteFieldScreen(const char* counter)
{
  g_fieldScreen = true;
  // The counter reads "typed/max": a field of at most 5 characters is a port, which takes digits only.
  const char* slash = counter ? strchr(counter, '/') : nullptr;
  g_fieldDigits = slash != nullptr && atoi(slash + 1) > 0 && atoi(slash + 1) <= 5;
  roundtouch::keyboardOnFieldScreen(g_fieldDigits); // draws the on-screen keyboard into the framebuffer
}

bool fieldScreen(bool* digitsOnly)
{
  if (digitsOnly != nullptr) { *digitsOnly = g_fieldDigits; }
  return g_fieldScreen;
}

static bool g_bobForce = false; // a state change wants Bob painted whole at the next chrome pass

// Composes a Bob frame into the framebuffer, clipped to his zone, and marks the rect dirty.
static bool composeBob(uint32_t nowMs, bool force)
{
  fb().setClipRect(0, g_clipTop, kRuiSize, g_clipBottom - g_clipTop);
  const bool drew = bobMotionTick(nowMs, force);
  if (drew) { sceneDrawProps(fb(), nowMs); } // Bob frame just erased the prop slots
  fb().clearClipRect();
  int16_t vx, vy, vw, vh;
  if (bobMotionTakeVisorDirty(&vx, &vy, &vw, &vh)) { dirty(vx, vy, vw, vh); } // a visor-only redraw: a small rectangle
  if (!drew) { return false; }
  g_bobDrawn = true;
  g_bobFrameDone = true;
  constexpr int16_t kHalf = bobtok::kBobCy - bobtok::kBobFrameTop; // half the Bob frame height (bob_motion.cpp)
  const int16_t y0 = g_bobCy - kHalf > g_clipTop ? g_bobCy - kHalf : g_clipTop;
  const int16_t y1 = g_bobCy - kHalf + bobtok::kBobFrameH < g_clipBottom ? g_bobCy - kHalf + bobtok::kBobFrameH : g_clipBottom;
  dirty(kRuiBobCx - 116, y0, 232, y1 - y0);
  ringLightDamage(kRuiBobCx - 116, y0, 232, y1 - y0); // the frame's corners reach the ring band: repaint those angles
  if (force)
  {
    fsm::journalEvent("bob_visible", String("rect=") + (kRuiBobCx - 116) + "," + y0 + ",232," + (y1 - y0));
  }
  return true;
}

void showBob(UiMood mood, int16_t cy, int16_t clipTop, int16_t clipBottom)
{
  if (g_bobOn && mood == g_mood && cy == g_bobCy) { return; }
  const bool kept = g_bobKept && cy == g_bobCy && clipTop == g_clipTop && clipBottom == g_clipBottom;
  if (g_bobKept && !kept) { fb().fillRect(kRuiBobCx - 116, g_keepY0, 232, g_keepY1 - g_keepY0, kRuiGround); } // the old frame is not Bob's place any more
  g_bobKept = false;
  g_mood = mood;
  g_bobCy = cy;
  g_clipTop = clipTop;
  g_clipBottom = clipBottom;
  g_bobOn = true;
  g_burstUntil = millis() + 1400;
  bobMotionSetEmotion(kMoodEmotion[static_cast<size_t>(mood)], kRuiBobCx, cy);
  // Speaking draws Bob smaller and higher (the token grid); every other mood is full size (pairing sets its own below).
  if (mood == UiMood::kSpeaking) { bobMotionSetStage(bobtok::kBobScaleSpeaking, bobtok::kBobRiseSpeaking); }
  else { bobMotionSetStage(1.0f, 0.0f); }
  if (kept) { g_motionAt = 0; } // his last frame is still there: the next ticks replace it band by band
  else { g_bobForce = true; } // composed at the next chrome pass (once, however many state changes one poll made): a repaint erased the area
}

// A scene takes Bob's feeling, and gives him back to the screen's mood when it ends (scene_engine.cpp).
void sceneBob(BobEmotion e)
{
  if (!g_bobOn) { return; }
  g_burstUntil = millis() + 1400;
  bobMotionSetEmotion(e, kRuiBobCx, g_bobCy);
  g_bobForce = true;
}

void sceneBobEnd()
{
  if (!g_bobOn || g_mood == UiMood::kCount) { return; }
  g_burstUntil = millis() + 1400;
  bobMotionSetEmotion(kMoodEmotion[static_cast<size_t>(g_mood)], kRuiBobCx, g_bobCy);
  ringLightSetMode(ringModeForMood(static_cast<uint8_t>(g_mood), status().dnd), millis());
  g_bobForce = true;
}

void hideBob()
{
  g_bobOn = false;
  g_bobDrawn = false;
  g_readyScreen = false; // a card replaces the Ready screen: the chip row is free again
}
bool bobVisible() { return g_bobOn; }
void setTapAnyKey(bool on) { g_tapAnyKey = on; }
bool tapAnyKey() { return g_tapAnyKey; }

// Bob's body at full size spans about 128 x 200 px above his feet (the demo's #bobhit, 126 x 194); the small views scale it about the
// feet and lift it by the stage's rise. Taps around him (most of the glass) stay GO.
bool bobHit(int16_t x, int16_t y)
{
  if (!g_bobOn) { return false; }
  float scale = 1.0f, rise = 0.0f;
  bobMotionStage(&scale, &rise);
  const float feet = bobtok::kBobFeetY + rise, top = feet - 200.0f * scale, half = 64.0f * scale;
  return y >= top && y <= feet && x >= kRuiBobCx - half && x <= kRuiBobCx + half;
}
bool playbackActive() { return g_playingAt != 0; }
int16_t bobClipTop() { return g_clipTop; }
void setReadyScreen(bool on) { g_readyScreen = on; }

// Copy is sentence case: an ALL-CAPS string from the shared state code ("CONNECTING", "NO WI-FI") is
// lowered to "Connecting", "No Wi-Fi"; anything with lower-case letters is left alone.
void sentenceCase(char* text)
{
  bool lower = false, upper = false;
  for (const char* p = text; *p != '\0'; ++p)
  {
    if (*p >= '0' && *p <= '9') { return; } // codes and counters ("ABCD-1234", "40%") stay as they are
    lower = lower || (*p >= 'a' && *p <= 'z');
    upper = upper || (*p >= 'A' && *p <= 'Z');
  }
  if (lower || !upper) { return; }
  bool first = true;
  for (char* p = text; *p != '\0'; ++p)
  {
    if (*p >= 'A' && *p <= 'Z')
    {
      if (!first) { *p = static_cast<char>(*p - 'A' + 'a'); }
      first = false;
    }
  }
  // the few names that keep their capitals
  for (char* p = strstr(text, "i-fi"); p != nullptr; p = strstr(p + 1, "i-fi"))
  {
    if (p > text && (p[-1] == 'w' || p[-1] == 'W')) { p[-1] = 'W'; p[2] = 'F'; }
  }
  for (char* p = strstr(text, "bob"); p != nullptr; p = strstr(p + 1, "bob")) { p[0] = 'B'; }
}

void textCentered(const char* text, int16_t y, uint32_t color, const void* font, int16_t maxW)
{
  auto& d = fb();
  d.setFont(asFont(font));
  d.setTextDatum(middle_center);
  d.setTextColor(color);
  const int16_t half = d.fontHeight() / 2;
  int16_t limit = chordWidth(y - half);
  const int16_t low = chordWidth(y + half);
  if (low < limit) { limit = low; }
  if (maxW > 0 && maxW < limit) { limit = maxW; }
  char buf[96];
  snprintf(buf, sizeof(buf), "%s", text ? text : "");
  sentenceCase(buf);
  size_t n = strlen(buf);
  if (d.textWidth(buf) > limit)
  {
    while (n > 0 && d.textWidth(buf) + d.textWidth("...") > limit) { buf[--n] = '\0'; }
    snprintf(buf + n, sizeof(buf) - n, "...");
  }
  const int16_t tw = d.textWidth(buf);
  const bool caption = y == kRuiCaptionY;
  d.setTextColor(color);
  bool plain = true; // every glyph in ASCII range: lay out with the browser's fractional advances
  for (const char* q = buf; *q != 0; ++q) { plain = plain && *q >= 0x20 && *q <= 0x7E; }
  if (font == detailFont() && plain)
  {
    // The browser places each glyph at the unhinted advance sum (the VLW's integer advances drift a pixel or two within a line):
    // the left edge is the centre minus half the true width, each glyph lands on the nearest pixel.
    int32_t total16 = 0;
    for (const char* q = buf; *q != 0; ++q) { total16 += kBodyAdv16[*q - 0x20]; }
    const float left = kRuiCenter - total16 / 32.0f;
    int32_t acc = 0;
    d.setTextDatum(middle_left);
    char one[2] = {0, 0};
    for (const char* q = buf; *q != 0; ++q)
    {
      one[0] = *q;
      d.drawString(one, static_cast<int32_t>(lroundf(left + acc / 16.0f)), y);
      acc += kBodyAdv16[*q - 0x20];
    }
  }
  else
  {
    d.drawString(buf, kRuiCenter + (tw & 1), y); // odd widths round half up, like the browser centring the demo text
  }
  const int16_t pad = caption ? 8 : 2;
  dirty(kRuiCenter - tw / 2 - pad - 1, y - half - pad, tw + 2 * pad + 2, 2 * half + 2 * pad + 4);
}

size_t wrapSpans(const char* text, int16_t maxW, Span* out, size_t max)
{
  auto& d = fb();
  const size_t length = strlen(text);
  size_t pos = 0, count = 0;
  char buf[64];
  while (count < max)
  {
    while (pos < length && text[pos] == ' ') { ++pos; }
    if (pos >= length) { break; }
    size_t take = 0, lastSpace = 0;
    while (pos + take < length && take + 1 < sizeof(buf))
    {
      memcpy(buf, text + pos, take + 1);
      buf[take + 1] = '\0';
      if (d.textWidth(buf) > maxW) { break; }
      ++take;
      if (text[pos + take] == ' ') { lastSpace = take; }
    }
    if (pos + take < length && lastSpace > 0) { take = lastSpace; }
    if (take == 0) { take = 1; }
    out[count++] = Span{static_cast<uint16_t>(pos), static_cast<uint8_t>(take)};
    pos += take;
  }
  return count;
}

void drawDot(int16_t x, int16_t y, uint32_t color) { fb().fillCircle(x, y, 5, color); }

// True while Bob is on screen, not held still for playback, and mid-blink as a visor-only redraw: the UI loop steps at 30 fps.
bool bobForcePending() { return g_bobOn && g_bobForce; }
bool bobSlicePending() { return g_bobOn && bobMotionSlicePending(); }
bool takeBobFrameDone()
{
  const bool done = g_bobFrameDone;
  g_bobFrameDone = false;
  return done;
}

bool bobFastTick() { return g_bobOn && !(kPauseWhilePlaying && g_playingAt != 0 && millis() - g_playingAt < 200) && bobMotionWantsFastTick(); }

// Advances Bob and paints his frame inside the clip zone (called from chromeTick).
void tickBob(uint32_t nowMs)
{
#ifdef BOB_RUI_NO_MOTION
  return; // measurement switch: Bob stays still
#endif
  if (!g_bobOn) { return; }
  if (g_bobForce)
  {
    g_bobForce = false;
    g_motionAt = nowMs;
    composeBob(nowMs, true);
    return;
  }
  if (!bobMotionSlicePending() && nowMs - g_motionAt < (bobFastTick() ? 33u : kMotionIntervalMs)) { return; }
  if (kPauseWhilePlaying && g_playingAt != 0 && nowMs - g_playingAt < 200) { return; }
  // Ready is wake-word listening, which already saturates the CPU (about 10 ms of work per 10 ms
  // frame), so Bob holds still there after his entry fade: a gesture burst stalled the loop for 2-3 s.
  const bool still = kIdleStill && g_mood == UiMood::kIdle && !sceneActive() && static_cast<int32_t>(nowMs - g_burstUntil) >= 0;
  bobMotionSetStill(still);
  if (still && !bobMotionSlicePending() && !bobMotionNeedsTick(nowMs)) { return; }
  g_motionAt = nowMs;
  composeBob(nowMs, false);
}

// Moves Bob to the speaking pose once reply audio is arriving.
void speakingBob() { showBob(UiMood::kSpeaking, g_bobCy, g_clipTop, g_clipBottom); }

// A label, then a status dot, for a pair of "WiFi"/"Server" items, centred on one line.
void dotsLine(int16_t y, const char* a, uint32_t colorA, const char* b, uint32_t colorB)
{
  auto& d = fb();
  d.setFont(asFont(smallFont()));
  d.setTextDatum(middle_left);
  const int16_t wa = d.textWidth(a), wb = d.textWidth(b);
  int16_t x = kRuiCenter - (wa + wb + 2 * 16 + 18) / 2;
  d.setTextColor(kRuiText);
  d.drawString(a, x, y);
  x += wa + 10;
  drawDot(x, y, colorA);
  x += 18;
  d.drawString(b, x, y);
  x += wb + 10;
  drawDot(x, y, colorB);
  dirty(40, y - 8, 280, 16);
}


uint32_t linkColor(bool ok, bool wifiOk) { return ok ? kRuiOk : (wifiOk ? kRuiAccent : kRuiBad); }

} // namespace roundui
using namespace roundui;

void drawStatus(const char* title, const char* detail, uint32_t titleColor, bool wifiConnected,
                bool websocketConnected)
{
  (void)detail; // the minimal-text screens keep at most one short line
  clearScreen(true);
  setServerOk(websocketConnected);
  const bool warn = titleColor == kColorRed || titleColor == kColorYellow;
  const UiMood mood = moodForState(fsm::state, warn);
  showBob(mood, kRuiBobCy, kRuiBobClipTop, kRuiBobClipBottom);
  ringLightSetMode(ringModeForMood(static_cast<uint8_t>(mood), status().dnd), millis());
  // Thinking and speaking show through Bob and the ring, not words; Listening has its one short line (the approved demo's).
  // The product name ("BOB v2...") is not a caption: Bob himself says it.
  const bool name = strncmp(title, "BOB v2", 6) == 0;
  if (mood == UiMood::kError)
  {
    // An error screen says plainly what is wrong, and that a tap retries (owner UX audit 2026-10-20, #1063).
    const char* plain = plainErrorCaption(title);
    textCentered(plain != nullptr ? plain : title, kRuiCaptionY - 22, bobtok::kCoral, detailFont());
    textCentered("Tap to retry", kRuiCaptionY, kRuiSky, smallFont());
  }
  else if (!name && (mood == UiMood::kHello || mood == UiMood::kListening || mood == UiMood::kOffline || mood == UiMood::kUpdating))
  {
    textCentered(title, kRuiCaptionY, kRuiText, detailFont()); // the demo: white, coral only for Oops
  }
  (void)wifiConnected;
}

void drawBuildTag(const char* version)
{
  char text[32];
  snprintf(text, sizeof(text), "Firmware %s", version);
  textCentered(text, 303, kRuiDim, smallFont()); // above the caption line (the joining screens say "Connecting" under it)
}

// The ring itself lives in round_ring.cpp; these only name the pattern (called every loop pass).
void updateListeningIndicator(uint32_t nowMs) { ringLightSetMode(RingMode::kListening, nowMs); }

void updatePlaybackIndicator(uint32_t nowMs, uint32_t downFrameCount)
{
  // Bob holds still only while reply audio is arriving (the speaker feed); while the server thinks he plays his thinking loop
  // (chin rub, eyes drifting) instead of freezing on the frame the capture ended on (UX audit 2026-10-20, #1063).
  g_playingAt = downFrameCount > 0 ? nowMs : 0;
  if (downFrameCount > 0) { speakingBob(); }
  ringLightSetMode(downFrameCount > 0 ? RingMode::kSpeaking : RingMode::kThinking, nowMs);
}

} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
