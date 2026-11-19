// How long a timer or alarm rings and which note plays when (#389,
// include/ring_policy.h): ring_seconds bounds, the three patterns, the
// stop decision, and millis() wrap.
#include <cstdint>
#include <string>

#include "doctest.h"
#include "ring_policy.h"

using bob::RingSchedule;
using bob::RingSound;
using bob::RingStep;

namespace {

// Ticks every `stepMs` from `from` to `to` (inclusive) and collects the note
// frequencies played, stopping at the first kExpired.
struct Run {
  std::string hz;       // "1047,1319,..."
  uint32_t expiredAt = 0;
  bool expired = false;
};

Run tickAll(RingSchedule& ring, uint32_t from, uint32_t to, uint32_t stepMs = 5) {
  Run run;
  for (uint32_t now = from; now - from <= to - from; now += stepMs) {
    bob::RingNote note{};
    const RingStep step = ring.tick(now, &note);
    if (step == RingStep::kExpired) {
      run.expired = true;
      run.expiredAt = now;
      break;
    }
    if (step == RingStep::kPlay) {
      if (!run.hz.empty()) run.hz += ',';
      run.hz += std::to_string(note.hz);
    }
  }
  return run;
}

}  // namespace

TEST_CASE("ring_seconds: 10..120, default 30; out of range is rejected, not clamped") {
  CHECK(bob::kRingSecondsDefault == 30);
  CHECK(bob::ringSecondsValid(10));
  CHECK(bob::ringSecondsValid(120));
  CHECK_FALSE(bob::ringSecondsValid(9));
  CHECK_FALSE(bob::ringSecondsValid(121));
  CHECK_FALSE(bob::ringSecondsValid(0));
}

TEST_CASE("ring_sound names round-trip; unknown names are rejected") {
  RingSound sound = RingSound::kClassic;
  CHECK(bob::parseRingSound("chime", sound));
  CHECK(sound == RingSound::kChime);
  CHECK(bob::parseRingSound("pulse", sound));
  CHECK(sound == RingSound::kPulse);
  CHECK(bob::parseRingSound("classic", sound));
  CHECK(sound == RingSound::kClassic);
  CHECK_FALSE(bob::parseRingSound("siren", sound));
  CHECK_FALSE(bob::parseRingSound("", sound));
  CHECK(sound == RingSound::kClassic);  // untouched on failure.
  CHECK(std::string(bob::ringSoundName(RingSound::kClassic)) == "classic");
  CHECK(std::string(bob::ringSoundName(RingSound::kChime)) == "chime");
  CHECK(std::string(bob::ringSoundName(RingSound::kPulse)) == "pulse");
}

TEST_CASE("classic: a three-note cabin pattern that repeats") {
  RingSchedule ring;
  ring.start(1000, RingSound::kClassic, 30);
  const Run run = tickAll(ring, 1000, 1000 + 2 * bob::ringPattern(RingSound::kClassic).periodMs - 1);
  CHECK_FALSE(run.expired);
  CHECK(run.hz == "587,494,587,587,494,587");
}

TEST_CASE("chime: a two-tone bell, high then low") {
  RingSchedule ring;
  ring.start(0, RingSound::kChime, 30);
  const Run run = tickAll(ring, 0, bob::ringPattern(RingSound::kChime).periodMs - 1);
  CHECK(run.hz == "659,494");
}

TEST_CASE("pulse: a spaced single bell, repeating faster than classic") {
  RingSchedule ring;
  ring.start(0, RingSound::kPulse, 30);
  const Run run = tickAll(ring, 0, bob::ringPattern(RingSound::kPulse).periodMs - 1);
  CHECK(run.hz == "587");
  CHECK(bob::ringPattern(RingSound::kPulse).periodMs <
        bob::ringPattern(RingSound::kClassic).periodMs);
}

TEST_CASE("every pattern: notes in order, inside the period, never overlapping, safe pitch") {
  for (RingSound sound : {RingSound::kClassic, RingSound::kChime, RingSound::kPulse}) {
    const bob::RingPattern& pattern = bob::ringPattern(sound);
    REQUIRE(pattern.count > 0);
    for (uint8_t i = 0; i < pattern.count; ++i) {
      const bob::RingNote& note = pattern.notes[i];
      CHECK(note.hz >= 400);
      CHECK(note.hz <= 2000);  // no shrill tones on the small speaker.
      CHECK(note.atMs + note.ms < pattern.periodMs);
      if (i > 0) CHECK(note.atMs >= pattern.notes[i - 1].atMs + pattern.notes[i - 1].ms);
    }
  }
}

TEST_CASE("the first note plays on the first tick") {
  RingSchedule ring;
  ring.start(5000, RingSound::kClassic, 10);
  bob::RingNote note{};
  CHECK(ring.tick(5000, &note) == RingStep::kPlay);
  CHECK(note.hz == 587);
  CHECK(ring.tick(5001, &note) == RingStep::kNone);
}

TEST_CASE("the ring stops after exactly ring_seconds, once") {
  RingSchedule ring;
  ring.start(1000, RingSound::kPulse, 10);
  bob::RingNote note{};
  CHECK(ring.tick(10999, &note) != RingStep::kExpired);
  CHECK(ring.tick(11000, &note) == RingStep::kExpired);
  CHECK_FALSE(ring.active());
  CHECK(ring.tick(11005, &note) == RingStep::kNone);  // only once.
}

TEST_CASE("a late loop still stops, and reports how long it really rang") {
  RingSchedule ring;
  ring.start(1000, RingSound::kClassic, 30);
  bob::RingNote note{};
  CHECK(ring.elapsedMs(31250) == 30250);
  CHECK(ring.tick(31250, &note) == RingStep::kExpired);
}

TEST_CASE("a loop time from before start() is not 49 days of ringing") {
  // The loop captures nowMs, then an announce starts the ring with a later
  // millis(); an unsigned compare would read nowMs - startedAt as ~4.29e9.
  RingSchedule ring;
  ring.start(10003, RingSound::kClassic, 10);
  bob::RingNote note{};
  CHECK(ring.tick(10000, &note) != RingStep::kExpired);
  CHECK(ring.active());
  CHECK(ring.elapsedMs(10000) == 0);
}

TEST_CASE("millis() wrapping mid-ring neither ends it early nor late") {
  RingSchedule ring;
  const uint32_t start = 0xFFFFFFFFu - 4000;  // wraps 4 s in.
  ring.start(start, RingSound::kChime, 10);
  const Run run = tickAll(ring, start, start + 20000, 10);
  REQUIRE(run.expired);
  CHECK(run.expiredAt - start == 10000);
}

TEST_CASE("stop() ends it without an expiry") {
  RingSchedule ring;
  ring.start(0, RingSound::kClassic, 10);
  ring.stop();
  bob::RingNote note{};
  CHECK_FALSE(ring.active());
  CHECK(ring.tick(20000, &note) == RingStep::kNone);
}

TEST_CASE("timer and alarm patterns remain distinct for every stored style") {
  for (RingSound sound : {RingSound::kClassic, RingSound::kChime, RingSound::kPulse}) {
    RingSchedule timer;
    RingSchedule alarm;
    timer.start(0, sound, 10, false);
    alarm.start(0, sound, 10, true);
    CHECK(tickAll(timer, 0, 3200).hz != tickAll(alarm, 0, 3200).hz);
  }
}
