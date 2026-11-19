// Bob Cardputer v2 — running timers on the Ready screen (#457).
//
// The server sends timers_state after welcome and whenever the account's
// timers change; the device counts down locally from each fires_in_ms and its
// own millis() at receipt, so no per-second traffic. The view model below is
// header-only and pure (host-tested); timers_view.cpp paints it.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include "types.h"

namespace bob {

// The last timers_state, soonest first, and when it arrived.
struct TimersModel {
  TimersMessage timers;
  uint32_t receivedAtMs = 0;
};

// Stores a parsed timers_state received at `nowMs`, sorted soonest first
// (stable; the server already sends them in that order).
inline void timersApply(TimersModel& model, const TimersMessage& message, uint32_t nowMs) {
  model.timers = message;
  model.receivedAtMs = nowMs;
  TimerEntry* entries = model.timers.entries;
  for (size_t i = 1; i < model.timers.count; ++i) {
    const TimerEntry item = entries[i];
    size_t j = i;
    for (; j > 0 && entries[j - 1].firesInMs > item.firesInMs; --j) entries[j] = entries[j - 1];
    entries[j] = item;
  }
}

inline void timersClear(TimersModel& model) { model = TimersModel(); }

// Time left on `entry`; 0 once reached. The unsigned difference stays right
// across the millis() wrap at 2^32 (fires_in_ms is below 2^31).
inline uint32_t timerRemainingMs(const TimerEntry& entry, uint32_t receivedAtMs, uint32_t nowMs) {
  const uint32_t elapsed = nowMs - receivedAtMs;
  return elapsed >= entry.firesInMs ? 0 : entry.firesInMs - elapsed;
}

// "m:ss" under an hour, "h:mm" from one hour. Seconds round up, so "0:00"
// shows only once the time is reached. Returns true for the h:mm form.
constexpr size_t kTimerClockBytes = 8;  // "596:31" (2^31 ms) + NUL.
inline bool formatCountdown(uint32_t remainingMs, char* out, size_t outSize) {
  const uint32_t totalSec = remainingMs / 1000 + (remainingMs % 1000 != 0 ? 1 : 0);
  if (totalSec >= 3600) {
    snprintf(out, outSize, "%u:%02u", static_cast<unsigned int>(totalSec / 3600),
             static_cast<unsigned int>((totalSec % 3600) / 60));
    return true;
  }
  snprintf(out, outSize, "%u:%02u", static_cast<unsigned int>(totalSec / 60),
           static_cast<unsigned int>(totalSec % 60));
  return false;
}

// What the Ready screen's timer band shows: the soonest timer and how many
// more are running. An unlabelled timer reads "Timer" (or "Alarm").
struct TimerBandView {
  bool visible = false;
  bool hours = false;    // clock is h:mm.
  bool reached = false;  // 0:00, waiting for the ring announce.
  uint8_t more = 0;
  char label[kTimerLabelBytes] = {};
  char clock[kTimerClockBytes] = {};
};

inline bool operator==(const TimerBandView& a, const TimerBandView& b) {
  return a.visible == b.visible && a.hours == b.hours && a.reached == b.reached &&
         a.more == b.more && strcmp(a.label, b.label) == 0 && strcmp(a.clock, b.clock) == 0;
}
inline bool operator!=(const TimerBandView& a, const TimerBandView& b) { return !(a == b); }

inline TimerBandView timerBandView(const TimersModel& model, uint32_t nowMs) {
  TimerBandView view;
  if (model.timers.count == 0) return view;
  const TimerEntry& soonest = model.timers.entries[0];
  const char* label = soonest.label[0] != '\0' ? soonest.label
                      : soonest.kind == TimerKind::kAlarm ? "Alarm" : "Timer";
  snprintf(view.label, sizeof(view.label), "%s", label);
  const uint32_t remaining = timerRemainingMs(soonest, model.receivedAtMs, nowMs);
  view.visible = true;
  view.reached = remaining == 0;
  view.hours = formatCountdown(remaining, view.clock, sizeof(view.clock));
  view.more = static_cast<uint8_t>(model.timers.count - 1);
  return view;
}

// Painting (timers_view.cpp, firmware only). The band sits between the Ready
// screen's WiFi line and the shortcut strip; the caller only updates it while
// the plain Ready screen is up (never over a turn, playback, card or ring).
// Repaints only when the shown text changes: digits in place, the band only
// when its layout moves. Invalidate after any full-screen draw.
void timersBandUpdate(const TimersModel& model, uint32_t nowMs);
void timersBandInvalidate();

}  // namespace bob
