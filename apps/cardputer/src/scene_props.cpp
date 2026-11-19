// The props of Bob's scenes, drawn procedurally in the Bob palette (no art files). Each prop is drawn around
// (cx, cy) from its OWN clock `ms` (independent of Bob and the ring), scaled and faded by the entrance and exit
// transform. Static shapes only use fill primitives; lines go through bobLine (thick, round-capped).
#if defined(BOB_BOARD_WAVESHARE_185C)

#include <math.h>

#include "bob_emotions.h"
#include "scene_engine.h"

namespace bob
{
namespace
{
constexpr float kRad = 0.01745329f;

uint16_t blendRgb(uint16_t from, uint16_t to, float k)
{
  auto ch = [&](int sh, int mask) { return static_cast<int>(((from >> sh) & mask) + (((to >> sh) & mask) - ((from >> sh) & mask)) * k); };
  return static_cast<uint16_t>((ch(11, 31) << 11) | (ch(5, 63) << 5) | ch(0, 31));
}

// Everything is drawn through one pen: scale about the centre and fade toward the ground by alpha.
struct Pen
{
  M5Canvas& c;
  int cx, cy;
  float s, alpha;
  uint16_t col(uint16_t color) const { return blendRgb(kBobInk, color, alpha); }
  int X(float u) const { return cx + static_cast<int>(lroundf(u * s)); }
  int Y(float v) const { return cy + static_cast<int>(lroundf(v * s)); }
  int R(float r) const { const int v = static_cast<int>(lroundf(r * s)); return v < 1 ? 1 : v; }
  void disc(float u, float v, float r, uint16_t color) { c.fillCircle(X(u), Y(v), R(r), col(color)); }
  void rect(float u, float v, float w, float h, float round, uint16_t color) { c.fillRoundRect(X(u), Y(v), R(w), R(h), R(round), col(color)); }
  void line(float u0, float v0, float u1, float v1, float w, uint16_t color)
  {
    bobLine(c, static_cast<float>(X(u0)), static_cast<float>(Y(v0)), static_cast<float>(X(u1)), static_cast<float>(Y(v1)), fmaxf(1.0f, w * s), col(color));
  }
  void tri(float u0, float v0, float u1, float v1, float u2, float v2, uint16_t color)
  {
    c.fillTriangle(X(u0), Y(v0), X(u1), Y(v1), X(u2), Y(v2), col(color));
  }
  // A line from the centre (u, v) at `deg` (0 = up, clockwise), `len` long.
  void hand(float u, float v, float deg, float len, float w, uint16_t color)
  {
    line(u, v, u + len * sinf(deg * kRad), v - len * cosf(deg * kRad), w, color);
  }
};

void cloud(Pen& p, float dx, uint16_t body)
{
  p.disc(-12 + dx, 4, 11, body);
  p.disc(2 + dx, -2, 14, body);
  p.disc(15 + dx, 5, 10, body);
  p.rect(-22 + dx, 4, 46, 12, 6, body);
}

void clock(Pen& p, uint32_t ms, bool ringing)
{
  const float shake = ringing ? 3.0f * sinf(ms * 0.045f) : 0.0f;  // ringing: a quick left-right rattle
  p.disc(shake, 2, 26, kBobYellow);
  p.disc(shake, 2, 22, kBobPaper);
  for (int i = 0; i < 12; ++i) { p.disc(shake + 19.0f * sinf(i * 30 * kRad), 2 - 19.0f * cosf(i * 30 * kRad), 1.6f, kBobSky); }
  p.hand(shake, 2, 0.0f, 11.0f, 3.0f, kBobInk);              // the hour hand rests at twelve
  p.hand(shake, 2, fmodf(ms * 0.18f, 360.0f), 17.0f, 2.0f, kBobCoral);  // the sweeping hand: one lap every 2 s
  p.disc(shake, 2, 2.5f, kBobInk);
  p.disc(-14, -26, 6, kBobYellow);  // the two bells on top
  p.disc(14, -26, 6, kBobYellow);
}

void bell(Pen& p, uint32_t ms)
{
  const float swing = 12.0f * sinf(ms * 0.012f);  // the whole bell swings about its top
  const float a = swing * kRad;
  auto rot = [&](float u, float v, float* ou, float* ov) { *ou = u * cosf(a) - v * sinf(a); *ov = u * sinf(a) + v * cosf(a); };
  float u, v;
  rot(0, 6, &u, &v);
  p.disc(u, v - 8, 17, kBobYellow);
  rot(-17, 8, &u, &v);
  float u2, v2;
  rot(17, 8, &u2, &v2);
  float u3, v3;
  rot(0, -8, &u3, &v3);
  p.tri(u, v, u2, v2, u3, v3 - 4, kBobYellow);
  rot(0, 16, &u, &v);
  p.rect(u - 20, v - 2, 40, 6, 3, kBobYellow);
  rot(0, 22 + 2 * sinf(ms * 0.024f), &u, &v);
  p.disc(u, v, 4, kBobCoral);  // the clapper
  p.disc(0, -22, 3, kBobYellow);
}

void sun(Pen& p, uint32_t ms)
{
  const float turn = ms * 0.04f;  // rays turn slowly
  for (int i = 0; i < 8; ++i) { p.hand(0, 0, turn + i * 45.0f, 28.0f, 4.0f, kBobYellow); }
  p.disc(0, 0, 21, kBobInk);  // the gap between disc and rays
  p.disc(0, 0, 18, kBobYellow);
  p.disc(-6, -6, 4, kBobPaper);
}

void rain(Pen& p, uint32_t ms)
{
  cloud(p, 2.0f * sinf(ms * 0.003f), kBobSky);
  for (int i = 0; i < 5; ++i)
  {
    const float f = fmodf(ms * 0.0011f + i * 0.2f, 1.0f);
    const float x = -18 + i * 9.0f, y = 14 + f * 26.0f;
    p.line(x, y, x - 2, y + 7, 2.5f, kBobSky);
  }
}

void snow(Pen& p, uint32_t ms)
{
  cloud(p, 2.0f * sinf(ms * 0.003f), kBobSky);
  for (int i = 0; i < 6; ++i)
  {
    const float f = fmodf(ms * 0.0006f + i * 0.17f, 1.0f);
    p.disc(-20 + i * 8.0f + 3.0f * sinf(f * 12.0f + i), 14 + f * 28.0f, 2.2f, kBobPaper);
  }
}

void notes(Pen& p, uint32_t ms)
{
  for (int i = 0; i < 3; ++i)
  {
    const float f = fmodf(ms * 0.0006f + i / 3.0f, 1.0f);
    const float x = -16 + i * 16.0f + 5.0f * sinf(f * 9.0f), y = 22 - f * 44.0f;
    p.disc(x, y, 5, i == 1 ? kBobYellow : kBobSky);
    p.line(x + 4.5f, y, x + 4.5f, y - 15, 2.5f, i == 1 ? kBobYellow : kBobSky);
    p.line(x + 4.5f, y - 15, x + 11, y - 10, 2.5f, i == 1 ? kBobYellow : kBobSky);
  }
}

void checklist(Pen& p, uint32_t ms)
{
  p.rect(-22, -28, 44, 56, 5, kBobPaper);
  p.rect(-22, -28, 44, 9, 4, kBobYellow);
  for (int i = 0; i < 3; ++i)
  {
    const float y = -8 + i * 15.0f;
    p.line(-4, y, 15, y, 2.5f, kBobSky);
    // The tick draws itself: first its short stroke, then the long one, one row after another.
    const float t = (static_cast<float>(ms) - 350.0f - i * 450.0f) / 350.0f;
    if (t <= 0.0f) { continue; }
    const float a = fminf(t * 2.0f, 1.0f), b = fminf(fmaxf(t * 2.0f - 1.0f, 0.0f), 1.0f);
    p.line(-18, y, -18 + 4 * a, y + 4 * a, 3.0f, kBobGrass);
    if (b > 0.0f) { p.line(-14, y + 4, -14 + 9 * b, y + 4 - 9 * b, 3.0f, kBobGrass); }
  }
}

void note(Pen& p, uint32_t ms)
{
  const float sway = 4.0f * sinf(ms * 0.004f);
  p.tri(-22 + sway, -24, 22 + sway, -24, 22 - sway, 26, kBobYellow);
  p.tri(-22 + sway, -24, 22 - sway, 26, -22 - sway, 26, kBobYellow);
  p.line(-14 + sway, -10, 14 + sway, -10, 2.5f, kBobInk);
  p.line(-14 + sway * 0.5f, 2, 8 + sway * 0.5f, 2, 2.5f, kBobInk);
  p.line(-14, 14, 4, 14, 2.5f, kBobInk);
}

void calendar(Pen& p, uint32_t ms)
{
  p.rect(-24, -24, 48, 52, 5, kBobPaper);
  const float flip = ms < 700 ? fabsf(cosf(ms * 0.0045f)) : 1.0f;  // the top page flips over at the start
  p.rect(-24, -24, 48, 12 * flip + 1, 4, kBobCoral);
  for (int r = 0; r < 3; ++r) { for (int c = 0; c < 4; ++c) { p.disc(-15 + c * 10.0f, -2 + r * 10.0f, 2.4f, (r == 1 && c == 2) ? kBobCoral : kBobSky); } }
}

void magnifier(Pen& p, uint32_t ms)
{
  const float ph = ms * 0.0035f;
  const float u = 8.0f * cosf(ph), v = 6.0f * sinf(ph);  // the glass searches in a loop
  p.disc(u, v - 4, 15, kBobSky);
  p.disc(u, v - 4, 11, kBobInk);
  p.disc(u - 4, v - 8, 2.5f, kBobPaper);
  p.line(u + 11, v + 7, u + 24, v + 20, 5.0f, kBobYellow);
}

void envelope(Pen& p, uint32_t ms)
{
  const float cycle = fmodf(ms, 2200.0f);
  const float fly = cycle < 900.0f ? 0.0f : fminf((cycle - 900.0f) / 1100.0f, 1.0f);  // it waits, then flies off up and to the right
  const float u = 30.0f * fly * fly, v = -34.0f * fly;
  p.rect(-24 + u, -14 + v, 48, 32, 4, kBobPaper);
  p.tri(-24 + u, -14 + v, 24 + u, -14 + v, u, 6 + v, kBobSky);
  p.line(-24 + u, 18 + v, u, 2 + v, 2.0f, kBobSky);
  p.line(24 + u, 18 + v, u, 2 + v, 2.0f, kBobSky);
}

void badge(Pen& p, bool good)
{
  p.disc(0, 0, 22, good ? kBobGrass : kBobCoral);
  if (good) { p.line(-10, 1, -3, 9, 5.0f, kBobPaper); p.line(-3, 9, 11, -8, 5.0f, kBobPaper); }
  else { p.line(-9, -9, 9, 9, 5.0f, kBobPaper); p.line(-9, 9, 9, -9, 5.0f, kBobPaper); }
}
} // namespace

void sceneDrawProp(M5Canvas& fb, scene::Prop prop, int16_t cx, int16_t cy, uint32_t ms, float scale, float alpha, int32_t value)
{
  (void)value; // the timer's number is the caption's job (one short line), not the clock's
  if (prop == scene::Prop::kNone || alpha <= 0.01f || scale <= 0.05f) { return; }
  Pen p{fb, cx, cy, scale, alpha > 1.0f ? 1.0f : alpha};
  switch (prop)
  {
    case scene::Prop::kClock: clock(p, ms, false); break;
    case scene::Prop::kClockRing: clock(p, ms, true); break;
    case scene::Prop::kBell: bell(p, ms); break;
    case scene::Prop::kSun: sun(p, ms); break;
    case scene::Prop::kCloud: cloud(p, 3.0f * sinf(ms * 0.0025f), kBobSky); break;
    case scene::Prop::kRain: rain(p, ms); break;
    case scene::Prop::kSnow: snow(p, ms); break;
    case scene::Prop::kNotes: notes(p, ms); break;
    case scene::Prop::kChecklist: checklist(p, ms); break;
    case scene::Prop::kNote: note(p, ms); break;
    case scene::Prop::kCalendar: calendar(p, ms); break;
    case scene::Prop::kMagnifier: magnifier(p, ms); break;
    case scene::Prop::kEnvelope: envelope(p, ms); break;
    case scene::Prop::kCheck: badge(p, true); break;
    case scene::Prop::kCross: badge(p, false); break;
    default: break;
  }
}

} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
