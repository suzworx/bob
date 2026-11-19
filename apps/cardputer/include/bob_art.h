// Bob's four poses as 192x192 RGB565 images for the Waveshare round screen. The pixels are
// built by scripts/bob_art_build.py from assets/bob/*.webp onto the ground colour
// kBobGround (#173E57) and embedded from lib/bob_art/ (see src/bob_art.cpp).
#pragma once

#if defined(BOB_BOARD_WAVESHARE_185C)

#include <stdint.h>

#include "bob_emotion_table.h" // BobPose, kBobSize, kBobGround, kBobPoseCount

namespace bob
{

// Pushes the pose, centred at (cx, cy), to M5.Display.
void drawBob(BobPose pose, int16_t cx, int16_t cy);

// "welcome", "curious", "thoughtful" or "playful".
const char* bobPoseName(BobPose pose);

} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
