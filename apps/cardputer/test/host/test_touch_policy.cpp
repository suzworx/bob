// Touch policy (include/touch_policy.h): gesture recognition, the gesture-to-key table, the press and
// release framing, the on-screen keyboard layout. Pure logic; the panel and KeysState glue is in
// round_touch.cpp.
#include <cstdint>
#include <cstring>
#include <initializer_list>

#include "doctest.h"
#include "touch_policy.h"

using namespace bob::touch;

namespace {

constexpr uint32_t kPoll = 33;  // round_touch.cpp polls the panel at 30 Hz

// Two polls down, two polls up: the shortest touch the debounce accepts (see
// test_touch_policy_phantom.cpp). The gesture may complete on either release poll.
Event run(Recognizer& r, int16_t x0, int16_t y0, int16_t x1, int16_t y1, uint32_t ms) {
  CHECK(r.update(true, x0, y0, 1000).gesture == Gesture::kNone);
  CHECK(r.update(true, x1, y1, 1000 + ms / 2).gesture == Gesture::kNone);
  const Event first = r.update(false, x1, y1, 1000 + ms);
  const Event second = r.update(false, x1, y1, 1000 + ms + kPoll);
  CHECK((first.gesture == Gesture::kNone || second.gesture == Gesture::kNone));
  return first.gesture != Gesture::kNone ? first : second;
}

// Feeds one poll per character ('D' finger down, 'U' up), kPoll apart from t0, at a fixed point.
// Returns how many polls produced `g`; *firstAt is the poll index of the first one (-1 if none).
int feed(Recognizer& r, const char* polls, Gesture g, int* firstAt = nullptr, int* others = nullptr) {
  int n = 0;
  if (firstAt) *firstAt = -1;
  if (others) *others = 0;
  for (int i = 0; polls[i] != '\0'; ++i) {
    const Event e = r.update(polls[i] == 'D', 150, 150, 1000 + static_cast<uint32_t>(i) * kPoll);
    if (e.gesture == g) {
      if (n == 0 && firstAt) *firstAt = i;
      ++n;
    } else if (e.gesture != Gesture::kNone && others) {
      ++*others;
    }
  }
  return n;
}

ChipRect chip(int16_t x, const char* keys) {
  ChipRect c;
  c.x = x;
  c.y = 316;
  c.w = 50;
  c.h = 18;
  snprintf(c.keys, sizeof(c.keys), "%s", keys);
  return c;
}

Event at(Gesture g, int16_t x, int16_t y) { return Event{g, x, y}; }

}  // namespace

TEST_CASE("touch: a short press without travel is a tap at the touch-down point") {
  Recognizer r;
  const Event e = run(r, 120, 200, 124, 203, 150);
  CHECK(e.gesture == Gesture::kTap);
  CHECK(e.x == 120);
  CHECK(e.y == 200);
}

TEST_CASE("touch: quick drags are swipes along the dominant axis, slow drags are nothing") {
  Recognizer r;
  CHECK(run(r, 180, 250, 180, 150, 200).gesture == Gesture::kSwipeUp);
  CHECK(run(r, 180, 150, 180, 250, 200).gesture == Gesture::kSwipeDown);
  CHECK(run(r, 50, 200, 160, 210, 200).gesture == Gesture::kSwipeRight);
  CHECK(run(r, 200, 200, 90, 190, 200).gesture == Gesture::kSwipeLeft);
  CHECK(run(r, 180, 250, 180, 150, 900).gesture == Gesture::kNone);
  CHECK(run(r, 180, 200, 180, 200 - kSwipePx + 1, 200).gesture == Gesture::kTap);  // under the threshold
}

TEST_CASE("touch: a long press fires once while the finger is down and the release adds nothing") {
  Recognizer r;
  CHECK(r.update(true, 100, 100, 0).gesture == Gesture::kNone);
  CHECK(r.update(true, 101, 100, kLongPressMs - 1).gesture == Gesture::kNone);
  CHECK(r.update(true, 101, 100, kLongPressMs).gesture == Gesture::kLongPress);
  CHECK(r.update(true, 101, 100, kLongPressMs + 50).gesture == Gesture::kNone);
  CHECK(r.update(false, 101, 100, kLongPressMs + 100).gesture == Gesture::kNone);
}

TEST_CASE("touch: moving cancels a long press and marks the touch as moved") {
  Recognizer r;
  r.update(true, 100, 100, 0);
  r.update(true, 100, 100 + kSwipePx, 100);
  CHECK(r.moved());
  CHECK(r.update(true, 100, 100 + kSwipePx, kLongPressMs + 10).gesture == Gesture::kNone);
}

