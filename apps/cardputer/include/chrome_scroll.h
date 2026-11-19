// Shortcut-strip motion, independent of display rendering and loop frequency.
#pragma once

#include <cstdint>

namespace bob {

inline int16_t stripScrollOffset(uint32_t elapsedMs, int16_t loopWidth) {
  if (loopWidth <= 0) return 0;
  constexpr uint32_t kPauseMs = 600;
  constexpr uint32_t kMsPerPixel = 10;  // 100 px/s, regardless of skipped frames.
  const uint32_t phase = elapsedMs %
      (kPauseMs + static_cast<uint32_t>(loopWidth) * kMsPerPixel);
  return phase <= kPauseMs ? 0 : static_cast<int16_t>((phase - kPauseMs) / kMsPerPixel);
}

}  // namespace bob
