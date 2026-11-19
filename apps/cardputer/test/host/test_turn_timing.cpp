#include <cstring>
#include <string>
#include "doctest.h"
#include "support.h"
#include "turn_timing.h"

using bob::Milestone;
using bob::PlaybackStamps;
using bob::TimingEnd;
using bob::TimingOutcome;
using bob::TimingSource;
using bob::TurnTimingRecord;

namespace {

// A wake turn: mic open at 1000, MP3 reply played to the end.
TurnTimingRecord drainedMp3(PlaybackStamps& p) {
  TurnTimingRecord r;
  r.begin(TimingSource::kWake, 1000);
  r.mark(Milestone::kFirstUp, 1050);
  r.setEnd(TimingEnd::kSilence);
  r.mark(Milestone::kCaptureEnd, 4200);
  r.mark(Milestone::kTurnEnd, 4230);
  r.upFrames = 320;
  r.setCaptureStats(true, 2050, 3, 99, 4, 120);  // last voiced frame 2.05 s in; 3 frames queued.
  p.clear();
  p.decoder = true;
  p.start.mark(5100);
  p.firstDown.mark(5110);
  p.decoderReady.mark(5180);
  p.submitted.mark(5200);
  p.ended.mark(9000);
  p.downFrames = 41;
  r.close(p);
  return r;
}

std::string encode(const TurnTimingRecord& r, TimingOutcome outcome, const char* ref = "turn_123456_v2") {
  char out[bob::kTurnTimingBytes];
  const size_t n = bob::encodeTurnTiming(out, sizeof(out), ref, r, outcome, 123456);
  return n == 0 ? std::string() : std::string(out, n);
}

}  // namespace

TEST_CASE("turn_timing for a drained MP3 reply matches the fixture the server's Zod accepts") {
  PlaybackStamps p;
  const TurnTimingRecord r = drainedMp3(p);
  CHECK(bob::timingOutcome(false, false, p) == TimingOutcome::kDrained);
  CHECK(encode(r, TimingOutcome::kDrained) == hosttest::str(hosttest::fixture("turn_timing")));
}

TEST_CASE("turn_timing for a stop before the first frame: playback steps not reached are null") {
  TurnTimingRecord r;
  r.begin(TimingSource::kPtt, 500);
  r.muted = true;
  r.mark(Milestone::kFirstUp, 620);
  r.setEnd(TimingEnd::kRelease);
  r.mark(Milestone::kCaptureEnd, 2500);
  r.mark(Milestone::kTurnEnd, 2510);
  r.upFrames = 200;
  r.setCaptureStats(false, 0, 0, 100, 0, 0);  // the VAD heard no onset: speech_end_ms is null.
  PlaybackStamps p;  // PCM: no decoder.
  p.start.mark(3500);
  p.ended.mark(4000);
  r.close(p);
  CHECK(bob::timingOutcome(true, false, p) == TimingOutcome::kInterrupted);
  CHECK(encode(r, TimingOutcome::kInterrupted) == hosttest::str(hosttest::fixture("turn_timing_stopped")));
}

TEST_CASE("zero, skipped and unknown stay distinct") {
  TurnTimingRecord r;
  r.begin(TimingSource::kFollowUp, 7000);
  r.mark(Milestone::kFirstUp, 7000);                    // measured 0.
  r.mark(Milestone::kCaptureEnd, 7000 + bob::kTurnTimingMaxMs + 1);  // past the bound: unknown.
  r.close(PlaybackStamps());                            // no reply at all: skipped.
  const std::string body = encode(r, TimingOutcome::kEmpty);
  CHECK(body.find("\"first_up_ms\":0") != std::string::npos);
  CHECK(body.find("capture_end_ms") == std::string::npos);
  CHECK(body.find("\"turn_end_ms\":null") != std::string::npos);
  CHECK(body.find("\"playback_start_ms\":null") != std::string::npos);
  CHECK(body.find("\"speaker_submission_ms\":null") != std::string::npos);
  CHECK(body.find("\"down_frames\":0") != std::string::npos);
  CHECK(body.find("\"source\":\"follow_up\"") != std::string::npos);
  CHECK(body.find("\"end_reason\":\"error\"") != std::string::npos);  // never set: the closed set's fallback.
}

TEST_CASE("offsets survive a millis() rollover between capture start and a milestone") {
  TurnTimingRecord r;
  r.begin(TimingSource::kWake, 0xffffff00u);
  r.mark(Milestone::kCaptureEnd, 0x00000100u);
  r.close(PlaybackStamps());
  uint32_t value = 0;
  bool isNull = true;
  CHECK(r.offset(Milestone::kCaptureEnd, &value, &isNull));
  CHECK(value == 512);
  CHECK_FALSE(isNull);
}

