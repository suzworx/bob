// Barge-in policy (include/barge_policy.h): the wake model may listen while Bob
// speaks only on a board whose mic and speaker are separate, and with a
// stricter cutoff because the echo canceller leaves residual echo.
#include <cstdint>

#include "doctest.h"
#include "barge_policy.h"

using bob::BargeInputs;
using bob::bargeCutoff;
using bob::bargeWanted;

static BargeInputs allFit() {
  BargeInputs in;
  in.welcomed = true;
  in.wakeMode = true;
  in.wakeFailed = false;
  in.followUpOpen = false;
  in.updateBusy = false;
  in.playingState = true;
  in.duplexActive = true;
  in.waveshare = true;
  return in;
}

TEST_CASE("barge listening is wanted only when every input fits") {
  CHECK(bargeWanted(allFit()));
}

TEST_CASE("each input alone turns barge listening off") {
  BargeInputs in = allFit();
  in.welcomed = false;
  CHECK_FALSE(bargeWanted(in));
  in = allFit(); in.wakeMode = false;
  CHECK_FALSE(bargeWanted(in));
  in = allFit(); in.wakeFailed = true;
  CHECK_FALSE(bargeWanted(in));
  in = allFit(); in.followUpOpen = true;
  CHECK_FALSE(bargeWanted(in));
  in = allFit(); in.updateBusy = true;
  CHECK_FALSE(bargeWanted(in));
  in = allFit(); in.playingState = false;
  CHECK_FALSE(bargeWanted(in));
  in = allFit(); in.duplexActive = false;
  CHECK_FALSE(bargeWanted(in));
}

TEST_CASE("never on the Cardputer: its mic and speaker share GPIO 43") {
  BargeInputs in = allFit();
  in.waveshare = false;
  CHECK_FALSE(bargeWanted(in));
}

TEST_CASE("near-end count is zero while the canceller hears only echo") {
  bob::NearEndGate gate;
  for (int i = 0; i < 300; ++i) gate.push(false);
  CHECK(gate.nearEndFrames() == 0);
}

TEST_CASE("near-end count tallies the near-end frames in the window") {
  bob::NearEndGate gate;
  for (int i = 0; i < 30; ++i) gate.push(true);
  CHECK(gate.nearEndFrames() == 30);
  gate.push(false);
  CHECK(gate.nearEndFrames() == 30);
}

TEST_CASE("near-end count falls as the near-end frames age out of the window") {
  bob::NearEndGate gate;
  for (int i = 0; i < bob::kNearEndWindowFrames; ++i) gate.push(true);
  CHECK(gate.nearEndFrames() == bob::kNearEndWindowFrames);
  for (int i = 0; i < bob::kNearEndWindowFrames - 1; ++i) gate.push(false);
  CHECK(gate.nearEndFrames() == 1);  // the last near-end frame is still in the window
  gate.push(false);
  CHECK(gate.nearEndFrames() == 0);
}

TEST_CASE("the barge cutoff takes half the headroom below the model's max") {
  CHECK(bargeCutoff(200) == 227);  // 200 + 55 / 2
  CHECK(bargeCutoff(100) == 177);  // 100 + 155 / 2
  CHECK(bargeCutoff(0) == 127);    // 0 + 255 / 2
  CHECK(bargeCutoff(247) == 251);  // Hey Bob's cutoff
  CHECK(bargeCutoff(229) == 242);  // alexa's cutoff
  CHECK(bargeCutoff(250) == 252);
  CHECK(bargeCutoff(255) == 255);
  CHECK(bargeCutoff(300) == 255);  // above the probability max: clamped
  CHECK(bargeCutoff(200) > 200);
}
