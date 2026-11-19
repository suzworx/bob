// Audio-driver seam for the real earcons.cpp. Playback retains the caller's
// PCM pointer, just like M5Unified; no eager copy can hide lifetime mistakes.
#pragma once
#include <cstddef>
#include <cstdint>
#include "Arduino.h"

namespace hostshim {
struct Microphone {
  bool running = false;
  bool isRunning() const { return running; }
};

struct Speaker {
  bool running = false;
  bool playing = false;
  unsigned int begins = 0;
  unsigned int rawCalls = 0;
  unsigned int toneCalls = 0;
  bool lastStopCurrent = false;
  uint32_t endsAt = 0;
  const uint8_t* samples = nullptr;
  size_t sampleCount = 0;
  bool begin() { running = true; ++begins; return true; }
  void end() { running = false; playing = false; samples = nullptr; }
  bool isRunning() const { return running; }
  bool isPlaying() {
    if (millis() >= endsAt) playing = false;
    return playing;
  }
  bool isPlaying(uint8_t) { return isPlaying(); }
  void setChannelVolume(uint8_t, uint8_t) {}
  uint8_t getChannelVolume(uint8_t) const { return 255; }
  bool tone(uint16_t, uint16_t ms, uint8_t, bool) {
    ++toneCalls;
    playing = true;
    endsAt = millis() + ms;
    return true;
  }
  bool playRaw(const uint8_t* pcm, size_t count, uint32_t rate, bool, uint32_t, uint8_t, bool stopCurrent = false) {
    lastStopCurrent = stopCurrent;
    ++rawCalls;
    samples = pcm;
    sampleCount = count;
    playing = true;
    endsAt = millis() + count * 1000 / rate;
    return true;
  }
  void stop(uint8_t) { playing = false; samples = nullptr; }
};

struct Cardputer {
  Microphone Mic;
  hostshim::Speaker Speaker;
};
}  // namespace hostshim

inline hostshim::Cardputer M5Cardputer;
inline void delay(uint32_t ms) { hostshim::g_millis += ms; }
