// Bob Cardputer v2 — microphone capture and uplink framing.
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include "frame_ring.h"
#include "types.h"

namespace bob {

// Callback used to send one complete OLX2 audio_up frame.
using SendFrameCallback = std::function<void(const uint8_t* frame, size_t length)>;

// Frames of 10 ms the ring holds (only while the mic is open): the slack the
// main loop has before capture loses audio. A wake model Invoke() takes ~16 ms
// and a display redraw more; the Waveshare LISTEN pass takes 111-121 ms, so it
// gets 640 ms (PSRAM, see audio_capture.cpp begin()). The Cardputer keeps 80 ms.
constexpr uint32_t kCaptureRingFramesCardputer = 8;
constexpr uint32_t kCaptureRingFramesWaveshare = 64;  // a power of two (FrameRing).
#if defined(BOB_BOARD_WAVESHARE_185C)
constexpr size_t kCaptureRingFrames = kCaptureRingFramesWaveshare;
#else
constexpr size_t kCaptureRingFrames = kCaptureRingFramesCardputer;
#endif

// Gap-free capture (include/frame_ring.h explains the M5Unified contract): the
// mic always holds two queued 10 ms buffers, refilled from its own release
// callback, and the main loop takes every finished frame in order.
class AudioCapture {
 public:
  AudioCapture();

  // Starts the microphone and queues the first buffers. Returns false on
  // failure (the mic or the ring's heap).
  bool begin();

  // Ends the microphone and frees the ring.
  void end();

  // True if the microphone is currently active.
  bool active() const;

  // Moves to the next 10 ms frame the mic has finished, oldest first; the
  // previous one is released. False when none is ready yet (call again next
  // loop) or capture failed (see failed()). Call it in a loop to drain.
  bool nextFrame();

  // True once the mic refused a buffer: the caller should enter an error state.
  bool failed() const;

  // The current frame (config::kSamplesPerFrame samples), valid until the
  // next nextFrame() or end().
  const int16_t* frame() const;

  // Frames the current frame as OLX2 audio_up and emits it via `send`.
  void sendFrame(SendFrameCallback send);

  // Frames taken since begin(), and the rate of the frames the mic delivered
  // (taken or still waiting in the ring) from its first frame to `nowMs` (0
  // before two frames).
  uint32_t framesTaken() const;
  uint32_t framesPerSecond(uint32_t nowMs) const;

  // Resets the uplink sequence counter at the start of a turn.
  void resetSequence();

  // Sets the sequence the next framed frame gets (a follow-up turn's first
  // live frame follows its renumbered pre-roll frames).
  void setSequence(uint32_t next);

  // Increments and returns the current sequence number after a frame is sent.
  uint32_t nextSequence();

#ifdef BOB_TEST_CONSOLE
  // HIL (`T audio tone <ms>`): the next capture sends a 440 Hz tone for its
  // first `ms` instead of the mic samples; ending that capture disarms it.
  void armTestTone(uint32_t ms);
#endif

 private:
#ifdef BOB_TEST_CONSOLE
  uint32_t toneFrames_ = 0;  // 10 ms frames of tone still to send.
  uint32_t toneSample_ = 0;  // phase, in samples.
  bool toneUsed_ = false;    // a capture has started sending the tone.
#endif
  using Ring = FrameRing<kCaptureRingFrames, 160>;

  // Mic release callback (capture task): the buffer is filled; queue the next.
  static void onBufferFilled(void* self, void* data, size_t length);
  // Queues free buffers until both mic slots are busy. Either side may call
  // it; whoever holds queueing_ does the work, the other skips.
  void topUp(bool fromMicTask);

  bool active_;
  Ring* ring_ = nullptr;
  int16_t* ringPcm_ = nullptr;
  int16_t* current_ = nullptr;  // taken from the ring, not yet popped.
  std::atomic<bool> queueing_{false};
  std::atomic<bool> refillWanted_{false};
  bool failed_ = false;
  uint32_t framesTaken_ = 0;
  uint32_t firstFrameAtMs_ = 0;
  uint32_t beganAtMs_ = 0;  // Waveshare: start of the mic warm-up that is discarded.
  uint8_t audioFrame_[340];  // 20-byte header + 160 PCM16 samples.
  uint32_t sequence_;
};

// How loud the mic is, 0..1: the frame level the VAD and wake path already measure, 0 at the noise floor and
// 1 at floor + 30 dB, smoothed over about 80 ms; 0 when capture is idle. Read-only and thread-safe (atomics
// only, no lock on the audio path), for the Waveshare ring light.
float captureLevel01();

}  // namespace bob
