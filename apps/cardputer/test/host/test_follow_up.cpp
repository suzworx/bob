// The follow-up window (include/follow_up.h): after a reply in Always awake the
// mic stays open for kFollowUpWindowMs; speech opens a turn without the wake
// word, silence closes the window at its deadline.
#include <cstdint>
#include <cstring>

#include "doctest.h"
#include "follow_up.h"

using bob::DeviceMode;
using bob::FollowUpClose;
using bob::FollowUpDecision;
using bob::FollowUpWindow;

TEST_CASE("only a reply in Always awake opens the window") {
  CHECK(bob::followUpAfterReply(DeviceMode::kWake, false, false));
  CHECK_FALSE(bob::followUpAfterReply(DeviceMode::kPtt, false, false));
  CHECK_FALSE(bob::followUpAfterReply(DeviceMode::kAnnounceOnly, false, false));
  // Always awake that fell back to push-to-talk, and Do not disturb.
  CHECK_FALSE(bob::followUpAfterReply(DeviceMode::kWake, true, false));
  CHECK_FALSE(bob::followUpAfterReply(DeviceMode::kWake, false, true));
}

TEST_CASE("the window is 6 s and keeps 300 ms of pre-roll") {
  CHECK(bob::kFollowUpWindowMs == 6000);
  CHECK(bob::kFollowUpPreRollFrames == 30);
}

TEST_CASE("a closed window decides nothing") {
  FollowUpWindow window;
  CHECK_FALSE(window.isOpen());
  CHECK(window.decide(100000, true) == FollowUpDecision::kNone);
}

TEST_CASE("silence keeps the window open until its deadline") {
  FollowUpWindow window;
  window.open(1000);
  CHECK(window.isOpen());
  CHECK(window.decide(1000, false) == FollowUpDecision::kNone);
  CHECK(window.decide(6999, false) == FollowUpDecision::kNone);
  CHECK(window.decide(7000, false) == FollowUpDecision::kTimeout);
  CHECK(window.decide(9000, false) == FollowUpDecision::kTimeout);
}

TEST_CASE("speech inside the window opens a turn") {
  FollowUpWindow window;
  window.open(1000);
  CHECK(window.decide(2500, true) == FollowUpDecision::kSpeech);
}

TEST_CASE("speech heard on the deadline's tick still wins") {
  FollowUpWindow window;
  window.open(1000);
  CHECK(window.decide(7000, true) == FollowUpDecision::kSpeech);
}

TEST_CASE("the deadline holds across the millis() wrap") {
  FollowUpWindow window;
  window.open(0xFFFFF000u);  // 4096 ms before the wrap.
  CHECK(window.decide(0xFFFFFFFFu, false) == FollowUpDecision::kNone);
  CHECK(window.decide(1903u, false) == FollowUpDecision::kNone);  // 5999 ms in.
  CHECK(window.decide(1904u, false) == FollowUpDecision::kTimeout);
}

TEST_CASE("closing ends the window and it opens again with a fresh deadline") {
  FollowUpWindow window;
  window.open(1000);
  window.close();
  CHECK_FALSE(window.isOpen());
  CHECK(window.decide(50000, false) == FollowUpDecision::kNone);
  window.open(50000);
  CHECK(window.decide(55999, false) == FollowUpDecision::kNone);
  CHECK(window.decide(56000, false) == FollowUpDecision::kTimeout);
}

TEST_CASE("a custom window length is honoured") {
  FollowUpWindow window;
  window.open(0, 250);
  CHECK(window.windowMs() == 250);
  CHECK(window.decide(249, false) == FollowUpDecision::kNone);
  CHECK(window.decide(250, false) == FollowUpDecision::kTimeout);
}

TEST_CASE("close reasons have their journal names") {
  CHECK(std::strcmp(bob::followUpCloseName(FollowUpClose::kSpeech), "speech") == 0);
  CHECK(std::strcmp(bob::followUpCloseName(FollowUpClose::kTimeout), "timeout") == 0);
  CHECK(std::strcmp(bob::followUpCloseName(FollowUpClose::kKey), "key") == 0);
  CHECK(std::strcmp(bob::followUpCloseName(FollowUpClose::kAnnounce), "announce") == 0);
  CHECK(std::strcmp(bob::followUpCloseName(FollowUpClose::kStop), "stop") == 0);
  CHECK(std::strcmp(bob::followUpCloseName(FollowUpClose::kMode), "mode") == 0);
  CHECK(std::strcmp(bob::followUpCloseName(FollowUpClose::kDisconnect), "disconnect") == 0);
  CHECK(std::strcmp(bob::followUpCloseName(FollowUpClose::kMic), "mic") == 0);
}

// --- c5 review findings ---

using bob::FollowUpChain;

TEST_CASE("at most two follow-ups per wake, so a TV cannot chain forever") {
  CHECK(bob::kMaxFollowUpsPerWake == 2);
  FollowUpChain chain;
  chain.beginChain();              // a wake (or GO) turn.
  CHECK(chain.allowsWindow());     // its reply opens a window.
  chain.followUpTurn();            // follow-up 1.
  CHECK(chain.allowsWindow());
  chain.followUpTurn();            // follow-up 2.
  CHECK_FALSE(chain.allowsWindow());
  chain.beginChain();              // the next wake starts over.
  CHECK(chain.allowsWindow());
}

TEST_CASE("a follow-up heard as nothing, or a failed turn, ends the chain") {
  FollowUpChain chain;
  chain.beginChain();
  chain.followUpTurn();
  chain.end();
  CHECK_FALSE(chain.allowsWindow());
  chain.beginChain();
  CHECK(chain.allowsWindow());
}

TEST_CASE("a reply heard as nothing ends the chain on any turn, so a 402 opens no window (#1041)") {
  FollowUpChain chain;
  chain.beginChain();              // a wake (or GO) turn, not a follow-up.
  chain.replyHeard("");            // e.g. a TTS-stage 402 out-of-credit reply.
  CHECK_FALSE(chain.allowsWindow());
  chain.beginChain();
  chain.replyHeard(nullptr);
  CHECK_FALSE(chain.allowsWindow());
  chain.beginChain();
  chain.replyHeard("what time is it");
  CHECK(chain.allowsWindow());
}

TEST_CASE("speech under way at the deadline gets up to 300 ms more for its onset") {
  CHECK(bob::kFollowUpOnsetGraceMs == 300);
  FollowUpWindow window;
  window.open(1000);  // deadline 7000.
  CHECK(window.decide(7000, false, true) == FollowUpDecision::kNone);
  CHECK(window.decide(7299, false, true) == FollowUpDecision::kNone);
  CHECK(window.decide(7300, false, true) == FollowUpDecision::kTimeout);
  CHECK(window.decide(7150, true, true) == FollowUpDecision::kSpeech);  // the onset made it.
  CHECK(window.decide(7000, false, false) == FollowUpDecision::kTimeout);  // silence: no grace.
}
