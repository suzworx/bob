#include "doctest.h"
#include "audio_playback.h"

TEST_CASE("announcement prelude yields to cancellation, ring pressure and bounded time") {
  using bob::waitForAnnouncementCue;
  CHECK(waitForAnnouncementCue(true, false, 0, 1024, 49152));
  CHECK(waitForAnnouncementCue(true, false, 2100, 12000, 49152));
  CHECK_FALSE(waitForAnnouncementCue(false, false, 0, 0, 49152));
  CHECK_FALSE(waitForAnnouncementCue(true, true, 0, 0, 49152));
  CHECK_FALSE(waitForAnnouncementCue(true, false, 2200, 0, 49152));
  CHECK_FALSE(waitForAnnouncementCue(true, false, 10, 24576, 49152));
}