// --- Debounce (Waveshare phantom-touch loop, 2026-10-27): a press needs >= 2 consecutive down
// polls and a release >= 2 consecutive up polls. Prod: a flickering panel read restarted a
// hands-free turn every ~0.8 s for 100 turns.

TEST_CASE("touch: a panel that flickers down/up every poll for 2 s gives no gesture at all") {
  Recognizer r;
  char polls[62] = {};
  for (int i = 0; i < 61; ++i) polls[i] = i % 2 == 0 ? 'D' : 'U';  // 61 polls x 33 ms ~ 2 s
  int others = 0;
  CHECK(feed(r, polls, Gesture::kTap, nullptr, &others) == 0);
  CHECK(others == 0);  // no swipe, no long press either
}

TEST_CASE("touch: a one-poll press is noise, not a tap") {
  Recognizer r;
  CHECK(feed(r, "DUUUU", Gesture::kTap) == 0);
}

TEST_CASE("touch: a one-poll release blip inside a hold does not split it into two taps") {
  Recognizer r;
  int at = -1;
  CHECK(feed(r, "DDDDUDDDUUU", Gesture::kTap, &at) == 1);
  CHECK(at == 9);  // the second up poll of the real release
}

TEST_CASE("touch: a normal tap (4 polls down, 3 up) is exactly one tap at the touch-down point") {
  Recognizer r;
  CHECK(r.update(true, 120, 200, 1000).gesture == Gesture::kNone);
  int taps = 0;
  Event tap;
  const bool polls[] = {true, true, true, false, false, false};
  for (int i = 0; i < 6; ++i) {
    const Event e = r.update(polls[i], 122, 201, 1000 + static_cast<uint32_t>(i + 1) * kPoll);
    if (e.gesture == Gesture::kTap) { ++taps; tap = e; }
    else CHECK(e.gesture == Gesture::kNone);
  }
  CHECK(taps == 1);
  CHECK(tap.x == 120);  // anchored at the first down sample of the press
  CHECK(tap.y == 200);
}

namespace {
// A finger moving 60 px up, down samples every kPoll from t=0 until the first up sample at
// `firstUpMs`, then the confirming up sample at `confirmMs` (any samples between are kUnknown).
// Returns how many polls produced `g`; *others counts every other gesture.
int swipeUp(uint32_t firstUpMs, uint32_t confirmMs, Gesture g, int* others) {
  Recognizer r;
  int n = 0;
  *others = 0;
  auto tally = [&](const Event& e) {
    if (e.gesture == g) ++n;
    else if (e.gesture != Gesture::kNone) ++*others;
  };
  const uint32_t lastDown = (firstUpMs - 1) / kPoll * kPoll;
  for (uint32_t t = 0; t <= lastDown; t += kPoll) {
    tally(r.update(Sample::kDown, 180, static_cast<int16_t>(250 - 60 * t / lastDown), t));
  }
  tally(r.update(Sample::kUp, 180, 190, firstUpMs));
  for (uint32_t t = firstUpMs + kPoll; t < confirmMs; t += kPoll) tally(r.update(Sample::kUnknown, 0, 0, t));
  tally(r.update(Sample::kUp, 180, 190, confirmMs));
  return n;
}
}  // namespace

TEST_CASE("touch: a quick swipe released at 363 ms is still a swipe, even though the release is confirmed one poll later") {
  // The finger lifts at 363 ms (<= kSwipeMaxMs); the read at 396 fails, the release is confirmed at 429.
  int others = 0;
  CHECK(swipeUp(363, 429, Gesture::kSwipeUp, &others) == 1);
  CHECK(others == 0);
}

TEST_CASE("touch: a swipe whose finger lifts after 400 ms is a slow drag") {
  int others = 0;
  CHECK(swipeUp(420, 420 + kPoll, Gesture::kSwipeUp, &others) == 0);
  CHECK(others == 0);
}

