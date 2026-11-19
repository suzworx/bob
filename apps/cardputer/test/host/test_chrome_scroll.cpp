#include "chrome_scroll.h"
#include "doctest.h"

TEST_CASE("shortcut strip rests for 600 ms then moves at 100 pixels per second") {
  CHECK(bob::stripScrollOffset(0, 600) == 0);
  CHECK(bob::stripScrollOffset(599, 600) == 0);
  CHECK(bob::stripScrollOffset(600, 600) == 0);
  CHECK(bob::stripScrollOffset(640, 600) == 4);
  CHECK(bob::stripScrollOffset(1600, 600) == 100);
}

TEST_CASE("shortcut strip catches up after irregular rendering without extra frames") {
  CHECK(bob::stripScrollOffset(647, 600) == 4);
  CHECK(bob::stripScrollOffset(1739, 600) == 113);
  CHECK(bob::stripScrollOffset(2840, 600) == 224);
}

TEST_CASE("shortcut strip loops with a readable pause at the start") {
  CHECK(bob::stripScrollOffset(6590, 600) == 599);
  CHECK(bob::stripScrollOffset(6600, 600) == 0);
  CHECK(bob::stripScrollOffset(7199, 600) == 0);
  CHECK(bob::stripScrollOffset(7240, 600) == 4);
  CHECK(bob::stripScrollOffset(13840, 600) == 4);
}

TEST_CASE("shortcut strip elapsed time survives the millis rollover") {
  const uint32_t startedAt = UINT32_MAX - 299;
  const uint32_t now = 340;
  CHECK(bob::stripScrollOffset(now - startedAt, 600) == 4);
}

TEST_CASE("empty shortcut strip has no scroll position") {
  CHECK(bob::stripScrollOffset(1000, 0) == 0);
  CHECK(bob::stripScrollOffset(1000, -1) == 0);
}
