// Speaker loopback self-test (P0 #1063): a Waveshare reply played its whole length in silence while
// every digital counter looked healthy. `T spk test` (hil console) plays a 1 kHz tone through the
// ES8311 + amplifier and records it back through the onboard ES7210 mic on the same full-duplex I2S
// port: quiet (amp on, zeros), tone with the amp off, tone with the amp on. The pass rule and the
// level math live here, pure and host-tested; the I2S work is ws185::speakerSelfTest().
#pragma once

#include <math.h>
#include <stddef.h>
#include <stdint.h>

namespace bob {
namespace spktest {

constexpr uint32_t kSampleRateHz = 16000;
constexpr uint32_t kToneHz = 1000;
constexpr int16_t kToneAmplitude = 4096;  // -18 dBFS: heard across a room, never loud (quiet tests at night)
constexpr uint32_t kPhaseMs = 400;        // per phase
constexpr uint32_t kSettleMs = 100;       // discarded at the start of each phase (amp switch-on, DMA fill)
// The mic must hear the tone this far above the quiet phase. A working speaker a few centimetres from
// the mic measures far more; an amp that never switches on, a muted DAC or a dead path measures ~0 dB.
constexpr float kMinRiseDb = 12.0f;

// RMS with the DC removed (the ES7210 output carries an offset), over every sample added.
class AcRms {
 public:
  void add(int32_t sample) {
    sum_ += sample;
    sumSq_ += static_cast<double>(sample) * sample;
    ++n_;
  }
  float rms() const {
    if (n_ == 0) return 0.0f;
    const double mean = sum_ / n_;
    const double var = sumSq_ / n_ - mean * mean;
    return var > 0.0 ? static_cast<float>(sqrt(var)) : 0.0f;
  }
  uint32_t count() const { return n_; }

 private:
  double sum_ = 0.0;
  double sumSq_ = 0.0;
  uint32_t n_ = 0;
};

// The tone's sample at index i (1 kHz at 16 kHz: a 16-sample period).
inline int16_t toneSample(uint32_t i) {
  constexpr float kTwoPi = 6.28318530718f;
  const float phase = kTwoPi * static_cast<float>(i % (kSampleRateHz / kToneHz)) * kToneHz / kSampleRateHz;
  return static_cast<int16_t>(lroundf(kToneAmplitude * sinf(phase)));
}

// How far `level` stands above `floor`, in dB; +1 LSB keeps a digital zero finite.
inline float riseDb(float level, float floor) { return 20.0f * log10f((level + 1.0f) / (floor + 1.0f)); }

struct Levels {
  float quietRms = 0.0f;   // amp on, zeros out
  float ampOffRms = 0.0f;  // tone out, amp off: the DAC alone (should be quiet)
  float toneRms = 0.0f;    // tone out, amp on
};

struct Verdict {
  bool pass;
  float riseDb;        // tone over quiet
  float ampOffRiseDb;  // tone with the amp off over quiet (diagnostic)
  const char* stage;   // "ok", or where the sound is lost: "mic" (no samples), "silent" (no rise)
};

inline Verdict judge(const Levels& l, uint32_t micSamples) {
  const float rise = riseDb(l.toneRms, l.quietRms);
  const float offRise = riseDb(l.ampOffRms, l.quietRms);
  if (micSamples == 0) return {false, rise, offRise, "mic"};
  if (rise < kMinRiseDb) return {false, rise, offRise, "silent"};
  return {true, rise, offRise, "ok"};
}

}  // namespace spktest
}  // namespace bob
