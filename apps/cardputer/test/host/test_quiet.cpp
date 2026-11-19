// CP-QUIET: the volume gain table (include/types.h), the earcon/ring share of
// the reply volume, and the rule that ends the speaker once it is idle
// (SpeakerIdle, include/earcons.h).
#include <cstdint>

#include "doctest.h"
#include "earcons.h"
#include "types.h"

using bob::gainForLevel;
using bob::kSpeakerIdleEndMs;
using bob::kVolumeDefault;
using bob::kVolumeMax;
using bob::SpeakerIdle;
using bob::toneChannelVolume;

TEST_CASE("gain table: level 0 is silent and every step is louder") {
  CHECK(gainForLevel(0) == 0);
  for (uint8_t level = 1; level <= kVolumeMax; ++level) {
    CHECK(gainForLevel(level) > gainForLevel(level - 1));
  }
}

TEST_CASE("gain table: a fresh device starts at 4 and 10 is no louder than the old 8") {
  CHECK(kVolumeDefault == 4);
  CHECK(kVolumeMax == 10);
  CHECK(gainForLevel(kVolumeMax) <= 212);  // the pre-CP-QUIET level 8.
  CHECK(gainForLevel(kVolumeDefault) < 160);  // quieter than the old default 6.
  CHECK(gainForLevel(255) == gainForLevel(kVolumeMax));  // clamped, never past the table.
}

TEST_CASE("cabin sounds retain channel gain with headroom at maximum") {
  CHECK(toneChannelVolume(0) == 0);
  CHECK(toneChannelVolume(255) == 249);
  CHECK(toneChannelVolume(64) == 62);
  CHECK(toneChannelVolume(1) == 1);  // never rounded down to silence.
  for (int v = 1; v <= 255; ++v) {
    const uint8_t tone = toneChannelVolume(static_cast<uint8_t>(v));
    CHECK(tone > 0);
    CHECK(tone <= v);
    CHECK(tone <= 249);
  }
}

TEST_CASE("the ring still sounds at level 1") {
  const uint32_t effective = gainForLevel(1) * toneChannelVolume(255);
  CHECK(effective > 0);
}

TEST_CASE("idle speaker ends once, kSpeakerIdleEndMs after it went quiet") {
  SpeakerIdle idle;
  CHECK_FALSE(idle.tick(1000, true, true, false, false));  // a beep plays.
  CHECK_FALSE(idle.tick(1100, true, false, false, false));  // quiet: countdown starts.
  CHECK_FALSE(idle.tick(1100 + kSpeakerIdleEndMs - 1, true, false, false, false));
  CHECK(idle.tick(1100 + kSpeakerIdleEndMs, true, false, false, false));
  CHECK_FALSE(idle.tick(1100 + kSpeakerIdleEndMs + 1, true, false, false, false));
  CHECK_FALSE(idle.tick(5000, false, false, false, false));  // already off.
}

TEST_CASE("a reply, a playing tone or the mic keep the speaker as it is") {
  SpeakerIdle idle;
  CHECK_FALSE(idle.tick(0, true, false, false, false));
  CHECK_FALSE(idle.tick(900, true, true, false, false));  // a ring note resets it.
  CHECK_FALSE(idle.tick(1500, true, false, false, false));
  CHECK_FALSE(idle.tick(2400, true, false, false, false));
  CHECK(idle.tick(2500, true, false, false, false));

  SpeakerIdle held;
  CHECK_FALSE(held.tick(0, true, false, true, false));  // reply buffering.
  CHECK_FALSE(held.tick(60000, true, false, true, false));
  SpeakerIdle mic;
  CHECK_FALSE(mic.tick(0, true, false, false, true));  // the mic owns GPIO 43.
  CHECK_FALSE(mic.tick(60000, true, false, false, true));
}

TEST_CASE("idle countdown survives millis() wrap") {
  SpeakerIdle idle;
  const uint32_t start = UINT32_MAX - 200;
  CHECK_FALSE(idle.tick(start, true, false, false, false));
  CHECK_FALSE(idle.tick(start + kSpeakerIdleEndMs - 1, true, false, false, false));
  CHECK(idle.tick(start + kSpeakerIdleEndMs, true, false, false, false));
}
