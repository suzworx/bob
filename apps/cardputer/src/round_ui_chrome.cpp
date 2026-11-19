// Bob — native round UI, part 3: the chrome (chrome.h): status icons along the top edge, the
// shortcut chips (shown while the screen is touched), toasts and the volume arc.
#if defined(BOB_BOARD_WAVESHARE_185C)

#include <M5Unified.h>
#include <WiFi.h>
#include <esp_heap_caps.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "bob_icons.h"
#include "bob_motion.h"
#include "bob_tokens.h"
#include "chrome.h"
#include "chrome_scroll.h"
#include "round_ring.h"
#include "round_ui.h"
#include "scene_engine.h"
#include "timers_view.h"

namespace bob
{
namespace fsm
{
extern State state;                                          // state_core.cpp
void journalEvent(const char* event, const String& detail); // state_core.cpp
}

using namespace roundui;

namespace
{
const lgfx::IFont* asFont(const void* f) { return static_cast<const lgfx::IFont*>(f); }
} // namespace

// --- Chrome (chrome.h): the status rows above Bob and the shortcut chip row below. ---

namespace
{
// Chips sit in two rows low in the circle, whole chips only: row 0 (y 294) has a 196 px chord, row 1
// (y 316) 160 px. More chips than fit make further pages, shown 1.5 s each while the chips are up.
constexpr int16_t kChipRowX = bobtok::kChipRowX, kChipRowW = bobtok::kChipRowW, kChipRowY = bobtok::kChipRowY, kChipRowH = bobtok::kChipRowH;
constexpr int16_t kChipRow1Dy = bobtok::kChipRow1Dy, kStripH = bobtok::kChipStripH;
constexpr int16_t kChipAvail[2] = {bobtok::kChipAvail0, bobtok::kChipAvail1};
constexpr uint32_t kOverlayMs = bobtok::kChipOverlayMs, kPageMs = bobtok::kChipPageMs, kChipColor = bobtok::kChipBg;
constexpr int16_t kChipGap = bobtok::kChipGap;
constexpr size_t kMaxChips = 10;

struct ChipDef
{
  char key[12];
  char label[20];
  int16_t x, w;
  uint8_t page, row;
};
enum class Overlay : uint8_t { kNone, kToast, kVolume };

M5Canvas g_strip(&M5.Display);
bool g_stripReady = false, g_visible = true, g_statusDirty = true, g_pulseDirty = false, g_stripDirty = true, g_statusValid = false;
StatusLineView g_status;
char g_shortcuts[160] = "";
ChipDef g_chips[kMaxChips];
size_t g_chipCount = 0;
uint8_t g_pages = 1, g_page = 0;
bool g_stripDrawn = false; // the chip strip has pixels on screen that it must erase
uint32_t g_revealAt = 0;
char g_plain[48] = "";
uint32_t g_overlayUntil = 0;
Overlay g_overlay = Overlay::kNone;
char g_toast[40] = "";
constexpr uint32_t kPressMs = 160;
uint32_t g_pressUntil = 0;
char g_pressKey[12] = "";
uint8_t g_volLevel = 0;
bool g_volMuted = false;

// --- Status icons on the top arc (no words; the details live in the info view). ---
// Layout comes from design/bob/tokens.json (bob_tokens.h): N glyphs on radius kArcRadius, evenly spaced and
// symmetric about 12 o'clock, each on a round chip disc. The glyphs are Lucide icons pre-rendered as
// antialiased A8 masks (bob_icons.h), tinted with a palette colour and alpha-blended onto the disc.
constexpr size_t kMaxIcons = 8;
bool g_serverOk = false;
uint32_t g_chipsUntil = 0;
bool g_chipsWasShown = false;
constexpr uint32_t kChipsShownMs = bobtok::kChipShownMs;

bool chipsShown(uint32_t nowMs) { return static_cast<int32_t>(g_chipsUntil - nowMs) > 0; }

// Wi-Fi and server link state: a Wi-Fi fan lit by RSSI and a cloud.
enum class Link : uint8_t { kUp, kDown, kConnecting };
bool g_demoNoMic = false; // `T ui`: the Ready mic chip is only on the Ready screens (fsm::state stays READY under a demo)
int g_demoWifi = 0;      // `T ui wifi-*`: 1 strong, 2 weak, 3 off, 4 connecting; 0 = the real link
int g_wifiArcs = 3;      // RSSI buckets: 3 at -60 dBm or better, 2 at -70, 1 at -80 or worse
uint32_t g_linkPhase = 0; // 250 ms steps while a link connects: the pulse

bool joining() { return fsm::state == State::kBoot || fsm::state == State::kWifi || fsm::state == State::kSocket; }

Link wifiLink()
{
  if (g_demoWifi != 0) { return g_demoWifi == 3 ? Link::kDown : g_demoWifi == 4 ? Link::kConnecting : Link::kUp; }
  return g_status.wifiOk ? Link::kUp : (joining() ? Link::kConnecting : Link::kDown);
}

Link serverLink()
{
  if (g_demoWifi != 0) { return g_demoWifi == 3 ? Link::kDown : g_demoWifi == 4 ? Link::kConnecting : Link::kUp; }
  return g_serverOk ? Link::kUp : (g_status.wifiOk && joining() ? Link::kConnecting : Link::kDown);
}

struct Glyph
{
  const uint8_t* mask; // nullptr: the server badge pill (text)
  uint32_t color;
};
size_t g_iconCount = 0; // glyphs on screen now (the next redraw erases this many discs first)

const uint8_t* wifiMask(Link link, int lit)
{
  if (link == Link::kDown) { return bobicons::kIconWifiOff; }
  switch (lit)
  {
    case 0: return bobicons::kIconWifiZero;
    case 1: return bobicons::kIconWifiLow;
    case 2: return bobicons::kIconWifiHigh;
    default: return bobicons::kIconWifi;
  }
}

const uint8_t* batteryMask(int pct, bool charging)
{
  if (charging) { return bobicons::kIconBatteryCharging; }
  if (pct <= 15) { return bobicons::kIconBatteryWarning; }
  if (pct <= 35) { return bobicons::kIconBatteryLow; }
  if (pct <= 65) { return bobicons::kIconBatteryMedium; }
  return bobicons::kIconBatteryFull;
}

// The glyphs for the current status, in arc order; returns how many.
float micPulse();
uint32_t mix888(uint32_t bg, uint32_t fg, uint32_t alpha);

size_t collectGlyphs(Glyph* out)
{
  size_t n = 0;
  const Link wl = wifiLink(), sl = serverLink();
  if (g_status.micOpen) { out[n++] = {bobicons::kIconMic, bobtok::kCoral}; }
  else if (fsm::state == State::kReady && !g_status.dnd && !g_demoNoMic) { out[n++] = {bobicons::kIconMic, bobtok::kSky}; }
  int lit = 0;
  if (g_demoWifi == 1) { lit = 3; }
  else if (g_demoWifi == 2) { lit = 1; }
  else if (wl == Link::kUp) { lit = g_wifiArcs; }
  else if (wl == Link::kConnecting) { lit = static_cast<int>(g_linkPhase % 3); }
  out[n++] = {wifiMask(wl, lit), wl == Link::kUp ? bobtok::kSky : wl == Link::kConnecting ? bobtok::kYellow : bobtok::kCoral};
  out[n++] = {sl == Link::kDown ? bobicons::kIconCloudOff : bobicons::kIconCloud,
              sl == Link::kUp ? bobtok::kSky : sl == Link::kConnecting ? bobtok::kYellow : bobtok::kCoral};
  if (g_status.muted) { out[n++] = {bobicons::kIconVolumeX, bobtok::kDim}; }
  else
  {
    const uint8_t* v = g_status.volume >= 4 || roundui::playbackActive() ? bobicons::kIconVolume2 : g_status.volume >= 1 ? bobicons::kIconVolume1 : bobicons::kIconVolume; // playing: the full speaker, dimmed and pulsing (the demo)
    uint32_t vc = bobtok::kSky;
    if (roundui::playbackActive())
    {
      // The demo's live speaker: its glyph pulses dim to bright on a solid disc (sixteenth steps keep the sprite cache small).
      const float k = roundf((0.1f + 0.9f * micPulse()) * 16.0f) / 16.0f;
      vc = mix888(bobtok::kDiscColor, bobtok::kSky, static_cast<uint32_t>(k * 255.0f + 0.5f));
    }
    out[n++] = {v, vc};
  }
  if (g_status.batteryPct >= 0)
  {
    const bool charging = g_status.charging == 1;
    out[n++] = {batteryMask(g_status.batteryPct, charging), fsm::state == State::kUpdating ? bobtok::kYellow : charging ? bobtok::kGrass : g_status.batteryPct <= 15 ? bobtok::kCoral : bobtok::kSky}; // the demo: the battery chip waits (yellow) during an update
  }
  if (g_status.dnd) { out[n++] = {bobicons::kIconMoon, bobtok::kYellow}; }
  if (g_status.serverBadge != nullptr && n < kMaxIcons) { out[n++] = {nullptr, bobtok::kYellow}; }
  return n;
}

// Centre of glyph i of n on the top arc: symmetric about 12 o'clock.
void arcPoint(size_t i, size_t n, int16_t* x, int16_t* y)
{
  const float a = (static_cast<float>(i) - static_cast<float>(n - 1) / 2.0f) * bobtok::kArcStepDeg * 0.01745329252f;
  *x = static_cast<int16_t>(lroundf(bobtok::kCenter + bobtok::kArcRadius * sinf(a)));
  *y = static_cast<int16_t>(lroundf(bobtok::kCenter - bobtok::kArcRadius * cosf(a)));
}

uint32_t mix888(uint32_t bg, uint32_t fg, uint32_t alpha)
{
  uint32_t out = 0;
  for (int shift = 0; shift <= 16; shift += 8)
  {
    const uint32_t b = (bg >> shift) & 255, f = (fg >> shift) & 255;
    out |= ((b * (255 - alpha) + f * alpha + 127) / 255) << shift;
  }
  return out;
}

// The listening mic chip pulses as a whole (the demo's .sb.cap: opacity 25% -> 100% -> 25% every 900 ms; the gate's REST render is its start).
float micPulse()
{
#if defined(BOBSIM_FREEZE)
  return 0.25f;
#else
  const float ph = static_cast<float>(millis() % 900u) / 900.0f;
  return 0.25f + 0.75f * (0.5f - 0.5f * cosf(6.2831853f * ph));
#endif
}

constexpr int kChipReach = bobtok::kDiscDiameter / 2 + 2; // a chip's pixels lie within this many px of its centre
constexpr int kChipCache = 24, kSpan = 2 * kChipReach + 1;
struct ChipSprite
{
  const uint8_t* mask = nullptr;
  uint32_t color = 0;
  int32_t key = -1;
  int16_t deg = 0;
  uint8_t a[kSpan * kSpan];
  uint32_t c[kSpan * kSpan];
};
ChipSprite* g_chipCache = nullptr; // PSRAM, allocated on the first chip
uint8_t g_chipNext = 0;

// A chip like the browser draws it: an anti-aliased disc centred on the float arc position, and the glyph (a 2x A8 mask) turned with the
// arc and sampled 2x2 per pixel. `deg` is the chip's turn about 12 o'clock.
void drawGlyph(const Glyph& g, float fx, float fy, float deg)
{
  auto& d = fb();
  constexpr float kR = bobtok::kDiscDiameter / 2.0f;
  constexpr int kS = bobicons::kIconSize;
  if (g.mask == nullptr)
  {
    const int16_t cx = static_cast<int16_t>(lroundf(fx)), cy = static_cast<int16_t>(lroundf(fy)), r = bobtok::kDiscDiameter / 2;
    d.setFont(asFont(smallFont()));
    const int16_t w = d.textWidth(g_status.serverBadge) + 12;
    d.fillSmoothRoundRect(cx - w / 2, cy - r, w, bobtok::kDiscDiameter, r, g.color);
    d.setTextDatum(middle_center);
    d.setTextColor(bobtok::kInk);
    d.drawString(g_status.serverBadge, cx, cy);
    return;
  }
  // The browser snaps the disc's box to whole pixels (left = round(fx - 11)) and snaps the 11 px glyph box inside it separately
  // (left = round(fx - 5.5)), so the glyph can sit a pixel off the disc centre.
  fx = roundf(fx * 10.0f) / 10.0f; // the demo writes left/top with toFixed(1)
  fy = roundf(fy * 10.0f) / 10.0f;
  // The disc box snaps like the browser paints it: x to the nearest pixel, y up to the next (measured on the demo render, every chip).
  const float discCx = floorf(fx - kR + 0.5f) + kR, discCy = ceilf(fy - kR) + kR;
  const float glyphRefY = floorf(fy - kR + 0.5f) + kR; // the glyph's y snaps from the nearest-pixel disc, not the ceiled one
  constexpr float kG = bobtok::kGlyphSize / 2.0f; // the glyph box snaps on its own: left = round(fx - 11 + 5.5)
  // x snaps from the absolute position, y from the already-snapped disc (measured against the demo's render): glyph centre = disc centre + 0.5.
  const float gx = floorf(fx - kG + 0.5f) + kG, gy = (bobtok::kDiscDiameter - bobtok::kGlyphSize) % 2 != 0 ? glyphRefY + 0.5f : discCy; // an odd margin puts the glyph box on a half pixel, which the browser then snaps
  fx = discCx;
  fy = discCy;
  // the listening mic chip fades as a whole; the live speaker only dims its glyph (collectGlyphs)
  const float opacity = g.mask == bobicons::kIconMic && g_status.micOpen ? micPulse() : 1.0f;
  // A chip's pixels only change when its glyph, colour or position does: render it once into a sprite (colour + combined alpha) and blit.
  const int32_t key = static_cast<int32_t>(fx * 10.0f + 0.5f) * 4096 + static_cast<int32_t>(fy * 10.0f + 0.5f);
  if (g_chipCache == nullptr)
  {
    g_chipCache = static_cast<ChipSprite*>(heap_caps_malloc(sizeof(ChipSprite) * kChipCache, MALLOC_CAP_SPIRAM));
    if (g_chipCache == nullptr) { g_chipCache = static_cast<ChipSprite*>(malloc(sizeof(ChipSprite) * kChipCache)); }
    if (g_chipCache == nullptr) { return; }
    for (int i = 0; i < kChipCache; ++i) { g_chipCache[i].mask = nullptr; g_chipCache[i].key = -1; }
  }
  ChipSprite* sp = nullptr;
  for (int ci = 0; ci < kChipCache; ++ci)
  {
    ChipSprite& c = g_chipCache[ci];
    if (c.mask == g.mask && c.color == g.color && c.key == key && c.deg == static_cast<int16_t>(deg)) { sp = &c; break; }
  }
  const int cx0 = static_cast<int>(floorf(fx)), cy0 = static_cast<int>(floorf(fy));
  constexpr int kReach = kChipReach;
  if (sp == nullptr)
  {
    sp = &g_chipCache[g_chipNext];
    g_chipNext = (g_chipNext + 1) % kChipCache;
    sp->mask = g.mask;
    sp->color = g.color;
    sp->key = key;
    sp->deg = static_cast<int16_t>(deg);
    const float rad = deg * 0.01745329252f, ca = cosf(rad), sa = sinf(rad), half = kS / 2.0f;
    auto at = [&](int sx, int sy) -> float { return sx < 0 || sy < 0 || sx >= kS || sy >= kS ? 0.0f : static_cast<float>(g.mask[sy * kS + sx]); };
    for (int dy = -kReach; dy <= kReach; ++dy)
    {
      for (int dx = -kReach; dx <= kReach; ++dx)
      {
        const int X = cx0 + dx, Y = cy0 + dy;
        const int idx = (dy + kReach) * kSpan + (dx + kReach);
        sp->a[idx] = 0;
        const float rx = X + 0.5f - fx, ry = Y + 0.5f - fy; // this pixel's centre, relative to the disc centre
        const float grx = X + 0.5f - gx, gry = Y + 0.5f - gy; // ... and to the glyph centre
        // The disc's coverage of this pixel: a 4x4 grid of sample points inside the circle, like the browser's area coverage.
        int inside = 0;
        for (int sy = 0; sy < 4; ++sy)
        {
          for (int sx = 0; sx < 4; ++sx)
          {
            const float qx = rx + (sx - 1.5f) * 0.25f, qy = ry + (sy - 1.5f) * 0.25f;
            inside += qx * qx + qy * qy <= kR * kR ? 1 : 0;
          }
        }
        if (inside == 0) { continue; }
        const float cover = inside / 16.0f;
        float glyphA = 0.0f;
        for (int sy = 0; sy < 2; ++sy)
        {
          for (int sx = 0; sx < 2; ++sx)
          {
            const float px = grx + (sx - 0.5f) * 0.5f, py = gry + (sy - 0.5f) * 0.5f;
            const float u = (px * ca + py * sa) * 2.0f + half - 0.5f, v = (-px * sa + py * ca) * 2.0f + half - 0.5f;
            const int ix = static_cast<int>(floorf(u)), iy = static_cast<int>(floorf(v));
            const float fu = u - static_cast<float>(ix), fv = v - static_cast<float>(iy);
            glyphA += (at(ix, iy) * (1 - fu) + at(ix + 1, iy) * fu) * (1 - fv) + (at(ix, iy + 1) * (1 - fu) + at(ix + 1, iy + 1) * fu) * fv;
          }
        }
        const float ga = glyphA * 0.25f / 255.0f > 1.0f ? 1.0f : glyphA * 0.25f / 255.0f;
        const float cv = cover > 1.0f ? 1.0f : cover;
        // base*(1-cv)*(1-ga) + disc*cv*(1-ga) + glyph*ga  ==  mix(base, C, A) with A = 1-(1-cv)(1-ga)
        const float A = 1.0f - (1.0f - cv) * (1.0f - ga);
        if (A <= 0.0f) { continue; }
        const float wd = cv * (1.0f - ga) / A, wg = ga / A;
        uint32_t col = 0;
        for (int shift = 0; shift <= 16; shift += 8)
        {
          const float v8 = ((bobtok::kDiscColor >> shift) & 255) * wd + ((g.color >> shift) & 255) * wg;
          col |= static_cast<uint32_t>(v8 + 0.5f > 255.0f ? 255.0f : v8 + 0.5f) << shift;
        }
        sp->c[idx] = col;
        sp->a[idx] = static_cast<uint8_t>(A * 255.0f + 0.5f);
      }
    }
  }
  const uint32_t op = static_cast<uint32_t>(opacity * 255.0f + 0.5f);
  for (int dy = -kReach; dy <= kReach; ++dy)
  {
    for (int dx = -kReach; dx <= kReach; ++dx)
    {
      const int X = cx0 + dx, Y = cy0 + dy;
      if (X < 0 || Y < 0 || X >= kRuiSize || Y >= kRuiSize) { continue; }
      const int idx = (dy + kReach) * kSpan + (dx + kReach);
      const uint32_t a = sp->a[idx];
      if (a == 0) { continue; }
      const auto base = d.readPixelRGB(X, Y);
      const uint32_t al = op == 255 ? a : (a * op + 127) / 255;
      d.drawPixel(X, Y, mix888((static_cast<uint32_t>(base.r) << 16) | (static_cast<uint32_t>(base.g) << 8) | base.b, sp->c[idx], al));
    }
  }
}

// The wide dirty band of the arc (glyph discs reach r + the disc radius from the centre).
// True when the outermost disc of the arc hangs below the top row Bob paints (clip top), so each Bob frame covers a bit of it.
bool statusReachesBob()
{
  if (g_iconCount < 2) { return false; }
  const float a = (static_cast<float>(g_iconCount) - 1.0f) / 2.0f * bobtok::kArcStepDeg * 0.01745329252f;
  const float bottom = bobtok::kCenter - bobtok::kArcRadius * cosf(a) + bobtok::kDiscDiameter / 2.0f + 2.0f;
  return bottom > static_cast<float>(roundui::bobClipTop());
}

// The chip that pulses (the mic while listening, the speaker while a reply plays), or -1.
int pulseIndex()
{
  Glyph glyphs[kMaxIcons];
  const size_t n = collectGlyphs(glyphs);
  for (size_t i = 0; i < n; ++i)
  {
    const bool speaker = glyphs[i].mask == bobicons::kIconVolume2 || glyphs[i].mask == bobicons::kIconVolume1 || glyphs[i].mask == bobicons::kIconVolume;
    if ((glyphs[i].mask == bobicons::kIconMic && g_status.micOpen) || (speaker && roundui::playbackActive())) { return static_cast<int>(i); }
  }
  return -1;
}

// `only` >= 0: redraw just that chip (the pulse); -1: the whole arc.
void drawStatusRows(int only)
{
  Glyph glyphs[kMaxIcons];
  const size_t n = collectGlyphs(glyphs);
  constexpr int16_t kR = bobtok::kDiscDiameter / 2;
  for (size_t i = 0; i < g_iconCount; ++i)
  {
    if (only >= 0 && static_cast<int>(i) != only) { continue; }
    int16_t x, y;
    arcPoint(i, g_iconCount, &x, &y);
    fb().fillCircle(x, y, kR + 2, bobtok::kInk);
  }
  for (size_t i = 0; i < n; ++i)
  {
    if (only >= 0 && static_cast<int>(i) != only) { continue; }
    const float ang = (static_cast<float>(i) - static_cast<float>(n - 1) / 2.0f) * bobtok::kArcStepDeg;
    drawGlyph(glyphs[i], bobtok::kCenter + bobtok::kArcRadius * sinf(ang * 0.01745329252f), bobtok::kCenter - bobtok::kArcRadius * cosf(ang * 0.01745329252f), 0.0f); // the glyphs stay upright (the curated demo does not turn them)
  }
  g_iconCount = n;
  if (only >= 0)
  {
    int16_t mx, my;
    arcPoint(static_cast<size_t>(only), n, &mx, &my);
    dirty(mx - kR - 3, my - kR - 3, 2 * kR + 6, 2 * kR + 6);
  }
  else { dirty(bobtok::kCenter - 140, 0, 280, 128); }
}

// Flows the chips into rows and pages (whole chips only) and centres each row.
void layoutChips()
{
  uint8_t page = 0, row = 0;
  int16_t used = 0;
  size_t rowStart = 0;
  auto centreRow = [&](size_t end) {
    const int16_t offset = (kChipAvail[row] - (used > 0 ? used - kChipGap : 0)) / 2 + (kChipRowW - kChipAvail[row]) / 2;
    for (size_t j = rowStart; j < end; ++j) { g_chips[j].x = static_cast<int16_t>(g_chips[j].x + offset); }
    rowStart = end;
  };
  for (size_t i = 0; i < g_chipCount; ++i)
  {
    if (used > 0 && used + g_chips[i].w > kChipAvail[row])
    {
      centreRow(i);
      if (row == 0) { row = 1; }
      else { row = 0; ++page; }
      used = 0;
    }
    g_chips[i].page = page;
    g_chips[i].row = row;
    g_chips[i].x = used;
    used = static_cast<int16_t>(used + g_chips[i].w + kChipGap);
  }
  centreRow(g_chipCount);
  g_pages = static_cast<uint8_t>(page + 1);
}

// "[key] label" pairs into chips; adjacent keys share one chip. No brackets: a plain line.
void parseShortcuts(const char* text)
{
  g_chipCount = 0;
  g_plain[0] = '\0';
  if (strchr(text, '[') == nullptr) { snprintf(g_plain, sizeof(g_plain), "%s", text); return; }
  g_strip.setFont(asFont(smallFont()));
  const char* p = text;
  int16_t x = 0;
  while (*p != '\0' && g_chipCount < kMaxChips)
  {
    if (*p != '[') { ++p; continue; }
    ChipDef& c = g_chips[g_chipCount];
    c.key[0] = c.label[0] = '\0';
    do
    {
      const char* end = strchr(p, ']');
      if (end == nullptr) { return; }
      char key[12];
      snprintf(key, sizeof(key), "%.*s", static_cast<int>(end - p - 1 < 11 ? end - p - 1 : 11), p + 1);
      if (strcmp(key, "GO") == 0) { snprintf(key, sizeof(key), "BOOT/tap"); }
      snprintf(c.key + strlen(c.key), sizeof(c.key) - strlen(c.key), "%s%s", c.key[0] ? " " : "", key);
      p = end + 1;
    } while (*p == '[');
    const char* next = strchr(p, '[');
    const size_t len = next ? static_cast<size_t>(next - p) : strlen(p);
    size_t from = 0, to = len;
    while (from < to && p[from] == ' ') { ++from; }
    while (to > from && p[to - 1] == ' ') { --to; }
    snprintf(c.label, sizeof(c.label), "%.*s", static_cast<int>(to - from < 19 ? to - from : 19), p + from);
    c.w = static_cast<int16_t>(g_strip.textWidth(c.key) + (c.label[0] ? g_strip.textWidth(c.label) + 6 : 0) + 18);
    ++g_chipCount;
    p += len;
  }
  layoutChips();
}

void drawChip(const ChipDef& c, int16_t x)
{
  const int16_t y0 = c.row == 0 ? 0 : kChipRow1Dy;
  const bool hot = g_pressUntil != 0 && static_cast<int32_t>(g_pressUntil - millis()) > 0 && strcmp(c.key, g_pressKey) == 0;
  g_strip.fillRoundRect(x, y0, c.w, kChipRowH, bobtok::kChipRadius, hot ? bobtok::kChipBgHot : kChipColor);
  g_strip.setTextColor(hot ? kRuiGround : kRuiAccent);
  g_strip.drawString(c.key, x + 9, y0 + kChipRowH / 2);
  if (c.label[0] == '\0') { return; }
  g_strip.setTextColor(hot ? kRuiGround : kRuiText);
  g_strip.drawString(c.label, x + 9 + g_strip.textWidth(c.key) + 6, y0 + kChipRowH / 2);
}

void pill(const char* text, uint32_t bg, uint32_t fg)
{
  const int16_t x0 = (kChipRowW - kChipAvail[1]) / 2;
  g_strip.fillRoundRect(x0, kChipRow1Dy, kChipAvail[1], kChipRowH, bobtok::kChipRadius, bg);
  g_strip.setTextColor(fg);
  g_strip.setTextDatum(middle_center);
  g_strip.drawString(text, kChipRowW / 2, kChipRow1Dy + kChipRowH / 2);
  g_strip.setTextDatum(middle_left);
}

uint8_t currentPage(uint32_t nowMs) { return g_pages > 1 ? static_cast<uint8_t>(((nowMs - g_revealAt) / kPageMs) % g_pages) : 0; }

void renderStrip()
{
  if (fieldScreen(nullptr)) { return; } // the on-screen keyboard owns y 204-316: no chips or toasts over it
  // The strip shares y 294-334 with the lowest text line: with nothing to show, leave the pixels alone
  // (only erase what the strip drew itself).
  const bool content = g_overlay != Overlay::kNone || chipsShown(millis());
  if (!content && !g_stripDrawn) { return; }
  g_stripDrawn = content;
  g_strip.fillSprite(kRuiGround);
  g_strip.setFont(asFont(smallFont()));
  g_strip.setTextDatum(middle_left);
  if (g_overlay == Overlay::kToast) { pill(g_toast, kRuiAccent, kRuiGround); }
  else if (g_overlay == Overlay::kVolume)
  {
    char text[16];
    if (g_volMuted) { snprintf(text, sizeof(text), "Muted"); }
    else { snprintf(text, sizeof(text), "Vol %u", static_cast<unsigned int>(g_volLevel)); }
    pill(text, kChipColor, kRuiAccent);
  }
  else if (!chipsShown(millis())) { /* chips fade out three seconds after the last touch */ }
  else if (g_chipCount == 0) { pill(g_plain, kChipColor, kRuiText); }
  else
  {
    for (size_t i = 0; i < g_chipCount; ++i)
    {
      if (g_chips[i].page == g_page) { drawChip(g_chips[i], g_chips[i].x); }
    }
  }
  g_strip.pushSprite(&fb(), kChipRowX, kChipRowY);
  dirty(kChipRowX, kChipRowY, kChipRowW, kStripH);
}

// The volume level as an arc along the bottom edge, just outside the text margin.
void volumeArc(bool show)
{
  constexpr int kFrom = 30, kTo = 150;
  dirty(20, 250, 320, 100);
  auto& d = fb();
  d.fillArc(kRuiCenter, kRuiCenter, 160, 166, kFrom, kTo, show ? kChipColor : kRuiGround);
  const int fill = g_volMuted ? 0 : kFrom + (kTo - kFrom) * g_volLevel / kVolumeMax;
  if (show && fill > kFrom) { d.fillArc(kRuiCenter, kRuiCenter, 160, 166, kFrom, fill, kRuiAccent); }
}

void startOverlay(Overlay overlay, uint32_t nowMs)
{
  if (g_overlay == Overlay::kVolume && overlay != Overlay::kVolume) { volumeArc(false); }
  g_overlay = overlay;
  g_overlayUntil = nowMs + kOverlayMs;
  g_stripDirty = true;
}
} // namespace

bool StatusLineView::operator==(const StatusLineView& o) const
{
  return mode == o.mode && wakeFallback == o.wakeFallback && micOpen == o.micOpen && muted == o.muted &&
         volume == o.volume && dnd == o.dnd && batteryPct == o.batteryPct && charging == o.charging &&
         wifiOk == o.wifiOk && serverBadge == o.serverBadge;
}

void chromeBegin()
{
  g_stripReady = g_strip.createSprite(kChipRowW, kStripH) != nullptr;
  fontsBegin();
  fbBegin();
  bobMotionSetTargetCanvas(&fb());
  {
    // The ground colour through every path: the constant the art is flattened onto, what a canvas
    // fill stores (raw, as pushed to the panel) and what the fill reads back.
    char hex[64];
    snprintf(hex, sizeof(hex), "bob_ground=0x%04X,fb_raw=0x%04X,rgb888=0x%06lX", kBobGround,
             static_cast<unsigned int>(fb().readPixelValue(180, 180) & 0xFFFF), static_cast<unsigned long>(kRuiGround));
    fsm::journalEvent("ui_ground", String(hex));
  }
  if (!bobMotionBegin()) { fsm::journalEvent("bob_motion", String("psram=missing")); }
}

const StatusLineView& roundui::status() { return g_status; }

// Redraws the status icons when the Wi-Fi arcs (RSSI bucket) or a connecting pulse step change.
static void watchLinks(uint32_t nowMs)
{
  static uint32_t checkedAt = 0;
  if (nowMs - checkedAt < 250) { return; }
  checkedAt = nowMs;
  int arcs = g_wifiArcs;
  if (g_status.wifiOk)
  {
    const int rssi = WiFi.RSSI();
    arcs = rssi >= -60 ? 3 : rssi >= -70 ? 2 : 1;
  }
  static bool wasPlaying = false;
  const bool playing = roundui::playbackActive();
  if (playing != wasPlaying) { wasPlaying = playing; g_statusDirty = true; }
  const bool micPulsing = (g_status.micOpen && fsm::state == State::kCapturing) || playing;
  const bool pulsing = wifiLink() == Link::kConnecting || serverLink() == Link::kConnecting || micPulsing;
  const uint32_t phase = pulsing ? nowMs / (micPulsing ? 90u : 250u) : g_linkPhase; // the mic chip fades smoothly, the link chips step
  if (arcs != g_wifiArcs || phase != g_linkPhase)
  {
    const bool micOnly = arcs == g_wifiArcs && micPulsing && wifiLink() != Link::kConnecting && serverLink() != Link::kConnecting;
    g_wifiArcs = arcs;
    g_linkPhase = phase;
    if (micOnly) { g_pulseDirty = true; } // only that chip's opacity changes
    else { g_statusDirty = true; }
  }
}

void roundui::demoChips(bool noMic)
{
  g_demoNoMic = noMic;
  g_statusDirty = true;
}

void roundui::demoWifi(int mode)
{
  g_demoWifi = mode;
  g_statusDirty = true;
}

void roundUiRevealChips(uint32_t nowMs) { roundUiTouch(nowMs); }

bool roundUiChipsShown(uint32_t nowMs)
{
  return g_stripReady && g_visible && g_overlay == Overlay::kNone && g_chipCount > 0 && chipsShown(nowMs) && !fieldScreen(nullptr);
}

void roundUiPressChip(const char* key, uint32_t nowMs)
{
  snprintf(g_pressKey, sizeof(g_pressKey), "%s", key);
  g_pressUntil = nowMs + kPressMs;
  g_stripDirty = true;
}

void roundUiTouch(uint32_t nowMs)
{
  if (!chipsShown(nowMs))
  {
    g_stripDirty = true;
    g_revealAt = nowMs;
    g_page = 0;
  }
  g_chipsUntil = nowMs + kChipsShownMs;
  if (g_chipsUntil == 0) { g_chipsUntil = 1; }
}

void roundui::setServerOk(bool ok)
{
  if (ok == g_serverOk) { return; }
  g_serverOk = ok;
  g_statusDirty = true;
}

void chromeSetVisible(bool visible)
{
  if (visible && !g_visible) { chromeInvalidate(); }
  g_visible = visible;
}

void chromeInvalidate()
{
  g_statusDirty = true;
  g_stripDirty = true;
  g_stripDrawn = false; // callers cleared the screen: nothing of the strip is on it
}

void chromeSetStatus(const StatusLineView& view)
{
  if (g_statusValid && view == g_status) { return; }
  g_status = view;
  g_statusValid = true;
  g_statusDirty = true;
}

void chromeSetShortcuts(const char* text, uint32_t nowMs)
{
  if (strncmp(text, g_shortcuts, sizeof(g_shortcuts)) == 0) { return; }
  snprintf(g_shortcuts, sizeof(g_shortcuts), "%s", text);
  if (g_stripReady) { parseShortcuts(g_shortcuts); }
  g_page = 0;
  g_stripDirty = true;
}

void chromeToast(const char* text, uint32_t nowMs)
{
  snprintf(g_toast, sizeof(g_toast), "%s", text);
  startOverlay(Overlay::kToast, nowMs);
}

void chromeVolumeBar(uint8_t level, bool muted, uint32_t nowMs)
{
  g_volLevel = level;
  g_volMuted = muted;
  startOverlay(Overlay::kVolume, nowMs);
  volumeArc(true);
}

size_t roundUiChips(RoundChip* out, size_t max)
{
  if (!g_stripReady || !g_visible || !chipsShown(millis())) { return 0; }
  size_t n = 0;
  for (size_t i = 0; i < g_chipCount && n < max; ++i)
  {
    if (g_chips[i].page != g_page) { continue; }
    out[n].x = static_cast<int16_t>(kChipRowX + g_chips[i].x);
    out[n].y = static_cast<int16_t>(kChipRowY + (g_chips[i].row == 0 ? 0 : kChipRow1Dy));
    out[n].w = g_chips[i].w;
    out[n].h = kChipRowH;
    snprintf(out[n].key, sizeof(out[n].key), "%s", g_chips[i].key);
    snprintf(out[n].label, sizeof(out[n].label), "%s", g_chips[i].label);
    ++n;
  }
  return n;
}

namespace
{
uint32_t g_lastTick = 0, g_gapMax = 0, g_statsAt = 0;

// Every 10 s while Bob animates: frame cost and the longest gap between loop passes, so the
// motion's effect on the main loop (and so on audio feeding) shows in the journal.
void logMotion(uint32_t nowMs)
{
  if (g_lastTick != 0 && nowMs - g_lastTick > g_gapMax) { g_gapMax = nowMs - g_lastTick; }
  g_lastTick = nowMs;
  if (nowMs - g_statsAt < 10000) { return; }
  g_statsAt = nowMs;
  const BobMotionStats s = bobMotionTakeStats();
  if (s.frames == 0 && s.visorFrames == 0) { return; }
  const uint32_t n = s.frames ? s.frames : 1;
  fsm::journalEvent("bob_motion", String("rig=") + (bobMotionRigActive() ? 1 : 0) + ",frames=" + s.frames + ",avg_us=" + s.totalUs / n +
                                      ",max_us=" + s.maxUs + ",compose_avg_us=" + s.rotateUs / n + ",compose_max_us=" + s.composeMaxUs +
                                      ",push_avg_us=" + s.pushUs / n + ",slow=" + s.slowFrames + ",cache_hit=" + s.cacheHits + ",cache_miss=" + s.cacheMisses + ",bake_hit=" + s.bakeHits + ",bake_miss=" + s.bakeMisses +
                                      ",visor=" + s.visorFrames + "/" + (s.visorFrames ? s.visorUs / s.visorFrames : 0) +
                                      ",window_ms=" + s.windowMs + ",loop_gap_max_ms=" + g_gapMax);
  g_gapMax = 0;
}
} // namespace

static void chromePass(uint32_t nowMs)
{
  watchLinks(nowMs);
  // Bob and the ring share one 25 fps clock, so their dirty rects go out in one present().
  static uint32_t uiFrameAt = 0;
  if (roundui::bobForcePending() || roundui::bobSlicePending() || nowMs - uiFrameAt >= (roundui::bobFastTick() ? 33u : 50u)) // a visor-only blink steps at 30 fps
  {
    uiFrameAt = nowMs;
    const uint32_t a0 = micros();
    tickBob(nowMs);
    const uint32_t a1 = micros();
    sceneTick(nowMs);
    const uint32_t a2 = micros();
    ringLightTick(nowMs);
    const uint32_t a3 = micros();
    if (a3 - a0 > 100000)
    {
      fsm::journalEvent("chrome_split", String("bob_ms=") + (a1 - a0) / 1000 + ",scene_ms=" + (a2 - a1) / 1000 + ",ring_ms=" + (a3 - a2) / 1000);
    }
    if (roundui::takeBobFrameDone() && statusReachesBob()) { g_statusDirty = true; } // the outer discs reach into Bob's frame: repaint them over it
  }
  infoTick(nowMs);
  logMotion(nowMs);
  // The status arc stays up while pairing (the demo shows it); only the shortcut strip is hidden then.
  if (!g_visible && fsm::state != State::kPairing) { return; }
  if (g_statusDirty && g_statusValid)
  {
    const uint32_t s0 = micros();
    drawStatusRows(-1);
    if (micros() - s0 > 50000) { fsm::journalEvent("chrome_split", String("status_ms=") + (micros() - s0) / 1000); }
    g_statusDirty = false;
    g_pulseDirty = false;
  }
  else if (g_pulseDirty && g_statusValid)
  {
    drawStatusRows(pulseIndex());
    g_pulseDirty = false;
  }
  if (!g_visible) { return; }
  if (!g_stripReady) { return; }
  if (g_overlay != Overlay::kNone && static_cast<int32_t>(nowMs - g_overlayUntil) >= 0)
  {
    if (g_overlay == Overlay::kVolume) { volumeArc(false); }
    g_overlay = Overlay::kNone;
    g_stripDirty = true;
  }
  if (g_pressUntil != 0 && static_cast<int32_t>(g_pressUntil - nowMs) <= 0) { g_pressUntil = 0; g_stripDirty = true; }
  const bool shownNow = chipsShown(nowMs);
  if (shownNow != g_chipsWasShown)
  {
    g_chipsWasShown = shownNow;
    g_stripDirty = true;
  }
  if (shownNow && g_overlay == Overlay::kNone && currentPage(nowMs) != g_page)
  {
    g_page = currentPage(nowMs);
    g_stripDirty = true;
  }
  if (!g_stripDirty) { return; }
  renderStrip();
  g_stripDirty = false;
}

void chromeTick(uint32_t nowMs)
{
  static uint8_t slowPasses = 0;
  const uint32_t t0 = micros();
  chromePass(nowMs);
  const uint32_t t1 = micros();
  present(nowMs);
  const uint32_t us = micros() - t0;
  if (t1 - t0 > 30000) { fsm::journalEvent("loop_slow_phase", String("phase=chrome_pass,ms=") + (t1 - t0) / 1000); }
  if (us - (t1 - t0) > 30000) { fsm::journalEvent("loop_slow_phase", String("phase=present,ms=") + (us - (t1 - t0)) / 1000); }
  // Escaped-defect guard: the UI's share of a loop pass must stay small. Ten passes in a row
  // over 50 ms on Ready means it is starving capture and earcons.
  if (fsm::state == State::kReady && us > 50000)
  {
    if (++slowPasses == 10) { fsm::journalEvent("loop_starved", String("ui_ms=") + us / 1000); slowPasses = 0; }
  }
  else { slowPasses = 0; }
}

} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
