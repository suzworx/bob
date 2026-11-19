// Bob Cardputer v2 — microphone capture and uplink framing.
#include "audio_capture.h"

#include <cstdlib>
#include <cstring>
#include <new>
#include <esp_heap_caps.h>
#include <M5Cardputer.h>
#include "audio_capture_rate.h"
#include "audio_hang.h"
#include "config.h"
#include "level_meter.h"
#include "protocol.h"
#include "wake_stats.h"

namespace bob {

#if defined(BOB_BOARD_WAVESHARE_185C)
constexpr uint32_t kMicWarmupMs = 400;  // mic frames discarded after Mic.begin()
#endif

AudioCapture::AudioCapture()
    : active_(false),
      audioFrame_{},
      sequence_(0) {}

bool AudioCapture::begin() {
  if (active_) return true;
  const size_t ringBytes = kCaptureRingFrames * config::kSamplesPerFrame * sizeof(int16_t);
#if defined(BOB_BOARD_WAVESHARE_185C)
  // 640 ms of PCM is too much for the internal heap the loop needs: PSRAM first, plain heap if it is short.
  ringPcm_ = static_cast<int16_t*>(heap_caps_malloc(ringBytes, MALLOC_CAP_SPIRAM));
  if (ringPcm_ == nullptr) ringPcm_ = static_cast<int16_t*>(malloc(ringBytes));
#else
  ringPcm_ = static_cast<int16_t*>(malloc(ringBytes));
#endif
  ring_ = ringPcm_ ? new (std::nothrow) Ring(ringPcm_) : nullptr;
  // Only set while the mic is stopped (Mic_Class.hpp).
  M5Cardputer.Mic.setBufferReleaseCallback(this, &AudioCapture::onBufferFilled);
  active_ = ring_ != nullptr && M5Cardputer.Mic.begin();
  current_ = nullptr;
  failed_ = false;
  framesTaken_ = 0;
#if defined(BOB_BOARD_WAVESHARE_185C)
  // Only the first start after boot has the silent warm-up; later turns must keep every frame.
  static bool warmedUp = false;
  beganAtMs_ = warmedUp ? millis() - kMicWarmupMs : millis();
  warmedUp = true;
#endif
  if (active_) topUp(false);
  if (!active_ || failed_) {
    end();
    return false;
  }
  return true;
}

void AudioCapture::end() {
  // After Mic.end() returns no release callback runs, so the ring is ours.
  if (active_) {
    AudioCall guard(AudioStage::kMicEnd, millis());
    M5Cardputer.Mic.end();
  }
  active_ = false;
  M5Cardputer.Mic.setBufferReleaseCallback(nullptr, nullptr);
  delete ring_;
  ring_ = nullptr;
  free(ringPcm_);
  ringPcm_ = nullptr;
  current_ = nullptr;
#ifdef BOB_TEST_CONSOLE
  if (toneUsed_) {
    toneFrames_ = 0;
    toneUsed_ = false;
  }
#endif
}

#ifdef BOB_TEST_CONSOLE
void AudioCapture::armTestTone(uint32_t ms) {
  toneFrames_ = (ms + 9) / 10;
  toneSample_ = 0;
  toneUsed_ = false;
}
#endif

bool AudioCapture::active() const { return active_; }

void AudioCapture::onBufferFilled(void* self, void* data, size_t /*length*/) {
  AudioCapture* capture = static_cast<AudioCapture*>(self);
  if (capture->ring_ == nullptr || !capture->ring_->markFilled(data)) return;
  capture->topUp(true);
}

// A caller that finds the token taken only leaves refillWanted_ set and
// returns; the holder clears it before each pass and, after letting go of
// the token, passes again while it is set (all seq_cst). So a slot the mic
// freed while the other side was queueing is never left empty until the next
// loop. (Before review 2026-09-24 the loser cleared the request itself with
// exchange() and then returned: that refill was lost.)
void AudioCapture::topUp(bool fromMicTask) {
  refillWanted_.store(true);
  for (;;) {
    bool idle = false;
    if (!queueing_.compare_exchange_strong(idle, true)) return;  // the holder re-checks.
    refillWanted_.store(false);
    bool refused = false;
    while (int16_t* buffer = ring_->claimForQueue()) {
      if (!M5Cardputer.Mic.record(buffer, config::kSamplesPerFrame, config::kSampleRateHz)) {
        ring_->unclaim();
        // From the mic task a refusal is transient (a stop in progress, the
        // lock busy); the main loop retries. From the main loop it is real.
        if (!fromMicTask) failed_ = true;
        refused = true;
        break;
      }
    }
    queueing_.store(false);
    if (refused || !refillWanted_.load()) return;
  }
}

bool AudioCapture::nextFrame() {
  if (!active_ || failed_) return false;
  if (current_ != nullptr) {
    ring_->pop();
    current_ = nullptr;
  }
  topUp(false);  // after a full ring, or a refill the mic task skipped.
  const int16_t* ready = ring_->peek();
  if (ready == nullptr) return false;
#if defined(BOB_BOARD_WAVESHARE_185C)
  // The ES7210/I2S path delivers near-silent frames for the first moments after Mic.begin(). They
  // would pin the VAD noise floor ~20 dB under the real idle level, and the floor only rises 1 dB/s,
  // so a turn started soon after would hear the room as continuous speech and run to the 15 s cap.
  if (millis() - beganAtMs_ < kMicWarmupMs) {
    // Drop every frame filled so far, not one per pass: they are all near-silent.
    while (ring_->peek() != nullptr && millis() - beganAtMs_ < kMicWarmupMs) ring_->pop();
    topUp(false);  // the drained slots go straight back to the mic, so no audio is lost after warm-up
    return false;
  }
#endif
  // The ring's own storage: the tone may overwrite it in place.
  current_ = const_cast<int16_t*>(ready);
  // The first take can come a slow pass after the mic filled it: backdate by the frames waiting.
  if (framesTaken_ == 0) firstFrameAtMs_ = captureStartMs(millis(), ring_->ready(), config::kFrameMs);
  ++framesTaken_;
#ifdef BOB_TEST_CONSOLE
  if (toneFrames_ > 0) {
    // 440 Hz at 16 kHz repeats every 400 samples; about -12 dBFS.
    for (size_t i = 0; i < config::kSamplesPerFrame; ++i) {
      current_[i] = static_cast<int16_t>(
          8000.0f * sinf(2.0f * PI * 440.0f * toneSample_ / config::kSampleRateHz));
      toneSample_ = (toneSample_ + 1) % 400;
    }
    --toneFrames_;
    toneUsed_ = true;
  }
#endif
  return true;
}

bool AudioCapture::failed() const { return failed_; }

const int16_t* AudioCapture::frame() const { return current_; }

void AudioCapture::sendFrame(SendFrameCallback send) {
  if (current_ == nullptr) return;
  std::memcpy(audioFrame_, config::kFrameMagic, 4);
  audioFrame_[4] = config::kFrameVersion;
  audioFrame_[5] = config::kKindAudioUp;
  audioFrame_[6] = config::kFormatPcm16;
  audioFrame_[7] = 1;  // channels
  writeU32(audioFrame_, 8, 1);  // proof-of-concept turn handle
  writeU32(audioFrame_, 12, sequence_);
  writeU32(audioFrame_, 16, config::kSamplesPerFrame * sizeof(int16_t));
  std::memcpy(audioFrame_ + config::kHeaderBytes, current_,
              config::kSamplesPerFrame * sizeof(int16_t));
  send(audioFrame_, config::kPcmFrameBytes);
  sequence_ += 1;
}

uint32_t AudioCapture::framesTaken() const { return framesTaken_; }

// The mic's frames delivered per second since its first frame (the fps of
// docs/log-reference.md turn_ended: 97-103 when capture is gap-free). Frames
// still in the ring unread count too, since endTurn reads this before the
// release pass drains them (audio_capture_rate.h).
uint32_t AudioCapture::framesPerSecond(uint32_t nowMs) const {
  return captureFramesPerSecond(framesTaken_, ring_ ? ring_->ready() : 0, current_ != nullptr,
                                firstFrameAtMs_, nowMs);
}

void AudioCapture::resetSequence() { sequence_ = 0; }

void AudioCapture::setSequence(uint32_t next) { sequence_ = next; }

uint32_t AudioCapture::nextSequence() { return sequence_; }

float captureLevel01() { return level::captureMeter().level(millis()); }

}  // namespace bob
