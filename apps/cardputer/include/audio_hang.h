// Hang guard for audio-driver calls. Escaped defect, Waveshare 2026-10-15: Speaker.end() after
// Mic.end() on the shared I2S port never returned, so the turn sat on LISTENING and the device
// went silent. A blocked call cannot watch itself, so a watcher outside it (a 250 ms esp_timer,
// src/audio_hang_watch.cpp) asks check(); the timing rule lives here and is host-tested.
#pragma once

#include <stdint.h>

#include <atomic>

namespace bob {

constexpr uint32_t kAudioHangMs = 2000;  // a driver call that takes this long is stuck

enum class AudioStage : uint8_t { kNone, kEndTurn, kMicEnd, kSpeakerEnd, kSpeakerBegin };

inline const char* audioStageName(AudioStage s) {
  switch (s) {
    case AudioStage::kEndTurn: return "end_turn";
    case AudioStage::kMicEnd: return "mic_end";
    case AudioStage::kSpeakerEnd: return "speaker_end";
    case AudioStage::kSpeakerBegin: return "speaker_begin";
    default: return "none";
  }
}

// One innermost call is tracked at a time: enter() returns what it replaces, leave() restores it,
// so a nested call (Speaker.end inside endTurn) times itself and the outer call resumes after.
class AudioHangGuard {
 public:
  struct Frame {
    AudioStage stage;
    uint32_t startMs;
  };

  Frame enter(AudioStage stage, uint32_t nowMs) {
    const Frame prev{static_cast<AudioStage>(stage_.load()), startMs_.load()};
    startMs_.store(nowMs);
    stage_.store(static_cast<uint8_t>(stage));
    return prev;
  }
  void leave(const Frame& prev) {
    startMs_.store(prev.startMs);
    stage_.store(static_cast<uint8_t>(prev.stage));
  }

  // The stage that has been stuck for kAudioHangMs, else kNone. Safe from another task.
  AudioStage check(uint32_t nowMs) const {
    const AudioStage stage = static_cast<AudioStage>(stage_.load());
    if (stage == AudioStage::kNone) return AudioStage::kNone;
    return static_cast<uint32_t>(nowMs - startMs_.load()) >= kAudioHangMs ? stage : AudioStage::kNone;
  }

 private:
  std::atomic<uint8_t> stage_{static_cast<uint8_t>(AudioStage::kNone)};
  std::atomic<uint32_t> startMs_{0};
};

inline AudioHangGuard& audioHang() {
  static AudioHangGuard guard;
  return guard;
}

// Brackets one driver call: AudioCall call(AudioStage::kMicEnd, millis()); Mic.end();
class AudioCall {
 public:
  AudioCall(AudioStage stage, uint32_t nowMs) : prev_(audioHang().enter(stage, nowMs)) {}
  ~AudioCall() { audioHang().leave(prev_); }
  AudioCall(const AudioCall&) = delete;
  AudioCall& operator=(const AudioCall&) = delete;

 private:
  AudioHangGuard::Frame prev_;
};

// Starts the watcher (src/audio_hang_watch.cpp, firmware only; active on the Waveshare).
void startAudioHangWatch();

}  // namespace bob
