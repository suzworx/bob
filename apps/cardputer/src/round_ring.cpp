// Bob — the light ring on the round screen: the outer annulus (radius 162-180) of the framebuffer
// with a soft glow, a bright core and a hairline edge. What it shows is data: a RingSpec from the
// ring-language table (round_ring_spec.h), composed per degree (round_ring_compose.h). The annulus
// is a precomputed pixel table sorted by angle, so a frame is: compose 360 pixels, diff them with
// the last frame, and redraw + dirty ONLY the angle runs that changed (a comet touches its tail, a
// breathe the whole ring). Budget: compose + blit <= 5 ms at 30 fps (ringLightStats()).
#if defined(BOB_BOARD_WAVESHARE_185C)

#include "round_ring.h"

#include <Arduino.h>
#include <esp_heap_caps.h>
#include <math.h>

#include "audio_capture.h"
#include "audio_playback.h"
#include "round_ring_compose.h"
#include "round_ring_policy.h"
#include "round_ring_spec.h"
#include "round_ui.h"

namespace bob
{
namespace
{
constexpr uint32_t kFrameMs = 33;  // 30 fps
constexpr uint32_t kFadeMs = 300;  // a new spec (colours included) melts in over this long
constexpr int kMaxSegments = 8;
constexpr float kBandOuter = 179.7f; // ... and where it falls to half coverage at the glass edge
constexpr float kBandInner = 165.6f; // where the demo's ring band reaches half coverage (measured on its render; the CSS mask edge is r164..165)
constexpr uint16_t kGround565 = ringRgb565(kRuiGround);

// One annulus pixel: framebuffer offset (17 bits: y * 360 + x) and coverage (8 bits), sorted by angle.
uint32_t* g_pixels = nullptr;
uint32_t g_start[kRingAngles + 1]; // g_pixels[g_start[a] .. g_start[a + 1]) lie at angle a (0 = right, clockwise)

const RingSpec* g_spec = nullptr;  // what was asked for
uint32_t g_specAt = 0;
const RingSpec* g_stage = nullptr; // the spec on stage now (a `then` follows the intro)
uint32_t g_stageAt = 0;
const RingSpec* g_from = nullptr;  // the stage being faded out
uint32_t g_fromAt = 0, g_fadeAt = 0;
RingMode g_mode = RingMode::kOff;
uint32_t g_lastAt = 0;
float g_level = -1.0f, g_smooth = 0.0f; // < 0: no live level, a synthetic envelope is used

uint32_t g_new[kRingAngles], g_old[kRingAngles], g_frame[kRingAngles], g_shown[kRingAngles]; // g_shown: what the framebuffer holds
RingStats g_stats;

// The demo glass, measured on its render (pixel-centre radii): the soft rim (25% sky) starts at r 174.6 (anti-aliased), the black inset
// edge starts at 177.9, and the glass ends at 179.7 where the near-black frame begins. Table entry: bits 0..16 offset, 17..24 coverage
// of the active ring, 25..29 coverage of the resting rim (0..31), 30 black edge ground, 31 frame ground.
constexpr float kRimEdge = 174.6f, kBezelIn = 177.9f, kGlassEdge = 179.7f, kTableOuter = 180.5f;
constexpr uint32_t kBezelBit = 0x40000000u, kFrameBit = 0x80000000u;
constexpr uint16_t kFrame565 = ringRgb565(0x0A0A0B);
bool g_rest = false;                       // the idle spec is on stage: draw the rim only

float restCover(float r)
{
  if (r >= kGlassEdge) { return 0.0f; }
  const float c = r - kRimEdge + 0.5f;
  return c <= 0.0f ? 0.0f : c >= 1.0f ? 1.0f : c;
}

// The active ring is the demo's masked band: flat, one pixel of anti-aliasing at each edge (outer edge at the glass, 179.8). The inner
// edge is kBandInner.
constexpr float kTableMin = 163.5f;        // the table stores each pixel's radius from here, 1/15 px steps (entry bits 17..24)
float g_inner = kBandInner;               // the active band's inner edge now
float bandCover(float r, float inner)
{
  const float lo = r - inner + 0.5f, hi = kBandOuter - r + 0.5f;
  const float e = lo < hi ? lo : hi;
  return e <= 0.0f ? 0.0f : e >= 1.0f ? 1.0f : e;
}

// A pixel the table owns: the ring annulus, the resting rim, and the black edge and frame of the glass (their ground is painted too).
bool inTable(float r) { return (r >= kTableMin && r < kTableOuter) || restCover(r) > 0.0f; }

float radius(int x, int y)
{
  const float dx = x + 0.5f - kRuiCenter, dy = y + 0.5f - kRuiCenter;
  return sqrtf(dx * dx + dy * dy);
}

int angleOf(int x, int y)
{
  float a = atan2f(y + 0.5f - kRuiCenter, x + 0.5f - kRuiCenter) * 57.29578f;
  a = a < 0.0f ? a + 360.0f : a;
  return static_cast<int>(a) % kRingAngles;
}

// Builds the pixel table once, in PSRAM (4 bytes a pixel). False (the ring stays dark) when out of memory.
bool buildTable()
{
  if (g_pixels != nullptr) { return true; }
  uint32_t count[kRingAngles] = {};
  size_t n = 0;
  for (int y = 0; y < kRuiSize; ++y)
  {
    for (int x = 0; x < kRuiSize; ++x)
    {
      if (inTable(radius(x, y))) { ++count[angleOf(x, y)]; ++n; }
    }
  }
  uint32_t* table = static_cast<uint32_t*>(heap_caps_malloc(n * sizeof(uint32_t), MALLOC_CAP_SPIRAM));
  if (table == nullptr) { return false; }
  uint32_t fillAt[kRingAngles];
  g_start[0] = 0;
  for (int a = 0; a < kRingAngles; ++a)
  {
    fillAt[a] = g_start[a];
    g_start[a + 1] = g_start[a] + count[a];
  }
  for (int y = 0; y < kRuiSize; ++y)
  {
    for (int x = 0; x < kRuiSize; ++x)
    {
      const float rr = radius(x, y);
      if (inTable(rr))
      {
        const uint32_t rim = (static_cast<uint32_t>(restCover(rr) * 31.0f + 0.5f) << 25) | (rr >= kBezelIn ? kBezelBit : 0u) | (rr >= kGlassEdge ? kFrameBit : 0u);
        table[fillAt[angleOf(x, y)]++] = static_cast<uint32_t>(y * kRuiSize + x) | (static_cast<uint32_t>((rr - kTableMin) * 15.0f + 0.5f) << 17) | rim;
      }
    }
  }
  g_pixels = table;
  for (uint32_t& v : g_shown) { v = 0xFFFFFFFFu; } // the first frame paints the glass edge at every angle
  return true;
}

// Redraws every pixel at angle a: ground blended towards the angle's colour by alpha * coverage,
// in the canvas's own byte order (big-endian RGB565).
void blitAngle(uint16_t* px, int a, uint32_t composed)
{
  const uint16_t fg = ringRgb565(composed & 0xFFFFFF);
  const uint32_t alpha = composed >> 24;
  for (uint32_t i = g_start[a]; i < g_start[a + 1]; ++i)
  {
    const uint32_t e = g_pixels[i];
    // At rest the ring is the soft glass rim: a flat 6 px band at 25% (the demo's .ring.soft); the rest of the annulus is ground.
    const uint32_t cover = g_rest ? (((e >> 25) & 31u) * 255u + 15u) / 31u : static_cast<uint32_t>(bandCover(kTableMin + ((e >> 17) & 0xFFu) / 15.0f, g_inner) * 255.0f + 0.5f);
    const uint16_t ground = (e & kFrameBit) != 0 ? kFrame565 : (e & kBezelBit) != 0 ? uint16_t(0) : kGround565;
    const uint16_t v = ringBlend565(ground, fg, ((g_rest ? 64u : alpha) * cover) >> 8);
    px[e & 0x1FFFF] = static_cast<uint16_t>((v << 8) | (v >> 8));
  }
}

// The level driving the level pattern: live when a source feeds ringLightSetLevel(), else a gentle
// synthetic speech-like envelope.
float targetLevel(uint32_t now)
{
  if (g_level >= 0.0f) { return g_level; }
  // The real thing: the mic while listening, the reply audio while speaking (smoothed atomics that read
  // 0 after 250 ms without audio); only when neither is flowing the built-in envelope shows.
  const float cap = captureLevel01(), play = playbackLevel01();
  const float live = cap > play ? cap : play;
  if (live > 0.02f) { return live; }
  return 0.35f + 0.65f * ringBreathe(now, 420) * ringBreathe(now + 170, 1130);
}

void start(const RingSpec* spec, uint32_t now)
{
  if (g_stage != nullptr)
  {
    g_from = g_stage; // melt out of whatever was showing
    g_fromAt = g_stageAt;
    g_fadeAt = now;
  }
  g_spec = spec;
  g_specAt = now;
  g_stage = ringStage(spec, 0).spec;
  g_stageAt = now;
}
} // namespace

void ringLightPlay(const RingSpec* spec, uint32_t nowMs)
{
  if (spec != nullptr) { start(spec, nowMs); }
}

bool ringLightPlay(const char* name, uint32_t nowMs)
{
  const RingSpec* spec = ringSpecByName(name);
  if (spec == nullptr) { return false; }
  start(spec, nowMs);
  // g_mode is left alone: the scene stays until the coarse mode really changes.
  return true;
}

void ringLightSetMode(RingMode mode, uint32_t nowMs)
{
  if (mode == g_mode && g_spec != nullptr) { return; }
  g_mode = mode;
  start(ringSpecByName(ringNameForMode(mode)), nowMs);
}

void ringLightSetLevel(float level01) { g_level = level01 < 0.0f ? -1.0f : level01 > 1.0f ? 1.0f : level01; }

void ringLightDamage(int16_t x, int16_t y, int16_t w, int16_t h)
{
  static float cs[kRingAngles], sn[kRingAngles];
  static bool ready = false;
  if (!ready)
  {
    for (int a = 0; a < kRingAngles; ++a) { cs[a] = cosf(a * 0.01745329252f); sn[a] = sinf(a * 0.01745329252f); }
    ready = true;
  }
  for (int a = 0; a < kRingAngles; ++a)
  {
    for (float r = kBandInner - 1.0f; r < 181.0f; r += 5.0f)
    {
      const float px = kRuiCenter + r * cs[a], py = kRuiCenter + r * sn[a];
      if (px >= x && px < x + w && py >= y && py < y + h) { g_shown[a] = 0xFFFFFFFFu; break; }
    }
  }
}

void ringLightInvalidate()
{
  for (uint32_t& v : g_shown) { v = 0xFFFFFFFFu; } // the framebuffer was wiped: nothing of the ring or the glass edge is on it, repaint every angle
  g_mode = RingMode::kOff;
  g_from = nullptr;
  g_stage = nullptr; // nothing to melt out of
  start(ringSpecByName("idle"), millis());
}

RingStats ringLightStats() { return g_stats; }

void ringLightTick(uint32_t nowMs)
{
  if (nowMs - g_lastAt < kFrameMs) { return; }
  const uint32_t dt = g_lastAt == 0 ? kFrameMs : nowMs - g_lastAt;
  g_lastAt = nowMs;
  if (g_spec == nullptr) { ringLightSetMode(RingMode::kOff, nowMs); }
  if (!buildTable()) { return; }
  const uint32_t t0 = micros();

  const RingStage stage = ringStage(g_spec, nowMs - g_specAt);
  if (stage.spec != g_stage) // the intro ended: melt into its `then`
  {
    g_from = g_stage;
    g_fromAt = g_stageAt;
    g_fadeAt = nowMs;
    g_stage = stage.spec;
    g_stageAt = nowMs - stage.since;
  }
  g_rest = g_stage == ringSpecByName("idle");
  g_smooth = ringSmooth(g_smooth, targetLevel(nowMs), dt, 40, 80);
#if defined(BOBSIM_FREEZE)
  // Sim only (visual gate REST mode): the ring is a constant per state, animation phase 0, no melt between stages.
  g_from = nullptr;
  g_smooth = 0.5f; // the demo's rest level (speak opacity .675)
  const RingSpec* first = ringStage(g_spec, 0).spec; // the first stage, not the one the clock moved on to
  g_rest = first == ringSpecByName("idle");
  RingSpec rest = *first;
  rest.inMs = 0; // no fade-in: phase 0 at full strength
  ringCompose(rest, 0, g_smooth, g_new);
#else
  ringCompose(*g_stage, nowMs - g_stageAt, g_smooth, g_new);
#endif
  const uint32_t fade = nowMs - g_fadeAt;
  if (g_from != nullptr && fade < kFadeMs)
  {
    ringCompose(*g_from, nowMs - g_fromAt, g_smooth, g_old);
    ringBlendFrames(g_old, g_new, fade * 256 / kFadeMs, g_frame);
  }
  else
  {
    g_from = nullptr;
    for (int a = 0; a < kRingAngles; ++a) { g_frame[a] = g_new[a]; }
  }
  const uint32_t t1 = micros();

  // One band edge for every active ring (a new edge, if it ever changes, repaints every angle).
  const float inner = kBandInner; // the demo's speak band measures the same inner edge at rest as the other bands
  if (static_cast<int>(inner * 4.0f) != static_cast<int>(g_inner * 4.0f)) { for (uint32_t& v : g_shown) { v = 0xFFFFFFFFu; } }
  g_inner = inner;

  RingSeg segs[kMaxSegments];
  const int count = ringDiffSegments(g_shown, g_frame, segs, kMaxSegments);
  uint16_t* px = count > 0 ? static_cast<uint16_t*>(roundui::fb().getBuffer()) : nullptr;
  if (px != nullptr)
  {
    for (int s = 0; s < count; ++s)
    {
      for (int a = segs[s].from; a < segs[s].to; ++a) { blitAngle(px, a, g_frame[a]); }
      roundui::dirtyArc(segs[s].from > 0 ? segs[s].from - 1 : 0, segs[s].to < kRingAngles ? segs[s].to + 1 : kRingAngles);
    }
    for (int a = 0; a < kRingAngles; ++a) { g_shown[a] = g_frame[a]; }
  }

  const uint32_t composeUs = t1 - t0, totalUs = micros() - t0;
  g_stats.composeUs = composeUs;
  g_stats.frameUs = totalUs;
  g_stats.maxFrameUs = totalUs > g_stats.maxFrameUs ? totalUs : g_stats.maxFrameUs;
  g_stats.segments = static_cast<uint8_t>(count);
  ++g_stats.frames;
}

} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
