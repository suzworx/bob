// Bob — the round UI's framebuffer: a 360x360 RGB565 PSRAM canvas that every draw goes into,
// a dirty-rect list, and present(), the only code that touches the panel. Small direct draws
// became thousands of tiny QSPI windows; one canvas and a few pushed rects replace them.
#if defined(BOB_BOARD_WAVESHARE_185C)

#include <math.h>
#include <string.h>

#include "round_ui.h"
#include "ws185_hw.h"

namespace bob
{
namespace fsm
{
void journalEvent(const char* event, const String& detail); // state_core.cpp
}

namespace roundui
{
namespace
{
constexpr size_t kMaxRects = 48;
constexpr uint32_t kPresentIntervalMs = 33; // 30 Hz cap
constexpr int32_t kFullFrameShare = 85;     // % of the screen above which the whole frame is pushed

struct Rect
{
  int16_t x0, y0, x1, y1; // [x0, x1) x [y0, y1)
  bool keep;              // a ring sector box: never merged with anything
};

M5Canvas g_fb(&M5.Display);
bool g_ok = false, g_all = false;
Rect g_rects[kMaxRects];
size_t g_count = 0;
uint32_t g_presentAt = 0, g_statsAt = 0, g_n = 0, g_totalUs = 0, g_maxUs = 0, g_px = 0, g_rectSum = 0, g_fullPushes = 0;

bool touches(const Rect& a, const Rect& b) { return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1; }
Rect unite(const Rect& a, const Rect& b)
{
  return Rect{a.x0 < b.x0 ? a.x0 : b.x0, a.y0 < b.y0 ? a.y0 : b.y0, a.x1 > b.x1 ? a.x1 : b.x1, a.y1 > b.y1 ? a.y1 : b.y1};
}
int32_t area(const Rect& r) { return static_cast<int32_t>(r.x1 - r.x0) * (r.y1 - r.y0); }
} // namespace

// Square-overlay experiments (#1065), all OFF unless the build defines them (env waveshare-s3-185c-hil-exp):
//   BOB_UI_FULL_PUSH   every present() sends the whole frame (no partial dirty-rect updates)
//   BOB_UI_TINT_RECTS  after each push, outline the pushed rect on the glass only (not in the framebuffer)
//   BOB_UI_TE_SYNC     enable the panel's tearing-effect output (0x35) and start each push on its pulse
//                        (TE is GPIO 18 on the Waveshare 1.85C, per the muse-gadget-sdk board file)
#ifdef BOB_UI_TE_SYNC
constexpr int kTePin = 18;
void waitForTe()
{
  const uint32_t t0 = micros();
  while (digitalRead(kTePin) == HIGH && micros() - t0 < 20000) {}
  while (digitalRead(kTePin) == LOW && micros() - t0 < 40000) {}
}
#endif

bool fbBegin()
{
  g_fb.setPsram(true);
  g_fb.setColorDepth(16);
  g_ok = g_fb.createSprite(kRuiSize, kRuiSize) != nullptr;
  if (g_ok) { g_fb.fillScreen(kRuiGround); }
  g_all = true;
#ifdef BOB_UI_TE_SYNC
  pinMode(kTePin, INPUT);
  const uint8_t teMode = 0x00; // V-blank only
  ws185::panelCommand(0x35, &teMode, 1);
#endif
  return g_ok;
}

M5Canvas& fb() { return g_fb; }

void dirtyAll() { g_all = true; }

namespace
{
void addDirty(int16_t x, int16_t y, int16_t w, int16_t h, bool keep)
{
  if (g_all || w <= 0 || h <= 0) { return; }
  Rect r{x < 0 ? int16_t(0) : x, y < 0 ? int16_t(0) : y, static_cast<int16_t>(x + w > kRuiSize ? kRuiSize : x + w),
         static_cast<int16_t>(y + h > kRuiSize ? kRuiSize : y + h), keep};
  if (r.x1 <= r.x0 || r.y1 <= r.y0) { return; }
  for (size_t i = 0; i < g_count && !keep; ++i)
  {
    if (g_rects[i].keep) { continue; }
    // Merge only overlapping rects whose union wastes little: the ring's sector boxes must stay apart.
    const Rect both = unite(g_rects[i], r);
    if (touches(g_rects[i], r) && area(both) * 2 <= (area(g_rects[i]) + area(r)) * 3) { g_rects[i] = both; return; }
  }
  if (g_count == kMaxRects)
  {
    g_all = true; // out of slots: one full push is cheaper than a pile of unions
    return;
  }
  g_rects[g_count++] = r;
}
} // namespace

void dirty(int16_t x, int16_t y, int16_t w, int16_t h) { addDirty(x, y, w, h, false); }

void dirtyArc(int from, int to)
{
  constexpr int kStep = 15; // finer boxes waste less of the ring's empty middle
  for (int a = from; a < to; a += kStep)
  {
    const int b = a + kStep < to ? a + kStep : to;
    float x0 = 1e9f, x1 = -1e9f, y0 = 1e9f, y1 = -1e9f;
    // The box of the whole band (radius 160-182; the ring is 162-180), sampled every 10 degrees so the
    // arc's bulge between the end points stays inside it.
    for (int t = a;; t += 10)
    {
      const int tt = t < b ? t : b;
      for (int r = kRuiRingRadius - 12; r <= kRuiRingRadius + 10; r += 22)
      {
        const float x = kRuiCenter + r * cosf(tt * 0.0174533f), y = kRuiCenter + r * sinf(tt * 0.0174533f);
        x0 = x < x0 ? x : x0; x1 = x > x1 ? x : x1; y0 = y < y0 ? y : y0; y1 = y > y1 ? y : y1;
      }
      if (tt == b) { break; }
    }
    addDirty(static_cast<int16_t>(x0) - 2, static_cast<int16_t>(y0) - 2, static_cast<int16_t>(x1 - x0) + 6, static_cast<int16_t>(y1 - y0) + 6, true);
  }
}

void present(uint32_t nowMs)
{
  if (!g_ok || (!g_all && g_count == 0) || nowMs - g_presentAt < kPresentIntervalMs) { return; }
  g_presentAt = nowMs;
  const uint32_t t0 = micros();
  int32_t total = 0;
  for (size_t i = 0; i < g_count && !g_all; ++i)
  {
    Rect& r = g_rects[i]; // the ST77916 wants even window bounds
    r.x0 &= ~1; r.y0 &= ~1; r.x1 = (r.x1 + 1) & ~1; r.y1 = (r.y1 + 1) & ~1;
    total += area(r);
  }
  g_rectSum += g_all ? 0 : static_cast<uint32_t>(g_count);
  if (total * 100 > kFullFrameShare * kRuiSize * kRuiSize) { g_all = true; }
#ifdef BOB_UI_FULL_PUSH
  g_all = true;
#endif
  g_fullPushes += g_all ? 1 : 0;
  auto& d = M5.Display;
#ifdef BOB_UI_TE_SYNC
  waitForTe();
#endif
  d.startWrite();
  if (g_all)
  {
    g_fb.pushSprite(&d, 0, 0);
    g_px += kRuiSize * kRuiSize;
  }
  else
  {
    for (size_t i = 0; i < g_count; ++i)
    {
      d.setClipRect(g_rects[i].x0, g_rects[i].y0, g_rects[i].x1 - g_rects[i].x0, g_rects[i].y1 - g_rects[i].y0);
      g_fb.pushSprite(&d, 0, 0);
    }
    d.clearClipRect();
    g_px += total;
  }
  d.endWrite();
#ifdef BOB_UI_TINT_RECTS
  {
    static uint8_t tint = 0;
    static const uint16_t kTints[] = {0xF800, 0x07E0, 0xFFE0, 0x07FF};
    const uint16_t c = kTints[tint++ & 3];
    if (g_all) { d.drawRect(0, 0, kRuiSize, kRuiSize, c); }
    for (size_t i = 0; i < g_count && !g_all; ++i) { d.drawRect(g_rects[i].x0, g_rects[i].y0, g_rects[i].x1 - g_rects[i].x0, g_rects[i].y1 - g_rects[i].y0, c); }
  }
#endif
  g_all = false;
  g_count = 0;
  const uint32_t us = micros() - t0;
  ++g_n; g_totalUs += us; g_maxUs = us > g_maxUs ? us : g_maxUs;
  if (nowMs - g_statsAt >= 10000)
  {
    if (g_statsAt != 0 && g_n > 0)
    {
      fsm::journalEvent("ui_present", String("pushes=") + g_n + ",avg_ms=" + g_totalUs / g_n / 1000 + ",max_ms=" + g_maxUs / 1000 +
                                          ",avg_px=" + g_px / g_n + ",avg_rects=" + g_rectSum / g_n + ",full=" + g_fullPushes);
    }
    g_statsAt = nowMs; g_n = g_totalUs = g_maxUs = g_px = g_rectSum = g_fullPushes = 0;
  }
}

#ifdef BOB_TEST_CONSOLE
// `T screenshot`: the framebuffer as "S <base64>" lines between BEGIN and END lines (raw big-endian
// RGB565, 360x360), with the CRC-32 of the raw bytes. scripts/screenshot.mjs turns it into a PNG.
void dumpFramebuffer()
{
  static const char* kB64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const uint8_t* px = static_cast<const uint8_t*>(g_fb.getBuffer());
  if (!g_ok || px == nullptr) { Serial.println("SCREENSHOT ERROR no_framebuffer"); return; }
  const size_t total = static_cast<size_t>(kRuiSize) * kRuiSize * 2;
  uint32_t crc = 0xFFFFFFFFu;
  for (size_t i = 0; i < total; ++i)
  {
    crc ^= px[i];
    for (int b = 0; b < 8; ++b) { crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u))); }
  }
  crc = ~crc;
  Serial.printf("SCREENSHOT BEGIN w=%d h=%d\n", kRuiSize, kRuiSize);
  constexpr size_t kLineBytes = 180; // 240 base64 characters per line
  char line[2 + 4 * (kLineBytes / 3) + 1];
  for (size_t at = 0; at < total; at += kLineBytes)
  {
    const size_t n = total - at < kLineBytes ? total - at : kLineBytes;
    size_t o = 0;
    line[o++] = 'S';
    line[o++] = ' ';
    for (size_t i = 0; i < n; i += 3)
    {
      const uint32_t v = (px[at + i] << 16) | ((i + 1 < n ? px[at + i + 1] : 0) << 8) | (i + 2 < n ? px[at + i + 2] : 0);
      line[o++] = kB64[(v >> 18) & 63];
      line[o++] = kB64[(v >> 12) & 63];
      line[o++] = i + 1 < n ? kB64[(v >> 6) & 63] : '=';
      line[o++] = i + 2 < n ? kB64[v & 63] : '=';
    }
    line[o] = '\0';
    Serial.println(line);
    if ((at / kLineBytes) % 32 == 31) { delay(1); }
  }
  Serial.printf("SCREENSHOT END crc=%08lx\n", static_cast<unsigned long>(crc));
}
#endif

} // namespace roundui
} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
