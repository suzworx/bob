// Bob's emotions on the Waveshare round screen. An emotion is the SAME character art put
// together from four independent parts: a body pose (one of the four existing images), an eye
// expression drawn on the dark visor (bob_face.cpp), a motion gesture (bob_motion.cpp) and an
// animated accent around him (bob_emotions.cpp). No new body art, no generated images.
//
// The emotion table (the X-macro, the enums, the palette and the frame geometry) is board-independent and lives in
// Bob's portable core: libs/bob-device/src/bob_emotion_table.h. This header is the device's drawing half.
#pragma once

#if defined(BOB_BOARD_WAVESHARE_185C)

#include <M5Unified.h>
#include <stdint.h>

#include "bob_art.h"
#include "bob_emotion_table.h"

namespace bob
{

// --- The shared shape primitives ------------------------------------------------------------

// Thick line and arc (0 deg = right, 90 = down), the same shapes as the preview script.
void bobLine(M5Canvas& c, float x0, float y0, float x1, float y1, float w, uint16_t col);
void bobArc(M5Canvas& c, float x, float y, float r, float a0, float a1, float w, uint16_t col);

// Clears the visor of the pose sprite (192 px) and draws the eye expression; `blink` squashes the eyes flat.
// `open` 1 = open .. 0 = shut squishes the eyes (the blink); lookU/lookV (+-1 px) move the catch-lights;
// gazeU/gazeV (visor px, clamped to +-3 and +-1.5) move the pupils toward a target.
void bobFaceDraw(M5Canvas& pose, BobPose p, BobEyes eyes, float open = 1.0f, float lookU = 0.0f, float lookV = 0.0f, float gazeU = 0.0f,
                 float gazeV = 0.0f);

// The same face on any canvas: visor centre (cx, cy) and tilt `deg` in canvas pixels. The rig draws it upright on a
// transparent visor-sized canvas (clearPlate false) and moves it with the visor part.
void bobFaceDrawAt(M5Canvas& c, float cx, float cy, float deg, BobEyes eyes, bool clearPlate, float open = 1.0f, float lookU = 0.0f,
                   float lookV = 0.0f, float gazeU = 0.0f, float gazeV = 0.0f);

// Frame-space position of visor-local offset (u, v) from eye s (-1 left, +1 right), for accents.
void bobEyePos(BobPose p, int s, float u, float v, float* x, float* y);

// One small coral heart rising from Bob's head (the tap reaction); t runs 0..1.
void bobAccentOneHeart(M5Canvas& frame, float t, BobPose p);

// The visor's art region of pose `p`, and the art put back in just that region of the pose sprite (visor-only redraws).
void bobFaceRegion(BobPose p, int16_t* x, int16_t* y, int16_t* w, int16_t* h);
void bobFaceReset(M5Canvas& pose, BobPose p);

// Draws accent `a` at animation phase t (0..1) into the frame sprite (kBobFrameW x kBobFrameH).
void bobAccentDraw(M5Canvas& frame, BobAccent a, float t, BobPose p);

} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
