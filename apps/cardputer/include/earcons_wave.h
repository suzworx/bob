// Immutable, source-generated cabin PCM. The speaker may retain each pointer.
#pragma once
#include <cstddef>
#include <cstdint>
#include "earcons.h"
#include "earcons_pcm.h"

namespace bob {
constexpr uint32_t kChimeRate = 4000;
struct ChimeClip { const uint8_t* samples; size_t count; };
template <size_t N> constexpr ChimeClip clip(const uint8_t (&samples)[N]) {
  return ChimeClip{samples, N};
}
inline ChimeClip chimeClip(Earcon cue) {
  switch (cue) {
    case Earcon::kListenStart: return clip(kCabinReady);
    case Earcon::kListenStop: return clip(kCabinSent);
    case Earcon::kError: return clip(kCabinError);
    case Earcon::kDisconnect: return clip(kCabinDisconnect);
    case Earcon::kChime: return clip(kCabinReminder);
    case Earcon::kNotice: return clip(kCabinNotice);
    case Earcon::kFollowupClose: return clip(kCabinFollowupClose);
    case Earcon::kTimer: return clip(kCabinTimer);
    case Earcon::kAlarm: return clip(kCabinAlarm);
    case Earcon::kVolume: return clip(kCabinVolume);
  }
  return clip(kCabinError);
}
inline ChimeClip ringClip(uint16_t hz) {
  if (hz == 494) return clip(kCabinRingLow);
  if (hz == 659) return clip(kCabinRingHigh);
  return clip(kCabinRingMid);
}
}  // namespace bob