TEST_CASE("touch: a swipe whose up sample arrives after a slow loop pass is still a swipe") {
  // The finger moves 120 px up over 0..297 ms, one down sample per poll. The loop pass then runs
  // slow (the volume HUD redraw), so no sample comes until the first up sample at 430 ms, confirmed
  // at 463. The finger was gone by the poll after 297 ms (330 ms), well inside kSwipeMaxMs.
  Recognizer r;
  for (uint32_t t = 0; t <= 297; t += kPoll) {
    const int16_t y = static_cast<int16_t>(250 - 120 * t / 300);
    CHECK(r.update(Sample::kDown, 180, y, t).gesture == Gesture::kNone);
  }
  const Event first = r.update(Sample::kUp, 180, 130, 430);
  const Event second = r.update(Sample::kUp, 180, 130, 463);
  const int swipes = (first.gesture == Gesture::kSwipeUp) + (second.gesture == Gesture::kSwipeUp);
  CHECK(swipes == 1);
  CHECK(first.gesture != Gesture::kTap);
  CHECK(second.gesture != Gesture::kTap);
}

TEST_CASE("touch: key names map to Cardputer keys") {
  bool go = true;
  Key k = keyFromName("Enter", 5, &go);
  CHECK(k.enter);
  CHECK_FALSE(go);
  CHECK(keyFromName("Tab", 3, &go).tab);
  k = keyFromName("Fn+`", 4, &go);
  CHECK(k.fn);
  CHECK(k.ch == '`');
  k = keyFromName(",", 1, &go);
  CHECK(k.ch == ',');
  CHECK_FALSE(k.fn);
  keyFromName("BOOT/tap", 8, &go);
  CHECK(go);
  CHECK(keyFromName("any key", 7, &go).enter);
  CHECK(keyFromName("bogus", 5, &go).empty());
}

TEST_CASE("touch: tapping a chip sends its key; two keys on one chip split left and right") {
  ChipRect chips[] = {chip(100, "c"), chip(160, "; ."), chip(220, "Fn+, Fn+/")};
  Context c;
  c.chips = chips;
  c.chipCount = 3;
  c.chipsVisible = true;
  Result r = mapGesture(at(Gesture::kTap, 120, 325), c);
  REQUIRE(r.count == 1);
  CHECK(r.keys[0].ch == 'c');
  r = mapGesture(at(Gesture::kTap, 170, 325), c);  // left half of "; ."
  REQUIRE(r.count == 1);
  CHECK(r.keys[0].ch == ';');
  r = mapGesture(at(Gesture::kTap, 205, 325), c);  // right half
  CHECK(r.keys[0].ch == '.');
  r = mapGesture(at(Gesture::kTap, 240, 325), c);  // Fn+,
  CHECK(r.keys[0].fn);
  CHECK(r.keys[0].ch == ',');
  r = mapGesture(at(Gesture::kTap, 120, 336), c);  // slop below the 18 px chip
  CHECK(r.count == 1);
  c.chipsVisible = false;
  CHECK(mapGesture(at(Gesture::kTap, 120, 325), c).count == 0);
}

TEST_CASE("touch: tapping a list row moves the selection there and presses Enter") {
  Context c;
  c.rows = Rows{true, 30, 300, 100, 30, 5, 2, 3};  // x, w, firstTop, rowH, visible, top, selection
  Result r = mapGesture(at(Gesture::kTap, 180, 100 + 30 * 3 + 5), c);  // row index 3 -> item 5, selection 3: two down
  REQUIRE(r.count == 3);
  CHECK(r.keys[0].ch == '.');
  CHECK(r.keys[1].ch == '.');
  CHECK(r.keys[2].enter);
  r = mapGesture(at(Gesture::kTap, 180, 135), c);  // row 1 -> item 3 = the selection: just Enter
  REQUIRE(r.count == 1);
  CHECK(r.keys[0].enter);
  c.rows.selection = 4;
  r = mapGesture(at(Gesture::kTap, 180, 105), c);  // up two
  REQUIRE(r.count == 3);
  CHECK(r.keys[0].ch == ';');
}

TEST_CASE("touch: swipes scroll, swipe right and long press go back, any-key screens take any tap") {
  Context c;
  CHECK(mapGesture(at(Gesture::kSwipeUp, 180, 200), c).keys[0].ch == ';');
  CHECK(mapGesture(at(Gesture::kSwipeDown, 180, 200), c).keys[0].ch == '.');
  CHECK(mapGesture(at(Gesture::kSwipeRight, 20, 200), c).keys[0].ch == '`');
  CHECK(mapGesture(at(Gesture::kSwipeLeft, 200, 200), c).count == 0);
  CHECK(mapGesture(at(Gesture::kLongPress, 180, 200), c).keys[0].ch == '`');
  CHECK(mapGesture(at(Gesture::kTap, 180, 200), c).count == 0);  // not a GO screen, not any-key: nothing
  c.anyKeyScreen = true;
  CHECK(mapGesture(at(Gesture::kTap, 180, 200), c).keys[0].enter);
  c.goScreen = true;  // READY: a long press shows the chips (intentFor), it is not back
  CHECK(mapGesture(at(Gesture::kLongPress, 180, 200), c).count == 0);
}