TEST_CASE("the first mark wins and nothing is recorded after close") {
  TurnTimingRecord r;
  r.begin(TimingSource::kPtt, 100);
  r.mark(Milestone::kFirstUp, 150);
  r.mark(Milestone::kFirstUp, 900);
  r.setEnd(TimingEnd::kKey);
  r.setEnd(TimingEnd::kUplink);
  r.close(PlaybackStamps());
  r.mark(Milestone::kTurnEnd, 950);
  uint32_t value = 0;
  bool isNull = false;
  CHECK(r.offset(Milestone::kFirstUp, &value, &isNull));
  CHECK(value == 50);
  CHECK_FALSE(r.offset(Milestone::kTurnEnd, &value, &isNull));
  CHECK(isNull);
  CHECK(r.end == TimingEnd::kKey);
}

TEST_CASE("the outcome separates stop, failure, empty and drained replies") {
  PlaybackStamps none;
  CHECK(bob::timingOutcome(false, false, none) == TimingOutcome::kEmpty);
  CHECK(bob::timingOutcome(true, true, none) == TimingOutcome::kInterrupted);
  CHECK(bob::timingOutcome(false, true, none) == TimingOutcome::kFailed);
  PlaybackStamps started;
  started.start.mark(10);
  CHECK(bob::timingOutcome(false, false, started) == TimingOutcome::kEmpty);  // no frame came.
  started.downFrames = 3;
  CHECK(bob::timingOutcome(false, false, started) == TimingOutcome::kFailed);  // frames, nothing played.
  started.submitted.mark(20);
  CHECK(bob::timingOutcome(false, false, started) == TimingOutcome::kDrained);
  started.failed = true;  // e.g. the MP3 decoder bailed after the first chunk.
  CHECK(bob::timingOutcome(false, false, started) == TimingOutcome::kFailed);
}

TEST_CASE("an MP3 decoder that never began reports decoder_ready as skipped") {
  TurnTimingRecord r;
  r.begin(TimingSource::kWake, 0);
  PlaybackStamps p;
  p.decoder = true;
  p.failed = true;
  p.start.mark(10);
  p.firstDown.mark(20);
  p.ended.mark(30);
  p.downFrames = 2;
  r.close(p);
  uint32_t value = 0;
  bool isNull = false;
  CHECK_FALSE(r.offset(Milestone::kDecoderReady, &value, &isNull));
  CHECK(isNull);
  CHECK(bob::timingOutcome(false, false, p) == TimingOutcome::kFailed);
}

TEST_CASE("the encoder refuses an open record, a bad turn_ref and a short buffer, and its worst case fits") {
  TurnTimingRecord open;
  open.begin(TimingSource::kWake, 0);
  CHECK(encode(open, TimingOutcome::kDrained).empty());
  PlaybackStamps p;
  const TurnTimingRecord r = drainedMp3(p);
  CHECK(encode(r, TimingOutcome::kDrained, "https://x").empty());
  CHECK(encode(r, TimingOutcome::kDrained, "short").empty());
  char small[64];
  CHECK(bob::encodeTurnTiming(small, sizeof(small), "turn_123456_v2", r, TimingOutcome::kDrained, 1) == 0);
  CHECK(small[0] == '\0');
  // Longest names, 64-char ref, 10-digit id, every offset at its bound.
  TurnTimingRecord worst;
  worst.begin(TimingSource::kFollowUp, 0);
  worst.setEnd(TimingEnd::kNoSpeech);
  for (size_t i = 0; i < bob::kMilestoneCount; ++i) worst.mark(static_cast<Milestone>(i), bob::kTurnTimingMaxMs);
  worst.upFrames = 0xffffffffu;
  worst.setCaptureStats(true, bob::kTurnTimingMaxMs, 0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu);
  PlaybackStamps all;
  all.decoder = true;
  all.firstDown.mark(1);
  all.downFrames = 0xffffffffu;
  worst.close(all);
  const std::string ref(64, 'a');
  char out[bob::kTurnTimingBytes];
  const size_t n = bob::encodeTurnTiming(out, sizeof(out), ref.c_str(), worst, TimingOutcome::kInterrupted, 0xffffffffu);
  CHECK(n > 0);
  CHECK(n < bob::kTurnTimingBytes);
  MESSAGE("turn_timing worst case bytes: " << n);
  // The required fields always fit; the optional stats only while they do.
  CHECK(std::string(out).find("\"up_frames\":100000,\"down_frames\":100000,\"speech_end_ms\":600000}}") !=
        std::string::npos);
  // The device's own ref (turn_<millis>_v2, at most 18 chars) with every value at its bound.
  const size_t device = bob::encodeTurnTiming(out, sizeof(out), "turn_4294967295_v2", worst,
                                                TimingOutcome::kInterrupted, 0xffffffffu);
  MESSAGE("turn_timing device worst case bytes: " << device);
  CHECK(device > 0);
  CHECK(device < bob::kTurnTimingBytes);
  CHECK(std::string(out).find("\"speech_end_ms\":600000") != std::string::npos);
}

