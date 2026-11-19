// The ring light language: the one RingSpec table and the pure compose math
// (libs/bob-device/src: round_ring_spec.h, round_ring_compose.h).
#include <chrono>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <set>
#include <string>
#include <vector>

#include "doctest.h"
#include "round_ring_compose.h"
#include "round_ring_policy.h"
#include "round_ring_spec.h"

using namespace bob;

namespace {
// Bob's emotion names, read from the X-macro in libs/bob-device/src/bob_emotion_table.h (the single source of truth).
std::vector<std::string> bobEmotionNames() {
  std::ifstream in("../../libs/bob-device/src/bob_emotion_table.h");
  std::string line;
  std::vector<std::string> names;
  while (std::getline(in, line)) {
    const size_t at = line.find_first_not_of(" 	");
    if (at == std::string::npos || line.compare(at, 2, "X(") != 0) continue;  // "#define X(" and "// Row: X(" start elsewhere
    const size_t comma = line.find(',', at);
    if (comma != std::string::npos) names.push_back(line.substr(at + 2, comma - at - 2));
  }
  return names;
}

uint32_t alphaOf(uint32_t px) { return px >> 24; }

int lit(const uint32_t* f, uint32_t minAlpha = 1) {
  int n = 0;
  for (int a = 0; a < kRingAngles; ++a) n += alphaOf(f[a]) >= minAlpha ? 1 : 0;
  return n;
}
}  // namespace

TEST_CASE("ring language: every one of Bob's 47 emotions has a spec") {
  const auto names = bobEmotionNames();
  REQUIRE(names.size() == 47);
  for (const auto& n : names) {
    INFO(n);
    CHECK(ringSpecByName(n.c_str()) != nullptr);
  }
}

TEST_CASE("ring language: device states and scenes all resolve") {
  for (const char* n : {"idle", "listening", "thinking", "speaking", "sleeping", "offline", "error", "updating", "hello", "dnd",
                        "notification", "timer_set", "timer_done", "alarm", "weather_sun", "weather_cloud", "weather_rain",
                        "weather_snow", "music", "task_added", "note_added", "reminder", "calendar", "search", "message_sent",
                        "success", "failed"}) {
    INFO(n);
    CHECK(ringSpecByName(n) != nullptr);
  }
  CHECK(ringSpecByName("no_such_scene") == nullptr);
  CHECK(ringSpecByName(nullptr) == nullptr);
  CHECK(ringSpecByName("") == nullptr);
}

TEST_CASE("ring language: names ignore case and separators, and are unique") {
  CHECK(ringSpecByName("WakingUp") == ringSpecByName("waking_up"));
  CHECK(ringSpecByName("Timer-Set") == ringSpecByName("timer_set"));
  CHECK(ringNameEq("Weather Sun", "weather_sun"));
  CHECK_FALSE(ringNameEq("love", "lov"));
  CHECK_FALSE(ringNameEq("lov", "love"));
  std::set<std::string> seen;
  for (const RingEntry& e : ringtable::kEntries) {
    std::string key;
    for (const char* p = e.name; *p; ++p)
      if (*p != '_') key += static_cast<char>(*p >= 'A' && *p <= 'Z' ? *p + 32 : *p);
    CHECK_MESSAGE(seen.insert(key).second, e.name);
  }
}

TEST_CASE("ring language: the examples in the brief map as written") {
  const RingSpec* listening = ringSpecByName("listening");
  CHECK(listening->pattern == RingShape::kSweep);
  CHECK(listening->colors[0] == kRingSky);
  CHECK(ringStage(listening, 0).spec->pattern == RingShape::kSweep);
  CHECK(ringStage(listening, listening->introMs + 5).spec->pattern == RingShape::kLevel);  // the demo sweep, then level
  const RingSpec* thinking = ringSpecByName("thinking");
  CHECK(thinking->pattern == RingShape::kSweep);
  CHECK(thinking->motion == RingMotion::kCw);
  CHECK(thinking->colors[0] == kRingYellow);
  CHECK(ringSpecByName("speaking")->pattern == RingShape::kGlow);
  CHECK(ringSpecByName("speaking")->colors[0] == kRingSky);
  CHECK(ringSpecByName("love")->pattern == RingShape::kHeartbeat);
  CHECK(ringSpecByName("love")->colors[0] == kRingCoral);
  CHECK(ringStage(ringSpecByName("celebrating"), 5000).spec->pattern == RingShape::kSparkle);
  CHECK(ringStage(ringSpecByName("celebrating"), 5000).spec->nColors == 0);  // rainbow hues
  const RingSpec* timer = ringSpecByName("timer_set");
  CHECK(timer->pattern == RingShape::kFill);
  CHECK(timer->ticks > 0);
  CHECK(timer->colors[0] == kRingYellow);
  CHECK(ringSpecByName("error")->pattern == RingShape::kBreathe);
  CHECK(ringSpecByName("error")->colors[0] == kRingCoral);
  CHECK(ringSpecByName("dnd")->pattern == RingShape::kBreathe);
  CHECK(ringSpecByName("notification")->pattern == RingShape::kChase);
  CHECK(ringSpecByName("notification")->colors[0] == kRingYellow);
  const RingSpec* success = ringSpecByName("success");
  CHECK(success->pattern == RingShape::kFill);
  CHECK(success->colors[0] == kRingGrass);
  CHECK(success->holdMs > 0);  // ... then fade
  CHECK(success->outMs > 0);
}

