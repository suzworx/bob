// Bob — the ring light language: ONE data table that maps device states, Bob's emotions and scene
// names to a RingSpec (pattern + colours + motion + speed + direction + segments + brightness
// envelope). Pure and constexpr (host-tested in test/host/test_round_ring_spec.cpp; no M5 includes).
// round_ring_compose.h turns a spec into 360 per-degree pixels; round_ring.cpp draws them.
//
// North star: Bob lightens up people's moods. The ring is a few warm, slow, minimal lights that react
// like a pet would, never a light show. Rainbow is rare (celebrating only). The ground is ink
// (#173E57), so "ink" on the ring is a lifted ink tint that can be seen against it.
#pragma once

#include <cstdint>

#include "bob_tokens.h"

namespace bob
{

enum class RingShape : uint8_t
{
  kSolid, kBreathe, kPulse, kComet, kDualComet, kSpinner, kChase, kWave, kGradient, kFill, kTicks, kSparkle,
  kRainbow, kLevel, kHeartbeat,
  kGlow, // the whole rim, one brightness that follows the level
  kSweep // the demo's conic sweep: head at segments*2 degrees (clockwise from 12 o'clock) at phase 0, tailHalf*2 degrees of linear tail, a 36 degree fade ahead
};

// cw/ccw turn forever; ping-pong swings back and forth; ease-in/out eases every lap; bounce settles
// like a ball; still does not travel; accel speeds up from a crawl to full speed over 2.5 s.
// `dir` (+1 cw, -1 ccw) picks the start direction of the ping-pong, ease, bounce and accel motions.
enum class RingMotion : uint8_t { kCw, kCcw, kPingPong, kEaseInOut, kBounce, kStill, kAccel };

// The Bob palette (the ring colours) and a few tints of it.
constexpr uint32_t kRingInk = bobtok::kInk, kRingPaper = bobtok::kPaper, kRingYellow = bobtok::kYellow;
constexpr uint32_t kRingSky = bobtok::kSky, kRingGrass = bobtok::kGrass, kRingCoral = bobtok::kCoral;

// Linear mix of two 0xRRGGBB colours: t 0 = a ... 256 = b.
constexpr uint32_t ringMix(uint32_t a, uint32_t b, uint32_t t)
{
  return (((((a >> 16) & 255) * (256 - t) + ((b >> 16) & 255) * t) >> 8) << 16) |
         (((((a >> 8) & 255) * (256 - t) + ((b >> 8) & 255) * t) >> 8) << 8) | ((((a & 255) * (256 - t) + (b & 255) * t) >> 8));
}

constexpr uint32_t kRingSkyTint = ringMix(kRingSky, kRingPaper, 110), kRingYellowTint = ringMix(kRingYellow, kRingPaper, 110);
constexpr uint32_t kRingCoralTint = ringMix(kRingCoral, kRingPaper, 100), kRingGrassTint = ringMix(kRingGrass, kRingPaper, 110);
constexpr uint32_t kRingSkyDeep = ringMix(kRingSky, kRingInk, 110);   // night sky: sleepy, sad, rainy
constexpr uint32_t kRingInkLift = ringMix(kRingInk, kRingSky, 105);   // "ink" that shows on the ink ground

// A plain constexpr value (the firmware builds as C++11: single-return constexpr functions only).
struct RingSpec
{
  RingShape pattern;
  RingMotion motion;
  int8_t dir;           // +1 cw, -1 ccw
  uint8_t nColors;      // 1..4 palette colours; 0 = rainbow hues
  uint32_t colors[4];   // 0xRRGGBB
  uint16_t periodMs;    // one lap / cycle / breath
  uint8_t segments;     // comet tails, chase dashes, wave crests, tick marks, spinner arcs (0 = pattern default)
  uint8_t lo, hi;       // brightness envelope: shape 0 -> lo, shape 1 -> hi
  uint16_t inMs;        // fade in
  uint16_t holdMs;      // 0 = until replaced; else fade out after inMs + holdMs
  uint16_t outMs;       // fade out length
  uint8_t ticks;        // clock-mark overlay drawn over any pattern (0 = none)
  uint16_t introMs;     // after introMs, continue with the spec named `then`
  const char* then;
  uint8_t aheadDeg;     // kSweep only: the fade in front of the head, degrees (ringAhead)
  uint8_t tailHalf;     // kSweep only: half the tail length in degrees (ringTail)