TEST_CASE("turn_timing is sent only after this connection's welcome acknowledged it") {
  CHECK(bob::welcomeSupportsTurnTiming(hosttest::fixture("welcome_turn_timing").c_str()));
  // The full welcome (every acked cap, answering hello_versioned) also acks it.
  CHECK(bob::welcomeSupportsTurnTiming(hosttest::fixture("welcome_turn_conversation").c_str()));
  CHECK_FALSE(bob::welcomeSupportsTurnTiming(hosttest::fixture("welcome_assistant_name").c_str()));
  CHECK_FALSE(bob::welcomeSupportsTurnTiming(hosttest::fixture("welcome").c_str()));
  CHECK_FALSE(bob::welcomeSupportsTurnTiming(nullptr));
}

TEST_CASE("capture end reasons map onto the closed wire set") {
  CHECK(bob::timingEndFromName("release") == TimingEnd::kRelease);
  CHECK(bob::timingEndFromName("silence") == TimingEnd::kSilence);
  CHECK(bob::timingEndFromName("max") == TimingEnd::kMax);
  CHECK(bob::timingEndFromName("key") == TimingEnd::kKey);
  CHECK(bob::timingEndFromName("uplink") == TimingEnd::kUplink);
  CHECK(bob::timingEndFromName("server") == TimingEnd::kSilence);
  CHECK(bob::timingEndFromName("none") == TimingEnd::kError);
  CHECK(bob::timingEndFromName(nullptr) == TimingEnd::kError);
}

TEST_CASE("capture stats: speech_end_ms is measured, null without an onset, unknown past the bound") {
  TurnTimingRecord r;
  r.begin(TimingSource::kPtt, 0);
  r.setCaptureStats(true, 0, 0, 0, 0, 0);  // a measured 0 is real.
  r.setCaptureStats(false, 9, 9, 9, 9, 9);  // the first call wins.
  r.close(PlaybackStamps());
  std::string body = encode(r, TimingOutcome::kEmpty);
  CHECK(body.find("\"down_frames\":0,\"speech_end_ms\":0,\"uplink_backlog\":0,\"mic_fps\":0,"
                  "\"tx_busy\":0,\"tx_busy_max_ms\":0}}") != std::string::npos);

  TurnTimingRecord late;
  late.begin(TimingSource::kWake, 0);
  late.setCaptureStats(true, bob::kTurnTimingMaxMs + 1, 1, 100, 2, 30);
  late.close(PlaybackStamps());
  body = encode(late, TimingOutcome::kEmpty);
  CHECK(body.find("speech_end_ms") == std::string::npos);
  CHECK(body.find("\"down_frames\":0,\"uplink_backlog\":1,\"mic_fps\":100,\"tx_busy\":2,\"tx_busy_max_ms\":30}}") !=
        std::string::npos);
}

TEST_CASE("a turn that never reached endTurn (no_speech cancel) leaves every capture stat out") {
  TurnTimingRecord r;
  r.begin(TimingSource::kWake, 0);
  r.setEnd(TimingEnd::kNoSpeech);
  r.close(PlaybackStamps());
  r.setCaptureStats(true, 5, 5, 5, 5, 5);  // after close: ignored.
  const std::string body = encode(r, TimingOutcome::kCancelled);
  CHECK(body.find("\"down_frames\":0}}") != std::string::npos);
  for (const char* key : {"speech_end_ms", "uplink_backlog", "mic_fps", "tx_busy"}) {
    CHECK(body.find(key) == std::string::npos);
  }
}

TEST_CASE("follow-up: speech_end_ms counts from capture start, not from the pre-roll the VAD heard first") {
  // The VAD clock starts at the pre-roll's first frame, 300 ms before capture start.
  TurnTimingRecord r;
  r.begin(TimingSource::kFollowUp, 1000, 300);
  r.setCaptureStats(true, 2050, 0, 100, 0, 0);
  r.close(PlaybackStamps());
  CHECK(encode(r, TimingOutcome::kEmpty).find("\"speech_end_ms\":1750,") != std::string::npos);

  TurnTimingRecord early;  // speech ended inside the pre-roll: before capture start, so 0.
  early.begin(TimingSource::kFollowUp, 1000, 300);
  early.setCaptureStats(true, 200, 0, 100, 0, 0);
  early.close(PlaybackStamps());
  CHECK(encode(early, TimingOutcome::kEmpty).find("\"speech_end_ms\":0,") != std::string::npos);
}
