#if defined(BOB_BOARD_WAVESHARE_185C)

#include "bob_art.h"

#include <M5Unified.h>

// The four 73,728 B images are .incbin'd from lib/bob_art (the build adds
// -Wa,-I$PROJECT_DIR/lib/bob_art), as src/wake_word.cpp does with its models. The
// assembler does not track them as dependencies: touch this file after
// regenerating them with scripts/bob_art_build.py.
asm(".section .rodata.bob_art,\"a\"\n"
    ".balign 4\n"
    ".global bob_welcome\n"
    "bob_welcome:\n"
    ".incbin \"bob_welcome.rgb565\"\n"
    ".balign 4\n"
    ".global bob_curious\n"
    "bob_curious:\n"
    ".incbin \"bob_curious.rgb565\"\n"
    ".balign 4\n"
    ".global bob_thoughtful\n"
    "bob_thoughtful:\n"
    ".incbin \"bob_thoughtful.rgb565\"\n"
    ".balign 4\n"
    ".global bob_playful\n"
    "bob_playful:\n"
    ".incbin \"bob_playful.rgb565\"\n"
    ".previous\n");
extern "C" const uint8_t bob_welcome[];
extern "C" const uint8_t bob_curious[];
extern "C" const uint8_t bob_thoughtful[];
extern "C" const uint8_t bob_playful[];

namespace bob
{
namespace
{
const uint8_t* const kImages[kBobPoseCount] = {bob_welcome, bob_curious, bob_thoughtful, bob_playful};
const char* const kNames[kBobPoseCount] = {"welcome", "curious", "thoughtful", "playful"};
} // namespace

void drawBob(BobPose pose, int16_t cx, int16_t cy)
{
  const uint8_t i = static_cast<uint8_t>(pose);
  if (i >= kBobPoseCount) { return; }
  // The files hold big-endian RGB565, which is lgfx::swap565_t: the order the panel takes.
  M5.Display.pushImage(cx - kBobSize / 2, cy - kBobSize / 2, kBobSize, kBobSize,
                       reinterpret_cast<const lgfx::swap565_t*>(kImages[i]));
}

const char* bobPoseName(BobPose pose)
{
  const uint8_t i = static_cast<uint8_t>(pose);
  return i < kBobPoseCount ? kNames[i] : "";
}

} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
