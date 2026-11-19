// Turn trouble (include/turn_trouble.h): the round board names why a turn failed (owner UX audit
// 2026-10-20, #1063) instead of "Something went wrong".
#include <cstring>
#include <initializer_list>

#include "doctest.h"
#include "turn_trouble.h"

using bob::TurnTrouble;

TEST_CASE("trouble: a failed speech or AI stage is busy, broken audio was not heard, offline wins") {
  CHECK(bob::troubleForServerError("INTERNAL", true) == TurnTrouble::kBusy);
  CHECK(bob::troubleForServerError("BAD_AUDIO", true) == TurnTrouble::kNotHeard);
  CHECK(bob::troubleForServerError("SEQUENCE_GAP", true) == TurnTrouble::kNotHeard);
  CHECK(bob::troubleForServerError("FRAME_TOO_LARGE", true) == TurnTrouble::kNotHeard);
  CHECK(bob::troubleForServerError("QUEUE_FULL", true) == TurnTrouble::kNotHeard);
  CHECK(bob::troubleForServerError("STATE_VIOLATION", true) == TurnTrouble::kOther);
  CHECK(bob::troubleForServerError("", true) == TurnTrouble::kOther);
  CHECK(bob::troubleForServerError(nullptr, true) == TurnTrouble::kOther);
  CHECK(bob::troubleForServerError("INTERNAL", false) == TurnTrouble::kNoInternet);
}

TEST_CASE("trouble: every kind has a short caption and a journal name") {
  for (TurnTrouble t : {TurnTrouble::kNoInternet, TurnTrouble::kBusy, TurnTrouble::kNotHeard, TurnTrouble::kOther}) {
    const char* caption = bob::troubleCaption(t);
    CHECK(std::strlen(caption) > 0);
    CHECK(std::strlen(caption) <= 18);  // one line in the caption chord at the bottom of the circle
    CHECK(std::strchr(bob::troubleName(t), ' ') == nullptr);
  }
  CHECK(std::strcmp(bob::troubleCaption(TurnTrouble::kNotHeard), "Didn't catch that") == 0);
}

TEST_CASE("trouble: error screens get a plain caption, other titles stay") {
  CHECK(std::strcmp(bob::plainErrorCaption("MIC ERROR"), "Mic trouble") == 0);
  CHECK(std::strcmp(bob::plainErrorCaption("WS ERROR"), "Can't connect") == 0);
  CHECK(std::strcmp(bob::plainErrorCaption("UPDATE NEEDED"), "Update needed") == 0);
  CHECK(bob::plainErrorCaption("NO INTERNET") == nullptr);
  CHECK(bob::plainErrorCaption(nullptr) == nullptr);
}
