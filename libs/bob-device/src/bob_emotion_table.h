// Bob's emotion table, the board-independent half of the Waveshare emotions (ADR 0004, libs/bob-device). An emotion is
// the SAME character art put together from four independent parts: a body pose (one of the four existing images), an
// eye expression drawn on the dark visor, a motion gesture and an animated accent around him. The drawing lives with
// each target (apps/cardputer/include/bob_emotions.h on the device); this header is data only: no Arduino, no M5.
//
// The X-macro below is the single source of truth: it builds the enum, the spec table and, via
// apps/cardputer/scripts/bob_emotions_preview.py, the contact sheet docs/cardputer/bob-emotions.png.
// Row: X(Name, pose, eyes, gesture, accent, loopMs). loopMs replays the gesture on that period
// (0 = the gesture plays once when the emotion starts).
#pragma once

#include <stdint.h>

#include "bob_tokens.h"

namespace bob
{

// Bob's four poses (192x192 RGB565 images on the device, apps/cardputer/include/bob_art.h).
enum class BobPose : uint8_t { kWelcome, kCurious, kThoughtful, kPlayful };

constexpr int16_t kBobSize = 192;
constexpr uint16_t kBobGround = 0x11EA; // #173E57 as RGB565, the colour the images are flattened onto
constexpr uint8_t kBobPoseCount = 4;

enum class BobEyes : uint8_t
{
  kDot, kWide, kNarrow, kHappyArc, kClosed, kHalfLid, kAngry, kSad, kHeart, kStar, kX, kSpiral,
  kBigSmall, kWink, kLookLeft, kLookRight, kLookUp, kShades, kLaugh, kRoll, kWavy, kSkeptic
};

enum class BobGesture : uint8_t { kNone, kNod, kShake, kBounce, kShiver, kBow, kWobble, kDance, kTilt, kSlump, kSway };

enum class BobAccent : uint8_t
{
  kNone, kHearts, kZzz, kQuestion, kExclaim, kSweat, kTears, kSparkles, kConfetti, kNotes, kBulb, kCheck,
  kCross, kBell, kNoSignal, kSpinner, kBlush, kDots, kWaves, kStars, kWarn, kShiverLines, kAnger, kSick, kBubble
};

// Name, pose, eyes, gesture, accent, loopMs.
#define BOB_EMOTIONS(X) \
  X(Idle,        kWelcome,    kDot,       kNone,   kNone,        0) \
  X(Listening,   kCurious,    kWide,      kTilt,   kNone,        0) \
  X(Thinking,    kThoughtful, kLookUp,    kNone,   kQuestion,    0) \
  X(Speaking,    kPlayful,    kHappyArc,  kNod,    kNotes,    2600) \
  X(Sleeping,    kThoughtful, kClosed,    kNone,   kZzz,         0) \
  X(WakingUp,    kCurious,    kHalfLid,   kNod,    kNone,        0) \
  X(Hello,       kWelcome,    kHappyArc,  kNod,    kSparkles,    0) \
  X(Updating,    kThoughtful, kClosed,    kNone,   kSpinner,     0) \
  X(Offline,     kThoughtful, kHalfLid,   kSlump,  kQuestion,    0) \
  X(Error,       kWelcome,    kSad,       kShake,  kQuestion,    0) \
  X(Success,     kPlayful,    kHappyArc,  kBounce, kCheck,       0) \
  X(Failed,      kThoughtful, kX,         kSlump,  kCross,       0) \
  X(Happy,       kWelcome,    kHappyArc,  kNod,    kNone,        0) \
  X(Joyful,      kPlayful,    kHappyArc,  kBounce, kSparkles, 2400) \
  X(Laughing,    kPlayful,    kLaugh,     kWobble, kTears,    1800) \
  X(Love,        kPlayful,    kHeart,     kSway,   kHearts,   3000) \
  X(Grateful,    kWelcome,    kHappyArc,  kBow,    kBlush,       0) \
  X(Proud,       kPlayful,    kClosed,    kNod,    kSparkles,    0) \
  X(Playful,     kPlayful,    kWink,      kTilt,   kNone,        0) \
  X(Excited,     kPlayful,    kWide,      kBounce, kSparkles, 1600) \
  X(Celebrating, kPlayful,    kHappyArc,  kDance,  kConfetti, 2000) \
  X(Relieved,    kWelcome,    kClosed,    kSlump,  kNone,        0) \
  X(Calm,        kThoughtful, kClosed,    kNone,   kNone,        0) \
  X(Cool,        kWelcome,    kShades,    kNod,    kSparkles,    0) \
  X(Curious,     kCurious,    kLookUp,    kTilt,   kQuestion,    0) \
  X(Surprised,   kCurious,    kWide,      kBounce, kExclaim,     0) \
  X(Amazed,      kPlayful,    kStar,      kBounce, kSparkles, 2400) \
  X(Confused,    kCurious,    kLookLeft,  kTilt,   kQuestion, 2800) \
  X(Skeptical,   kThoughtful, kSkeptic,   kTilt,   kNone,        0) \
  X(Focused,     kThoughtful, kNarrow,    kNone,   kNone,        0) \
  X(Idea,        kCurious,    kWide,      kBounce, kBulb,        0) \
  X(Sad,         kThoughtful, kSad,       kSlump,  kNone,        0) \
  X(Crying,      kThoughtful, kSad,       kShiver, kTears,    1600) \
  X(Worried,     kThoughtful, kSad,       kTilt,   kSweat,       0) \
  X(Scared,      kWelcome,    kWide,      kShiver, kShiverLines, 900) \
  X(Grumpy,      kWelcome,    kAngry,     kShake,  kAnger,    2600) \
  X(Annoyed,     kThoughtful, kRoll,      kTilt,   kNone,        0) \
  X(Embarrassed, kWelcome,    kLookLeft,  kWobble, kBlush,       0) \
  X(Shy,         kWelcome,    kDot,       kTilt,   kNone,        0) \
  X(Bored,       kThoughtful, kHalfLid,   kSlump,  kDots,        0) \
  X(Sleepy,      kWelcome,    kHalfLid,   kNod,    kZzz,         0) \
  X(Dizzy,       kCurious,    kSpiral,    kWobble, kStars,    1800) \
  X(Sick,        kThoughtful, kWavy,      kWobble, kSick,        0) \
  X(Apologetic,  kWelcome,    kSad,       kBow,    kNone,        0) \
  X(Alarm,       kCurious,    kWide,      kShake,  kBell,     1200) \
  X(Music,       kPlayful,    kHappyArc,  kDance,  kNotes,    2000) \
  X(Reminder,    kWelcome,    kWide,      kNod,    kBubble,   3000)

enum class BobEmotion : uint8_t
{
#define X(name, pose, eyes, gesture, accent, loopMs) k##name,
  BOB_EMOTIONS(X)
#undef X
  kCount
};

struct BobEmotionSpec
{
  const char* name;
  BobPose pose;
  BobEyes eyes;
  BobGesture gesture;
  BobAccent accent;
  uint16_t loopMs;
};

constexpr BobEmotionSpec kBobEmotions[] = {
#define X(name, pose, eyes, gesture, accent, loopMs) {#name, BobPose::pose, BobEyes::eyes, BobGesture::gesture, BobAccent::accent, loopMs},
    BOB_EMOTIONS(X)
#undef X
};
constexpr uint8_t kBobEmotionCount = static_cast<uint8_t>(BobEmotion::kCount);
static_assert(sizeof(kBobEmotions) / sizeof(kBobEmotions[0]) == kBobEmotionCount, "emotion table and enum disagree");

inline const BobEmotionSpec& bobEmotionSpec(BobEmotion e) { return kBobEmotions[static_cast<uint8_t>(e)]; }

// --- Palette (RGB565) ----------------------------------------------------------------------
constexpr uint16_t bobRgb(uint8_t r, uint8_t g, uint8_t b) { return static_cast<uint16_t>(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)); }
constexpr uint16_t kBobInk = bobRgb(0x17, 0x3E, 0x57), kBobPaper = bobRgb(0xFF, 0xFD, 0xF6), kBobYellow = bobRgb(0xF0, 0xC7, 0x5E);
constexpr uint16_t kBobSky = bobRgb(0xBB, 0xDD, 0xF0), kBobGrass = bobRgb(0x72, 0x96, 0x5B), kBobCoral = bobRgb(0xF0, 0x7A, 0x6A);
constexpr uint16_t kBobAmber = bobRgb(0xF0, 0xC7, 0x5E); // the demo eye colour: the palette yellow

// Frame sprite geometry shared with bob_motion.cpp: the 192 px pose sits at (kBobPoseX, kBobPoseY).
constexpr int16_t kBobFrameW = 232, kBobFrameH = bobtok::kBobFrameH, kBobPoseX = 20, kBobPoseY = 24; // the frame starts at the token's frame top and is the token's height

} // namespace bob
