// Bob — barge-in policy (#1364): when the wake model may listen while Bob
// speaks, and how strict it is then. Pure, so it is host-tested.
#pragma once

#include <cstdint>

namespace bob {

struct BargeInputs {
  bool welcomed = false;
  bool wakeMode = false;      // Always awake.
  bool wakeFailed = false;
  bool followUpOpen = false;
  bool updateBusy = false;
  bool playingState = false;  // State is kAwaiting or kAnnounce.
  bool duplexActive = false;  // a reply or announcement plays through the full-duplex loop.
  bool waveshare = false;     // the Cardputer's mic and speaker share GPIO 43: never there.
};

inline bool bargeWanted(const BargeInputs& in) {
  return in.waveshare && in.welcomed && in.wakeMode && !in.wakeFailed && !in.followUpOpen &&
         !in.updateBusy && in.playingState && in.duplexActive;
}

// While Bob plays the echo canceller leaves residual echo, and a false barge cuts
// Bob off mid-sentence, so the cutoff rises by this share of the headroom left
// below the model's max: half (Hey Bob 247 -> 251, alexa 229 -> 242).
constexpr uint16_t kBargeCutoffHeadroomDivisor = 2;
// The model's probability is a uint8, so no window sum can pass a higher cutoff.
constexpr uint16_t kProbabilityMax = 255;

inline uint16_t bargeCutoff(uint16_t readyCutoff) {
  if (readyCutoff >= kProbabilityMax) return kProbabilityMax;
  return static_cast<uint16_t>(readyCutoff + (kProbabilityMax - readyCutoff) / kBargeCutoffHeadroomDivisor);
}

// Diagnostic: how many of the last kNearEndWindowFrames (1.2 s) 10 ms frames the
// canceller judged to hold a near-end talker. Logged in barge_stats; it does not
// gate barge-in (the echo's level is too close to a real talker's for an energy
// flag to tell them apart).
constexpr int kNearEndWindowFrames = 120;

class NearEndGate {
 public:
  // One call per 10 ms frame: did the canceller judge it to hold a near-end talker?
  void push(bool nearEnd) {
    count_ -= flags_[next_] ? 1 : 0;
    flags_[next_] = nearEnd;
    count_ += nearEnd ? 1 : 0;
    next_ = (next_ + 1) % kNearEndWindowFrames;
  }
  int nearEndFrames() const { return count_; }

 private:
  bool flags_[kNearEndWindowFrames] = {};
  int next_ = 0;
  int count_ = 0;
};

}  // namespace bob