  constexpr RingSpec(RingShape p, RingMotion m, int8_t d, uint8_t n, uint32_t c0, uint32_t c1, uint32_t c2, uint32_t c3, uint16_t period,
                     uint8_t seg, uint8_t lo_, uint8_t hi_, uint16_t in, uint16_t hold, uint16_t out, uint8_t tk, uint16_t intro, const char* next, uint8_t ahead = 36, uint8_t tail = 0)
      : pattern(p), motion(m), dir(d), nColors(n), colors{c0, c1, c2, c3}, periodMs(period), segments(seg), lo(lo_), hi(hi_), inMs(in),
        holdMs(hold), outMs(out), ticks(tk), introMs(intro), then(next), aheadDeg(ahead), tailHalf(tail)
  {
  }
};

constexpr RingSpec ringMake(RingShape p, RingMotion m, uint16_t periodMs, uint8_t segments, uint8_t lo, uint8_t hi, uint8_t n,
                            uint32_t c0, uint32_t c1 = 0, uint32_t c2 = 0, uint32_t c3 = 0)
{
  return RingSpec(p, m, 1, n, c0, c1, c2, c3, periodMs, segments, lo, hi, 120, 0, 0, 0, 0, nullptr);
}
constexpr RingSpec ringDir(const RingSpec& s, int8_t dir)
{
  return RingSpec(s.pattern, s.motion, dir, s.nColors, s.colors[0], s.colors[1], s.colors[2], s.colors[3], s.periodMs, s.segments, s.lo, s.hi,
                  s.inMs, s.holdMs, s.outMs, s.ticks, s.introMs, s.then, s.aheadDeg, s.tailHalf);
}
constexpr RingSpec ringLife(const RingSpec& s, uint16_t inMs, uint16_t holdMs, uint16_t outMs)
{
  return RingSpec(s.pattern, s.motion, s.dir, s.nColors, s.colors[0], s.colors[1], s.colors[2], s.colors[3], s.periodMs, s.segments, s.lo, s.hi,
                  inMs, holdMs, outMs, s.ticks, s.introMs, s.then, s.aheadDeg, s.tailHalf);
}
constexpr RingSpec ringTicks(const RingSpec& s, uint8_t n)
{
  return RingSpec(s.pattern, s.motion, s.dir, s.nColors, s.colors[0], s.colors[1], s.colors[2], s.colors[3], s.periodMs, s.segments, s.lo, s.hi,
                  s.inMs, s.holdMs, s.outMs, n, s.introMs, s.then, s.aheadDeg, s.tailHalf);
}
constexpr RingSpec ringTail(const RingSpec& s, uint8_t half)
{
  return RingSpec(s.pattern, s.motion, s.dir, s.nColors, s.colors[0], s.colors[1], s.colors[2], s.colors[3], s.periodMs, s.segments, s.lo, s.hi,
                  s.inMs, s.holdMs, s.outMs, s.ticks, s.introMs, s.then, s.aheadDeg, half);
}
constexpr RingSpec ringAhead(const RingSpec& s, uint8_t deg)
{
  return RingSpec(s.pattern, s.motion, s.dir, s.nColors, s.colors[0], s.colors[1], s.colors[2], s.colors[3], s.periodMs, s.segments, s.lo, s.hi,
                  s.inMs, s.holdMs, s.outMs, s.ticks, s.introMs, s.then, deg, s.tailHalf);
}
constexpr RingSpec ringThen(const RingSpec& s, uint16_t introMs, const char* then)
{
  return RingSpec(s.pattern, s.motion, s.dir, s.nColors, s.colors[0], s.colors[1], s.colors[2], s.colors[3], s.periodMs, s.segments, s.lo, s.hi,
                  s.inMs, s.holdMs, s.outMs, s.ticks, introMs, then, s.aheadDeg, s.tailHalf);
}

struct RingEntry
{
  const char* name;
  RingSpec spec;
};

namespace ringtable
{
using P = RingShape;
using M = RingMotion;
constexpr uint32_t INK = kRingInkLift, SKY = kRingSky, YEL = kRingYellow, COR = kRingCoral, GRS = kRingGrass, PAP = kRingPaper;
constexpr uint32_t SKYT = kRingSkyTint, YELT = kRingYellowTint, CORT = kRingCoralTint, GRST = kRingGrassTint, SKYD = kRingSkyDeep;

// The one table. Names are matched ignoring case, '_', '-' and ' ' (ringSpecByName).
constexpr RingEntry kEntries[] = {
    // --- device states -------------------------------------------------------------------------
    {"idle", ringMake(P::kSolid, M::kStill, 1000, 0, 255, 255, 1, SKY)}, // rests as the soft glass rim (round_ring.cpp draws it at 25%, 6 px)
    {"listening", ringTail(ringThen(ringMake(P::kSweep, M::kCw, 1600, 162, 0, 255, 1, SKY), 1000, "listening_level"), 90)},
    {"listening_level", ringMake(P::kLevel, M::kCw, 4000, 0, 50, 255, 2, SKY, SKYT)},
    {"thinking", ringAhead(ringTail(ringMake(P::kSweep, M::kCw, 1100, 178, 0, 255, 1, YEL), 79), 4)},
    {"speaking", ringMake(P::kGlow, M::kStill, 3000, 0, 89, 255, 2, SKY, SKYT)}, // the demo: opacity .35 + .65 * level
    {"sleeping", ringMake(P::kBreathe, M::kStill, 4500, 0, 8, 90, 1, SKYD)},
    {"ok", ringMake(P::kBreathe, M::kStill, 1600, 0, 64, 255, 1, GRS)}, // pairing: the demo's grass pulse (25% at rest, 100% at the peak)
    {"dnd", ringMake(P::kBreathe, M::kStill, 5000, 0, 10, 80, 1, INK)},
    {"notification", ringMake(P::kChase, M::kCw, 1600, 12, 0, 255, 2, YEL, YELT)},
    {"offline", ringMake(P::kBreathe, M::kStill, 2600, 0, 20, 140, 1, COR)},
    {"error", ringMake(P::kBreathe, M::kStill, 1200, 0, 26, 153, 1, COR)}, // the demo: a soft coral pulse, 10% to 60%
    {"updating", ringAhead(ringTail(ringMake(P::kSweep, M::kCw, 1100, 178, 0, 255, 1, YEL), 79), 4)}, // the demo rings Updating like Thinking
    {"hello", ringLife(ringMake(P::kGradient, M::kCw, 2400, 0, 0, 230, 3, YEL, SKY, GRS), 200, 2200, 700)},
    {"waking_up", ringLife(ringMake(P::kFill, M::kEaseInOut, 1500, 0, 0, 220, 2, SKYD, SKY), 100, 1700, 600)},
    // --- Bob's emotions ------------------------------------------------------------------------
    {"success", ringLife(ringMake(P::kFill, M::kCw, 1100, 0, 0, 255, 2, GRS, GRST), 100, 1500, 700)}, // grass fill, then fade
    {"failed", ringLife(ringMake(P::kPulse, M::kStill, 900, 1, 0, 255, 2, COR, CORT), 80, 1500, 600)},
    {"happy", ringMake(P::kWave, M::kCw, 3000, 3, 40, 200, 2, YEL, YELT)},
    {"joyful", ringMake(P::kSparkle, M::kStill, 700, 0, 20, 255, 3, YEL, PAP, SKY)},
    {"laughing", ringMake(P::kWave, M::kCcw, 700, 6, 30, 255, 2, YEL, YELT)},
    {"love", ringMake(P::kHeartbeat, M::kStill, 1150, 0, 25, 255, 2, COR, CORT)},
    {"grateful", ringMake(P::kBreathe, M::kStill, 3200, 0, 25, 170, 1, YELT)},
    {"proud", ringMake(P::kGradient, M::kCw, 2600, 0, 0, 210, 3, YEL, PAP, YEL)},
    {"playful", ringMake(P::kComet, M::kCw, 1800, 3, 0, 255, 2, SKY, YEL)},
    {"excited", ringMake(P::kSpinner, M::kCw, 800, 3, 0, 255, 2, YEL, COR)},
    {"celebrating", ringThen(ringMake(P::kRainbow, M::kCw, 1500, 0, 60, 230, 0, 0), 900, "celebrating_sparkle")}, // rainbow: the only one
    {"celebrating_sparkle", ringMake(P::kSparkle, M::kStill, 650, 0, 30, 255, 0, 0)},
    {"relieved", ringMake(P::kBreathe, M::kStill, 3600, 0, 20, 150, 1, SKYT)},
    {"calm", ringMake(P::kBreathe, M::kStill, 5200, 0, 10, 110, 1, SKY)},
    {"cool", ringDir(ringMake(P::kGradient, M::kCcw, 3200, 0, 0, 210, 3, SKYD, SKY, PAP), -1)},
    {"curious", ringMake(P::kComet, M::kPingPong, 2600, 1, 0, 255, 2, SKY, SKYT)},
    {"surprised", ringLife(ringMake(P::kPulse, M::kStill, 800, 1, 0, 255, 2, YEL, PAP), 60, 1400, 500)},
    {"amazed", ringMake(P::kSparkle, M::kStill, 900, 0, 20, 255, 3, SKY, YEL, PAP)},
    {"confused", ringMake(P::kSpinner, M::kBounce, 1900, 1, 0, 220, 2, COR, YEL)},
    {"skeptical", ringMake(P::kChase, M::kPingPong, 2800, 4, 0, 170, 1, SKY)},
    {"focused", ringMake(P::kTicks, M::kCw, 9000, 12, 20, 200, 2, SKYT, SKY)},
    {"idea", ringLife(ringMake(P::kPulse, M::kStill, 1000, 1, 10, 255, 2, YEL, PAP), 60, 1600, 500)},
    {"sad", ringMake(P::kBreathe, M::kStill, 4600, 0, 8, 80, 1, SKYD)},
    {"crying", ringMake(P::kWave, M::kCcw, 2300, 4, 15, 140, 2, SKYD, SKY)},
    {"worried", ringMake(P::kComet, M::kPingPong, 2100, 1, 0, 170, 2, CORT, COR)},
    {"scared", ringMake(P::kSparkle, M::kStill, 380, 0, 0, 220, 2, CORT, PAP)},
    {"grumpy", ringMake(P::kBreathe, M::kStill, 1100, 0, 30, 200, 1, COR)},
    {"annoyed", ringMake(P::kChase, M::kCcw, 1700, 3, 0, 200, 2, COR, CORT)},
    {"embarrassed", ringMake(P::kBreathe, M::kStill, 2400, 0, 30, 160, 1, CORT)},
    {"shy", ringMake(P::kComet, M::kEaseInOut, 3200, 1, 0, 180, 2, CORT, COR)},
    {"bored", ringMake(P::kSpinner, M::kCw, 6000, 1, 0, 110, 1, INK)},
    {"sleepy", ringMake(P::kBreathe, M::kStill, 4200, 0, 5, 70, 1, SKYD)},
    {"dizzy", ringMake(P::kGradient, M::kCw, 900, 0, 0, 200, 4, COR, YEL, SKY, GRS)},
    {"sick", ringMake(P::kWave, M::kCcw, 2600, 2, 20, 160, 2, GRS, GRST)},
    {"apologetic", ringLife(ringMake(P::kFill, M::kCcw, 2200, 0, 0, 170, 1, SKYT), 100, 2300, 600)},
    {"alarm", ringMake(P::kChase, M::kCw, 700, 8, 0, 255, 2, COR, YEL)},
    {"music", ringMake(P::kWave, M::kCw, 1800, 4, 40, 255, 3, SKY, YEL, COR)},
    {"reminder", ringMake(P::kPulse, M::kStill, 1500, 1, 10, 255, 2, YEL, YELT)},
    // --- scenes (the server's scene/express names); alarm, music, reminder, success, failed are above
    {"timer_set", ringLife(ringTicks(ringMake(P::kFill, M::kPingPong, 4000, 0, 25, 255, 2, YEL, PAP), 12), 150, 3600, 600)}, // fill, drain, ticks
    {"timer_done", ringTicks(ringMake(P::kPulse, M::kStill, 800, 1, 20, 255, 2, YEL, COR), 12)},
    {"weather_sun", ringMake(P::kBreathe, M::kStill, 3500, 0, 60, 225, 2, YEL, PAP)},
    {"weather_cloud", ringMake(P::kWave, M::kCw, 5000, 2, 40, 170, 2, SKY, PAP)},
    {"weather_rain", ringMake(P::kChase, M::kCcw, 1400, 24, 0, 200, 2, SKYD, SKY)},
    {"weather_snow", ringMake(P::kSparkle, M::kStill, 1700, 0, 10, 230, 2, PAP, SKY)},
    {"task_added", ringLife(ringTicks(ringMake(P::kFill, M::kCw, 700, 0, 0, 255, 2, GRS, GRST), 4), 100, 1000, 500)},
    {"note_added", ringLife(ringMake(P::kComet, M::kCw, 900, 1, 0, 255, 2, YEL, YELT), 80, 1300, 500)},
    {"calendar", ringMake(P::kTicks, M::kCw, 6000, 12, 20, 255, 2, SKYT, YEL)},
    {"search", ringMake(P::kSpinner, M::kEaseInOut, 1800, 1, 0, 230, 2, SKY, PAP)},
    {"message_sent", ringLife(ringMake(P::kPulse, M::kStill, 900, 1, 0, 255, 2, SKY, SKYT), 60, 1000, 400)},
};
} // namespace ringtable

constexpr uint16_t kRingEntryCount = sizeof(ringtable::kEntries) / sizeof(ringtable::kEntries[0]);

// Equal ignoring case and the separators '_', '-', ' ' ("WakingUp" == "waking_up").
inline bool ringNameEq(const char* a, const char* b)
{
  auto skip = [](const char* p) { while (*p == '_' || *p == '-' || *p == ' ') { ++p; } return p; };
  auto low = [](char c) { return c >= 'A' && c <= 'Z' ? static_cast<char>(c + 32) : c; };
  a = skip(a); b = skip(b);
  while (*a != '\0' && *b != '\0')
  {
    if (low(*a) != low(*b)) { return false; }
    a = skip(a + 1); b = skip(b + 1);
  }
  return *a == '\0' && *b == '\0';
}

// The scene engine's lookup: a device state, emotion or scene name -> its RingSpec, or nullptr.
inline const RingSpec* ringSpecByName(const char* name)
{
  if (name == nullptr) { return nullptr; }
  for (const RingEntry& e : ringtable::kEntries)
  {
    if (ringNameEq(e.name, name)) { return &e.spec; }
  }
  return nullptr;
}

} // namespace bob
