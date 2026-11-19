// Touch input for the Waveshare round screen, as pure logic (host-tested, no I/O): a gesture
// recognizer over finger samples, and the table that turns a gesture into the Cardputer key it
// stands for. round_touch.cpp feeds it the panel and the screen context and turns the result into
// the Keyboard_Class::KeysState the existing dispatchers already read, so no state logic changes.
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace bob {
namespace touch {

constexpr int16_t kSwipePx = 40;        // travel that makes a swipe (and cancels a tap or a GO hold)
constexpr uint32_t kSwipeMaxMs = 400;   // a swipe is a quick move
constexpr uint32_t kLongPressMs = 600;  // stationary this long = long press
constexpr uint32_t kPollMs = 33;        // the panel is sampled by a task (round_touch.cpp) every kPollMs: 30 Hz

enum class Gesture : uint8_t { kNone, kTap, kLongPress, kSwipeUp, kSwipeDown, kSwipeLeft, kSwipeRight };

struct Event {
  Gesture gesture;
  int16_t x, y;  // where the finger first touched
  Event(Gesture g = Gesture::kNone, int16_t px = 0, int16_t py = 0) : gesture(g), x(px), y(py) {}
};

// One panel poll. kUnknown = the read failed or was garbage: it keeps the last state, is neither a
// press nor a release, and neither starts nor breaks a run of samples.
enum class Sample : uint8_t { kUp, kDown, kUnknown };

// One call per touch poll. Returns an event when a gesture completes: a long press fires once while
// the finger is still down, everything else on release. A press needs 2 consecutive down samples
// (anchored at the first) and a release 2 consecutive up samples, so a flickering panel is no tap.
class Recognizer {
 public:
  Event update(bool down, int16_t x, int16_t y, uint32_t nowMs) { return update(down ? Sample::kDown : Sample::kUp, x, y, nowMs); }

  Event update(Sample s, int16_t x, int16_t y, uint32_t nowMs) {
    Event out;
    if (s == Sample::kUnknown) return out;
    if (s == Sample::kDown) {
      upRun_ = 0;
      lastDownMs_ = nowMs;
      if (downRun_ == 0) {
        cx_ = x;
        cy_ = y;
        ct_ = nowMs;
      }
      if (downRun_ < 2) ++downRun_;
      if (!down_ && downRun_ >= 2) {
        down_ = true;
        longFired_ = false;
        x0_ = cx_;
        y0_ = cy_;
        t0_ = ct_;
      }
      if (!down_) return out;
      x_ = x;
      y_ = y;
      if (!longFired_ && !moved() && static_cast<uint32_t>(nowMs - t0_) >= kLongPressMs) {
        longFired_ = true;
        out = Event{Gesture::kLongPress, x0_, y0_};
      }
      return out;
    }
    downRun_ = 0;
    if (upRun_ == 0) ut_ = nowMs;  // the finger lifted at the first up sample, not at the confirming one
    if (!down_ || ++upRun_ < 2) return out;
    upRun_ = 0;
    down_ = false;
    if (longFired_) return out;
    const int dx = x_ - x0_, dy = y_ - y0_;
    const int adx = dx < 0 ? -dx : dx, ady = dy < 0 ? -dy : dy;
    // A slow loop pass delays the first up sample, not the finger: it was gone by the next regular poll
    // after its last down sample, so the lift is never later than that.
    uint32_t dt = static_cast<uint32_t>(ut_ - t0_);
    const uint32_t dtLast = static_cast<uint32_t>(lastDownMs_ - t0_) + kPollMs;
    if (dtLast < dt) dt = dtLast;
    if (adx >= kSwipePx || ady >= kSwipePx) {
      if (dt > kSwipeMaxMs) return out;  // a slow drag is nothing
      const Gesture g = adx >= ady ? (dx > 0 ? Gesture::kSwipeRight : Gesture::kSwipeLeft)
                                   : (dy > 0 ? Gesture::kSwipeDown : Gesture::kSwipeUp);
      return Event{g, x0_, y0_};
    }
    return Event{Gesture::kTap, x0_, y0_};
  }

  bool down() const { return down_; }
  bool moved() const {
    const int dx = x_ - x0_, dy = y_ - y0_;
    return (dx < 0 ? -dx : dx) >= kSwipePx || (dy < 0 ? -dy : dy) >= kSwipePx;
  }
  int16_t startX() const { return x0_; }
  int16_t startY() const { return y0_; }

 private:
  bool down_ = false, longFired_ = false;
  uint8_t downRun_ = 0, upRun_ = 0;
  int16_t x0_ = 0, y0_ = 0, x_ = 0, y_ = 0, cx_ = 0, cy_ = 0;
  uint32_t t0_ = 0, ct_ = 0, ut_ = 0, lastDownMs_ = 0;
};

// The largest gap between consecutive sample timestamps since reset(): ~kPollMs when the sampler task runs
// on time, far more when it starved. round_touch.cpp journals it per gesture (gap_ms).
class GapMeter {
 public:
  void reset() { has_ = false; max_ = 0; }
  void add(uint32_t ms) {
    if (has_ && static_cast<uint32_t>(ms - last_) > max_) max_ = static_cast<uint32_t>(ms - last_);
    last_ = ms;
    has_ = true;
  }
  uint32_t maxMs() const { return max_; }

 private:
  bool has_ = false;
  uint32_t last_ = 0, max_ = 0;
};

// Which samples the sampler task queues: every down / unknown, but an up only while fewer than two have been queued
// since the last non-up (the Recognizer's release debounce needs two). An idle panel then never fills the queue.
class IdleFilter {
 public:
  bool shouldQueue(Sample s) {
    if (s != Sample::kUp) { ups_ = 0; return true; }
    if (ups_ >= 2) return false;
    ++ups_;
    return true;
  }
  // The queue rejected an up shouldQueue() approved: the loop never saw it, so it must not count.
  void dropped() { if (ups_ > 0) --ups_; }

 private:
  uint8_t ups_ = 0;
};

constexpr int16_t kPanelPx = 360;  // the 1.85C panel is 360 x 360

// CST816 registers 0x02..0x06: one finger inside the panel is a press, no finger is up, anything else
// (two fingers, a coordinate off the panel, a floating-bus 0xFF read) is unknown, not a release.
inline Sample decodeCst816(const uint8_t raw[5], int16_t* x, int16_t* y) {
  const uint8_t fingers = raw[0] & 0x0F;
  if (fingers == 0) return Sample::kUp;
  const int px = ((raw[1] & 0x0F) << 8) | raw[2], py = ((raw[3] & 0x0F) << 8) | raw[4];
  if (fingers != 1 || px >= kPanelPx || py >= kPanelPx) return Sample::kUnknown;
  *x = static_cast<int16_t>(px);
  *y = static_cast<int16_t>(py);
  return Sample::kDown;
}

// Stops a self-sustaining tap-to-go loop: kMaxEmptyTurns touch-started turns in a row that ended with
// no speech within kEmptyTurnMs block tap-to-go for kHoldOffMs.
class GoLoopBreaker {
 public:
  static constexpr uint8_t kMaxEmptyTurns = 3;
  static constexpr uint32_t kEmptyTurnMs = 3000;
  static constexpr uint32_t kHoldOffMs = 5000;
  void turnEnded(bool byTouch, bool heardSpeech, uint32_t startedMs, uint32_t endedMs) {
    if (!byTouch) return;
    if (heardSpeech || static_cast<uint32_t>(endedMs - startedMs) >= kEmptyTurnMs) {
      empty_ = 0;
      return;
    }
    if (++empty_ >= kMaxEmptyTurns) {
      holdUntil_ = endedMs + kHoldOffMs;
      held_ = true;
      empty_ = 0;
    }
  }
  bool goAllowed(uint32_t nowMs) const { return !held_ || static_cast<int32_t>(nowMs - holdUntil_) >= 0; }

 private:
  uint8_t empty_ = 0;
  bool held_ = false;
  uint32_t holdUntil_ = 0;
};

// One Cardputer key as the dispatchers see it: a character in KeysState.word and/or a flag.
struct Key {
  char ch = 0;
  bool enter = false, del = false, tab = false, fn = false, space = false;
  bool empty() const { return ch == 0 && !enter && !del && !tab && !fn && !space; }
};

// Press frame then release frame, one pair per key, exactly like the HIL console's
// testPressAndRelease: Settings counts a key on its press edge, so two taps must be two presses.
class KeyFramer {
 public:
  static constexpr size_t kCapacity = 24;
  bool push(const Key& key) {
    if (count_ >= kCapacity) return false;
    keys_[(head_ + count_++) % kCapacity] = key;
    return true;
  }
  // The next frame: the key being pressed, or an empty key as its release. False when idle.
  bool next(Key* frame, bool* isPress) {
    if (releasePending_) {
      releasePending_ = false;
      *frame = Key();
      *isPress = false;
      return true;
    }
    if (count_ == 0) return false;
    *frame = keys_[head_];
    head_ = (head_ + 1) % kCapacity;
    --count_;
    releasePending_ = true;
    *isPress = true;
    return true;
  }
  size_t pending() const { return count_; }

 private:
  Key keys_[kCapacity];
  size_t head_ = 0, count_ = 0;
  bool releasePending_ = false;
};

// --- Shortcut chips ("[key] label" markup): key names to keys ----------------------------------

// One chip token as the strip text names it: "Enter", "Tab", "Del", "`", ";", "Fn+`", "c", ...
// "BOOT/tap" is GO (BtnA), reported through *go. "any key" is Enter (Enter does no usual job on the
// screens that advertise it). Unknown names give an empty key.
inline Key keyFromName(const char* name, size_t len, bool* go) {
  Key k;
  *go = false;
  if (len == 8 && strncmp(name, "BOOT/tap", 8) == 0) { *go = true; return k; }
  if (len == 7 && strncmp(name, "any key", 7) == 0) { k.enter = true; return k; }
  if (len == 5 && strncmp(name, "Enter", 5) == 0) { k.enter = true; return k; }
  if (len == 3 && strncmp(name, "Tab", 3) == 0) { k.tab = true; return k; }
  if (len == 3 && strncmp(name, "Del", 3) == 0) { k.del = true; return k; }
  if (len == 5 && strncmp(name, "Space", 5) == 0) { k.space = true; return k; }
  if (len == 4 && strncmp(name, "Fn+", 3) == 0) { k.fn = true; k.ch = name[3]; return k; }
  if (len == 1) k.ch = name[0];
  return k;
}

struct ChipRect {
  int16_t x = 0, y = 0, w = 0, h = 0;
  char keys[12] = "";  // RoundChip::key: one key, or two that share a chip ("; .")
};

// A list screen (picker, settings list): row i is the rect starting at firstTop + i * rowH.
struct Rows {
  bool active;
  int16_t x, w, firstTop, rowH;
  uint8_t visible, top, selection;  // visible rows, first shown index, selected index
  Rows(bool a = false, int16_t px = 0, int16_t pw = 0, int16_t top0 = 0, int16_t h = 0, uint8_t vis = 0, uint8_t t = 0, uint8_t sel = 0)
      : active(a), x(px), w(pw), firstTop(top0), rowH(h), visible(vis), top(t), selection(sel) {}
};

// --- On-screen keyboard (field screens) -----------------------------------------------------
enum class KbLayer : uint8_t { kLower, kUpper, kSymbols, kDigits };
enum class KbKind : uint8_t { kNone, kChar, kShift, kLayer, kSpace, kDel, kEnter };
struct KbRect {
  int16_t x, y, w, h;
};
struct KbHit {
  KbKind kind;
  char ch;
  KbHit(KbKind k = KbKind::kNone, char c = 0) : kind(k), ch(c) {}
};

constexpr int16_t kKbTop = 204, kKbPitch = 28, kKbCenterX = 180;  // 28 px hit targets, rows 204..316

inline const char* kbRowChars(KbLayer layer, int row) {
  static const char* const kLower[] = {"qwertyuiop", "asdfghjkl", "zxcvbnm"};
  static const char* const kUpper[] = {"QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"};
  static const char* const kSymbols[] = {"1234567890", "-/:;()&@\"", ".,?!'_~=#"};
  static const char* const kDigits[] = {"12345", "67890", ""};
  const char* const* rows = layer == KbLayer::kLower ? kLower : layer == KbLayer::kUpper ? kUpper : layer == KbLayer::kSymbols ? kSymbols : kDigits;
  return row >= 0 && row < 3 ? rows[row] : "";
}

// Calls f(rect, kind, ch) for every key of the layer, rows top to bottom. Drawing and hit testing
// both use this, so they cannot disagree.
template <class F>
void kbForEach(KbLayer layer, F f) {
  int row = 0;
  for (; row < 3; ++row) {
    const char* chars = kbRowChars(layer, row);
    const int n = static_cast<int>(strlen(chars));
    if (n == 0) continue;
    int16_t x = kKbCenterX - n * kKbPitch / 2;
    for (int i = 0; i < n; ++i, x += kKbPitch) f(KbRect{x, static_cast<int16_t>(kKbTop + row * kKbPitch), kKbPitch, kKbPitch}, KbKind::kChar, chars[i]);
  }
  const int16_t y = kKbTop + 3 * kKbPitch;
  if (layer == KbLayer::kDigits) {  // a port: digits, Del, Enter
    f(KbRect{static_cast<int16_t>(kKbCenterX - 60), y, 60, kKbPitch}, KbKind::kDel, 0);
    f(KbRect{kKbCenterX, y, 60, kKbPitch}, KbKind::kEnter, 0);
    return;
  }
  int16_t x = kKbCenterX - 96;  // [layer 30][shift 30][space 60][Del 34][Enter 38] = 192
  f(KbRect{x, y, 30, kKbPitch}, KbKind::kLayer, 0);
  x += 30;
  f(KbRect{x, y, 30, kKbPitch}, KbKind::kShift, 0);
  x += 30;
  f(KbRect{x, y, 60, kKbPitch}, KbKind::kSpace, ' ');
  x += 60;
  f(KbRect{x, y, 34, kKbPitch}, KbKind::kDel, 0);
  x += 34;
  f(KbRect{x, y, 38, kKbPitch}, KbKind::kEnter, 0);
}

inline KbHit kbHitAt(KbLayer layer, int16_t px, int16_t py) {
  KbHit hit;
  kbForEach(layer, [&](const KbRect& r, KbKind kind, char ch) {
    if (hit.kind == KbKind::kNone && px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) hit = KbHit{kind, ch};
  });
  return hit;
}

// --- Gesture -> keys ----------------------------------------------------------------------------

// What is on screen right now; round_touch.cpp fills it from round_ui each poll.
struct Context {
  const ChipRect* chips = nullptr;
  size_t chipCount = 0;
  bool chipsVisible = false;  // chips that are hidden cannot be tapped
  Rows rows;
  bool goScreen = false;      // READY, HELP, ANNOUNCE, AWAITING: a long press is not back (it shows the chips)
  bool anyKeyScreen = false;  // the screen says "[any key]": any tap
  bool keyboard = false;      // a field screen with the on-screen keyboard
  KbLayer layer = KbLayer::kLower;
};

struct Result {
  Key keys[KeyFramer::kCapacity];
  size_t count = 0;
  bool shiftToggle = false, layerToggle = false;  // keyboard-local state, owned by round_keyboard.cpp
  void add(const Key& k) {
    if (count < KeyFramer::kCapacity) keys[count++] = k;
  }
};

constexpr int16_t kChipSlop = 6;      // chips are 18 px tall: the hit area grows to a finger
constexpr int16_t kKbBottom = kKbTop + 4 * kKbPitch;

inline bool inside(int16_t x, int16_t y, int16_t rx, int16_t ry, int16_t rw, int16_t rh, int16_t slop = 0) {
  return x >= rx - slop && x < rx + rw + slop && y >= ry - slop && y < ry + rh + slop;
}

inline Key backKey(const Context& c) {
  Key k;
  k.ch = '`';
  k.fn = c.keyboard;  // inside a field, a plain ` is a character: cancel is Fn+`
  return k;
}

inline void tapChip(const ChipRect& chip, int16_t x, Result* out) {
  char tokens[2][12];
  size_t n = 0;
  if (strcmp(chip.keys, "any key") == 0) {
    snprintf(tokens[0], sizeof(tokens[0]), "any key");
    n = 1;
  } else {
    const char* p = chip.keys;
    while (*p != '\0' && n < 2) {
      const char* end = strchr(p, ' ');
      const size_t len = end ? static_cast<size_t>(end - p) : strlen(p);
      snprintf(tokens[n++], sizeof(tokens[0]), "%.*s", static_cast<int>(len < 11 ? len : 11), p);
      p += len;
      while (*p == ' ') ++p;
    }
  }
  if (n == 0) return;
  int idx = chip.w > 0 ? (x - chip.x) * static_cast<int>(n) / chip.w : 0;  // two keys share a chip: left half, right half
  idx = idx < 0 ? 0 : idx >= static_cast<int>(n) ? static_cast<int>(n) - 1 : idx;
  bool go = false;
  const Key k = keyFromName(tokens[idx], strlen(tokens[idx]), &go);
  if (!k.empty()) out->add(k);
}

inline Result mapGesture(const Event& e, const Context& c) {
  Result out;
  switch (e.gesture) {
    case Gesture::kTap: {
      if (c.keyboard && e.y < kKbBottom) {
        const KbHit hit = kbHitAt(c.layer, e.x, e.y);
        Key k;
        switch (hit.kind) {
          case KbKind::kChar: k.ch = hit.ch; out.add(k); break;
          case KbKind::kSpace: k.ch = ' '; k.space = true; out.add(k); break;
          case KbKind::kDel: k.del = true; out.add(k); break;
          case KbKind::kEnter: k.enter = true; out.add(k); break;
          case KbKind::kShift: out.shiftToggle = true; break;
          case KbKind::kLayer: out.layerToggle = true; break;
          default: break;
        }
        return out;
      }
      if (c.chipsVisible) {
        for (size_t i = 0; i < c.chipCount; ++i) {
          const ChipRect& r = c.chips[i];
          if (inside(e.x, e.y, r.x, r.y, r.w, r.h, kChipSlop)) {
            tapChip(r, e.x, &out);
            return out;
          }
        }
      }
      if (c.rows.active && c.rows.rowH > 0 && inside(e.x, e.y, c.rows.x, c.rows.firstTop, c.rows.w, c.rows.visible * c.rows.rowH)) {
        const int target = c.rows.top + (e.y - c.rows.firstTop) / c.rows.rowH;
        int moves = target - c.rows.selection;
        moves = moves > 16 ? 16 : moves < -16 ? -16 : moves;
        Key step;
        step.ch = moves > 0 ? '.' : ';';  // . moves down, ; moves up, like the picker's keys
        for (int i = 0; i < (moves < 0 ? -moves : moves); ++i) out.add(step);
        Key enter;
        enter.enter = true;
        out.add(enter);
        return out;
      }
      if (c.anyKeyScreen) {
        Key k;
        k.enter = true;
        out.add(k);
      }
      return out;
    }
    case Gesture::kSwipeUp:
    case Gesture::kSwipeDown: {
      if (c.keyboard) return out;  // ; and . are characters inside a field
      Key k;
      k.ch = e.gesture == Gesture::kSwipeUp ? ';' : '.';
      out.add(k);
      return out;
    }
    case Gesture::kSwipeLeft:
    case Gesture::kSwipeRight: {
      if (c.keyboard) {  // cursor moves: Fn+, and Fn+/
        Key k;
        k.fn = true;
        k.ch = e.gesture == Gesture::kSwipeLeft ? ',' : '/';
        out.add(k);
      } else if (e.gesture == Gesture::kSwipeRight) {
        out.add(backKey(c));
      }
      return out;
    }
    case Gesture::kLongPress:
      if (!c.goScreen) out.add(backKey(c));  // on a GO screen a long press is push-to-talk
      return out;
    default: return out;
  }
}

// --- Gesture -> intent: the round screen's own interaction model --------------------------------
// The approved demo (docs/waveshare/device-ux-prototype.html): a tap is GO (talk hands-free, send now, stop
// and talk again, close, retry); a tap on Bob is a giggle (and, on Ready, the info view, which stays until
// a tap or a swipe right closes it) and never opens the mic; swipe up / down on Ready is the volume; the
// shortcut chips show only after a swipe or a long press, never on the first touch. Everything else keeps
// its key (mapGesture). Owner UX audit 2026-10-20 (#1063).

// Which family of screen is up, from the state machine (round_touch.cpp).
enum class Screen : uint8_t {
  kOther,      // lists, Settings, Wi-Fi, pairing, new chat: keys only
  kReady,      // Ready, no reply card
  kReadyCard,  // Ready with the reply card (also through the follow-up window)
  kTalk,       // listening, thinking / speaking, HELP, an announcement, an error or the socket screen
};

enum class Action : uint8_t {
  kNone,
  kKeys,       // mapGesture() decides the keys
  kGo,         // the tap means GO on this screen (state code: touchGo)
  kBob,        // a giggle, nothing else
  kBobInfo,    // a giggle, then the info view
  kCloseInfo,  // the info view goes, the screen under it comes back
  kVolume,     // Intent::volume steps
};

struct Intent {
  Action action = Action::kNone;
  int8_t volume = 0;         // kVolume: +1 louder, -1 quieter
  bool revealChips = false;  // the shortcut chips show for a while
  Intent(Action a = Action::kNone, int8_t v = 0, bool reveal = false) : action(a), volume(v), revealChips(reveal) {}
};

struct Where {
  Screen screen = Screen::kOther;
  bool infoOpen = false;  // the Ready info view is up
  bool onBob = false;     // the gesture began on Bob (he is on screen)
  bool onChip = false;    // the gesture began on a visible shortcut chip
  bool keyboard = false;  // a field screen with the on-screen keyboard
};

inline bool isSwipe(Gesture g) {
  return g == Gesture::kSwipeUp || g == Gesture::kSwipeDown || g == Gesture::kSwipeLeft || g == Gesture::kSwipeRight;
}

inline Intent intentFor(Gesture g, const Where& w) {
  if (g == Gesture::kNone) return Intent();
  const bool reveal = isSwipe(g) || g == Gesture::kLongPress;
  if (w.keyboard || w.screen == Screen::kOther) return Intent(Action::kKeys, 0, reveal && !w.keyboard);
  if (w.infoOpen) {
    return g == Gesture::kTap || g == Gesture::kSwipeRight ? Intent(Action::kCloseInfo) : Intent();
  }
  if (g == Gesture::kTap) {
    if (w.onChip) return Intent(Action::kKeys);
    if (w.onBob) return Intent(w.screen == Screen::kTalk ? Action::kBob : Action::kBobInfo);
    return Intent(Action::kGo);
  }
  if (g == Gesture::kLongPress || g == Gesture::kSwipeLeft) return Intent(Action::kNone, 0, true);
  if (w.screen == Screen::kReady) {
    // The volume arc and pill answer a volume swipe; the chips would only pop up behind them.
    if (g == Gesture::kSwipeUp) return Intent(Action::kVolume, 1);
    if (g == Gesture::kSwipeDown) return Intent(Action::kVolume, -1);
    return Intent(Action::kNone, 0, true);  // swipe right: nothing to go back to
  }
  // The reply card pages (up / down) and closes (right); listening, the reply in flight, HELP and the
  // rest keep their keys (scroll, back).
  return Intent(Action::kKeys, 0, true);
}
}  // namespace touch
}  // namespace bob
