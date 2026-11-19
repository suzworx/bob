// End of speech for hands-free turns (include/end_of_speech.h), fed synthetic
// per-10 ms-frame dB levels against a fixed noise floor. Owner report
// 2026-09-24 (#392): wake turns ended ~2.5 s in, mid-sentence.
#include <cstdint>
#include <cstring>

#include "doctest.h"
#include "end_of_speech.h"
#include "follow_up.h"

using bob::EndOfSpeech;
using bob::VadEnd;

namespace {

constexpr float kFloor = 16.0f;   // the owner's room.
constexpr float kVoice = 54.0f;   // the owner's speech peak.
constexpr float kQuiet = kFloor;  // a pause.

// Feeds `ms` of frames at `db`; false as soon as the turn has ended.
bool feed(EndOfSpeech& vad, float db, uint32_t ms) {
  for (uint32_t t = 0; t < ms; t += 10) {
    if (vad.ended()) return false;
    vad.feed(db, kFloor);
  }
  return !vad.ended();
}

// `ms` of talking with a 100 ms dip between syllables every 300 ms.
bool talk(EndOfSpeech& vad, uint32_t ms) {
  for (uint32_t t = 0; t < ms; t += 300) {
    if (!feed(vad, kVoice, 200) || !feed(vad, 20.0f, 100)) return false;
  }
  return true;
}

}  // namespace

TEST_CASE("the tuning the owner's turns need") {
  CHECK(bob::kVadEndSilenceMs == 1200);
  CHECK(bob::kVadMinSpeechWindowMs == 1500);
  CHECK(bob::kVadMaxTurnMs == 15000);
  CHECK(bob::kVadMinSpeechDb == doctest::Approx(38.0f));
  CHECK(bob::kVadWordGapMs == 150);
}

TEST_CASE("a quiet speaker well over the floor is speech") {
  CHECK(bob::isSpeechFrame(40.0f, kFloor));
  CHECK_FALSE(bob::isSpeechFrame(37.0f, kFloor));    // under the absolute minimum.
  CHECK_FALSE(bob::isSpeechFrame(40.0f, 30.0f));     // not 12 dB over the floor.
  CHECK(bob::isSpeechFrame(40.0f, -1.0f));           // floor not measured yet.
}

TEST_CASE("a 6 s sentence with three 900 ms pauses does not end early") {
  EndOfSpeech vad;
  REQUIRE(talk(vad, 1500));
  for (int pause = 0; pause < 3; ++pause) {
    REQUIRE(feed(vad, kQuiet, 900));
    REQUIRE(talk(vad, 1200));
  }
  REQUIRE(feed(vad, kVoice, 200));  // the last word.
  CHECK(vad.heardSpeech());
  CHECK_FALSE(vad.ended());
  // 1.2 s of silence after the last word ends it, not a frame sooner.
  REQUIRE(feed(vad, kQuiet, 1190));
  vad.feed(kQuiet, kFloor);
  CHECK(vad.ended());
  CHECK(vad.endReason() == VadEnd::kSilence);
  // Onset to the end of the last word: 1500 + 3 x (900 + 1200) + 200.
  CHECK(vad.speechMs() == 8000);
}

TEST_CASE("dips under 150 ms between syllables keep the onset going") {
  EndOfSpeech vad;
  // 30 ms bursts with 100 ms dips: never 50 ms of consecutive speech frames.
  for (int i = 0; i < 3; ++i) {
    feed(vad, kVoice, 30);
    feed(vad, 20.0f, 100);
  }
  CHECK(vad.heardSpeech());
}

TEST_CASE("a gap of 150 ms or more restarts the onset") {
  EndOfSpeech vad;
  for (int i = 0; i < 3; ++i) {
    feed(vad, kVoice, 30);
    feed(vad, 20.0f, 200);
  }
  CHECK_FALSE(vad.heardSpeech());
}

TEST_CASE("a short utterance still gets its 1.5 s from the onset") {
  EndOfSpeech vad;
  REQUIRE(feed(vad, kVoice, 100));  // "yes"
  REQUIRE(feed(vad, kQuiet, 1390)); // 1200 ms of silence passed, 1500 from onset not yet.
  CHECK_FALSE(vad.ended());
  vad.feed(kQuiet, kFloor);
  CHECK(vad.ended());
  CHECK(vad.endReason() == VadEnd::kSilence);
  CHECK(vad.speechMs() == 100);
}

