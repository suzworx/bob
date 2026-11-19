// What an MP3 reply's teardown may touch (include/audio_playback.h). The
// ESP8266Audio generator's stop() frees stream/frame/synth, which its default
// constructor leaves uninitialised until begin() allocates them, so stop() on a
// generator whose begin() failed crashed the device (heap_caps_free assert,
// HIL run 20260924-152435-04ca: stop pressed as a reply started).
#include <initializer_list>

#include "doctest.h"
#include "audio_playback.h"

TEST_CASE("a decode that began and exited: stop the generator and output, free all") {
  const bob::Mp3TeardownPlan plan = bob::planMp3Teardown(true, true);
  CHECK(plan.stopGenerator);
  CHECK(plan.stopOutput);
  CHECK(plan.freeObjects);
}

TEST_CASE("begin() failed (source closed by an abort): never stop the generator") {
  const bob::Mp3TeardownPlan plan = bob::planMp3Teardown(true, false);
  CHECK_FALSE(plan.stopGenerator);
  CHECK(plan.stopOutput);
  CHECK(plan.freeObjects);
}

TEST_CASE("an abandoned decode task: touch nothing, leak it") {
  for (const bool began : {true, false}) {
    const bob::Mp3TeardownPlan plan = bob::planMp3Teardown(false, began);
    CHECK_FALSE(plan.stopGenerator);
    CHECK_FALSE(plan.stopOutput);
    CHECK_FALSE(plan.freeObjects);
  }
}
