// Waveshare phantom-touch loop (prod journal, waveshare-s3-185c, 2026-10-27 22:27-22:29Z): a failed
// or flickering CST816 read looked like press -> release = tap, so touchGo() ended, cancelled and
// restarted a hands-free turn every ~0.8 s, 100 turns, never replying.
//
// API the fix provides in include/touch_policy.h (namespace bob::touch):
//
//   enum class Sample : uint8_t { kUp, kDown, kUnknown };
//     One panel poll. kUnknown = the read failed: it keeps the last state, never counts as a
//     release (or a press), and neither starts nor breaks a debounce run.
//   Event Recognizer::update(Sample s, int16_t x, int16_t y, uint32_t nowMs);
//     The bool overload stays: update(down, ...) == update(down ? kDown : kUp, ...).
//     A press is accepted after >= 2 consecutive kDown polls, a release after >= 2 consecutive kUp
//     polls; the press is anchored (x0, y0, t0) at the FIRST kDown sample of its run.
//     ws185::touchPoint must report a failed I2C read as kUnknown (round_touch.cpp feeds it).
//
//   constexpr int16_t kPanelPx = 360;  // the 1.85C panel is 360 x 360
//   Sample decodeCst816(const uint8_t raw[5], int16_t* x, int16_t* y);
//     The CST816 decode, pulled out of ws185::touchPoint. raw = registers 0x02..0x06: finger count
//     (low nibble of raw[0]), x = ((raw[1] & 0x0F) << 8) | raw[2], y = ((raw[3] & 0x0F) << 8) | raw[4].
//     kUp for 0 fingers; kDown (and *x, *y written) for exactly 1 finger with x, y < kPanelPx;
//     kUnknown for any other finger count, an out-of-range x or y, or an all-0xFF read. The live
//     capture showed every phantom tap as action=go off Bob: garbage coordinates.
//     ws185::touchPoint returns kUnknown for a failed I2C read and decodeCst816(raw) otherwise.
//
//   class GoLoopBreaker {
//    public:
//     static constexpr uint8_t kMaxEmptyTurns = 3;    // empty touch turns in a row ...
//     static constexpr uint32_t kEmptyTurnMs = 3000;  // ... each ended (no speech) within this
//     static constexpr uint32_t kHoldOffMs = 5000;    // ... stop tap-to-go for this long
//     void turnEnded(bool byTouch, bool heardSpeech, uint32_t startedMs, uint32_t endedMs);
//     bool goAllowed(uint32_t nowMs) const;
//   };
//     Empty = byTouch && !heardSpeech && endedMs - startedMs < kEmptyTurnMs. Any other touch turn
//     resets the count; turns not started by touch leave it alone. The third empty turn in a row
//     blocks GO for kHoldOffMs from its end; when the window lapses the count starts again at zero.
//     state_turn.cpp asks goAllowed() in touchGo() and reports turnEnded() as a turn finishes.
#include <cstdint>

#include "doctest.h"
#include "touch_policy.h"

using namespace bob::touch;

namespace {

constexpr uint32_t kPoll = 33;

// One poll per character: 'D' down, 'U' up, '?' a failed read. Counts taps; *firstAt is the poll
// index of the first tap, *others counts any other gesture.
int feed(Recognizer& r, const char* polls, int* firstAt = nullptr, int* others = nullptr) {
  int taps = 0;
  if (firstAt) *firstAt = -1;
  if (others) *others = 0;
  for (int i = 0; polls[i] != '\0'; ++i) {
    const Sample s = polls[i] == 'D' ? Sample::kDown : polls[i] == 'U' ? Sample::kUp : Sample::kUnknown;
    const Event e = r.update(s, 150, 150, 1000 + static_cast<uint32_t>(i) * kPoll);
    if (e.gesture == Gesture::kTap) {
      if (taps == 0 && firstAt) *firstAt = i;
      ++taps;
    } else if (e.gesture != Gesture::kNone && others) {
      ++*others;
    }
  }
  return taps;
}

// One empty hands-free turn like the incident's: started by a tap, no speech, ~0.8 s long.
uint32_t emptyTouchTurn(GoLoopBreaker& b, uint32_t startMs) {
  const uint32_t end = startMs + 800;
  b.turnEnded(true, false, startMs, end);
  return end;
}

}  // namespace

TEST_CASE("touch phantom: a failed read in the middle of a press is not a release") {
  Recognizer r;
  int at = -1, others = 0;
  CHECK(feed(r, "DDDD?DDDUU", &at, &others) == 1);
  CHECK(at == 9);  // only at the real release, never at the failed read (poll 4)
  CHECK(others == 0);
}

TEST_CASE("touch phantom: a run of failed reads while the finger is down keeps the press") {
  Recognizer r;
  int at = -1;
  CHECK(feed(r, "DDD????DUU", &at) == 1);
  CHECK(at == 9);
  CHECK_FALSE(r.down());
}

TEST_CASE("touch phantom: failed reads with no finger are nothing") {
  Recognizer r;
  int others = 0;
  CHECK(feed(r, "?U?U??U?", nullptr, &others) == 0);
  CHECK(others == 0);
  CHECK_FALSE(r.down());
}