// --- The touch state machine: gesture -> intent (owner UX audit 2026-10-20, #1063) ---

namespace {
Where where(Screen s, bool onBob = false, bool infoOpen = false, bool onChip = false) {
  Where w;
  w.screen = s;
  w.onBob = onBob;
  w.infoOpen = infoOpen;
  w.onChip = onChip;
  return w;
}
}  // namespace

TEST_CASE("touch: on Ready a tap off Bob is GO (a hands-free turn), a tap on Bob is a giggle and the info view") {
  CHECK(intentFor(Gesture::kTap, where(Screen::kReady)).action == Action::kGo);
  CHECK(intentFor(Gesture::kTap, where(Screen::kReadyCard)).action == Action::kGo);
  const Intent bob = intentFor(Gesture::kTap, where(Screen::kReady, true));
  CHECK(bob.action == Action::kBobInfo);
  CHECK_FALSE(bob.revealChips);
  CHECK(intentFor(Gesture::kTap, where(Screen::kReadyCard, true)).action == Action::kBobInfo);
}

TEST_CASE("touch: a tap on Bob never means GO, mid-turn it is only a giggle") {
  for (Screen s : {Screen::kReady, Screen::kReadyCard, Screen::kTalk}) {
    const Action a = intentFor(Gesture::kTap, where(s, true)).action;
    CHECK(a != Action::kGo);
  }
  CHECK(intentFor(Gesture::kTap, where(Screen::kTalk, true)).action == Action::kBob);
  CHECK(intentFor(Gesture::kTap, where(Screen::kTalk)).action == Action::kGo);  // send now, stop and talk, close, retry
}

TEST_CASE("touch: the first touch never shows the chips; a swipe or a long press does") {
  for (Screen s : {Screen::kReady, Screen::kReadyCard, Screen::kTalk, Screen::kOther}) {
    CHECK_FALSE(intentFor(Gesture::kTap, where(s)).revealChips);
    CHECK(intentFor(Gesture::kLongPress, where(s)).revealChips);
    CHECK(intentFor(Gesture::kSwipeLeft, where(s)).revealChips);
  }
  CHECK(intentFor(Gesture::kSwipeUp, where(Screen::kReadyCard)).revealChips);
  // A long press is no longer push-to-talk on a GO screen: it only shows the chips.
  CHECK(intentFor(Gesture::kLongPress, where(Screen::kReady)).action == Action::kNone);
  CHECK(intentFor(Gesture::kLongPress, where(Screen::kTalk)).action == Action::kNone);
}

TEST_CASE("touch: swipe up / down on Ready is the volume; on the reply card it pages") {
  Intent up = intentFor(Gesture::kSwipeUp, where(Screen::kReady));
  CHECK(up.action == Action::kVolume);
  CHECK(up.volume == 1);
  CHECK_FALSE(up.revealChips);  // the volume arc answers it, not the chips
  Intent down = intentFor(Gesture::kSwipeDown, where(Screen::kReady));
  CHECK(down.action == Action::kVolume);
  CHECK(down.volume == -1);
  CHECK(intentFor(Gesture::kSwipeRight, where(Screen::kReady)).action == Action::kNone);
  CHECK(intentFor(Gesture::kSwipeUp, where(Screen::kReadyCard)).action == Action::kKeys);
  CHECK(intentFor(Gesture::kSwipeRight, where(Screen::kReadyCard)).action == Action::kKeys);  // ` closes the card
  CHECK(intentFor(Gesture::kSwipeDown, where(Screen::kTalk)).action == Action::kKeys);       // the live reply pages
}

TEST_CASE("touch: the info view stays until a tap or a swipe right closes it") {
  CHECK(intentFor(Gesture::kTap, where(Screen::kReady, false, true)).action == Action::kCloseInfo);
  CHECK(intentFor(Gesture::kTap, where(Screen::kReady, true, true)).action == Action::kCloseInfo);  // on Bob too
  CHECK(intentFor(Gesture::kSwipeRight, where(Screen::kReady, false, true)).action == Action::kCloseInfo);
  for (Gesture g : {Gesture::kSwipeUp, Gesture::kSwipeDown, Gesture::kSwipeLeft, Gesture::kLongPress, Gesture::kNone}) {
    const Intent i = intentFor(g, where(Screen::kReady, false, true));
    CHECK(i.action == Action::kNone);
    CHECK_FALSE(i.revealChips);
  }
}