TEST_CASE("ring language: the table uses every pattern and motion, and rainbow stays rare") {
  std::set<int> patterns, motions;
  int rainbow = 0;
  for (const RingEntry& e : ringtable::kEntries) {
    patterns.insert(static_cast<int>(e.spec.pattern));
    motions.insert(static_cast<int>(e.spec.motion));
    if (e.spec.pattern == RingShape::kRainbow || e.spec.nColors == 0) ++rainbow;
    CHECK(e.spec.periodMs > 0);
    CHECK(e.spec.nColors <= 4);
    CHECK(e.spec.hi >= e.spec.lo);
    if (e.spec.then) {
      CHECK(ringSpecByName(e.spec.then) != nullptr);
      CHECK(e.spec.introMs > 0);
    }
  }
  CHECK(patterns.size() == 16);
  CHECK(motions.size() == 6); // kAccel stays in the enum but no spec uses it since Thinking follows the demo sweep
  CHECK(rainbow <= 3);
}

TEST_CASE("ring language: the palette is Bob's and tints stay in range") {
  CHECK(kRingInk == 0x173E57);
  CHECK(kRingPaper == 0xFFFDF6);
  CHECK(kRingYellow == 0xF0C75E);
  CHECK(kRingSky == 0xBBDDF0);
  CHECK(kRingGrass == 0x72965B);
  CHECK(kRingCoral == 0xF07A6A);
  CHECK(ringMix(0x000000, 0xFFFFFF, 0) == 0x000000);
  CHECK(ringMix(0x102030, 0xF0E0D0, 256) == 0xF0E0D0);
  CHECK(ringMix(0x000000, 0xFEFEFE, 128) == 0x7F7F7F);
  CHECK(kRingInkLift != kRingInk);  // visible on the ink ground
}

TEST_CASE("ring compose: motion travels the way it says") {
  RingSpec cw = ringMake(RingShape::kComet, RingMotion::kCw, 1000, 1, 0, 255, 1, kRingSky);
  RingSpec ccw = cw;
  ccw.motion = RingMotion::kCcw;
  CHECK(ringPhase(cw, 250) == doctest::Approx(0.25f));
  CHECK(ringPhase(ccw, 250) == doctest::Approx(-0.25f));
  RingSpec pp = cw;
  pp.motion = RingMotion::kPingPong;
  for (uint32_t t = 0; t < 4000; t += 37) {
    CHECK(ringPhase(pp, t) >= -0.001f);
    CHECK(ringPhase(pp, t) <= 0.501f);
  }
  RingSpec still = cw;
  still.motion = RingMotion::kStill;
  CHECK(ringPhase(still, 12345) == 0.0f);
  RingSpec accel = cw;
  accel.motion = RingMotion::kAccel;
  const float early = ringPhase(accel, 500) - ringPhase(accel, 0), late = ringPhase(accel, 5500) - ringPhase(accel, 5000);
  CHECK(late > early * 2.0f);  // it speeds up
  CHECK(late == doctest::Approx(0.5f));  // full speed: half a lap in 500 ms of a 1 s lap
  RingSpec ease = cw;
  ease.motion = RingMotion::kEaseInOut;
  CHECK(ringPhase(ease, 100) < 0.1f);  // slow start
  CHECK(ringPhase(ease, 500) == doctest::Approx(0.5f));
  CHECK(ringPhase(ease, 1000) == doctest::Approx(1.0f));
  RingSpec bounce = cw;
  bounce.motion = RingMotion::kBounce;
  for (uint32_t t = 0; t < 4000; t += 41) {
    CHECK(ringPhase(bounce, t) >= -0.001f);
    CHECK(ringPhase(bounce, t) <= 0.501f);
  }
}

