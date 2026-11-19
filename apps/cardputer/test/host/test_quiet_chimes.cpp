#include <array>
#include <algorithm>
#include <cmath>
#include "doctest.h"
#include "earcons_wave.h"
#include "M5Cardputer.h"
#include "settings.h"

using namespace bob;

namespace {
DeviceSettings chimeSettings;
void resetAudio() {
  ringStop();
  holdSpeaker(false);
  M5Cardputer = {};
  hostshim::setMillis(0);
  chimeSettings = DeviceSettings{};
  markSpeakerPinsStale();
}
}  // namespace

namespace bob {
const DeviceSettings& settings() { return chimeSettings; }
uint8_t speakerGain() {
  return chimeSettings.muted ? 0 : gainForLevel(chimeSettings.volume);
}
void applySpeakerGain() {}
}  // namespace bob

TEST_CASE("cabin cues fit the existing microphone handoff and have silent endpoints") {
  for (const Earcon cue : {Earcon::kListenStart, Earcon::kListenStop,
                          Earcon::kError, Earcon::kDisconnect, Earcon::kChime, Earcon::kNotice, Earcon::kFollowupClose, Earcon::kTimer, Earcon::kAlarm, Earcon::kVolume}) {
    const ChimeClip rendered = chimeClip(cue);
    const uint8_t* pcm = rendered.samples;
    const size_t count = rendered.count;
    REQUIRE(count > 0);
    REQUIRE(count <= kChimeRate * 2100 / 1000);
    CHECK(pcm[0] == 128);
    CHECK(pcm[count - 1] == 128);
    if (cue == Earcon::kListenStart) {
      CHECK(count <= kChimeRate * 140 / 1000);
    }
    int peak = 0;
    for (size_t i = 0; i < count; ++i) {
      const int amplitude = std::abs(static_cast<int>(pcm[i]) - 128);
      if (amplitude > peak) peak = amplitude;
      CHECK(amplitude <= 100);
    }
    CHECK(peak > 8);
  }
}

TEST_CASE("ready ding gently decays instead of ending a sustained beep") {
  const ChimeClip rendered = chimeClip(Earcon::kListenStart);
  const uint8_t* pcm = rendered.samples;
  const size_t count = rendered.count;
  double first = 0;
  double last = 0;
  for (size_t i = count / 5; i < count * 2 / 5; ++i) first += std::abs(pcm[i] - 128);
  for (size_t i = count * 4 / 5; i < count; ++i) last += std::abs(pcm[i] - 128);
  CHECK(first > last * 4);
}

TEST_CASE("interaction sounds respect quiet settings and microphone ownership") {
  resetAudio();
  SUBCASE("mute") { chimeSettings.muted = true; }
  SUBCASE("zero volume") { chimeSettings.volume = 0; }
  SUBCASE("DND") { chimeSettings.dnd = true; }
  SUBCASE("microphone") { M5Cardputer.Mic.running = true; }
  playEarcon(Earcon::kListenStart);
  CHECK(M5Cardputer.Speaker.begins == 0);
  CHECK(M5Cardputer.Speaker.rawCalls == 0);
}

TEST_CASE("a new interaction never rewrites a clip still read asynchronously") {
  resetAudio();
  playEarcon(Earcon::kChime);
  REQUIRE(M5Cardputer.Speaker.rawCalls == 1);
  const auto* pcm = M5Cardputer.Speaker.samples;
  const std::array<uint8_t, 3> samples{pcm[70], pcm[300], pcm[700]};
  playEarcon(Earcon::kError);
  CHECK(M5Cardputer.Speaker.rawCalls == 1);
  CHECK(pcm[70] == samples[0]);
  CHECK(pcm[300] == samples[1]);
  CHECK(pcm[700] == samples[2]);
}

TEST_CASE("ready cue finishes before the existing 150ms microphone handoff") {
  resetAudio();
  playEarcon(Earcon::kListenStart);
  REQUIRE(earconPlaying());
  waitForEarcon(150);
  CHECK_FALSE(earconPlaying());
  CHECK(millis() <= 140);
}

TEST_CASE("reply speaker restart preempts a cue and held playback suppresses new cues") {
  resetAudio();
  playEarcon(Earcon::kChime);
  REQUIRE(earconPlaying());
  restartSpeaker();  // AudioPlayback's existing beginPlayback path.
  holdSpeaker(true);
  CHECK_FALSE(earconPlaying());
  playEarcon(Earcon::kVolume);
  CHECK(M5Cardputer.Speaker.rawCalls == 1);
}

