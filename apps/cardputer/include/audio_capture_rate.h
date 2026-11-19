// Bob Cardputer v2 — the microphone capture rate (pure arithmetic, no I/O).
//
// The capture fps (the `fps` of turn_ended, docs/log-reference.md) counts the
// 10 ms frames the mic delivered, not the frames the loop took: the ring holds
// the ones it has not read yet. Kept apart from audio_capture.cpp so the host
// tests can reach it.
#pragma once

#include <cstdint>
#include "wake_stats.h"

namespace bob {

// Start of the rate window when the first frame is taken at `nowMs`, with
// `readyAtFirstTake` frames filled and unread (the one taken included): the
// frames waiting were filled `frameMs` apart, before it.
inline uint32_t captureStartMs(uint32_t nowMs, uint32_t readyAtFirstTake, uint32_t frameMs) {
  return readyAtFirstTake > 0 ? nowMs - (readyAtFirstTake - 1) * frameMs : nowMs;
}

// Frames per second the mic delivered over the window. `readyUnread` counts the
// frame in hand too (it is unread until the next take), so that one is taken
// off once. 0 before two frames were taken.
inline uint32_t captureFramesPerSecond(uint32_t framesTaken, uint32_t readyUnread, bool hasCurrent,
                                       uint32_t firstFrameAtMs, uint32_t nowMs) {
  if (framesTaken < 2) return 0;
  const uint32_t delivered = framesTaken + readyUnread - (hasCurrent ? 1 : 0);
  return framesPerSecond(delivered - 1, nowMs - firstFrameAtMs);
}

}  // namespace bob