TEST_CASE("ring compose: the comet's head leads, its tail trails, and ccw reverses it") {
  RingSpec cw = ringMake(RingShape::kComet, RingMotion::kCw, 3600, 1, 0, 255, 1, kRingSky);
  cw.inMs = 0;
  uint32_t f[kRingAngles];
  ringCompose(cw, 0, 0.0f, f);  // head at the top (270)
  CHECK(alphaOf(f[269]) > 240);
  CHECK(alphaOf(f[250]) > 0);      // tail behind (counter-clockwise of the head)
  CHECK(alphaOf(f[250]) < alphaOf(f[268]));
  CHECK(alphaOf(f[300]) == 0);     // nothing ahead
  RingSpec ccw = cw;
  ccw.motion = RingMotion::kCcw;
  ringCompose(ccw, 0, 0.0f, f);
  CHECK(alphaOf(f[290]) > 0);      // the tail is now clockwise of the head
  CHECK(alphaOf(f[250]) == 0);
  CHECK(lit(f) < 140);
}

TEST_CASE("ring compose: comet tails and dual comet") {
  RingSpec three = ringMake(RingShape::kComet, RingMotion::kCw, 3600, 3, 0, 255, 1, kRingSky);
  three.inMs = 0;
  uint32_t f[kRingAngles];
  ringCompose(three, 0, 0.0f, f);
  int heads = 0;
  for (int a = 0; a < kRingAngles; ++a) heads += alphaOf(f[a]) > 235 ? 1 : 0;
  CHECK(heads >= 3);
  RingSpec dual = *ringSpecByName("listening");
  dual.pattern = RingShape::kDualComet; // the mirrored two-head pattern still composes symmetrically
  dual.inMs = 0;
  ringCompose(dual, 400, 0.0f, f);
  // Mirrored about the top: the left and right halves match.
  for (int k = 0; k < 170; ++k) CHECK(alphaOf(f[(270 + k) % 360]) == alphaOf(f[(269 - k + 360) % 360]));
}

TEST_CASE("ring compose: fill grows to full, drain empties, and a one-shot fades out") {
  RingSpec fill = ringMake(RingShape::kFill, RingMotion::kCw, 1000, 0, 0, 255, 1, kRingGrass);
  fill.inMs = 0;
  uint32_t f[kRingAngles];
  ringCompose(fill, 0, 0.0f, f);
  CHECK(lit(f) < 8);
  ringCompose(fill, 500, 0.0f, f);
  CHECK(lit(f, 128) >= 170);
  CHECK(lit(f, 128) <= 190);
  CHECK(alphaOf(f[270 + 10]) > 200);  // filled from the top, clockwise
  CHECK(alphaOf(f[270 - 10]) == 0);
  ringCompose(fill, 1000, 0.0f, f);
  CHECK(lit(f, 250) == kRingAngles);
  RingSpec drain = fill;
  drain.motion = RingMotion::kCcw;
  ringCompose(drain, 1000, 0.0f, f);
  CHECK(lit(f) < 8);
  const RingSpec* success = ringSpecByName("success");
  CHECK(ringEnvelope(*success, 0) == 0.0f);
  CHECK(ringEnvelope(*success, success->inMs + 50) == 1.0f);
  const uint32_t end = success->inMs + success->holdMs;
  CHECK(ringEnvelope(*success, end + success->outMs / 2) == doctest::Approx(0.5f));
  CHECK_FALSE(ringFinished(*success, end));
  CHECK(ringFinished(*success, end + success->outMs));
  ringCompose(*success, end + success->outMs + 10, 0.0f, f);
  CHECK(lit(f) == 0);
  CHECK_FALSE(ringFinished(*ringSpecByName("thinking"), 9999999));  // holdMs 0 = until replaced
}

