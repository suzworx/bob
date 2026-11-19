// Bob's action scenes as data: a scene is Bob's feeling (one of the 47 emotions, by name), a ring pattern, up
// to two props in the 11 and 1 o'clock slots, a duration and a Cardputer icon text. Everything here is plain
// constexpr data and pure functions, so the host tests can check the whole catalogue; scene_engine.cpp turns it
// into pixels. The names are the wire contract of the server's `scene` message (the SAME names).
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace bob {
namespace scene {

enum class Prop : uint8_t { kNone, kClock, kClockRing, kBell, kSun, kCloud, kRain, kSnow, kNotes, kChecklist, kNote, kCalendar, kMagnifier, kEnvelope, kCheck, kCross };
constexpr uint8_t kPropCount = 16;

// Same order as RingMode (round_ring_policy.h); scene_engine.cpp static_asserts it.
enum class Ring : uint8_t { kOff, kListening, kThinking, kSpeaking, kError, kNotify, kSleep };

constexpr uint8_t kMaxSeconds = 20, kMinSeconds = 1;
constexpr size_t kLabelMax = 24;

// Row: X(name, emotion, ring, prop at 11 o'clock, prop at 1 o'clock, default seconds, Cardputer icon text).
// `emotion` is a BobEmotion name from bob_emotions.h. A prop pair is independent: each prop has its own clock.
#define BOB_SCENES(X) \
  X(timer_set,     Focused,    kThinking, kClock,     kNone,     6,  "clock") \
  X(timer_done,    Surprised,  kNotify,   kClockRing, kNone,     8,  "clock") \
  X(alarm,         Alarm,      kNotify,   kBell,      kNone,     10, "bell") \
  X(weather_sun,   Happy,      kOff,      kSun,       kNone,     6,  "sun") \
  X(weather_cloud, Calm,       kOff,      kCloud,     kNone,     6,  "cloud") \
  X(weather_rain,  Calm,       kOff,      kRain,      kNone,     6,  "rain") \
  X(weather_snow,  Joyful,     kOff,      kSnow,      kNone,     6,  "snow") \
  X(music,         Music,      kSpeaking, kNotes,     kNone,     8,  "music") \
  X(task_added,    Proud,      kNotify,   kChecklist, kNone,     5,  "task") \
  X(note_added,    Happy,      kOff,      kNote,      kNone,     5,  "note") \
  X(reminder,      Reminder,   kNotify,   kBell,      kNone,     8,  "reminder") \
  X(calendar,      Curious,    kOff,      kCalendar,  kNone,     6,  "calendar") \
  X(search,        Focused,    kThinking, kMagnifier, kNone,     6,  "search") \
  X(message_sent,  Joyful,     kOff,      kEnvelope,  kNone,     5,  "message") \
  X(success,       Success,    kNotify,   kNone,      kNone,     4,  "ok") \
  X(failed,        Apologetic, kError,    kNone,      kNone,     5,  "oops")

enum class SceneId : uint8_t {
  kNone,
#define X(name, emotion, ring, p0, p1, secs, icon) k_##name,
  BOB_SCENES(X)
#undef X
  kCount
};

struct SceneSpec {
  const char* name;
  const char* emotion;
  Ring ring;
  Prop prop0, prop1;
  uint8_t seconds;
  const char* icon;
};

constexpr SceneSpec kScenes[] = {
    {"", "Idle", Ring::kOff, Prop::kNone, Prop::kNone, 0, ""},
#define X(name, emotion, ring, p0, p1, secs, icon) {#name, #emotion, Ring::ring, Prop::p0, Prop::p1, secs, icon},
    BOB_SCENES(X)
#undef X
};
constexpr uint8_t kSceneCount = static_cast<uint8_t>(SceneId::kCount);
static_assert(sizeof(kScenes) / sizeof(kScenes[0]) == kSceneCount, "scene table and enum disagree");

inline const SceneSpec& specOf(SceneId id) { return kScenes[static_cast<uint8_t>(id) < kSceneCount ? static_cast<uint8_t>(id) : 0]; }

// The wire name to its scene; kNone for an unknown name (the caller ignores it and journals scene_unknown).
inline SceneId idFromName(const char* name) {
  if (name == nullptr || name[0] == '\0') return SceneId::kNone;
  for (uint8_t i = 1; i < kSceneCount; ++i) {
    if (strcmp(kScenes[i].name, name) == 0) return static_cast<SceneId>(i);
  }
  return SceneId::kNone;
}

// A message's `seconds` clamped to 1..20; 0 or missing means the scene's own default.
inline uint8_t durationSeconds(SceneId id, uint32_t requested) {
  if (requested == 0) return specOf(id).seconds;
  return requested < kMinSeconds ? kMinSeconds : requested > kMaxSeconds ? kMaxSeconds : static_cast<uint8_t>(requested);
}

// The one short line under Bob (the owner's minimal-text rule): a timer shows its length as m:ss (h:mm:ss over an
// hour), every other scene its label when it has one. Empty means no caption.
inline void caption(SceneId id, const char* label, int32_t value, char* out, size_t outSize) {
  out[0] = '\0';
  if ((id == SceneId::k_timer_set || id == SceneId::k_timer_done) && value > 0) {
    const uint32_t s = static_cast<uint32_t>(value);
    if (s >= 3600) snprintf(out, outSize, "%u:%02u:%02u", static_cast<unsigned>(s / 3600), static_cast<unsigned>(s / 60 % 60), static_cast<unsigned>(s % 60));
    else snprintf(out, outSize, "%u:%02u", static_cast<unsigned>(s / 60), static_cast<unsigned>(s % 60));
    return;
  }
  if (label != nullptr && label[0] != '\0') snprintf(out, outSize, "%.*s", static_cast<int>(kLabelMax), label);
}

// One line for the Cardputer: the same information without art, e.g. "[clock] 10:00" or "[sun]".
inline void iconLine(SceneId id, const char* label, int32_t value, char* out, size_t outSize) {
  char cap[kLabelMax + 8];
  caption(id, label, value, cap, sizeof(cap));
  if (cap[0] != '\0') snprintf(out, outSize, "[%s] %s", specOf(id).icon, cap);
  else snprintf(out, outSize, "[%s]", specOf(id).icon);
}

}  // namespace scene
}  // namespace bob
