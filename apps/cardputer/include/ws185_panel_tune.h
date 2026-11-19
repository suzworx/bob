// Bob — ST77916 panel tuning for the hil console (#1065: navy #173E57 reads as bright blue on the
// Waveshare 1.85C glass). Pure data and parsing, host-tested in test/host/test_ws185_panel_tune.cpp;
// the console (src/test_console.cpp) and the board file (src/ws185_hw.cpp) send the bytes. Nothing here
// changes the default output: the product writes the Waveshare table in include/ws185_panel.h, and
// these values reach the glass only when an owner types a `T gamma` / `T panel init` command.
// docs/waveshare/navy-1065.md says which command to try first and what each result means.
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace bob
{
namespace ws185tune
{

constexpr size_t kGammaBytes = 14;

// One gamma pair: E0 (positive polarity) and E1 (negative polarity), written on the gamma page
// (F0 = 0x02). Bytes are Sitronix-style voltage points: the low bytes set one end of the grey
// scale (V0..V6), the middle the mid tones (V13..V50), the high bytes the other end (V57..V63).
struct GammaPreset
{
  const char* name;
  uint8_t pos[kGammaBytes];
  uint8_t neg[kGammaBytes];
};

// ws    Waveshare vendor_specific_init_new (Display_ST77916.cpp, picked when RDDID reads 00 02 7F 7F);
//       byte-identical in LovyanGFX, muse-gadget-sdk @fa07304 and xiaozhi. The product default.
// esp   Espressif esp_lcd_st77916 vendor_specific_init_default: what Waveshare's demo runs when RDDID
//       reads 00 7F 7F 7F (its "case 1"). A brighter-black table on the wrong glass is the top suspect.
// nt150 The NT150XV 360x360 ST77916 module (decaday/display-driver panels/st77916 spec.rs, also
//       embeddedboys pico_dm tft_st77916.c): an independent third glass, steeper dark end.
// sym   Derived, not from a vendor: ws with E1 = E0. ws's E1 byte 5 (0x05 vs 0x36) and byte 9 (0x39 vs
//       0x29) differ from E0; if the two polarities settle at different levels the pixel carries a DC
//       offset that lifts dark tones like a VCOM error. esp is symmetric there, so this isolates that.
constexpr GammaPreset kGammaPresets[] = {
    {"ws",
     {0xF0, 0x0A, 0x10, 0x09, 0x09, 0x36, 0x35, 0x33, 0x4A, 0x29, 0x15, 0x15, 0x2E, 0x34},
     {0xF0, 0x0A, 0x0F, 0x08, 0x08, 0x05, 0x34, 0x33, 0x4A, 0x39, 0x15, 0x15, 0x2D, 0x33}},
    {"esp",
     {0x70, 0x09, 0x12, 0x0C, 0x0B, 0x27, 0x38, 0x54, 0x4E, 0x19, 0x15, 0x15, 0x2C, 0x2F},
     {0x70, 0x08, 0x11, 0x0C, 0x0B, 0x27, 0x38, 0x43, 0x4C, 0x18, 0x14, 0x14, 0x2B, 0x2D}},
    {"nt150",
     {0xF0, 0x10, 0x18, 0x0D, 0x0C, 0x38, 0x3E, 0x44, 0x51, 0x39, 0x15, 0x15, 0x30, 0x34},
     {0xF0, 0x0F, 0x17, 0x0D, 0x0B, 0x07, 0x3E, 0x33, 0x51, 0x39, 0x15, 0x15, 0x30, 0x34}},
    {"sym",
     {0xF0, 0x0A, 0x10, 0x09, 0x09, 0x36, 0x35, 0x33, 0x4A, 0x29, 0x15, 0x15, 0x2E, 0x34},
     {0xF0, 0x0A, 0x10, 0x09, 0x09, 0x36, 0x35, 0x33, 0x4A, 0x29, 0x15, 0x15, 0x2E, 0x34}},
};
constexpr size_t kGammaPresetCount = sizeof(kGammaPresets) / sizeof(kGammaPresets[0]);

inline const GammaPreset* findGammaPreset(const char* name)
{
  for (size_t i = 0; i < kGammaPresetCount; ++i)
  {
    if (strcmp(kGammaPresets[i].name, name) == 0) { return &kGammaPresets[i]; }
  }
  return nullptr;
}

// Space-separated hex bytes ("F0 0A 10"), each 1-2 digits. Returns how many were parsed, or -1 when
// the text has anything else in it, a value over FF, or more than `max` bytes.
inline int parseHexBytes(const char* text, uint8_t* out, size_t max)
{
  size_t n = 0;
  const char* p = text;
  while (*p == ' ') { ++p; }
  while (*p != '\0')
  {
    unsigned v = 0;
    int digits = 0;
    for (; digits < 3; ++digits, ++p)
    {
      const char c = *p;
      const int d = (c >= '0' && c <= '9') ? c - '0' : (c >= 'a' && c <= 'f') ? c - 'a' + 10 : (c >= 'A' && c <= 'F') ? c - 'A' + 10 : -1;
      if (d < 0) { break; }
      v = v * 16 + static_cast<unsigned>(d);
    }
    if (digits == 0 || digits > 2 || (*p != ' ' && *p != '\0') || n >= max) { return -1; }
    out[n++] = static_cast<uint8_t>(v);
    while (*p == ' ') { ++p; }
  }
  return static_cast<int>(n);
}

// Which init table Waveshare's demo would pick for an RDDID (0x04) read of 4 bytes, first byte first.
// Display_ST77916.cpp: 00 02 7F 7F -> vendor_specific_init_new ("ws"); 00 7F 7F 7F -> the Espressif
// default ("esp"); anything else -> unknown (the read may not work on this bus: no conclusion).
inline const char* tableForPanelId(const uint8_t id[4])
{
  if (id[0] == 0x00 && id[2] == 0x7F && id[3] == 0x7F)
  {
    if (id[1] == 0x02) { return "ws"; }
    if (id[1] == 0x7F) { return "esp"; }
  }
  return "unknown";
}

// MADCTL (0x36) in words for the console reply: row/column mirror, exchange and the BGR bit.
inline void describeMadctl(uint8_t v, char* out, size_t n)
{
  if (n == 0) { return; }
  out[0] = '\0';
  const struct { uint8_t bit; const char* name; } kBits[] = {{0x80, "MY"}, {0x40, "MX"}, {0x20, "MV"}, {0x10, "ML"}, {0x08, "BGR"}, {0x04, "MH"}};
  size_t len = 0;
  for (const auto& b : kBits)
  {
    if ((v & b.bit) == 0) { continue; }
    const size_t add = strlen(b.name) + (len ? 1 : 0);
    if (len + add + 1 > n) { break; }
    if (len) { out[len++] = '+'; }
    memcpy(out + len, b.name, strlen(b.name));
    len += strlen(b.name);
    out[len] = '\0';
  }
  if (len == 0 && n > 3) { memcpy(out, "RGB", 4); }
}

// M5GFX Light_PWM (9-bit LEDC, offset 0): the duty out of 512 for setBrightness(level). 200 -> 402
// (78 %); Waveshare's demo backlight is 50 of 100 on a 10-bit timer, i.e. 50 %, which is level 128 here.
constexpr uint32_t kBacklightDutyMax = 512;
inline uint32_t backlightDuty(uint8_t level)
{
  return level == 0 ? 0 : (static_cast<uint32_t>(level) * 257 + 64) >> 7;
}

} // namespace ws185tune
} // namespace bob
