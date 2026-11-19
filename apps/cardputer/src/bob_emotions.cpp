#if defined(BOB_BOARD_WAVESHARE_185C)

#include <math.h>

#include "bob_emotions.h"
#include "round_ui.h"

// Accents drawn into the frame sprite around Bob, one function per accent, animated by a
// phase t (0..1). Mirrors scripts/bob_emotions_preview.py (accent()) shape for shape.
namespace bob
{
namespace
{
constexpr uint16_t kGround = kBobGround;
constexpr float kTau = 6.2831853f;

int ri(float v) { return static_cast<int>(lroundf(v)); }
float frac(float t, int i, int n) { return fmodf(t + float(i) / n, 1.0f); }

uint16_t mix(uint16_t a, uint16_t b, float k)
{
  auto ch = [&](int sh, int mask) { return int(((a >> sh) & mask) + (((b >> sh) & mask) - ((a >> sh) & mask)) * k); };
  return static_cast<uint16_t>((ch(11, 31) << 11) | (ch(5, 63) << 5) | ch(0, 31));
}

void disc(M5Canvas& c, float x, float y, float r, uint16_t col) { c.fillCircle(ri(x), ri(y), ri(r), col); }
void tri(M5Canvas& c, float x0, float y0, float x1, float y1, float x2, float y2, uint16_t col)
{
  c.fillTriangle(ri(x0), ri(y0), ri(x1), ri(y1), ri(x2), ri(y2), col);
}

void heart(M5Canvas& c, float x, float y, float s, uint16_t col)
{
  disc(c, x - s * 0.5f, y - s * 0.3f, s * 0.55f, col);
  disc(c, x + s * 0.5f, y - s * 0.3f, s * 0.55f, col);
  tri(c, x - s * 1.02f, y - s * 0.1f, x + s * 1.02f, y - s * 0.1f, x, y + s * 1.1f, col);
}

void spark(M5Canvas& c, float x, float y, float s, uint16_t col)
{
  const float q = s * 0.25f, p[8][2] = {{0, -s}, {q, -q}, {s, 0}, {q, q}, {0, s}, {-q, q}, {-s, 0}, {-q, -q}};
  for (int i = 0; i < 8; i++) { tri(c, x, y, x + p[i][0], y + p[i][1], x + p[(i + 1) % 8][0], y + p[(i + 1) % 8][1], col); }
}

void drop(M5Canvas& c, float x, float y, float r, uint16_t col)
{
  disc(c, x, y + r, r, col);
  tri(c, x - r, y + r - 1, x + r, y + r - 1, x, y - r * 1.6f, col);
}

void zed(M5Canvas& c, float x, float y, float s, uint16_t col)
{
  bobLine(c, x - s, y - s, x + s, y - s, 2, col);
  bobLine(c, x + s, y - s, x - s, y + s, 2, col);
  bobLine(c, x - s, y + s, x + s, y + s, 2, col);
}

void speechBubble(M5Canvas& c, int x, int y, int w, int h, uint16_t col)
{
  c.fillRect(x + 6, y, w - 12, h, col);
  c.fillRect(x, y + 6, w, h - 12, col);
  for (int dx : {6, w - 7}) { for (int dy : {6, h - 7}) { c.fillCircle(x + dx, y + dy, 6, col); } }
  c.fillTriangle(x + 8, y + h - 2, x + 18, y + h - 2, x + 4, y + h + 9, col);
}
} // namespace

void bobAccentOneHeart(M5Canvas& c, float t, BobPose)
{
  const float p = t < 0.0f ? 0.0f : t > 1.0f ? 1.0f : t;
  // Full size and colour for the first half of its rise, then it fades into the ground (no shrinking to a speck).
  const float fade = p < 0.5f ? 0.0f : (p - 0.5f) * 2.0f;
  heart(c, 152 + 6 * sinf(p * 5.0f), 70 - p * 46, 5.5f, mix(kBobCoral, kGround, fade));
}

// The demo's two prop slots in frame pixels (glass (92, 96) and (268, 96) minus the frame origin (64, 49)).
constexpr float kSlotLx = 28.0f, kSlotRx = 204.0f, kSlotY = 47.0f;

void bobAccentDraw(M5Canvas& c, BobAccent a, float t, BobPose pose)
{
  float ex, ey;
  switch (a)
  {
  case BobAccent::kHearts:
    heart(c, kSlotLx, kSlotY + 1, 8, kBobCoral); // the demo: a hearts prop at each slot, 28 and 22 px
    heart(c, kSlotRx, kSlotY + 1, 6.5f, kBobCoral);
    break;
  case BobAccent::kZzz:
  {
    // The demo: a big Z at the right slot and a small z below it, rising and fading out of step (at the start only the small one shows).
    const float za = sinf(3.14159f * t), zb = sinf(3.14159f * (t + 0.45f > 1.0f ? t - 0.55f : t + 0.45f));
    zed(c, kSlotRx, kSlotY - 4 * t, 8, mix(kGround, kBobSky, za > 0 ? za : 0));
    zed(c, kSlotRx - 6, kSlotY + 22 - 4 * t, 4, mix(kGround, kBobSky, zb > 0 ? zb : 0));
    break;
  }
  case BobAccent::kQuestion:
  {
    // The demo draws the question mark as ExtraBold text (42 px, yellow) in the upper-right prop slot: the hero font does the same here.
    const float y = kSlotY + 4 + 3 * sinf(t * kTau);
    c.setFont(static_cast<const lgfx::IFont*>(roundui::heroFont()));
    c.setTextDatum(middle_center);
    c.setTextColor(mix(kGround, 0x0000, 0.25f));
    c.drawString("?", static_cast<int32_t>(kSlotRx) - 1, static_cast<int32_t>(lroundf(y)) + 2);
    c.setTextColor(kBobYellow);
    c.drawString("?", static_cast<int32_t>(kSlotRx) - 1, static_cast<int32_t>(lroundf(y)));
    c.drawString("?", static_cast<int32_t>(kSlotRx), static_cast<int32_t>(lroundf(y))); // the browser draws ExtraBold heavier than the font mask
    break;
  }
  case BobAccent::kExclaim:
  {
    // The demo draws the exclamation mark as ExtraBold text (44 px, yellow) in the upper-right prop slot, like the question mark.
    c.setFont(static_cast<const lgfx::IFont*>(roundui::heroFont()));
    c.setTextDatum(middle_center);
    c.setTextColor(mix(kGround, 0x0000, 0.25f));
    c.drawString("!", static_cast<int32_t>(kSlotRx), static_cast<int32_t>(kSlotY) + 5);
    c.setTextColor(kBobYellow);
    c.drawString("!", static_cast<int32_t>(kSlotRx), static_cast<int32_t>(kSlotY) + 3);
    c.drawString("!", static_cast<int32_t>(kSlotRx) + 1, static_cast<int32_t>(kSlotY) + 3);
    break;
  }
  case BobAccent::kSweat: drop(c, 190, 38 + t * 16, 4, kBobSky); break;
  case BobAccent::kTears:
    for (int s = -1; s <= 1; s += 2)
    {
      const float p = frac(t, s < 0 ? 0 : 1, 2);
      bobEyePos(pose, s, 0, 9, &ex, &ey);
      drop(c, ex + s * 3, ey + p * 30, 3, mix(kBobSky, kGround, p * p));
    }
    break;
  case BobAccent::kSparkles:
  {
    // The demo's sparkle prop: a yellow star at 11 o'clock and a smaller sky one at 1 o'clock, twinkling out of step.
    const float a = 0.7f + 0.3f * fabsf(sinf(t * 3.14159f)), b = 0.7f + 0.3f * fabsf(sinf((t + 0.5f) * 3.14159f));
    spark(c, kSlotLx, kSlotY, 11 * a, mix(kGround, kBobYellow, a));
    spark(c, kSlotRx, kSlotY, 8 * b, mix(kGround, kBobSky, b));
    break;
  }
  case BobAccent::kConfetti:
  {
    const uint16_t cols[4] = {kBobYellow, kBobSky, kBobGrass, kBobCoral};
    for (int i = 0; i < 16; i++) { c.fillRect(8 + (i * 53) % 212, int(t * kBobFrameH + i * 37) % kBobFrameH, 6, 9, cols[i % 4]); }
    break;
  }
  case BobAccent::kNotes:
  {
    // The demo's music props: a green eighth note at 11 o'clock and a yellow beamed pair at 1 o'clock, floating a little.
    const float yl = 3 * sinf(t * kTau), yr = 3 * sinf((t + 0.35f) * kTau);
    const uint16_t g = mix(kGround, kBobGrass, 0.8f), y = mix(kGround, kBobYellow, 0.9f);
    disc(c, 24, 58 + yl, 4, g);
    bobLine(c, 28, 56 + yl, 28, 36 + yl, 2, g);
    bobLine(c, 28, 36 + yl, 35, 43 + yl, 2, g);
    disc(c, 198, 58 + yr, 4, y);
    disc(c, 209, 55 + yr, 4, y);
    bobLine(c, 201, 57 + yr, 201, 41 + yr, 2, y);
    bobLine(c, 212, 54 + yr, 212, 37 + yr, 2, y);
    bobLine(c, 201, 41 + yr, 212, 37 + yr, 3, y);
    break;
  }
  case BobAccent::kBulb:
  {
    disc(c, 200, 38, 10 * (1 + 0.1f * sinf(t * kTau)), kBobYellow);
    c.fillRect(194, 47, 12, 6, kBobSky);
    for (float d : {210.0f, 270.0f, 330.0f})
    {
      const float r = d * 0.01745329f;
      bobLine(c, 200 + 15 * cosf(r), 38 + 15 * sinf(r), 200 + 21 * cosf(r), 38 + 21 * sinf(r), 2, kBobYellow);
    }
    break;
  }
  case BobAccent::kCheck:
    disc(c, 200, 40, 17, kBobGrass);
    bobLine(c, 191, 41, 197, 48, 4, kBobPaper);
    bobLine(c, 197, 48, 210, 32, 4, kBobPaper);
    break;
  case BobAccent::kCross:
    disc(c, 200, 40, 17, kBobCoral);
    bobLine(c, 192, 32, 208, 48, 4, kBobPaper);
    bobLine(c, 192, 48, 208, 32, 4, kBobPaper);
    break;
  case BobAccent::kBell:
  {
    const float sw = 6 * sinf(t * kTau * 3);
    disc(c, 200 + sw * 0.3f, 38, 11, kBobYellow);
    c.fillRect(ri(189 + sw * 0.3f), 38, 22, 10, kBobYellow);
    disc(c, 200 + sw, 55, 3, kBobYellow);
    bobArc(c, 200, 40, 24, 200, 240, 2, kBobSky);
    bobArc(c, 200, 40, 24, 300, 340, 2, kBobSky);
    break;
  }
  case BobAccent::kNoSignal:
    for (float r : {7.0f, 14.0f, 21.0f}) { bobArc(c, 200, 66, r, 225, 315, 3, kBobSky); }
    disc(c, 200, 66, 2, kBobSky);
    bobLine(c, 184, 30, 216, 68, 4, kBobCoral);
    break;
  case BobAccent::kSpinner:
  {
    // The demo's turning arrow, sky blue in the upper-right prop slot: a three-quarter ring with its arrowhead, turning once per cycle.
    const float a0 = -45.0f + t * 360.0f, a1 = a0 + 280.0f, sy = kSlotY + 4;
    bobArc(c, kSlotRx, sy, 11, a0, a1, 3, kBobSky);
    const float e = a1 * 0.01745329252f;
    const float hx = kSlotRx + 11 * cosf(e), hy = sy + 11 * sinf(e), tx = -sinf(e), ty = cosf(e), nx = cosf(e), ny = sinf(e);
    tri(c, hx + tx * 5, hy + ty * 5, hx + nx * 4, hy + ny * 4, hx - nx * 4, hy - ny * 4, kBobSky);
    break;
  }
  case BobAccent::kBlush:
    for (int s = -1; s <= 1; s += 2)
    {
      bobEyePos(pose, s, s * 9, 14, &ex, &ey);
      disc(c, ex, ey, 4, kBobCoral);
    }
    break;
  case BobAccent::kDots:
    for (int i = 0; i < 3; i++) { disc(c, 180 + i * 15, 44 - (int(t * 3) == i ? 4 : 0), 3, kBobYellow); }
    break;
  case BobAccent::kWaves:
    for (int i = 0; i < 3; i++) { bobArc(c, 176, 60, 12 + i * 9, -45, 45, 3, mix(kGround, kBobSky, int(t * 4) >= i ? 1.0f : 0.35f)); }
    break;
  case BobAccent::kStars:
    for (int i = 0; i < 3; i++) { const float ang = t * kTau + i * 2.09f; spark(c, 116 + 52 * cosf(ang), 36 + 10 * sinf(ang), 5, kBobYellow); }
    break;
  case BobAccent::kWarn:
    tri(c, 200, 22, 182, 56, 218, 56, kBobYellow);
    bobLine(c, 200, 33, 200, 45, 3, kBobInk);
    disc(c, 200, 50, 2, kBobInk);
    break;
  case BobAccent::kShiverLines:
  {
    const float dx = (int(t * 6) % 2) ? 2.0f : -2.0f;
    for (int i = 0; i < 3; i++) { for (int x : {12, 220}) { bobLine(c, x + dx, 90 + i * 22, x + dx, 102 + i * 22, 3, kBobSky); } }
    break;
  }
  case BobAccent::kAnger:
  {
    const float k = 1 + 0.15f * sinf(t * kTau * 2);
    constexpr int cells[4][3] = {{-1, -1, 0}, {1, -1, 90}, {-1, 1, 270}, {1, 1, 180}};
    for (const auto& q : cells) { bobArc(c, 200 + q[0] * 6 * k, 38 + q[1] * 6 * k, 5, q[2], q[2] + 90, 3, kBobCoral); }
    break;
  }
  case BobAccent::kSick:
    for (int i = 0; i < 3; i++) { const float p = frac(t, i, 3); disc(c, 190 + 12 * sinf(p * 9 + i), 90 - p * 70, 4, mix(kBobGrass, kGround, p * p)); }
    break;
  case BobAccent::kBubble:
    speechBubble(c, 184, 12, 38, 34, kBobYellow);
    bobLine(c, 203, 20, 203, 33 * (1 + 0.06f * sinf(t * kTau)) - 4, 4, kBobInk);
    disc(c, 203, 37, 2, kBobInk);
    break;
  default: break;
  }
}

} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