TEST_CASE("touch phantom: a panel cycling down / failed read / up for 2 s gives no gesture") {
  Recognizer r;
  char polls[61] = {};
  for (int i = 0; i < 60; ++i) polls[i] = "D?U"[i % 3];  // no two downs in a row: never a press
  int others = 0;
  CHECK(feed(r, polls, nullptr, &others) == 0);
  CHECK(others == 0);
}

TEST_CASE("touch phantom: the tri-state sample still taps, swipes and long-presses") {
  Recognizer r;
  CHECK(feed(r, "DDDDUUU") == 1);
  // swipe up: two downs travelling 100 px in 66 ms, then a held release
  CHECK(r.update(Sample::kDown, 180, 250, 5000).gesture == Gesture::kNone);
  CHECK(r.update(Sample::kDown, 180, 150, 5000 + kPoll).gesture == Gesture::kNone);
  const Event a = r.update(Sample::kUp, 180, 150, 5000 + 2 * kPoll);
  const Event b = r.update(Sample::kUp, 180, 150, 5000 + 3 * kPoll);
  CHECK((a.gesture == Gesture::kSwipeUp || b.gesture == Gesture::kSwipeUp));
  // long press: held past kLongPressMs, a failed read on the way does not reset it
  Recognizer l;
  CHECK(l.update(Sample::kDown, 100, 100, 0).gesture == Gesture::kNone);
  CHECK(l.update(Sample::kDown, 100, 100, kPoll).gesture == Gesture::kNone);
  CHECK(l.update(Sample::kUnknown, 0, 0, kLongPressMs / 2).gesture == Gesture::kNone);
  CHECK(l.update(Sample::kDown, 100, 100, kLongPressMs).gesture == Gesture::kLongPress);
}

TEST_CASE("go loop breaker: three empty tap-started turns stop tap-to-go until the window passes") {
  GoLoopBreaker b;
  CHECK(b.goAllowed(0));
  uint32_t t = emptyTouchTurn(b, 1000);
  CHECK(b.goAllowed(t));
  t = emptyTouchTurn(b, t);
  CHECK(b.goAllowed(t));
  t = emptyTouchTurn(b, t);
  CHECK_FALSE(b.goAllowed(t));
  CHECK_FALSE(b.goAllowed(t + GoLoopBreaker::kHoldOffMs - 1));
  CHECK(b.goAllowed(t + GoLoopBreaker::kHoldOffMs));
}

TEST_CASE("go loop breaker: after the window the count starts again, one more empty turn is allowed") {
  GoLoopBreaker b;
  uint32_t t = 1000;
  for (int i = 0; i < 3; ++i) t = emptyTouchTurn(b, t);
  t += GoLoopBreaker::kHoldOffMs;
  REQUIRE(b.goAllowed(t));
  t = emptyTouchTurn(b, t);
  CHECK(b.goAllowed(t));
}

TEST_CASE("go loop breaker: a turn with speech resets the count") {
  GoLoopBreaker b;
  uint32_t t = emptyTouchTurn(b, 1000);
  t = emptyTouchTurn(b, t);
  b.turnEnded(true, true, t, t + 800);  // the user spoke
  t += 800;
  t = emptyTouchTurn(b, t);
  t = emptyTouchTurn(b, t);
  CHECK(b.goAllowed(t));
  t = emptyTouchTurn(b, t);
  CHECK_FALSE(b.goAllowed(t));
}

TEST_CASE("go loop breaker: slow silent turns and turns not started by touch are not empty taps") {
  GoLoopBreaker b;
  uint32_t t = 1000;
  for (int i = 0; i < 3; ++i, t += GoLoopBreaker::kEmptyTurnMs) {
    b.turnEnded(true, false, t, t + GoLoopBreaker::kEmptyTurnMs);  // a real wait for speech
  }
  CHECK(b.goAllowed(t));
  GoLoopBreaker w;
  t = emptyTouchTurn(w, 1000);
  t = emptyTouchTurn(w, t);
  w.turnEnded(false, false, t, t + 800);  // a wake-word turn
  t += 800;
  CHECK(w.goAllowed(t));
}

TEST_CASE("cst816 decode: only one finger inside the panel is a press; garbage is unknown, not up") {
  int16_t x = -1, y = -1;
  const uint8_t ff[5] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF};  // a bus read of a floating line
  CHECK(decodeCst816(ff, &x, &y) == Sample::kUnknown);
  const uint8_t wideX[5] = {0x01, 0x01, 0xF4, 0x00, 0x64};  // x = 500, y = 100
  CHECK(decodeCst816(wideX, &x, &y) == Sample::kUnknown);
  const uint8_t wideY[5] = {0x01, 0x00, 0x64, 0x01, 0x68};  // x = 100, y = 360
  CHECK(decodeCst816(wideY, &x, &y) == Sample::kUnknown);
  const uint8_t twoFingers[5] = {0x02, 0x00, 0x64, 0x00, 0x64};
  CHECK(decodeCst816(twoFingers, &x, &y) == Sample::kUnknown);
  const uint8_t none[5] = {0x00, 0x00, 0x00, 0x00, 0x00};
  CHECK(decodeCst816(none, &x, &y) == Sample::kUp);
  const uint8_t one[5] = {0x01, 0x01, 0x2C, 0x00, 0xC8};  // x = 300, y = 200
  REQUIRE(decodeCst816(one, &x, &y) == Sample::kDown);
  CHECK(x == 300);
  CHECK(y == 200);
  CHECK(kPanelPx == 360);
}
