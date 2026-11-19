// Bob — the light ring on the Waveshare round screen (round_ring.cpp). The glass has no LEDs, so
// the ring is drawn in the outer annulus of the round UI's framebuffer; round_ring_policy.h holds the
// mood-to-pattern table and the animation math.
#pragma once

#if defined(BOB_BOARD_WAVESHARE_185C)

#include <stdint.h>

#include "round_ring_policy.h"
#include "round_ring_spec.h"

namespace bob
{

// Switches the coarse mode (restarts its animation); the same mode again changes nothing, so a scene
// played over it keeps running until the mode really changes.
void ringLightSetMode(RingMode mode, uint32_t nowMs);

// Plays a state, emotion or scene by name from the ring-language table (round_ring_spec.h) and always
// restarts it; false (nothing changes) for an unknown name. The scene engine and `T ring <name>` use it.
bool ringLightPlay(const char* name, uint32_t nowMs);
void ringLightPlay(const RingSpec* spec, uint32_t nowMs);

// Frame cost of the last frame and the worst one (microseconds): compose, then compose + draw.
struct RingStats
{
  uint32_t composeUs = 0, frameUs = 0, maxFrameUs = 0, frames = 0;
  uint8_t segments = 0; // dirty angle runs drawn by the last frame
};
RingStats ringLightStats();

// Live audio level 0..1 (mic while listening, playback while speaking). A negative value goes back
// to the built-in envelope. Nothing feeds this yet (a synthetic envelope runs meanwhile).
void ringLightSetLevel(float level01);

// The framebuffer was cleared: the ring is dark until a mode is set again.
void ringLightInvalidate();
// Something (Bob's frame) just painted over the rectangle: the ring angles whose band passes through it are repainted on the next tick.
void ringLightDamage(int16_t x, int16_t y, int16_t w, int16_t h);

// Draws one frame when due (20 fps) into the framebuffer and marks its sectors dirty.
void ringLightTick(uint32_t nowMs);

} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