TEST_CASE("touch: a visible chip keeps its key; lists, Settings and fields keep the key table") {
  CHECK(intentFor(Gesture::kTap, where(Screen::kReady, false, false, true)).action == Action::kKeys);
  CHECK(intentFor(Gesture::kTap, where(Screen::kOther)).action == Action::kKeys);
  CHECK(intentFor(Gesture::kSwipeUp, where(Screen::kOther)).action == Action::kKeys);
  Where field = where(Screen::kOther);
  field.keyboard = true;
  const Intent typed = intentFor(Gesture::kSwipeLeft, field);
  CHECK(typed.action == Action::kKeys);
  CHECK_FALSE(typed.revealChips);  // the keyboard owns the chip rows
  CHECK(intentFor(Gesture::kNone, where(Screen::kReady)).action == Action::kNone);
}

TEST_CASE("touch: field screens type, cancel with Fn+`, move the cursor with Fn+, and Fn+/") {
  Context c;
  c.keyboard = true;
  c.layer = KbLayer::kLower;
  CHECK(mapGesture(at(Gesture::kSwipeUp, 180, 200), c).count == 0);  // ; and . are characters here
  Result r = mapGesture(at(Gesture::kLongPress, 180, 150), c);
  REQUIRE(r.count == 1);
  CHECK(r.keys[0].fn);
  CHECK(r.keys[0].ch == '`');
  r = mapGesture(at(Gesture::kSwipeLeft, 200, 150), c);
  CHECK(r.keys[0].fn);
  CHECK(r.keys[0].ch == ',');
  r = mapGesture(at(Gesture::kSwipeRight, 100, 150), c);
  CHECK(r.keys[0].ch == '/');
}

TEST_CASE("touch: every on-screen key is at least 28 px and inside the circle") {
  for (KbLayer layer : {KbLayer::kLower, KbLayer::kUpper, KbLayer::kSymbols, KbLayer::kDigits}) {
    int keys = 0;
    kbForEach(layer, [&](const KbRect& r, KbKind, char) {
      ++keys;
      CHECK(r.w >= 28);
      CHECK(r.h >= 28);
      for (int16_t px : {r.x, static_cast<int16_t>(r.x + r.w)}) {
        for (int16_t py : {r.y, static_cast<int16_t>(r.y + r.h)}) {
          const int dx = px - 180, dy = py - 180;
          CHECK(dx * dx + dy * dy <= 180 * 180);
        }
      }
    });
    CHECK(keys > 8);
  }
}

TEST_CASE("touch: the keyboard maps hits to characters, Del, Enter, shift and the layer key") {
  Context c;
  c.keyboard = true;
  KbRect q{}, del{}, enter{}, shift{}, layerKey{}, nine{};
  kbForEach(KbLayer::kLower, [&](const KbRect& r, KbKind kind, char ch) {
    if (kind == KbKind::kChar && ch == 'q') q = r;
    if (kind == KbKind::kDel) del = r;
    if (kind == KbKind::kEnter) enter = r;
    if (kind == KbKind::kShift) shift = r;
    if (kind == KbKind::kLayer) layerKey = r;
  });
  auto tap = [&](const KbRect& r) { return mapGesture(at(Gesture::kTap, r.x + r.w / 2, r.y + r.h / 2), c); };
  CHECK(tap(q).keys[0].ch == 'q');
  CHECK(tap(del).keys[0].del);
  CHECK(tap(enter).keys[0].enter);
  CHECK(tap(shift).shiftToggle);
  CHECK(tap(layerKey).layerToggle);
  c.layer = KbLayer::kDigits;
  kbForEach(KbLayer::kDigits, [&](const KbRect& r, KbKind kind, char ch) {
    if (kind == KbKind::kChar && ch == '9') nine = r;
  });
  CHECK(tap(nine).keys[0].ch == '9');
  int letters = 0;
  kbForEach(KbLayer::kDigits, [&](const KbRect&, KbKind kind, char ch) {
    if (kind == KbKind::kChar) {
      ++letters;
      CHECK(ch >= '0');
      CHECK(ch <= '9');
    }
  });
  CHECK(letters == 10);
}

