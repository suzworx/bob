// Touch glue for the Waveshare: panel samples -> gestures -> intents (touch_policy.h) -> either a state
// machine action (GO, the info view) or the KeysState the existing dispatchers already read: board::keys(),
// keysChanged() and anyKeyPressed() return synthesized frames, exactly like the HIL console's testPressAndRelease.
//
// The round screen's own model (intentFor(), the approved demo; owner UX audit 2026-10-20, #1063):
//   tap                   GO: Ready -> a hands-free turn that ends on silence; listening -> send now;
//                         thinking / speaking -> stop and listen again; HELP, announcement -> close; error -> retry
//   tap Bob               a giggle; on Ready the info view follows and stays until a tap or a swipe right
//   swipe up / down       Ready: volume; the reply card, lists, HELP: ; / . (scroll, page)
//   swipe left, long press   the shortcut chips (never on the first touch)
// Then the key table (mapGesture() in touch_policy.h) for chips, lists, fields and the rest:
//   tap a chip            that chip's key (two keys on one chip: left half, right half)
//   tap a list row        move the selection there with ; or ., then Enter
//   tap, "[any key]" screen  Enter
//   tap a keyboard key    that character (field screens); Del, Enter, shift and 123/abc as drawn
//   swipe right           ` back   (a text field: cursor right, Fn+/)
//   swipe left            nothing  (a text field: cursor left, Fn+,)
//   long press            ` back off the GO screens, or Fn+` cancel in a text field
//   touch held in the first 1.5 s after boot    Fn+` (the rescue chord), through keys() only
// Push-to-talk is the BOOT button alone (board_waveshare_185c.cpp); a touch never holds GO.
#if defined(BOB_BOARD_WAVESHARE_185C)

#include "round_touch.h"

#include <Arduino.h>
#include <string.h>

#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

#include "bob_motion.h"
#include "round_ui.h"
#include "ws185_hw.h"

