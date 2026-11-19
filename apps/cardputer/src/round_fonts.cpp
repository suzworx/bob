// Bob — the round UI's Nunito smooth fonts (scripts/font_build.py).
//
// The four VLW files are .incbin'd from lib/fonts (the build adds
// -Wa,-I$PROJECT_DIR/lib/fonts), as src/bob_art.cpp does with its images. The assembler does
// not track them as dependencies: touch this file after regenerating them. fontsBegin() parses
// each once at boot; M5GFX keeps the glyph tables in PSRAM and reads bitmaps from flash.
#if defined(BOB_BOARD_WAVESHARE_185C)

#include <M5Unified.h>

#include "round_ui.h"

asm(".section .rodata.bob_fonts,\"a\"\n"
    ".balign 4\n"
    ".global bob_font_caption\n"
    "bob_font_caption:\n"
    ".incbin \"nunito_caption.vlw\"\n"
    ".balign 4\n"
    ".global bob_font_body\n"
    "bob_font_body:\n"
    ".incbin \"nunito_body.vlw\"\n"
    ".balign 4\n"
    ".global bob_font_title\n"
    "bob_font_title:\n"
    ".incbin \"nunito_title.vlw\"\n"
    ".balign 4\n"
    ".global bob_font_hero\n"
    "bob_font_hero:\n"
    ".incbin \"nunito_hero.vlw\"\n"
    ".balign 4\n"
    ".global bob_font_url\n"
    "bob_font_url:\n"
    ".incbin \"nunito_url.vlw\"\n"
    ".balign 4\n"
    ".global bob_font_micro\n"
    "bob_font_micro:\n"
    ".incbin \"nunito_micro.vlw\"\n"
    ".balign 4\n"
    ".global bob_font_code\n"
    "bob_font_code:\n"
    ".incbin \"nunito_code.vlw\"\n"
    ".previous\n");
extern "C" const uint8_t bob_font_caption[];
extern "C" const uint8_t bob_font_body[];
extern "C" const uint8_t bob_font_title[];
extern "C" const uint8_t bob_font_hero[];
extern "C" const uint8_t bob_font_url[];
extern "C" const uint8_t bob_font_micro[];
extern "C" const uint8_t bob_font_code[];

namespace bob
{
namespace roundui
{
namespace
{
enum Role : uint8_t { kCaption, kBody, kTitle, kHero, kUrl, kMicro, kCode, kRoles };

const uint8_t* const kData[kRoles] = {bob_font_caption, bob_font_body, bob_font_title, bob_font_hero, bob_font_url, bob_font_micro, bob_font_code};
const lgfx::IFont* const kFallback[kRoles] = {&lgfx::fonts::Font2, &lgfx::fonts::FreeSans9pt7b, &lgfx::fonts::FreeSansBold12pt7b, &lgfx::fonts::FreeSansBold24pt7b, &lgfx::fonts::Font2, &lgfx::fonts::Font2, &lgfx::fonts::FreeSansBold18pt7b};

lgfx::VLWfont g_fonts[kRoles];
lgfx::PointerWrapper g_wrappers[kRoles];
bool g_loaded[kRoles] = {};

// The Nunito font once fontsBegin() parsed it, the built-in one if that failed.
const void* pick(Role r) { return g_loaded[r] ? static_cast<const lgfx::IFont*>(&g_fonts[r]) : kFallback[r]; }
} // namespace

void fontsBegin()
{
  for (uint8_t r = 0; r < kRoles; ++r)
  {
    if (g_loaded[r]) { continue; }
    g_wrappers[r].set(kData[r]);
    g_loaded[r] = g_fonts[r].loadFont(&g_wrappers[r]);
  }
}

const void* smallFont() { return pick(kCaption); }
const void* detailFont() { return pick(kBody); }
const void* titleFont() { return pick(kTitle); }
const void* heroFont() { return pick(kHero); }
const void* urlFont() { return pick(kUrl); }
const void* microFont() { return pick(kMicro); }
const void* codeFont() { return pick(kCode); }

} // namespace roundui
} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