TEST_CASE("an intentional ring retains its existing DND sound semantics") {
  resetAudio();
  chimeSettings.dnd = true;
  ringStart(0, RingSound::kClassic, 10);
  CHECK(M5Cardputer.Speaker.rawCalls == 1);
  CHECK(M5Cardputer.Speaker.toneCalls == 0);
  ringStop();
}

TEST_CASE("reply teardown releases cues before the next playback loop clears its hold") {
  resetAudio();
  M5Cardputer.Speaker.begin();
  holdSpeaker(true);
  M5Cardputer.Speaker.end();  // successful abort/drain, before the next loop.
  playEarcon(Earcon::kError);
  CHECK(M5Cardputer.Speaker.rawCalls == 1);
}

TEST_CASE("ring preemption never mutates the previous asynchronously retained clip") {
  resetAudio();
  playEarcon(Earcon::kChime);
  const uint8_t* previous = M5Cardputer.Speaker.samples;
  const uint8_t saved = previous[100];
  ringStart(0, RingSound::kClassic, 10);
  CHECK(M5Cardputer.Speaker.samples != previous);
  CHECK(previous[100] == saved);
  CHECK(M5Cardputer.Speaker.rawCalls == 2);
  CHECK(M5Cardputer.Speaker.toneCalls == 0);
}

TEST_CASE("each semantic interaction has a distinct immutable waveform") {
  const Earcon cues[] = {Earcon::kListenStart, Earcon::kListenStop, Earcon::kError,
      Earcon::kDisconnect, Earcon::kChime, Earcon::kNotice, Earcon::kFollowupClose, Earcon::kTimer, Earcon::kAlarm, Earcon::kVolume};
  for (size_t i = 0; i < 10; ++i) {
    for (size_t j = i + 1; j < 10; ++j) {
      const ChimeClip a = chimeClip(cues[i]);
      const ChimeClip b = chimeClip(cues[j]);
      CHECK((a.count != b.count || std::memcmp(a.samples, b.samples, a.count) != 0));
      CHECK(a.samples != b.samples);
    }
  }
}

TEST_CASE("ring notes have the measured pitch and fade to silence") {
  for (const unsigned int hz : {494u, 587u, 659u}) {
    const ChimeClip pcm = ringClip(hz);
    CHECK(pcm.count == 4200);
    CHECK(pcm.samples[0] == 128);
    CHECK(pcm.samples[pcm.count - 1] == 128);
    unsigned int rising = 0;
    for (size_t i = 1; i < 2000; ++i) {
      if (pcm.samples[i - 1] <= 128 && pcm.samples[i] > 128) ++rising;
    }
    CHECK(rising == doctest::Approx(hz / 2.0).epsilon(.01));
  }
}

TEST_CASE("late ring ticks replace rather than fill the blocking speaker queue") {
  resetAudio();
  ringStart(0, RingSound::kClassic, 10);
  hostshim::setMillis(2200);
  ringTick(2200);
  CHECK(M5Cardputer.Speaker.lastStopCurrent);
  ringTick(2201);
  CHECK(M5Cardputer.Speaker.lastStopCurrent);
  CHECK(M5Cardputer.Speaker.rawCalls == 3);
}

TEST_CASE("every cabin clip retains digital headroom at maximum device volume") {
  // Pinned M5Unified mono 8-bit mixer: sample * 2 * board magnification *
  // master^2 * channel^2 / 2^28. Cardputer's configured magnification is 16.
  const double master = gainForLevel(kVolumeMax);
  const double channel = toneChannelVolume(255);
  const double scale = 2.0 * 16 * master * master * channel * channel / (1ULL << 28);
  const std::array<ChimeClip, 13> clips = {
    chimeClip(Earcon::kListenStart), chimeClip(Earcon::kListenStop),
    chimeClip(Earcon::kError), chimeClip(Earcon::kDisconnect),
    chimeClip(Earcon::kChime), chimeClip(Earcon::kNotice),
    chimeClip(Earcon::kFollowupClose), chimeClip(Earcon::kTimer),
    chimeClip(Earcon::kAlarm), chimeClip(Earcon::kVolume),
    ringClip(494), ringClip(587), ringClip(659)};
  for (const ChimeClip rendered : clips) {
    int peak = 0;
    for (size_t i = 0; i < rendered.count; ++i) {
      peak = std::max(peak, std::abs(static_cast<int>(rendered.samples[i]) - 128));
    }
    CHECK(peak * scale < 32767);
  }
}