namespace bob
{
namespace fsm
{
extern State state;      // state_core.cpp
extern bool g_cardShown; // state_cards.cpp: Ready shows the reply card
void enterReady();       // state_core.cpp: Ready again (the plain screen or the reply card)
void touchGo();          // state_turn.cpp: what a GO tap does on this screen
void journalEvent(const char* event, const String& detail); // state_core.cpp
}

namespace roundtouch
{
namespace
{
constexpr uint32_t kPollMs = touch::kPollMs;  // the touch controller is an I2C read: 30 Hz
constexpr uint32_t kRescueWindowMs = 1500;
constexpr uint32_t kInfoAfterGiggleMs = 750; // the demo: the giggle plays, then the info view replaces Bob
constexpr size_t kMaxChips = 10;

touch::Recognizer g_rec;
touch::GoLoopBreaker g_loop;
bool g_touchTurn = false; // the open turn was started by a GO tap
uint32_t g_touchTurnAt = 0;
touch::KeyFramer g_frames;
Keyboard_Class::KeysState g_keys, g_rescueKeys;
bool g_changed = false, g_any = false;
bool g_touching = false, g_delHeld = false, g_delConsumesTap = false, g_rescue = false;
uint32_t g_pollAt = 0; // the inline fallback's rate limit
touch::GapMeter g_gap; // largest gap between consecutive samples of the gesture in flight (gap_ms)
uint32_t g_infoAt = 0; // a tap on Bob on Ready: the info view opens at this time (0: none pending)

void toKeysState(const touch::Key& k, Keyboard_Class::KeysState* out)
{
  out->reset();
  if (k.ch != 0) { out->word.push_back(k.ch); }
  out->enter = k.enter;
  out->del = k.del;
  out->tab = k.tab;
  out->fn = k.fn;
  out->space = k.space;
}

bool goScreen(State s)
{
  switch (s)
  {
    case State::kReady:
    case State::kCapturing: // the hold that started a turn keeps it going
    case State::kAwaiting:
    case State::kHelp:
    case State::kAnnounce:
    case State::kError:
    case State::kSocket: return true;
    default: return false;
  }
}

// What is on screen now, from round_ui and the state, never from text.
touch::Context buildContext(uint32_t nowMs)
{
  static RoundChip chips[kMaxChips];
  static touch::ChipRect rects[kMaxChips];
  touch::Context c;
  const size_t n = roundUiChips(chips, kMaxChips);
  bool anyKeyChip = false;
  for (size_t i = 0; i < n; ++i)
  {
    rects[i].x = chips[i].x;
    rects[i].y = chips[i].y;
    rects[i].w = chips[i].w;
    rects[i].h = chips[i].h;
    snprintf(rects[i].keys, sizeof(rects[i].keys), "%s", chips[i].key);
    anyKeyChip = anyKeyChip || strcmp(chips[i].key, "any key") == 0;
  }
  c.chips = rects;
  c.chipCount = n;
  c.chipsVisible = roundUiChipsShown(nowMs);
  RoundRows rows;
  if (roundUiRows(&rows))
  {
    c.rows = touch::Rows{true, rows.x, rows.w, rows.firstTop, rows.rowH, rows.visible, rows.top, rows.selection};
  }
  const State s = fsm::state;
  c.goScreen = goScreen(s);
  c.anyKeyScreen = anyKeyChip || s == State::kAnnounce || roundui::tapAnyKey();
  c.keyboard = s == State::kSettings && keyboardVisible();
  c.layer = keyboardLayer();
  return c;
}

// Lights the chip a tap landed on (the keyboard lights its own key).
void flashChip(int16_t x, int16_t y, const touch::Context& c, uint32_t nowMs)
{
  if (!c.chipsVisible) { return; }
  for (size_t i = 0; i < c.chipCount; ++i)
  {
    const touch::ChipRect& r = c.chips[i];
    if (touch::inside(x, y, r.x, r.y, r.w, r.h, touch::kChipSlop)) { roundUiPressChip(r.keys, nowMs); return; }
  }
}

bool onChip(int16_t x, int16_t y, const touch::Context& c)
{
  if (!c.chipsVisible) { return false; }
  for (size_t i = 0; i < c.chipCount; ++i)
  {
    const touch::ChipRect& r = c.chips[i];
    if (touch::inside(x, y, r.x, r.y, r.w, r.h, touch::kChipSlop)) { return true; }
  }
  return false;
}

touch::Screen screenNow()
{
  switch (fsm::state)
  {
    case State::kReady: return fsm::g_cardShown ? touch::Screen::kReadyCard : touch::Screen::kReady;
    case State::kCapturing:
    case State::kAwaiting:
    case State::kHelp:
    case State::kAnnounce:
    case State::kError:
    case State::kSocket: return touch::Screen::kTalk;
    default: return touch::Screen::kOther;
  }
}

const char* actionName(touch::Action a)
{
  switch (a)
  {
    case touch::Action::kGo: return "go";
    case touch::Action::kBob: return "bob";
    case touch::Action::kBobInfo: return "bob_info";
    case touch::Action::kCloseInfo: return "close_info";
    case touch::Action::kVolume: return "volume";
    case touch::Action::kKeys: return "keys";
    default: return "none";
  }
}

const char* gestureName(touch::Gesture g)
{
  switch (g)
  {
    case touch::Gesture::kTap: return "tap";
    case touch::Gesture::kLongPress: return "long_press";
    case touch::Gesture::kSwipeUp: return "swipe_up";
    case touch::Gesture::kSwipeDown: return "swipe_down";
    case touch::Gesture::kSwipeLeft: return "swipe_left";
    case touch::Gesture::kSwipeRight: return "swipe_right";
    default: return "none";
  }
}

void pushKey(char ch)
{
  touch::Key k;
  k.ch = ch;
  g_frames.push(k);
}

void handleKeys(const touch::Event& ev, const touch::Context& c, uint32_t nowMs)
{
  if (ev.gesture == touch::Gesture::kTap) { flashChip(ev.x, ev.y, c, nowMs); }
  const touch::Result r = touch::mapGesture(ev, c);
  if (c.keyboard && ev.gesture == touch::Gesture::kTap && !r.shiftToggle && !r.layerToggle) { keyboardPressAt(ev.x, ev.y, nowMs); }
  if (r.shiftToggle) { keyboardToggleShift(); }
  if (r.layerToggle) { keyboardToggleLayer(); }
  for (size_t i = 0; i < r.count; ++i)
  {
    g_frames.push(r.keys[i]);
    if (c.keyboard && r.keys[i].ch >= ' ' && !r.keys[i].fn) { keyboardTyped(); }
  }
}

// One finished gesture: what it means here (intentFor), then that.
void handleGesture(const touch::Event& ev, const touch::Context& c, uint32_t nowMs)
{
  g_infoAt = 0; // a new gesture cancels an info view still waiting for its giggle
  touch::Where w;
  w.screen = screenNow();
  w.infoOpen = roundui::infoOpen();
  w.keyboard = c.keyboard;
  w.onChip = onChip(ev.x, ev.y, c);
  w.onBob = !c.keyboard && roundui::bobHit(ev.x, ev.y);
  const touch::Intent in = touch::intentFor(ev.gesture, w);
  if (in.revealChips) { roundUiRevealChips(nowMs); }
  if (in.action != touch::Action::kKeys && (in.action != touch::Action::kNone || in.revealChips))
  {
    // HIL evidence (scripts/hil touch scenarios): which gesture meant what. Never a coordinate.
    fsm::journalEvent("touch", String("gesture=") + gestureName(ev.gesture) + ",action=" +
                                   (in.action == touch::Action::kNone ? "chips" : actionName(in.action)) + ",gap_ms=" + g_gap.maxMs());
  }
  if (in.action == touch::Action::kKeys)
  {
    // Why a gesture became keys (HIL evidence; never a coordinate): a chip or the on-screen keyboard took it.
    fsm::journalEvent("touch_keys", String("gesture=") + gestureName(ev.gesture) + ",chip=" + (w.onChip ? 1 : 0) + ",bob=" + (w.onBob ? 1 : 0) +
                                       ",keyboard=" + (w.keyboard ? 1 : 0) + ",screen=" + static_cast<int>(w.screen));
  }
  switch (in.action)
  {
    case touch::Action::kKeys: handleKeys(ev, c, nowMs); break;
    case touch::Action::kGo:
    {
      if (!g_loop.goAllowed(nowMs)) { fsm::journalEvent("touch_go_suppressed", String("state=") + static_cast<int>(fsm::state)); break; }
      const State before = fsm::state;
      fsm::touchGo();
      if (before != State::kCapturing && fsm::state == State::kCapturing)
      {
        g_touchTurn = true;
        g_touchTurnAt = nowMs;
      }
      break;
    }
    case touch::Action::kBob: bobMotionTapReaction(); break; // a giggle, ^ ^ eyes and a little heart
    case touch::Action::kBobInfo:
      bobMotionTapReaction();
      g_infoAt = nowMs + kInfoAfterGiggleMs;
      if (g_infoAt == 0) { g_infoAt = 1; }
      break;
    case touch::Action::kCloseInfo:
      roundui::infoReset();
      fsm::enterReady();
      fsm::journalEvent("info_closed", String("source=") + gestureName(ev.gesture));
      break;
    case touch::Action::kVolume: pushKey(in.volume > 0 ? '=' : '-'); break;
    case touch::Action::kNone: break;
  }
}

// The info view opens once the giggle has played, if Bob is still on the Ready screen.
void openInfoWhenDue(uint32_t nowMs)
{
  if (g_infoAt == 0 || static_cast<int32_t>(nowMs - g_infoAt) < 0) { return; }
  g_infoAt = 0;
  if (fsm::state == State::kReady && roundui::bobVisible() && !roundui::infoOpen())
  {
    onBobTapped();
    fsm::journalEvent("info_opened", String("source=bob"));
  }
}

// One key frame per poll: the press, then its release.
void emitFrame()
{
  if (g_delHeld) { return; } // the finger holds Del: no other frame until it lifts
  touch::Key frame;
  bool press = false;
  if (!g_frames.next(&frame, &press)) { return; }
  toKeysState(frame, &g_keys);
  g_any = press;
  g_changed = true;
}
} // namespace

__attribute__((weak)) void onBobTapped() {}

#ifdef BOB_TEST_CONSOLE
// `T touch x y [ms]` and `T swipe <dir>` (hil env): a finger moving from (x0, y0) to (x1, y1) over ms,
// fed to poll() in place of the panel, so touch behaviour is repeatable without a hand.
namespace
{
struct Injection
{
  bool active = false;
  uint32_t start = 0, until = 0;
  int16_t x0 = 0, y0 = 0, x1 = 0, y1 = 0;
} g_inject;
portMUX_TYPE g_injectMux = portMUX_INITIALIZER_UNLOCKED; // the sampler task reads it, the console (loop task) writes it
} // namespace

void injectGesture(int16_t x0, int16_t y0, int16_t x1, int16_t y1, uint32_t ms)
{
  const uint32_t now = millis();
  Injection in;
  in.active = true;
  in.start = now;
  // A finger stays down for longer than the slowest loop pass: the first pass of a state change is a full Bob frame (~250 ms), and a
  // shorter injected touch could fall inside it, between two polls, and never be seen. Still well under the 600 ms long press.
  in.until = now + (ms < 300 ? 300 : ms);
  in.x0 = x0;
  in.y0 = y0;
  in.x1 = x1;
  in.y1 = y1;
  portENTER_CRITICAL(&g_injectMux);
  g_inject = in;
  portEXIT_CRITICAL(&g_injectMux);
}

bool injectedPoint(uint32_t nowMs, int16_t* x, int16_t* y)
{
  Injection in;
  portENTER_CRITICAL(&g_injectMux);
  in = g_inject;
  if (in.active && static_cast<int32_t>(nowMs - in.until) >= 0) { g_inject.active = false; }
  portEXIT_CRITICAL(&g_injectMux);
  if (!in.active || static_cast<int32_t>(nowMs - in.until) >= 0) { return false; }
  const float t = static_cast<float>(nowMs - in.start) / static_cast<float>(in.until - in.start);
  *x = static_cast<int16_t>(in.x0 + (in.x1 - in.x0) * t);
  *y = static_cast<int16_t>(in.y0 + (in.y1 - in.y0) * t);
  return true;
}
#endif

namespace
{
// One panel reading with the time it was taken: the sampler task queues them, poll() replays them in order.
struct TimedSample
{
  touch::Sample s;
  int16_t x, y;
  uint32_t ms;
};
constexpr UBaseType_t kQueueLen = 16; // ~0.5 s of samples: longer than any loop pass
QueueHandle_t g_queue = nullptr;      // written once before the task starts; null = inline fallback
bool g_samplerTried = false;
volatile uint32_t g_dropped = 0;      // sampler task writes, poll() reads (a stale read only delays a journal line)
uint32_t g_droppedReported = 0;
TaskHandle_t g_task = nullptr;
uint32_t g_startedAt = 0;
bool g_stackReported = false;

TimedSample readPanel()
{
  TimedSample t{touch::Sample::kUp, 0, 0, millis()};
#ifdef BOB_TEST_CONSOLE
  t.s = injectedPoint(t.ms, &t.x, &t.y) ? touch::Sample::kDown : ws185::touchSample(&t.x, &t.y);
#else
  t.s = ws185::touchSample(&t.x, &t.y);
#endif
  return t;
}

// Samples the panel every kPollMs whatever the Arduino loop is doing (a Bob render pass holds it for ~130 ms).
void samplerTask(void*)
{
  TickType_t last = xTaskGetTickCount();
  touch::IdleFilter idle; // an idle panel queues two ups, then nothing: a long stall cannot fill the queue
  for (;;)
  {
    vTaskDelayUntil(&last, pdMS_TO_TICKS(kPollMs));
    const TimedSample t = readPanel();
    if (!idle.shouldQueue(t.s)) { continue; }
    if (xQueueSend(g_queue, &t, 0) != pdTRUE)
    {
      g_dropped = g_dropped + 1;
      if (t.s == touch::Sample::kUp) { idle.dropped(); }
    }
  }
}

// Lazily, on the first poll(): the board (I2C bus, panel) is up by then.
void startSampler()
{
  if (g_samplerTried) { return; }
  g_samplerTried = true;
  g_queue = xQueueCreate(kQueueLen, sizeof(TimedSample));
  if (g_queue == nullptr) { return; }
  // Core 1 (the loop's), one priority above it so the ~1 ms I2C read pre-empts a render pass; the wake task is on core 0.
  if (xTaskCreatePinnedToCore(samplerTask, "touch", 4096, nullptr, 2, &g_task, 1) != pdPASS)
  {
    vQueueDelete(g_queue);
    g_queue = nullptr;
    g_task = nullptr;
    return;
  }
  g_startedAt = millis();
}

// Once, ~1 s after the sampler started: how much of its stack is still unused (evidence for the 4096 B size).
void reportStackOnce(uint32_t nowMs)
{
  if (g_stackReported || g_task == nullptr || nowMs - g_startedAt < 1000) { return; }
  g_stackReported = true;
  fsm::journalEvent("touch_sampler", String("stack_free=") + static_cast<uint32_t>(uxTaskGetStackHighWaterMark(g_task)) + ",core=1,prio=2");
}

// One panel sample: press / release tracking, the recognizer (at the sample's own time), then what a gesture means.
// Returns true when the sample completed a gesture (poll() then leaves the rest of the queue for the next pass).
bool processSample(const TimedSample& t, const touch::Context& ctx, uint32_t nowMs)
{
  const touch::Sample sample = t.s;
  const int16_t x = t.x, y = t.y;
  // A failed read keeps the last state: it is neither a press nor a release.
  const bool down = sample == touch::Sample::kDown || (sample == touch::Sample::kUnknown && g_touching);
  const bool rising = down && !g_touching;
  g_touching = down;
  if (rising) { g_gap.reset(); }
  g_gap.add(t.ms);
  if (rising)
  {
    g_rescue = t.ms < kRescueWindowMs;
    if (!g_rescue && ctx.keyboard && y < touch::kKbBottom && touch::kbHitAt(ctx.layer, x, y).kind == touch::KbKind::kDel)
    {
      g_delHeld = true; // Del repeats while the finger stays down (settingsTick reads the held state)
      g_delConsumesTap = true;
      touch::Key del;
      del.del = true;
      toKeysState(del, &g_keys);
      g_any = true;
      g_changed = true;
      keyboardPressAt(x, y, nowMs);
    }
  }
  const touch::Event ev = g_rec.update(sample, x, y, t.ms);
  if (ev.gesture != touch::Gesture::kNone && !g_rescue && !g_delConsumesTap) { handleGesture(ev, ctx, nowMs); }
  if (!down)
  {
    if (g_delHeld)
    {
      g_delHeld = false;
      g_keys.reset();
      g_any = false;
      g_changed = true;
    }
    g_delConsumesTap = false;
    g_rescue = false;
  }
  // Bob's eyes follow the finger.
  if (sample == touch::Sample::kDown && roundui::bobVisible()) { bobMotionLookAt(x, y); } // only a real point, never a stale 0,0
  return ev.gesture != touch::Gesture::kNone;
}
} // namespace

void poll(uint32_t nowMs)
{
  g_changed = false;
  keyboardTick(nowMs);
  // A tap-started turn that closed without endTurn (wake_rejected, a server error, a capture fail or stall) never ran the
  // hook. endTurn runs it while the state is still Capturing and clears the flag, so a turn is never counted twice.
  if (g_touchTurn && fsm::state != State::kCapturing) { fsm::touchTurnEnded(false); }
  startSampler();
  if (g_rescueKeys.word.empty())
  {
    g_rescueKeys.fn = true;
    g_rescueKeys.word.push_back('`');
  }
  const touch::Context ctx = buildContext(nowMs);
  openInfoWhenDue(nowMs);
  TimedSample t;
  if (g_queue != nullptr)
  {
    // Stop as soon as a sample changed the key state or finished a gesture: the next sample (say the up of a quick Del
    // tap) would reset the keys before settingsTick saw them. The rest waits for the next pass; samples keep their time.
    bool gestureHandled = false;
    while (!g_changed && !gestureHandled && xQueueReceive(g_queue, &t, 0) == pdTRUE) { gestureHandled = processSample(t, ctx, nowMs); }
    reportStackOnce(nowMs);
  }
  else if (nowMs - g_pollAt >= kPollMs) // the task could not start: today's inline read, so touch never dies
  {
    g_pollAt = nowMs;
    processSample(readPanel(), ctx, nowMs);
  }
  const uint32_t dropped = g_dropped;
  if (dropped != g_droppedReported)
  {
    fsm::journalEvent("touch_dropped", String("total=") + dropped);
    g_droppedReported = dropped;
  }
  // Bob leans and squishes while a finger holds him still.
  bobMotionHold(g_rec.down() && !g_rescue && !g_rec.moved() && !ctx.keyboard && roundui::bobHit(g_rec.startX(), g_rec.startY()));
  if (!g_changed) { emitFrame(); }
}

bool keysChanged() { return g_changed; }

const Keyboard_Class::KeysState& keys() { return g_rescue && g_touching ? g_rescueKeys : g_keys; }

bool anyKeyPressed() { return g_any; }
} // namespace roundtouch

namespace fsm
{
// state_turn.cpp endTurn(): feeds the GO loop breaker, so a turn a tap started and nobody spoke in counts as empty.
void touchTurnEnded(bool heardSpeech)
{
  roundtouch::g_loop.turnEnded(roundtouch::g_touchTurn, heardSpeech, roundtouch::g_touchTurnAt, millis());
  roundtouch::g_touchTurn = false;
}
} // namespace fsm
} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
