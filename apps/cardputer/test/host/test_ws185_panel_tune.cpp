// ST77916 tuning data for the hil console (include/ws185_panel_tune.h, #1065): the presets match their
// sources, the default preset is the table the product writes, and the console parsers reject junk.
#include <cstdint>
#include <cstring>

#include "doctest.h"
#include "ws185_panel_tune.h"

using namespace bob::ws185tune;

TEST_CASE("ws185 tune: every preset is found by name and unknown names are not") {
  for (size_t i = 0; i < kGammaPresetCount; ++i) CHECK(findGammaPreset(kGammaPresets[i].name) == &kGammaPresets[i]);
  CHECK(findGammaPreset("WS") == nullptr);
  CHECK(findGammaPreset("") == nullptr);
}

TEST_CASE("ws185 tune: ws is the product table, esp the Espressif default, sym mirrors ws E0") {
  // include/ws185_panel.h initCommands() E0/E1 (the bytes on the glass by default).
  const uint8_t kPos[] = {0xF0, 0x0A, 0x10, 0x09, 0x09, 0x36, 0x35, 0x33, 0x4A, 0x29, 0x15, 0x15, 0x2E, 0x34};
  const uint8_t kNeg[] = {0xF0, 0x0A, 0x0F, 0x08, 0x08, 0x05, 0x34, 0x33, 0x4A, 0x39, 0x15, 0x15, 0x2D, 0x33};
  const GammaPreset* ws = findGammaPreset("ws");
  REQUIRE(ws != nullptr);
  CHECK(memcmp(ws->pos, kPos, kGammaBytes) == 0);
  CHECK(memcmp(ws->neg, kNeg, kGammaBytes) == 0);
  const GammaPreset* esp = findGammaPreset("esp");
  REQUIRE(esp != nullptr);
  CHECK(esp->pos[0] == 0x70);
  CHECK(esp->neg[13] == 0x2D);
  const GammaPreset* sym = findGammaPreset("sym");
  REQUIRE(sym != nullptr);
  CHECK(memcmp(sym->pos, kPos, kGammaBytes) == 0);
  CHECK(memcmp(sym->neg, kPos, kGammaBytes) == 0);
}

TEST_CASE("ws185 tune: hex bytes parse with any spacing and reject junk, big values and overflow") {
  uint8_t b[14] = {};
  CHECK(parseHexBytes("F0 0a 1", b, 14) == 3);
  CHECK(b[0] == 0xF0);
  CHECK(b[1] == 0x0A);
  CHECK(b[2] == 0x01);
  CHECK(parseHexBytes("  21  ", b, 14) == 1);
  CHECK(b[0] == 0x21);
  CHECK(parseHexBytes("", b, 14) == 0);
  CHECK(parseHexBytes("100", b, 14) == -1);
  CHECK(parseHexBytes("0x21", b, 14) == -1);
  CHECK(parseHexBytes("2G", b, 14) == -1);
  CHECK(parseHexBytes("01 02 03", b, 2) == -1);
  CHECK(parseHexBytes("F0 0A 10 09 09 36 35 33 4A 29 15 15 2E 34", b, 14) == 14);
  CHECK(b[13] == 0x34);
}

TEST_CASE("ws185 tune: RDDID maps to the table Waveshare's demo would pick") {
  const uint8_t kNew[4] = {0x00, 0x02, 0x7F, 0x7F};
  const uint8_t kDefault[4] = {0x00, 0x7F, 0x7F, 0x7F};
  const uint8_t kBlank[4] = {0x00, 0x00, 0x00, 0x00};
  const uint8_t kFloat[4] = {0xFF, 0xFF, 0xFF, 0xFF};
  CHECK(strcmp(tableForPanelId(kNew), "ws") == 0);
  CHECK(strcmp(tableForPanelId(kDefault), "esp") == 0);
  CHECK(strcmp(tableForPanelId(kBlank), "unknown") == 0);
  CHECK(strcmp(tableForPanelId(kFloat), "unknown") == 0);
}

TEST_CASE("ws185 tune: MADCTL bits in words, RGB when no bit is set, never past the buffer") {
  char s[32];
  describeMadctl(0x00, s, sizeof(s));
  CHECK(strcmp(s, "RGB") == 0);
  describeMadctl(0x08, s, sizeof(s));
  CHECK(strcmp(s, "BGR") == 0);
  describeMadctl(0xC8, s, sizeof(s));
  CHECK(strcmp(s, "MY+MX+BGR") == 0);
  char tiny[4];
  describeMadctl(0xFF, tiny, sizeof(tiny));
  CHECK(strlen(tiny) < sizeof(tiny));
}

TEST_CASE("ws185 tune: backlight duty follows M5GFX Light_PWM (9 bit)") {
  CHECK(backlightDuty(0) == 0);
  CHECK(backlightDuty(200) == 402);
  CHECK(backlightDuty(128) == 257);
  CHECK(backlightDuty(255) == 512);
}
