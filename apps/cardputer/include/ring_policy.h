// Bob Cardputer v2 — the timer/alarm ring (#389): its length, its three
// sounds and which note plays when (pure; host-tested in
// test/host/test_ring_policy.cpp). earcons.cpp plays the notes.
#pragma once

#include <cstdint>
#include <cstring>

namespace bob {

// ring_seconds (contract: integer 10..120, default 30).
constexpr uint8_t kRingSecondsMin = 10;
constexpr uint8_t kRingSecondsMax = 120;
constexpr uint8_t kRingSecondsDefault = 30;

inline bool ringSecondsValid(unsigned int seconds) {
  return seconds >= kRingSecondsMin && seconds <= kRingSecondsMax;
}

// ring_sound (contract: "classic" | "chime" | "pulse", default "classic").
// The values are stored in NVS; append, never renumber.
enum class RingSound : uint8_t {
  kClassic = 0,
  kChime = 1,
  kPulse = 2,
};

inline const char* ringSoundName(RingSound sound) {
  switch (sound) {
    case RingSound::kClassic: return "classic";
    case RingSound::kChime: return "chime";
    case RingSound::kPulse: return "pulse";
  }
  return "classic";
}

// Leaves `out` untouched when `name` is not a known sound.
inline bool parseRingSound(const char* name, RingSound& out) {
  if (std::strcmp(name, "classic") == 0) out = RingSound::kClassic;
  else if (std::strcmp(name, "chime") == 0) out = RingSound::kChime;
  else if (std::strcmp(name, "pulse") == 0) out = RingSound::kPulse;
  else return false;
  return true;
}

// One sine note, `atMs` into its pattern's cycle. Patterns are a few notes
// in flash, never sample buffers: samples are immutable flash clips. Pitches stay
// in 494..659 Hz for a soft cabin sound; the
// loudness is the user's volume level (earcons.cpp), never more.
struct RingNote {
  uint16_t atMs;
  uint16_t hz;
  uint16_t ms;
};

struct RingPattern {
  const RingNote* notes;
  uint8_t count;
  uint16_t periodMs;  // the cycle repeats every periodMs.
};

// The descending cabin pair identifies timers; its ascending counterpart
// identifies alarms. The user-selected styles retain their stable NVS IDs.
inline const RingPattern& ringPattern(RingSound sound, bool alarm = false) {
  static constexpr RingNote kClassicTimer[] = {{0, 587, 1050}, {1050, 494, 1050}, {2100, 587, 1050}};
  static constexpr RingNote kClassicAlarm[] = {{0, 494, 1050}, {1050, 587, 1050}, {2100, 494, 1050}};
  static constexpr RingNote kChimeTimer[] = {{0, 659, 1050}, {1050, 494, 1050}};
  static constexpr RingNote kChimeAlarm[] = {{0, 494, 1050}, {1050, 659, 1050}};
  static constexpr RingNote kPulseTimer[] = {{0, 587, 1050}};
  static constexpr RingNote kPulseAlarm[] = {{0, 494, 1050}};
  static constexpr RingPattern kPatterns[] = {
    {kClassicTimer, 3, 5200}, {kClassicAlarm, 3, 5200},
    {kChimeTimer, 2, 4800}, {kChimeAlarm, 2, 4800},
    {kPulseTimer, 1, 3000}, {kPulseAlarm, 1, 3000},
  };
  const unsigned int style = sound == RingSound::kChime ? 1 : sound == RingSound::kPulse ? 2 : 0;
  return kPatterns[style * 2 + (alarm ? 1 : 0)];
}

enum class RingStep : uint8_t {
  kNone,     // nothing to do this tick.
  kPlay,     // play *note now.
  kExpired,  // the ring ran its full ring_seconds: stop (returned once).
};

// A ring in progress, ticked from the main loop. Times are compared signed,
// like persistDue(): the loop's nowMs can be a few ms older than the
// millis() start() was given, which unsigned would read as ~49 days; and
// millis() wrapping mid-ring changes nothing.
class RingSchedule {
 public:
  void start(uint32_t nowMs, RingSound sound, uint8_t seconds, bool alarm = false) {
    active_ = true;
    sound_ = sound;
    alarm_ = alarm;
    startedAt_ = nowMs;
    cycleAt_ = nowMs;
    next_ = 0;
    durationMs_ = static_cast<uint32_t>(seconds) * 1000u;
  }

  void stop() { active_ = false; }
  bool active() const { return active_; }

  // Milliseconds since start(); 0 for a time before it.
  uint32_t elapsedMs(uint32_t nowMs) const {
    const int32_t elapsed = static_cast<int32_t>(nowMs - startedAt_);
    return elapsed > 0 ? static_cast<uint32_t>(elapsed) : 0;
  }

  RingStep tick(uint32_t nowMs, RingNote* note) {
    if (!active_) return RingStep::kNone;
    if (elapsedMs(nowMs) >= durationMs_) {
      active_ = false;
      return RingStep::kExpired;
    }
    const RingPattern& pattern = ringPattern(sound_, alarm_);
    int32_t inCycle = static_cast<int32_t>(nowMs - cycleAt_);
    if (inCycle < 0) return RingStep::kNone;
    if (next_ >= pattern.count) {
      if (inCycle < static_cast<int32_t>(pattern.periodMs)) return RingStep::kNone;
      cycleAt_ += pattern.periodMs;
      next_ = 0;
      inCycle -= pattern.periodMs;
      // A loop stalled for more than a whole cycle restarts from now rather
      // than replaying the notes it missed.
      if (inCycle >= static_cast<int32_t>(pattern.periodMs)) {
        cycleAt_ = nowMs;
        inCycle = 0;
      }
    }
    if (inCycle < static_cast<int32_t>(pattern.notes[next_].atMs)) return RingStep::kNone;
    *note = pattern.notes[next_++];
    return RingStep::kPlay;
  }

 private:
  bool active_ = false;
  bool alarm_ = false;
  RingSound sound_ = RingSound::kClassic;
  uint8_t next_ = 0;
  uint32_t startedAt_ = 0;
  uint32_t cycleAt_ = 0;
  uint32_t durationMs_ = 0;
};

}  // namespace bob