TEST_CASE("ring compose: level follows the audio level, heartbeat double-beats, idle is the soft rim") {
  RingSpec lv = *ringSpecByName("speaking");
  lv.inMs = 0;
  uint32_t quiet[kRingAngles], loud[kRingAngles];
  ringCompose(lv, 1000, 0.0f, quiet);
  ringCompose(lv, 1000, 1.0f, loud);
  CHECK(alphaOf(loud[0]) > alphaOf(quiet[0]) + 100);
  CHECK(alphaOf(quiet[0]) >= lv.lo - 1);
  RingSpec hb = *ringSpecByName("love");
  hb.inMs = 0;
  uint32_t f[kRingAngles];
  const uint32_t period = hb.periodMs;
  auto at = [&](float u) { ringCompose(hb, static_cast<uint32_t>(u * static_cast<float>(period)), 0.0f, f); return alphaOf(f[0]); };
  CHECK(at(0.08f) > 200);   // lub
  CHECK(at(0.19f) < 100);   // between
  CHECK(at(0.29f) > 120);   // dub
  CHECK(at(0.7f) <= static_cast<uint32_t>(hb.lo) + 1);
  ringCompose(*ringSpecByName("idle"), 1234, 0.5f, f);
  CHECK(lit(f) == kRingAngles); // the idle ring is the soft glass rim: every angle on (round_ring.cpp draws it at 25%, 6 px)
}

TEST_CASE("ring compose: ticks overlay marks, chase makes dashes, wave stays inside its envelope") {
  RingSpec timer = *ringSpecByName("timer_set");
  timer.inMs = 0;
  uint32_t f[kRingAngles];
  ringCompose(timer, 100, 0.0f, f);
  for (int i = 0; i < timer.ticks; ++i) CHECK(alphaOf(f[(270 + i * 360 / timer.ticks) % 360]) > 150);
  RingSpec chase = ringMake(RingShape::kChase, RingMotion::kCw, 1000, 12, 0, 255, 1, kRingYellow);
  chase.inMs = 0;
  ringCompose(chase, 0, 0.0f, f);
  int onRuns = 0;
  for (int a = 0; a < kRingAngles; ++a) onRuns += alphaOf(f[a]) > 200 && alphaOf(f[(a + 359) % 360]) <= 200 ? 1 : 0;
  CHECK(onRuns == 12);
  RingSpec wave = ringMake(RingShape::kWave, RingMotion::kCw, 2000, 3, 40, 200, 1, kRingSky);
  wave.inMs = 0;
  ringCompose(wave, 700, 0.0f, f);
  for (int a = 0; a < kRingAngles; ++a) {
    CHECK(alphaOf(f[a]) >= 39);
    CHECK(alphaOf(f[a]) <= 201);
  }
}

TEST_CASE("ring compose: every table entry composes inside its envelope for the whole life") {
  uint32_t f[kRingAngles];
  for (const RingEntry& e : ringtable::kEntries) {
    INFO(e.name);
    for (uint32_t t = 0; t < 12000; t += 173) {
      for (float level : {0.0f, 0.5f, 1.0f}) {
        ringCompose(e.spec, t, level, f);
        for (int a = 0; a < kRingAngles; ++a) CHECK(alphaOf(f[a]) <= 255);
        if (e.spec.ticks == 0 && e.spec.pattern != RingShape::kSparkle) {
          for (int a = 0; a < kRingAngles; ++a) CHECK(alphaOf(f[a]) <= static_cast<uint32_t>(e.spec.hi));
        }
        if (alphaOf(f[0]) == 0) CHECK((f[0] & 0xFFFFFF) == 0);
      }
    }
  }
}

TEST_CASE("ring compose: the rainbow and sparkle use hues, and a sparkle really twinkles") {
  RingSpec rb = *ringSpecByName("celebrating");
  rb.inMs = 0;
  uint32_t f[kRingAngles];
  ringCompose(rb, 100, 0.0f, f);
  std::set<uint32_t> colors;
  for (int a = 0; a < kRingAngles; ++a) colors.insert(f[a] & 0xFFFFFF);
  CHECK(colors.size() > 100);
  RingSpec sp = *ringSpecByName("celebrating_sparkle");
  sp.inMs = 0;
  uint32_t g[kRingAngles];
  ringCompose(sp, 100, 0.0f, f);
  ringCompose(sp, 700, 0.0f, g);
  CHECK(lit(f, 100) > 4);
  CHECK(lit(f, 100) < 180);
  CHECK(std::memcmp(f, g, sizeof(f)) != 0);
}

