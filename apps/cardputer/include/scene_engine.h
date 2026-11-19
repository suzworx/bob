// Scene engine, device half: the compositor and the props' drawing on the Waveshare round UI
// (src/scene_engine.cpp, src/scene_props.cpp). The pure half (per-layer clocks and keyframed transforms) is
// scene_layers.h in Bob's portable core (libs/bob-device).
#pragma once

#include "scene_layers.h"

#if defined(BOB_BOARD_WAVESHARE_185C)

#include <M5Unified.h>

namespace bob {

// Starts `id` on the round UI: Bob takes the scene's feeling (unless `keepBob`, while he is speaking), the ring its
// pattern, the props appear on their own clocks and the caption fades in. False when Bob is not on screen (a card,
// Settings): the scene is dropped and journaled as scene_skipped.
bool sceneBegin(scene::SceneId id, uint8_t seconds, const char* label, int32_t value, bool keepBob, uint32_t nowMs);
bool sceneActive();
// Ends the scene now and gives Bob and the ring back to the screen's mood.
void sceneEnd(uint32_t nowMs);
// Called from chromeTick: ends the scene when its time is up and keeps the caption fresh.
void sceneTick(uint32_t nowMs);
// Called right after Bob's frame was composed (the frame erases the slots each time): draws the props.
void sceneDrawProps(M5Canvas& fb, uint32_t nowMs);

// Draws one prop centred at (cx, cy); `ms` is its own clock, `scale`/`alpha` the entrance and exit transform,
// `value` the scene's number (a timer's seconds) for props that show it. scene_props.cpp.
void sceneDrawProp(M5Canvas& fb, scene::Prop prop, int16_t cx, int16_t cy, uint32_t ms, float scale, float alpha, int32_t value);

}  // namespace bob

#endif  // BOB_BOARD_WAVESHARE_185C