TEST_CASE("nonstop speech ends at the 15 s cap") {
  EndOfSpeech vad;
  REQUIRE(feed(vad, kVoice, 14990));
  vad.feed(kVoice, kFloor);
  CHECK(vad.ended());
  CHECK(vad.endReason() == VadEnd::kMax);
}

TEST_CASE("woken and nothing said ends at 8 s without speech") {
  EndOfSpeech vad;
  REQUIRE(feed(vad, kQuiet, 7990));
  vad.feed(kQuiet, kFloor);
  CHECK(vad.ended());
  CHECK_FALSE(vad.heardSpeech());
  CHECK(vad.endReason() == VadEnd::kMax);
  CHECK(vad.speechMs() == 0);
}

TEST_CASE("voiced frames tell the caller not to move the noise floor") {
  EndOfSpeech vad;
  CHECK(vad.feed(kVoice, kFloor));
  CHECK(vad.feed(20.0f, kFloor));   // inside the 150 ms hangover.
  for (int i = 0; i < 14; ++i) vad.feed(20.0f, kFloor);
  CHECK_FALSE(vad.feed(20.0f, kFloor));  // hangover over: silence.
}

// --- c2 (#392 research D2/D3) ---

TEST_CASE("hysteresis: speech starts 12 dB over the floor and holds down to 8 dB over") {
  CHECK(bob::kVadSpeechOverFloorDb == doctest::Approx(12.0f));
  CHECK(bob::kVadSpeechHoldOverFloorDb == doctest::Approx(8.0f));
  EndOfSpeech vad;
  REQUIRE(feed(vad, kVoice, 30));
  // 26 dB (floor + 10) is under the start level but keeps a run going...
  CHECK(vad.feed(26.0f, kFloor));
  REQUIRE(feed(vad, 26.0f, 20));
  CHECK(vad.heardSpeech());  // 3 + 3 frames of speech >= 50 ms.
  // ...and speech_ms runs to the end of the held frames.
  CHECK(vad.speechMs() == 60);
  // Under floor + 8 ends the run; 26 dB alone never starts one.
  EndOfSpeech fresh;
  REQUIRE(feed(fresh, 26.0f, 500));
  CHECK_FALSE(fresh.heardSpeech());
}

TEST_CASE("the follow-up window needs 200 ms of speech: an echo-like 120 ms burst does not open it") {
  CHECK(bob::kFollowUpOnsetMs == 200);
  EndOfSpeech vad;
  vad.reset(bob::kFollowUpOnsetMs, bob::VadOnset::kFollowUp);
  REQUIRE(feed(vad, kVoice, 120));
  REQUIRE(feed(vad, kQuiet, 1000));
  CHECK_FALSE(vad.heardSpeech());
}

TEST_CASE("250 ms of speech opens the follow-up window, at its 200th ms") {
  EndOfSpeech vad;
  vad.reset(bob::kFollowUpOnsetMs, bob::VadOnset::kFollowUp);
  REQUIRE(feed(vad, kVoice, 190));
  CHECK_FALSE(vad.heardSpeech());
  REQUIRE(feed(vad, kVoice, 10));
  CHECK(vad.heardSpeech());
  REQUIRE(feed(vad, kVoice, 50));
  CHECK(vad.speechMs() == 250);
}

TEST_CASE("wake turns keep the 50 ms onset") {
  EndOfSpeech vad;
  vad.reset();
  REQUIRE(feed(vad, kVoice, 50));
  CHECK(vad.heardSpeech());
}

TEST_CASE("the follow-up guard waits 250 ms after the speaker drained, across the wrap") {
  CHECK(bob::kFollowUpGuardMs == 250);
  CHECK_FALSE(bob::followUpGuardPassed(1000, 1249));
  CHECK(bob::followUpGuardPassed(1000, 1250));
  CHECK_FALSE(bob::followUpGuardPassed(0xFFFFFF80u, 0x00000079u));  // 128 + 121 = 249 ms in.
  CHECK(bob::followUpGuardPassed(0xFFFFFF80u, 0x0000007Au));        // 250 ms in.
}

