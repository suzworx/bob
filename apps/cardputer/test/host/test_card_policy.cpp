// Scrolling the READY cards and pickers, and the announcement inbox: the
// busy-time FIFO and replay dedupe (#318-#321, include/card_policy.h).
#include <cstddef>
#include <cstring>
#include <string>

#include "card_policy.h"
#include "doctest.h"

using bob::AnnounceInbox;
using bob::Announcement;

namespace {

Announcement make(const char* id) {
  Announcement a{};
  strncpy(a.id, id, bob::kAnnounceIdBytes - 1);
  a.id[bob::kAnnounceIdBytes - 1] = '\0';
  return a;
}

}  // namespace

TEST_CASE("stepWithin: one step, never past either end") {
  size_t index = 0;
  CHECK_FALSE(bob::stepWithin(&index, 2, -1));
  CHECK(index == 0);
  CHECK(bob::stepWithin(&index, 2, 1));
  CHECK(bob::stepWithin(&index, 2, 1));
  CHECK(index == 2);
  CHECK_FALSE(bob::stepWithin(&index, 2, 1));
  CHECK(index == 2);
  CHECK(bob::stepWithin(&index, 2, -1));
  CHECK(index == 1);
  CHECK_FALSE(bob::stepWithin(&index, 2, 0));  // delta 0: no move, no redraw.
  CHECK(index == 1);
  size_t none = 0;  // an empty list: nothing moves.
  CHECK_FALSE(bob::stepWithin(&none, 0, 1));
  CHECK_FALSE(bob::stepWithin(&none, 0, -1));
}

TEST_CASE("cardMaxFirstLine: a card that fits does not scroll") {
  CHECK(bob::cardMaxFirstLine(0) == 0);
  CHECK(bob::cardMaxFirstLine(bob::kCardVisibleLines) == 0);
  CHECK(bob::cardMaxFirstLine(bob::kCardVisibleLines + 3) == 3);
}

TEST_CASE("inbox: FIFO order, full at kDepth") {
  AnnounceInbox inbox;
  CHECK(inbox.held() == 0);
  Announcement out{};
  CHECK_FALSE(inbox.takeNext(out));
  CHECK(inbox.hold(make("a1")));
  CHECK(inbox.hold(make("a2")));
  CHECK(inbox.hold(make("a3")));
  CHECK_FALSE(inbox.hold(make("a4")));  // dropped unacked: the server replays it.
  CHECK(inbox.held() == AnnounceInbox::kDepth);
  REQUIRE(inbox.takeNext(out));
  CHECK(std::string(out.id) == "a1");
  REQUIRE(inbox.takeNext(out));
  CHECK(std::string(out.id) == "a2");
  CHECK(inbox.hold(make("a5")));
  REQUIRE(inbox.takeNext(out));
  CHECK(std::string(out.id) == "a3");
  REQUIRE(inbox.takeNext(out));
  CHECK(std::string(out.id) == "a5");
  CHECK(inbox.held() == 0);
}

TEST_CASE("inbox: seen covers the held ones and the recently acked ids") {
  AnnounceInbox inbox;
  CHECK_FALSE(inbox.seen("a1"));
  inbox.hold(make("a1"));
  CHECK(inbox.seen("a1"));
  inbox.rememberAcked("b1");
  CHECK(inbox.seen("b1"));
  inbox.dropHeld();  // a disconnect: held ones go, acked ids stay.
  CHECK(inbox.held() == 0);
  CHECK_FALSE(inbox.seen("a1"));
  CHECK(inbox.seen("b1"));
}

TEST_CASE("inbox: only the last kRecentIds acks are remembered") {
  AnnounceInbox inbox;
  const char* ids[] = {"r1", "r2", "r3", "r4", "r5"};
  for (const char* id : ids) inbox.rememberAcked(id);
  CHECK_FALSE(inbox.seen("r1"));  // the oldest was replaced.
  for (size_t i = 1; i < 5; ++i) CHECK(inbox.seen(ids[i]));
}

TEST_CASE("inbox: the unfilled recent slots match an empty id, as before the split") {
  // The server never sends an empty announce_id; kept exactly as state.cpp had it.
  AnnounceInbox inbox;
  CHECK(inbox.seen(""));
}

TEST_CASE("inbox: an over-long acked id is truncated, never overflows") {
  AnnounceInbox inbox;
  const std::string longId(bob::kAnnounceIdBytes + 10, 'x');
  inbox.rememberAcked(longId.c_str());
  CHECK(inbox.seen(std::string(bob::kAnnounceIdBytes - 1, 'x').c_str()));
}
