// The scene compositor on the round UI: Bob, the ring, up to two props and one caption line, each on its own
// clock (scene_engine.h has the clock and keyframe maths). Bob's frame erases the prop slots every time it is
// composed, so round_ui calls sceneDrawProps() right after each Bob frame; the caption sits below Bob's frame and
// is redrawn only when its fade step changes. The scene ends on its own timer, or at once when the screen leaves
// READY/AWAITING, and then gives Bob and the ring back to the screen's mood.
#if defined(BOB_BOARD_WAVESHARE_185C)

#include "scene_engine.h"

#include <Arduino.h>
#include <string.h>

#include "bob_emotions.h"
#include "round_ring.h"
#include "round_ui.h"

namespace bob
{
namespace fsm
{
extern State state;                                          // state_core.cpp
void journalEvent(const char* event, const String& detail); // state_core.cpp
}

static_assert(static_cast<uint8_t>(scene::Ring::kOff) == static_cast<uint8_t>(RingMode::kOff) &&
                  static_cast<uint8_t>(scene::Ring::kSleep) == static_cast<uint8_t>(RingMode::kSleep) &&
                  static_cast<uint8_t>(scene::Ring::kNotify) == static_cast<uint8_t>(RingMode::kNotify),
              "scene::Ring must follow RingMode");

namespace
{
// The 11 and 1 o'clock prop slots. Props must stay inside Bob's 232 px frame (x 64..296): the frame is what gets erased and
// presented every time, so a prop that pokes out would be cut off (or leave trails). Radius of a prop is at most about 30 px.
constexpr int16_t kSlotX[2] = {95, 265}, kSlotY[2] = {92, 92};
constexpr int16_t kCaptionY = kRuiCaptionY, kCaptionX = 60, kCaptionW = 240, kCaptionH = 40; // the token grid's caption line; the height covers the text halo
constexpr uint8_t kCaptionSteps = 8;

bool g_active = false, g_keepBob = false;
scene::SceneId g_id = scene::SceneId::kNone;
uint32_t g_start = 0, g_durMs = 0, g_serial = 0, g_frames = 0, g_propUsSum = 0, g_propUsMax = 0;
int32_t g_value = 0;
char g_caption[scene::kLabelMax + 8] = "";
int g_captionStep = -1; // the fade step last drawn; -1 = nothing drawn

BobEmotion emotionByName(const char* name)
{
  for (uint8_t i = 0; i < kBobEmotionCount; ++i)
  {
    if (strcmp(kBobEmotions[i].name, name) == 0) { return static_cast<BobEmotion>(i); }
  }
  return BobEmotion::kIdle;
}

uint32_t mix888(uint32_t from, uint32_t to, float k)
{
  auto ch = [&](int sh) { return static_cast<uint32_t>(((from >> sh) & 0xFF) + (static_cast<int>((to >> sh) & 0xFF) - static_cast<int>((from >> sh) & 0xFF)) * k); };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

void eraseCaption()
{
  auto& fb = roundui::fb();
  fb.fillRect(kCaptionX, kCaptionY - kCaptionH / 2, kCaptionW, kCaptionH, kRuiGround);
  roundui::dirty(kCaptionX, kCaptionY - kCaptionH / 2, kCaptionW, kCaptionH);
  g_captionStep = -1;
}

void finish(uint32_t nowMs, const char* why)
{
  if (!g_active) { return; }
  g_active = false;
  fsm::journalEvent("scene", String("name=") + scene::specOf(g_id).name + ",end=" + why + ",props_us=" +
                                 (g_frames ? g_propUsSum / g_frames : 0) + "/" + g_propUsMax + ",frames=" + g_frames);
  eraseCaption();
  if (!g_keepBob) { roundui::sceneBobEnd(); }
  (void)nowMs;
}
} // namespace

bool sceneBegin(scene::SceneId id, uint8_t seconds, const char* label, int32_t value, bool keepBob, uint32_t nowMs)
{
  if (id == scene::SceneId::kNone) { return false; }
  const scene::SceneSpec& spec = scene::specOf(id);
  if (!roundui::bobVisible())
  {
    fsm::journalEvent("scene_skipped", String("name=") + spec.name + ",reason=no_bob");
    return false;
  }
  if (g_active) { finish(nowMs, "replaced"); }
  g_active = true;
  g_keepBob = keepBob;
  g_id = id;
  g_start = nowMs;
  g_durMs = static_cast<uint32_t>(seconds) * 1000u;
  g_value = value;
  g_frames = g_propUsSum = g_propUsMax = 0;
  g_serial = roundui::screenSerial();
  scene::caption(id, label, value, g_caption, sizeof(g_caption));
  g_captionStep = -1;
  if (!keepBob)
  {
    roundui::sceneBob(emotionByName(spec.emotion));
    ringLightSetMode(static_cast<RingMode>(spec.ring), nowMs);
  }
  fsm::journalEvent("scene", String("name=") + spec.name + ",begin=1,seconds=" + seconds + ",bob=" + (keepBob ? "kept" : spec.emotion));
  return true;
}

bool sceneActive() { return g_active; }

void sceneEnd(uint32_t nowMs) { finish(nowMs, "stopped"); }

void sceneTick(uint32_t nowMs)
{
  if (!g_active) { return; }
  const State s = fsm::state;
  if (s != State::kReady && s != State::kAwaiting) { finish(nowMs, "left_screen"); return; }
  const uint32_t elapsed = nowMs - g_start;
  if (elapsed >= g_durMs) { finish(nowMs, "done"); return; }
  if (g_caption[0] == '\0') { return; }
  if (g_serial != roundui::screenSerial()) { g_serial = roundui::screenSerial(); g_captionStep = -1; } // the screen repainted over it
  const float a = scene::captionAlpha(elapsed, g_durMs);
  const int step = static_cast<int>(a * kCaptionSteps + 0.5f);
  if (step == g_captionStep) { return; }
  g_captionStep = step;
  eraseCaption();
  g_captionStep = step;
  if (step > 0) { roundui::textCentered(g_caption, kCaptionY, mix888(kRuiGround, kRuiText, static_cast<float>(step) / kCaptionSteps), roundui::detailFont()); }
}

void sceneDrawProps(M5Canvas& fb, uint32_t nowMs)
{
  if (!g_active) { return; }
  const uint32_t t0 = micros();
  const uint32_t elapsed = nowMs - g_start;
  const scene::SceneSpec& spec = scene::specOf(g_id);
  const scene::Prop props[2] = {spec.prop0, spec.prop1};
  for (uint8_t i = 0; i < 2; ++i)
  {
    if (props[i] == scene::Prop::kNone) { continue; }
    const scene::Transform t = scene::propTransform(i, elapsed, g_durMs);
    sceneDrawProp(fb, props[i], static_cast<int16_t>(kSlotX[i] + t.x), static_cast<int16_t>(kSlotY[i] + t.y), scene::propClockMs(i, elapsed), t.scale, t.alpha, g_value);
  }
  const uint32_t us = micros() - t0;
  g_propUsSum += us;
  g_frames++;
  if (us > g_propUsMax) { g_propUsMax = us; }
}

} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