TEST_CASE("reset starts a fresh turn") {
  EndOfSpeech vad;
  feed(vad, kVoice, 15000);
  REQUIRE(vad.ended());
  vad.reset();
  CHECK_FALSE(vad.ended());
  CHECK_FALSE(vad.heardSpeech());
  CHECK(vad.endReason() == VadEnd::kNone);
  CHECK(std::strcmp(bob::vadEndName(VadEnd::kSilence), "silence") == 0);
  CHECK(std::strcmp(bob::vadEndName(VadEnd::kMax), "max") == 0);
}

TEST_CASE("follow-up voicedRun expires after a 50 ms gap") {
  EndOfSpeech vad;
  vad.reset(bob::kFollowUpOnsetMs, bob::VadOnset::kFollowUp);
  CHECK_FALSE(vad.voicedRun());
  REQUIRE(feed(vad, kVoice, 100));
  CHECK(vad.voicedRun());
  CHECK_FALSE(vad.heardSpeech());
  REQUIRE(feed(vad, 20.0f, 40));  // a brief dip before confirmation.
  CHECK(vad.voicedRun());
  REQUIRE(feed(vad, 20.0f, 10));   // 50 ms of gap: the run is over.
  CHECK_FALSE(vad.voicedRun());
}

TEST_CASE("follow-up onset rejects isolated clicks and held noise") {
  EndOfSpeech vad;
  vad.reset(bob::kFollowUpOnsetMs, bob::VadOnset::kFollowUp);
  SUBCASE("click train with 100 ms gaps") {
    for (int i = 0; i < 20; ++i) {
      feed(vad, kVoice, 10);
      feed(vad, kQuiet, 100);
    }
  }
  SUBCASE("one click followed by subthreshold hiss") {
    feed(vad, kVoice, 10);
    feed(vad, 26.0f, 190);
  }
  CHECK_FALSE(vad.heardSpeech());
}

TEST_CASE("follow-up accepts quiet onset with brief dips and retains post-onset pauses") {
  EndOfSpeech vad;
  vad.reset(bob::kFollowUpOnsetMs, bob::VadOnset::kFollowUp);
  feed(vad, 40.0f, 100);
  feed(vad, kQuiet, 30);
  feed(vad, 40.0f, 90);
  CHECK_FALSE(vad.heardSpeech());
  feed(vad, 40.0f, 10);
  REQUIRE(vad.heardSpeech());
  feed(vad, 26.0f, 100);  // confirmed speech retains the lower hold threshold.
  CHECK(vad.speechMs() == 330);
  REQUIRE(feed(vad, kQuiet, 900));
  REQUIRE(feed(vad, 40.0f, 200));
  REQUIRE(feed(vad, kQuiet, 1190));
  vad.feed(kQuiet, kFloor);
  CHECK(vad.endReason() == VadEnd::kSilence);
  vad.reset();  // resetting to normal wake restores the original onset policy.
  feed(vad, kVoice, 30);
  feed(vad, 26.0f, 20);
  CHECK(vad.heardSpeech());
}

TEST_CASE("follow-up silence never confirms an onset") {
  EndOfSpeech vad;
  vad.reset(bob::kFollowUpOnsetMs, bob::VadOnset::kFollowUp);
  REQUIRE(feed(vad, kQuiet, 6000));
  CHECK_FALSE(vad.heardSpeech());
  CHECK_FALSE(vad.voicedRun());
}

// --- The round touch board's quicker end (owner UX audit 2026-10-20, #1063;
// stays 1000 ms: 600 cut long sentences, HIL turn-long-sentence) ---

namespace {
constexpr uint32_t kQuickMs = bob::kVadQuickEndSilenceMs;
}  // namespace

TEST_CASE("the round board ends hands-free turns after 1 s; the Cardputer keeps 1.2 s") {
  CHECK(kQuickMs == 1000);
  // The host build is the Cardputer's: its hands-free default is unchanged.
  CHECK(bob::kVadHandsFreeEndSilenceMs == bob::kVadEndSilenceMs);
}

