// Bob's motion on the Waveshare round screen: transforms of the four existing poses only,
// the same moves as heybob.app (src/components/landing/bob-motion.tsx): rotate and
// translate around a pivot at 50% x / 90% y, cubic-bezier(.45,0,.55,1), 650 ms gestures,
// plus a 3.2 s idle breathing bob, blinks, and 200 ms crossfades between poses.
// Rendering uses two PSRAM sprites and caps at 30 fps. Call bobMotionTick() every loop.
#pragma once

#if defined(BOB_BOARD_WAVESHARE_185C)

#include <M5Unified.h>
#include <stdint.h>

#include "bob_art.h"
#include "bob_emotions.h"

namespace bob
{

struct BobMotionStats
{
  uint32_t frames = 0; // frames drawn since the last read
  uint32_t totalUs = 0; // sum of compose + push time of those frames
  uint32_t maxUs = 0;
  uint32_t rotateUs = 0; // part of totalUs: pose blend + rotate into the frame sprite
  uint32_t pushUs = 0;   // part of totalUs: frame sprite to the panel
  uint32_t visorFrames = 0, visorUs = 0; // face-only redraws (upright blink/gaze): count and total cost, not in frames/totalUs
  uint32_t windowMs = 0; // wall time covered
  // Rig mode (bob_rig.h): the compose step alone (fill + parts + face + accents, before the push).
  uint32_t composeMaxUs = 0;
  uint32_t slowFrames = 0; // frames whose compose took more than the 15 ms budget
  uint32_t cacheHits = 0, cacheMisses = 0; // rotated-part cache
  uint32_t bakeHits = 0, bakeMisses = 0;   // baked static layers: blits vs re-bakes (a re-bake is one slow frame)
};

// Allocates the PSRAM sprites. False when PSRAM is missing: bobMotionSet() then only
// draws the still pose.
bool bobMotionBegin();

// Switches to `pose` centred at (cx, cy) with a 200 ms crossfade, then plays its gesture once.
void bobMotionSet(BobPose pose, int16_t cx, int16_t cy);

// Switches to emotion `e` (pose + eye expression + gesture + accent, see bob_emotions.h)
// centred at (cx, cy). bobMotionSet() is the pose-only wrapper kept for the bring-up screens.
void bobMotionSetEmotion(BobEmotion e, int16_t cx, int16_t cy);

// Touch reactions (emotion mode only; no-ops in the bring-up pose mode).
// A tap on Bob: a giggle wiggle, ^ ^ eyes and one small coral heart rising, about 0.9 s.
void bobMotionTapReaction();
// While a finger holds Bob: he leans and squishes a little (a spring eases it in and out).
void bobMotionHold(bool held);
// The eyes look toward a screen point (touch coordinates) for 2.5 s, springing there and back.
void bobMotionLookAt(int16_t x, int16_t y);

// Plays rig move `name` (bob_moves.h, e.g. "wave", "backflip") once now, over the emotion's own motion.
// False when the rig is not in use (blobs missing, PSRAM missing, bring-up pose mode) or the name is unknown.
bool bobMotionPlayMove(const char* name);

// True when Bob is drawn from rig parts; false when the whole-pose images are used.
bool bobMotionRigActive();
bool bobMotionSlicePending(); // a rig frame is being composed band by band: tick again next pass

#if defined(BOBSIM_FREEZE)
// Visual gate REST mode (sim only, -DBOBSIM_FREEZE=1; device builds never define it).
// Freeze on: no breath, bob or sway, gaze fixed at 0, no blink, no idle micro-behaviours, no looping state gesture:
// Bob sits in the rest pose of the current state and emotion.
void bobMotionFreeze(bool on);
// Draws rig move `name` frozen at normalised time t in [0, 1] (t = elapsed / move duration), springs run to rest, so the
// same t always gives the same pixels. False for an unknown move or when the rig is off. Implies freeze.
bool bobMotionPoseAt(const char* move, float t);
#endif

// A face-only change while Bob is upright (blink, gaze) redraws just the visor: bobMotionTick() returns false for it and the
// pushed rectangle (target coordinates) is taken here once, to mark it dirty. False when there is none.
bool bobMotionTakeVisorDirty(int16_t* x, int16_t* y, int16_t* w, int16_t* h);
// While still, Bob starts no idle extras (hop, wobble, hum): only blinks and looks, which are visor-only redraws.
void bobMotionSetStill(bool still);
// The current feeling rests with both arms down instead of its pose's own (the demo's reply card); a new feeling resets it.
void bobMotionRestArmsDown(bool down);
// True while a blink is a visor-only redraw: the UI ticks Bob at 30 fps instead of 15.
bool bobMotionWantsFastTick();
// True when a blink or look is due or moving: a resting Bob still needs ticks for those (never for full-frame idle extras).
bool bobMotionNeedsTick(uint32_t now);

// Draws the rig smaller and higher (tokens: pairing, speaking): `scale` about the feet line, then `rise` px (negative = up).
// 1 and 0 restore the full-size Bob. No effect on the whole-pose fallback.
void bobMotionSetStage(float scale, float rise);
// The stage last set (touch hit-testing: where Bob's body is now).
void bobMotionStage(float* scale, float* rise);

// Replays the current pose's gesture.
void bobMotionGesture();

// Advances the animation and draws a frame when due (at most 30 fps).
// Returns true when a frame was composed into the target. `force` skips the 30 fps gate.
bool bobMotionTick(uint32_t nowMs, bool force = false);

// Composes frames into `target` (a canvas) instead of M5.Display; nullptr restores the display.
void bobMotionSetTarget(lgfx::LovyanGFX* target);

// Same for a canvas target: frames are then copied row by row (memcpy), honouring the canvas clip rect.
void bobMotionSetTargetCanvas(M5Canvas* canvas);

// Returns and clears the frame statistics.
BobMotionStats bobMotionTakeStats();

} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