TEST_CASE("ring frames: crossfade, blend565 and dirty segments") {
  CHECK(ringBlendPixel(0, 0, 100) == 0);
  CHECK(ringBlendPixel(0xFF112233, 0, 0) == 0xFF112233);
  CHECK(ringBlendPixel(0xFF112233, 0x80445566, 256) == 0x80445566);
  const uint32_t mid = ringBlendPixel(0xFFFF0000, 0xFF0000FF, 128);
  CHECK(alphaOf(mid) >= 254);
  CHECK(((mid >> 16) & 255) > 120);
  CHECK((mid & 255) > 120);
  // Fading in from dark keeps the new colour (premultiplied), only its alpha grows.
  const uint32_t in = ringBlendPixel(0, 0xFF40A0F0, 128);
  CHECK((in & 0xFFFFFF) == 0x40A0F0);
  CHECK(alphaOf(in) == 127);

  const uint16_t bg = ringRgb565(kRingInk), fg = ringRgb565(kRingYellow);
  CHECK(ringBlend565(bg, fg, 0) == bg);
  CHECK(ringBlend565(bg, fg, 255) == fg);
  for (uint32_t a = 0; a <= 255; a += 5) {
    const uint16_t v = ringBlend565(bg, fg, a);
    const int r0 = bg >> 11, r1 = fg >> 11, r = v >> 11;
    const int g0 = (bg >> 5) & 63, g1 = (fg >> 5) & 63, g = (v >> 5) & 63;
    const int b0 = bg & 31, b1 = fg & 31, b = v & 31;
    CHECK(std::abs(r - (r0 + (r1 - r0) * static_cast<int>(a) / 255)) <= 2);
    CHECK(std::abs(g - (g0 + (g1 - g0) * static_cast<int>(a) / 255)) <= 3);
    CHECK(std::abs(b - (b0 + (b1 - b0) * static_cast<int>(a) / 255)) <= 2);
  }

  uint32_t prev[kRingAngles] = {}, cur[kRingAngles] = {};
  RingSeg segs[8];
  CHECK(ringDiffSegments(prev, cur, segs, 8) == 0);
  for (int a = 100; a < 140; ++a) cur[a] = 0xFF00FF00;
  for (int a = 300; a < 310; ++a) cur[a] = 0xFF00FF00;
  CHECK(ringDiffSegments(prev, cur, segs, 8) == 2);
  CHECK(segs[0].from == 100);
  CHECK(segs[0].to == 140);
  CHECK(segs[1].from == 300);
  CHECK(segs[1].to == 310);
  cur[142] = 0xFF00FF00;  // a gap of two bridges into one run
  CHECK(ringDiffSegments(prev, cur, segs, 8) == 2);
  CHECK(segs[0].to == 143);
  // A difference below what the panel can show is not a change.
  for (int a = 0; a < kRingAngles; ++a) prev[a] = cur[a] = 0xFF204080;
  cur[50] = 0xFF214080;
  CHECK(ringDiffSegments(prev, cur, segs, 8) == 0);
  cur[50] = 0x40204080;
  CHECK(ringDiffSegments(prev, cur, segs, 8) == 1);
  // Too many runs collapse into one span.
  for (int a = 0; a < kRingAngles; ++a) prev[a] = cur[a] = 0;
  for (int a = 10; a < 350; a += 20) cur[a] = 0xFFFFFFFF;
  CHECK(ringDiffSegments(prev, cur, segs, 8) == 1);
  CHECK(segs[0].from == 10);
  CHECK(segs[0].to == 331);
  // Dark frames over dark frames: nothing to draw even if the colour bits differ.
  for (int a = 0; a < kRingAngles; ++a) { prev[a] = 0; cur[a] = 0x00123456; }
  CHECK(ringDiffSegments(prev, cur, segs, 8) == 0);
}

TEST_CASE("ring compose: the coarse modes name a real spec") {
  for (RingMode m : {RingMode::kOff, RingMode::kListening, RingMode::kThinking, RingMode::kSpeaking, RingMode::kError, RingMode::kNotify,
                     RingMode::kSleep, RingMode::kDnd})
    CHECK(ringSpecByName(ringNameForMode(m)) != nullptr);
  CHECK(ringModeForMood(0, true) == RingMode::kDnd);
  CHECK(std::strcmp(ringNameForMode(ringModeForMood(0, true)), "dnd") == 0);
}

TEST_CASE("ring compose: a frame costs far less than the 5 ms budget on the host") {
  // Not a device measurement (T ring reports that); a regression guard on the algorithmic cost, with
  // wide headroom because this build runs under AddressSanitizer at -O1.
  uint32_t f[kRingAngles];
  const auto t0 = std::chrono::steady_clock::now();
  int frames = 0;
  for (int rep = 0; rep < 20; ++rep)
    for (const RingEntry& e : ringtable::kEntries) {
      ringCompose(e.spec, 500 + 33u * static_cast<uint32_t>(rep), 0.6f, f);
      ++frames;
    }
  const double us = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count() / frames;
  CHECK(us < 1500.0);
}