TEST_CASE("the quick end silence does not cut a sentence with 0.9-1.0 s pauses (turn-long-sentence)") {
  EndOfSpeech vad;
  vad.reset(bob::kVadOnsetMs, bob::VadOnset::kWake, kQuickMs);
  REQUIRE(feed(vad, kVoice, 940));
  REQUIRE(feed(vad, kQuiet, 920));
  REQUIRE(feed(vad, kVoice, 1000));
  REQUIRE(feed(vad, kQuiet, 940));
  REQUIRE(feed(vad, kVoice, 600));
  REQUIRE(feed(vad, kQuiet, 900));
  CHECK_FALSE(vad.ended());
  // A full quick end silence after the last word ends it.
  REQUIRE(feed(vad, kQuiet, kQuickMs - 900 - bob::kVadFrameMs));
  CHECK_FALSE(vad.ended());
  vad.feed(kQuiet, kFloor);
  CHECK(vad.ended());
  CHECK(vad.endReason() == VadEnd::kSilence);
}

TEST_CASE("the quick end silence ends a sentence that long after its last word, not a frame sooner") {
  EndOfSpeech vad;
  vad.reset(bob::kVadOnsetMs, bob::VadOnset::kWake, kQuickMs);
  REQUIRE(talk(vad, 2400));
  REQUIRE(feed(vad, kVoice, 200));  // the last word.
  REQUIRE(feed(vad, kQuiet, kQuickMs - bob::kVadFrameMs));
  CHECK_FALSE(vad.ended());
  vad.feed(kQuiet, kFloor);
  CHECK(vad.ended());
  CHECK(vad.endReason() == VadEnd::kSilence);
}

TEST_CASE("the quick end silence still waits out the 1.5 s window after a short word") {
  EndOfSpeech vad;
  vad.reset(bob::kVadOnsetMs, bob::VadOnset::kWake, kQuickMs);
  REQUIRE(feed(vad, kVoice, 100));   // "hi"
  // The quick silence long gone, 1500 ms from the onset not yet.
  REQUIRE(feed(vad, kQuiet, bob::kVadMinSpeechWindowMs - 100 - bob::kVadFrameMs));
  CHECK_FALSE(vad.ended());
  vad.feed(kQuiet, kFloor);
  CHECK(vad.ended());
}

TEST_CASE("a long pause in the first 1.5 s is bridged; a shorter-than-quick one later does not end the turn") {
  EndOfSpeech vad;
  vad.reset(bob::kVadOnsetMs, bob::VadOnset::kWake, kQuickMs);
  REQUIRE(feed(vad, kVoice, 200));
  REQUIRE(feed(vad, kQuiet, 900));   // "um..." inside the 1.5 s window.
  REQUIRE(talk(vad, 1500));          // ends on a syllable's 100 ms dip...
  REQUIRE(feed(vad, kQuiet, kQuickMs - 100 - 2 * bob::kVadFrameMs));  // ...so 20 ms short of it in all.
  REQUIRE(talk(vad, 900));
  CHECK_FALSE(vad.ended());
}

TEST_CASE("the default reset keeps the 1.2 s end silence") {
  EndOfSpeech vad;
  vad.reset();
  REQUIRE(talk(vad, 2400));
  REQUIRE(feed(vad, kVoice, 200));
  REQUIRE(feed(vad, kQuiet, 1000));  // past 1 s: a quick end would be over.
  CHECK_FALSE(vad.ended());
}

// The server's end_of_turn (#1365): closes a hands-free capture only for the turn in capture.
TEST_CASE("server end_of_turn: the matching turn_ref closes a hands-free capture") {
  CHECK(bob::serverEndOfTurnCloses(true, true, "turn_0001_abcd", "turn_0001_abcd"));
}

TEST_CASE("server end_of_turn: a stale, unknown or empty turn_ref is ignored") {
  CHECK_FALSE(bob::serverEndOfTurnCloses(true, true, "turn_0002_abcd", "turn_0001_abcd"));
  CHECK_FALSE(bob::serverEndOfTurnCloses(true, true, "turn_0001_abcd", "turn_0001_abc"));
  CHECK_FALSE(bob::serverEndOfTurnCloses(true, true, "turn_0001_abcd", ""));
  CHECK_FALSE(bob::serverEndOfTurnCloses(true, true, "", ""));
}

TEST_CASE("server end_of_turn: after capture ended, or on a push-to-talk hold, it is a no-op") {
  CHECK_FALSE(bob::serverEndOfTurnCloses(false, true, "turn_0001_abcd", "turn_0001_abcd"));
  CHECK_FALSE(bob::serverEndOfTurnCloses(true, false, "turn_0001_abcd", "turn_0001_abcd"));
}