TEST_CASE("touch: framing sends a press then an empty release per key, so two taps are two presses") {
  KeyFramer f;
  Key a, b;
  a.ch = ',';
  b.ch = ',';
  f.push(a);
  f.push(b);
  Key frame;
  bool press = false;
  REQUIRE(f.next(&frame, &press));
  CHECK(press);
  CHECK(frame.ch == ',');
  REQUIRE(f.next(&frame, &press));
  CHECK_FALSE(press);
  CHECK(frame.empty());
  REQUIRE(f.next(&frame, &press));
  CHECK(press);
  CHECK(frame.ch == ',');
  REQUIRE(f.next(&frame, &press));
  CHECK_FALSE(press);
  CHECK_FALSE(f.next(&frame, &press));
  CHECK(f.pending() == 0);
}

TEST_CASE("touch: the framer drops keys beyond its capacity instead of overrunning") {
  KeyFramer f;
  Key k;
  k.ch = 'a';
  for (size_t i = 0; i < KeyFramer::kCapacity; ++i) CHECK(f.push(k));
  CHECK_FALSE(f.push(k));
}

TEST_CASE("touch: late batch - samples taken every poll but replayed in one burst after a render pass are one swipe") {
  // The sampler task reads the panel every kPollMs; poll() replays the queue after a ~130 ms render pass with each
  // sample's own timestamp. The Recognizer is time-pure, so a burst gives the same answer as live feeding.
  Recognizer r;
  int swipes = 0, others = 0;
  auto tally = [&](const Event& e) {
    if (e.gesture == Gesture::kSwipeUp) ++swipes;
    else if (e.gesture != Gesture::kNone) ++others;
  };
  for (uint32_t t = 0; t <= 297; t += kPoll) tally(r.update(Sample::kDown, 180, static_cast<int16_t>(250 - 120 * t / 300), t));
  tally(r.update(Sample::kUp, 180, 130, 330));
  tally(r.update(Sample::kUp, 180, 130, 363));
  CHECK(swipes == 1);
  CHECK(others == 0);
}

TEST_CASE("touch: late batch - the starved loop-only read of the same swipe was a tap") {
  // The shape the loop-only read produced (issue #1374): one reading per render pass, so a 300 ms swipe left
  // two down readings ~30 px apart (< kSwipePx), then the up readings. That is a tap, which is why the sampler exists.
  Recognizer r;
  CHECK(r.update(Sample::kDown, 180, 250, 0).gesture == Gesture::kNone);
  CHECK(r.update(Sample::kDown, 180, 220, 132).gesture == Gesture::kNone);
  const Event first = r.update(Sample::kUp, 180, 220, 264);
  const Event second = r.update(Sample::kUp, 180, 220, 297);
  CHECK((first.gesture == Gesture::kTap || second.gesture == Gesture::kTap));
}

TEST_CASE("touch: GapMeter tracks the largest gap between consecutive samples since the last reset") {
  GapMeter g;
  CHECK(g.maxMs() == 0);
  g.add(100);
  CHECK(g.maxMs() == 0);  // one sample has no gap
  g.add(133);
  g.add(166);
  g.add(300);
  g.add(333);
  CHECK(g.maxMs() == 134);
  g.reset();
  CHECK(g.maxMs() == 0);
  g.add(1000);
  g.add(1033);
  CHECK(g.maxMs() == 33);
}

TEST_CASE("touch: idle up samples - the sampler queues only the two ups the release debounce needs") {
  IdleFilter f;
  CHECK(f.shouldQueue(Sample::kDown));
  CHECK(f.shouldQueue(Sample::kUp));
  CHECK(f.shouldQueue(Sample::kUp));
  CHECK_FALSE(f.shouldQueue(Sample::kUp));
  CHECK_FALSE(f.shouldQueue(Sample::kUp));
  CHECK(f.shouldQueue(Sample::kDown));
  CHECK(f.shouldQueue(Sample::kUp));
  CHECK(f.shouldQueue(Sample::kUp));
  CHECK(f.shouldQueue(Sample::kUnknown));  // a failed read is never filtered
  CHECK(f.shouldQueue(Sample::kUp));
}

TEST_CASE("touch: idle filter full queue - an up the queue rejected does not count as queued") {
  IdleFilter f;
  CHECK(f.shouldQueue(Sample::kDown));
  CHECK(f.shouldQueue(Sample::kUp));
  f.dropped();
  CHECK(f.shouldQueue(Sample::kUp));
  f.dropped();
  CHECK(f.shouldQueue(Sample::kUp));  // still wanted: the loop has seen no up yet
  CHECK(f.shouldQueue(Sample::kUp));
  CHECK_FALSE(f.shouldQueue(Sample::kUp));
}
