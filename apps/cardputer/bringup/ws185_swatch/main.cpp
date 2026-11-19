// Colour diagnosis for the Waveshare 1.85C: three rows of the same six colours, drawn by
// fillRect, by pushImage from DRAM and by pushImage from flash (big-endian, as Bob's art).
//   all rows share a cast  -> panel gamma / inversion (init table)
//   only the image rows    -> the pushImage path (writeImage)
// BOOT or a tap toggles the panel's inversion so the owner can compare both states.
// Serial: `ws185 swatch ...` (the value the code writes for navy #173E57 and the first
// bytes of bob_welcome.rgb565, expected 0x11ea and 11 ea).
#include <Arduino.h>
#include <M5Unified.h>

#include "ws185_hw.h"

namespace ws = bob::ws185;

namespace
{
// Native RGB565: navy #173E57, ivory #FFFDF6, red, green, blue, grey #808080.
constexpr uint16_t kSwatch565[6] = {0x11EA, 0xFFFE, 0xF800, 0x07E0, 0x001F, 0x8410};
constexpr int16_t kPatchW = 24, kPatchH = 24, kSwatchX = 108;
#define P24(c) c, c, c, c, c, c, c, c, c, c, c, c, c, c, c, c, c, c, c, c, c, c, c, c
// Image rows hold big-endian (swap565_t) data like bob_*.rgb565: pushImage's no-convert path.
#define BE(c) static_cast<uint16_t>(((c) >> 8) | (((c) & 0xFF) << 8))
#define SWATCH_ROW P24(BE(0x11EA)), P24(BE(0xFFFE)), P24(BE(0xF800)), P24(BE(0x07E0)), P24(BE(0x001F)), P24(BE(0x8410))
const uint16_t kFlashRows[6 * kPatchW * 4] = {SWATCH_ROW, SWATCH_ROW, SWATCH_ROW, SWATCH_ROW}; // in flash
uint16_t s_ramRows[6 * kPatchW * 4];                                                           // in DRAM
// invertDisplay() is relative to the panel's native inversion (cfg.invert = true, INVON), so
// false = the normal product state and true sends INVOFF.
bool s_inverted = false;
bool s_wasDown = false;

extern "C" const uint8_t bob_welcome[];

void showSwatches()
{
  auto& d = M5.Display;
  memcpy(s_ramRows, kFlashRows, sizeof(s_ramRows));
  d.fillScreen(TFT_BLACK);
  d.setTextColor(TFT_WHITE, TFT_BLACK);
  d.setTextDatum(middle_center);
  d.setTextSize(1);
  const char* labels[3] = {"fill", "image (ram)", "image (flash)"};
  for (int r = 0; r < 3; r++)
  {
    const int16_t y = 110 + r * 54;
    d.drawString(labels[r], 180, y - 10);
    if (r == 0)
    {
      for (int c = 0; c < 6; c++) { d.fillRect(kSwatchX + c * kPatchW, y, kPatchW, kPatchH, kSwatch565[c]); }
      continue;
    }
    const auto* src = reinterpret_cast<const lgfx::swap565_t*>(r == 1 ? s_ramRows : kFlashRows);
    for (int k = 0; k < kPatchH / 4; k++) { d.pushImage(kSwatchX, y + k * 4, 6 * kPatchW, 4, src); }
  }
  d.drawString("navy ivory red green blue grey", 180, 270);
  d.drawString(s_inverted ? "panel INVOFF (BOOT/tap toggles)" : "panel INVON, product state (BOOT/tap toggles)", 180, 290);
}

void report()
{
  Serial.printf("ws185 swatch navy565=0x%04x bob_welcome[0..3]=%02x %02x %02x %02x invert=%d\n", kSwatch565[0],
                bob_welcome[0], bob_welcome[1], bob_welcome[2], bob_welcome[3], s_inverted ? 1 : 0);
}
} // namespace

void setup()
{
  auto cfg = M5.config();
  cfg.clear_display = false;
  cfg.internal_spk = false;
  cfg.internal_mic = false;
  cfg.output_power = false;
  M5.begin(cfg);
  Serial.begin(115200);
  delay(1500);
  Serial.printf("ws185 swatch bus=%d display=%d\n", ws::beginBus(), ws::attachDisplay(360, 360));
  showSwatches();
  report();
}

void loop()
{
  int16_t x, y;
  const bool down = ws::bootPressed() || ws::touchPoint(&x, &y);
  if (down && !s_wasDown)
  {
    s_inverted = !s_inverted;
    M5.Display.invertDisplay(s_inverted);
    showSwatches();
    report();
  }
  s_wasDown = down;
  delay(20);
}
