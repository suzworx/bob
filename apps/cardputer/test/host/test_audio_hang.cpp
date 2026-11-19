// Audio-call hang guard (include/audio_hang.h). Escaped defect, Waveshare 2026-10-15: after
// Mic.end() on the shared I2S port, Speaker.end() never returned and the turn hung on LISTENING.
#include <cstdint>
#include <cstring>

#include "audio_hang.h"
#include "doctest.h"

using bob::AudioCall;
using bob::AudioHangGuard;
using bob::AudioStage;
using bob::audioStageName;
using bob::kAudioHangMs;

TEST_CASE("audio hang: nothing in flight never fires") {
  AudioHangGuard g;
  CHECK(g.check(0) == AudioStage::kNone);
  CHECK(g.check(1000000) == AudioStage::kNone);
}

TEST_CASE("audio hang: a stuck Speaker.end is named after kAudioHangMs") {
  AudioHangGuard g;
  g.enter(AudioStage::kSpeakerEnd, 5000);
  CHECK(g.check(5000 + kAudioHangMs - 1) == AudioStage::kNone);
  CHECK(g.check(5000 + kAudioHangMs) == AudioStage::kSpeakerEnd);
  CHECK(std::strcmp(audioStageName(AudioStage::kSpeakerEnd), "speaker_end") == 0);
}

TEST_CASE("audio hang: a call that returns clears the guard") {
  AudioHangGuard g;
  const auto prev = g.enter(AudioStage::kMicEnd, 100);
  g.leave(prev);
  CHECK(g.check(100 + 10 * kAudioHangMs) == AudioStage::kNone);
}

TEST_CASE("audio hang: the innermost stuck call is reported, the outer resumes its own clock") {
  AudioHangGuard g;
  const auto outer = g.enter(AudioStage::kEndTurn, 0);
  const auto inner = g.enter(AudioStage::kMicEnd, 1900);
  CHECK(g.check(2500) == AudioStage::kNone);  // the inner call only started 600 ms ago
  g.leave(inner);
  CHECK(g.check(2100) == AudioStage::kEndTurn);  // the outer call has now run 2.1 s
  g.leave(outer);
  CHECK(g.check(60000) == AudioStage::kNone);
}

TEST_CASE("audio hang: the RAII bracket restores the previous stage when the call returns") {
  bob::audioHang().leave({AudioStage::kNone, 0});
  {
    AudioCall mic(AudioStage::kMicEnd, 10);
    CHECK(bob::audioHang().check(10 + kAudioHangMs) == AudioStage::kMicEnd);
  }
  CHECK(bob::audioHang().check(10 + 10 * kAudioHangMs) == AudioStage::kNone);
}

TEST_CASE("audio hang: the millisecond counter wrapping does not fire early") {
  AudioHangGuard g;
  g.enter(AudioStage::kSpeakerBegin, 0xFFFFFF00u);
  CHECK(g.check(0x00000010u) == AudioStage::kNone);  // 272 ms across the wrap
  CHECK(g.check(0x00000010u + kAudioHangMs) == AudioStage::kSpeakerBegin);
}
