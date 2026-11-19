// Bob Cardputer v2 — downlink playback with PCM fallback and MP3 streaming.
#pragma once

#include <cstddef>
#include <cstdint>
#include "turn_timing.h"
#include "types.h"

namespace bob {

// What an MP3 reply's teardown may touch. `drained`: the decode task provably
// no longer uses the MP3 objects (else they are leaked, never touched).
// `began`: the generator's begin() succeeded. ESP8266Audio's stop() frees
// stream/frame/synth and calls output->stop() and file->close(), all of which
// only begin() sets up, so a generator whose begin() failed (an abort closed
// the source first) is freed without stop(). Its output is ours and is safe to
// stop either way.
struct Mp3TeardownPlan {
  bool stopGenerator;
  bool stopOutput;
  bool freeObjects;
};

constexpr Mp3TeardownPlan planMp3Teardown(bool drained, bool began) {
  return Mp3TeardownPlan{drained && began, drained, drained};
}

// Announcements may finish their cabin cue while incoming MP3 stays in the
// existing ring. Yield early to cancellation or pressure; never block the WS loop.
constexpr bool waitForAnnouncementCue(bool playing, bool stopped, uint32_t elapsedMs,
                                      size_t buffered, size_t capacity) {
  return playing && !stopped && elapsedMs < 2200 && buffered < capacity / 2;
}

#ifdef BOB_TEST_CONSOLE
// HIL hook (`T mp3 abort_at_begin`): the next MP3 decode task holds before
// begin() until playback is stopped (bounded), so a stop pressed as the reply
// starts always lands between playback_started and begin().
void testArmMp3AbortAtBegin();
#endif

class AudioPlayback {
 public:
  AudioPlayback();
  ~AudioPlayback();

  // Allocates the PCM playback buffer at boot. Kept for API stability; the
  // PCM buffer is now allocated lazily on the first PCM reply so MP3 replies
  // keep the full heap. Returns true (nothing to preallocate).
  bool allocateBuffer();

  // Frees the lazy PCM buffer after a PCM reply has drained.
  void freePcmBuffer();

  // Begins a reply in the given format. For MP3 this starts the decode task.
  void beginPlayback(AudioFormat format, bool finishAnnouncementCue = false);

  // Pushes one audio_down payload into the playback pipeline.
  // For PCM: copies into the bounded PCM ring and feeds free speaker slots.
  // For MP3: copies into the ring buffer for the decode task.
  void pushDownlink(const Olx2Header& header, const uint8_t* payload);

  // The server sent playback_end: close the stream and let the buffered audio
  // drain. Non-blocking; loop() finishes the teardown once the speaker is idle,
  // so keys (volume, stop) keep working while the reply plays out.
  void finishStream();

  // Stops now: flushes the MP3 ring and the speaker and tears down (bounded
  // ~0.5 s wait for the decode task). Used by stop/cancel and every path that
  // must silence the speaker immediately.
  void abort();

  // True while a reply is being received, decoded or played.
  bool active() const;

  // True between finishStream() and the end of the drain.
  bool draining() const;

  // Current format of the active reply.
  AudioFormat format() const;

  // The reply's timing stamps (turn_timing.h): playback_start receipt, first
  // frame, decoder ready, first speaker submission and teardown. They outlive
  // the reply until clearStamps() or the next beginPlayback().
  const PlaybackStamps& stamps() const { return stamps_; }
  void clearStamps() { stamps_.clear(); }

  // Number of downlink frames received for the active reply.
  uint32_t downFrameCount() const;

  // Updates the last-frame timestamp; call when any downlink frame arrives.
  void markFrameReceived();

  // Returns the millis() of the last received downlink frame.
  uint32_t lastFrameAt() const;

  // True if no frame has arrived for the stall threshold.
  bool isStalled(uint32_t now) const;

  // Returns true if an overflow was logged this reply.
  bool overflowLogged() const;

  // Drives the drain: once the stream is closed (or the decoder exited) and
  // the speaker is idle, tears the reply down. Call every main-loop tick.
  void loop();

  // Diagnostic tone test (BOB_TONE_TEST build flag only): plays 1 s of a
  // 1 kHz sine through the speaker and journals the wall-clock time, so a
  // wrong speaker/I2S clock can be measured independent of decode pacing.
  void toneTest();

 private:
  // PCM path state: a bounded ring plus three speaker chunks, allocated per
  // reply (#674). pcmSamples_ counts samples the speaker accepted.
  struct PcmState;
  PcmState* pcm_;
  size_t pcmSamples_;

  // Moves ring audio into free speaker queue slots; never blocks.
  void pumpPcm();

  // Shared reply state.
  PlaybackStamps stamps_;
  bool active_;
  AudioFormat format_;
  uint32_t downFrames_;
  uint32_t lastFrameAt_;
  bool overflowLogged_;

  // Downlink sequence tracking (diagnostics): first/last sequence numbers of
  // the active reply and the count of gaps detected against the expected
  // +1 increment. Reported on the playback_completed journal line.
  uint32_t firstSeq_;
  uint32_t lastSeq_;
  uint32_t seqGapCount_;

  // Drain state: set by finishStream(), cleared by teardown. decodeExited_
  // latches the decode task's one-shot exit signal once loop() has seen it.
  bool draining_;
  uint32_t drainStartedAt_;
  bool decodeExited_;

  // MP3 path state (opaque pointers to keep the header clean).
  struct Mp3State;
  Mp3State* mp3_;

  // Frees the reply and journals playback_completed. `drained` is true once
  // the decode task provably no longer touches the MP3 objects; otherwise
  // they are deliberately leaked.
  void teardownMp3(bool drained);
  void teardownPcm();
};

// How loud the reply being played is, 0..1: the RMS envelope of the PCM written to the speaker (PCM and MP3
// replies alike), -50 dBFS = 0 and -5 dBFS = 1, smoothed over about 80 ms; 0 when idle. Read-only and
// thread-safe (atomics only), for the Waveshare ring light.
float playbackLevel01();

}  // namespace bob
