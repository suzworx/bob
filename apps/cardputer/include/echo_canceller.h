// NLMS acoustic echo canceller: removes the speaker's own signal from the mic so the wake model can
// listen while Bob speaks (barge-in, #1364). The reference is the exact digital stream written to the
// speaker; the speaker-to-mic path is a constant bulk delay plus a short room response the filter learns.
// The mic arrives unclipped (int32): the echo can be louder than the reference, and a clipped mic is an
// echo the filter cannot model.
//
// Pure DSP: no Arduino/FreeRTOS, no heap. The history and weights are fixed arrays sized by the template
// parameters, so the caller can place the object in PSRAM (about 4 * (2 * Taps + 2 * (Taps + MaxDelay)) bytes).
//
// Two paths: the foreground filter makes the output and never adapts; the background filter adapts by NLMS
// on every block with reference signal. Every kCopyBlock samples the background replaces the foreground once
// it leads (two blocks in a row), and the foreground is copied back into it when the background makes the
// mic worse. No double-talk gate: a near-end talker raises the error of both paths alike, so the background
// cannot win on it and the foreground keeps its weights.
//
// CPU: one fused pass over the taps per sample (apply the previous sample's background update and take both
// dot products in the same loop: Taps multiply-adds for the update, 2 * Taps for the dot products, one load
// and one store of each background weight). The silence peak is a decaying running max updated per sample,
// not a scan, and the window energy is a float updated incrementally and recomputed exactly every kCheckEvery
// samples. 128 taps (8 ms, enough for a speaker and mic on one board) is half the cost of 256.
#pragma once

#include <math.h>
#include <stddef.h>
#include <stdint.h>

namespace bob {

template <size_t Taps, size_t MaxDelay>
class NlmsEchoCanceller {
 public:
  static constexpr float kMu = 0.5f;            // NLMS step size: 0 < mu < 2, 0.5 is fast yet stable
  static constexpr float kEps = 1.0e5f;         // regularizer on int16^2 scale (a window of ~1 LSB noise per tap)
  static constexpr float kCopyRatio = 0.5f;     // default two-path copy ratio (see setDoubleTalkThreshold)
  static constexpr float kSilentRef = 16.0f;    // reference peak below this (LSB) counts as silence: no adapt
  static constexpr float kDcPole = 0.995f;      // mic DC blocker pole: ~13 Hz at 16 kHz, before both paths

  NlmsEchoCanceller() { reset(); }

  // Full reset: weights, counters and the bulk delay (the caller sets the delay again).
  void reset() {
    clearWeights();
    resGain_ = 1.0f;
    resets_ = 0;
    nonFinite_ = 0;
    delay_ = 0;
    beginReply();
  }

  // Start of a reply: history, DC blocker, ERLE sums and per-reply flags start over, the weights stay. The
  // speaker-to-mic path is the same hardware from one reply to the next, so what was learned still holds.
  void beginReply() {
    for (size_t i = 0; i < 2 * kHist; ++i) hist_[i] = 0.0f;
    head_ = 0;
    energy_ = 0.0f;
    peak_ = 0.0f;
    sinceCheck_ = 0;
    sinceBlock_ = 0;
    blockLive_ = 0;
    goodBlocks_ = 0;
    blockErr_ = 0.0f;
    blockFg_ = 0.0f;
    blockMic_ = 0.0f;
    blockOut_ = 0.0f;
    gPending_ = 0.0f;
    dcIn_ = 0.0f;
    dcOut_ = 0.0f;
    erleMic_ = 0.0;
    erleOut_ = 0.0;
    micClips_ = 0;
    reverted_ = false;
    frozen_ = false;
    nearEnd_ = false;
  }

  // Samples of delay between the speaker write and the echo reaching the mic, 0..MaxDelay.
  void setBulkDelay(size_t samples) {
    delay_ = samples > MaxDelay ? MaxDelay : samples;
    resync();
  }

  // Two-path copy ratio, default 0.5: the background replaces the foreground once its error energy is under
  // this fraction of the foreground's for two blocks in a row. Lower it to switch sooner only on clear wins.
  // Survives reset(): it is tuning, not state.
  void setDoubleTalkThreshold(float ratio) { copyRatio_ = (ratio > 0.0f && ratio < 1.0f) ? ratio : kCopyRatio; }
  float doubleTalkThreshold() const { return copyRatio_; }

  // ref: the n samples written to the speaker. mic: the n time-aligned raw captures (int32, unclipped).
  // out receives the foreground error (the mic with the echo estimate removed), clipped to int16.
  void process(const int16_t* ref, const int32_t* mic, int16_t* out, size_t n) {
    size_t silentCount = 0;
    float refAcc = 0.0f, outAcc = 0.0f;
    for (size_t i = 0; i < n; ++i) {
      push(static_cast<float>(ref[i]));
      refAcc += energy_;  // filter-window energy: the reference power aligned with the echo at the mic
      const float* __restrict x = &hist_[head_ + delay_];
      float* __restrict wb = wb_;
      const float* __restrict wf = wf_;
      // Fused: wb += gPending * x(previous sample), then both estimates. x(previous)[j] is x[j + 1].
      const float gp = gPending_;
      float b0 = 0.0f, b1 = 0.0f, b2 = 0.0f, b3 = 0.0f;
      float f0 = 0.0f, f1 = 0.0f, f2 = 0.0f, f3 = 0.0f;
      for (size_t j = 0; j < Taps; j += 4) {
        const float w0 = wb[j] + gp * x[j + 1];
        const float w1 = wb[j + 1] + gp * x[j + 2];
        const float w2 = wb[j + 2] + gp * x[j + 3];
        const float w3 = wb[j + 3] + gp * x[j + 4];
        wb[j] = w0;
        wb[j + 1] = w1;
        wb[j + 2] = w2;
        wb[j + 3] = w3;
        b0 += w0 * x[j];
        b1 += w1 * x[j + 1];
        b2 += w2 * x[j + 2];
        b3 += w3 * x[j + 3];
        f0 += wf[j] * x[j];
        f1 += wf[j + 1] * x[j + 1];
        f2 += wf[j + 2] * x[j + 2];
        f3 += wf[j + 3] * x[j + 3];
      }
      const float estB = (b0 + b1) + (b2 + b3), estF = (f0 + f1) + (f2 + f3);
      const float raw = static_cast<float>(mic[i]);
      if (raw > 32767.0f || raw < -32768.0f) ++micClips_;
      // DC blocker on the mic: the offset the reference cannot model is removed before both paths.
      const float m = raw - dcIn_ + kDcPole * dcOut_;
      dcIn_ = raw;
      dcOut_ = m;
      float eb = m - estB, ef = m - estF;
      if (!isfinite(estF) || !isfinite(ef)) {  // foreground went NaN/inf: start over, pass the mic through
        ++nonFinite_;
        guardReset();
        eb = ef = m;
      } else if (!isfinite(estB) || !isfinite(eb)) {  // background went NaN/inf: take the foreground's weights
        ++nonFinite_;
        ++resets_;
        reverted_ = true;
        copyWeights(wb_, wf_);
        eb = ef;
      }
      const bool silent = peak_ < kSilentRef;
      const float o = ef > 32767.0f ? 32767.0f : ef < -32768.0f ? -32768.0f : ef;
      out[i] = static_cast<int16_t>(lrintf(o));
      outAcc += o * o;
      if (silent) {
        ++silentCount;
        gPending_ = 0.0f;
      } else {
        gPending_ = kMu * eb / (kEps + energy_);
        blockErr_ += eb * eb;
        blockFg_ += ef * ef;
        blockMic_ += m * m;
        blockOut_ += o * o;
        ++blockLive_;
      }
      if (++sinceCheck_ >= kCheckEvery) check();
      if (++sinceBlock_ >= kCopyBlock) evaluate();
    }
    frozen_ = n > 0 && (silentCount * 2 > n || reverted_);
    reverted_ = false;
    if (n > 0) updateNearEnd(refAcc / static_cast<float>(n * Taps), outAcc / static_cast<float>(n));
  }

  // True when the last block holds more than residual echo: out power above kNearEndMargin times the
  // learned residual gain times the reference power (plus a floor). With a silent reference this is
  // simply "the mic is above the floor". The wake gate should only trust the model while this is true.
  bool nearEnd() const { return nearEnd_; }

  // Residual echo gain (out power over reference power on echo-only blocks), dB. Starts at 0 and falls as
  // the filter converges; for the journal.
  float residualGainDb() const {
    const float r = 10.0f * log10f(resGain_ + 1.0e-9f);
    return isfinite(r) ? r : 0.0f;
  }

  // Echo return loss enhancement, dB: mic power over output power since reset(), counted on the samples with
  // reference signal. 0 before any such audio. Always finite.
  float erleDb() const {
    if (erleMic_ <= 0.0) return 0.0f;
    const double r = 10.0 * log10(erleMic_ / (erleOut_ + 1.0e-9));
    return isfinite(r) ? static_cast<float>(r) : 0.0f;
  }

  // True when the last block had a silent reference, or the background made the mic worse and the foreground
  // was put back into it (the foreground held).
  bool frozen() const { return frozen_; }

  // Samples since reset() whose raw mic was beyond int16.
  uint32_t micClips() const { return micClips_; }

  // Times the guard acted: the foreground was zeroed with the background (non-finite estimate, or weight norm
  // above kMaxWeightNormSq), or the background was restarted from the foreground (non-finite, or norm above the
  // bound). The copy-back in evaluate() is not counted: it is the normal path, reported by frozen().
  uint32_t resets() const { return resets_; }
  // Subset of resets() caused by a NaN/inf estimate.
  uint32_t nonFinite() const { return nonFinite_; }

 private:
  static constexpr size_t kHist = Taps + MaxDelay;
  static_assert(Taps % 4 == 0, "the fused loop is unrolled by 4");
  static constexpr float kNearEndMargin = 4.0f;      // 6 dB over the expected residual echo
  static constexpr float kNearEndFloor = 1000.0f;    // absolute out power (int16^2, ~32 LSB rms) below which nothing counts
  static constexpr float kMinRefPow = 1000.0f;       // reference power needed to learn the residual gain
  static constexpr float kGainDown = 0.25f;          // gain estimate follows improvements fast, rises slowly
  static constexpr float kGainUp = 0.02f;
  static constexpr size_t kCheckEvery = 256;        // exact energy recompute + weight norm check
  static constexpr size_t kCopyBlock = 160;         // 10 ms: the two-path copy decision (see evaluate())
  static constexpr float kMaxWeightNormSq = 1.0e4f;  // |w| > 100: a real path never needs it (mic gain ~x16)
  static constexpr float kPeakDecay = 1.0f - 1.0f / static_cast<float>(Taps);

  void updateNearEnd(float refPow, float outPow) {
    if (!isfinite(refPow) || !isfinite(outPow)) return;
    nearEnd_ = outPow > kNearEndMargin * resGain_ * refPow + kNearEndFloor;
    if (!nearEnd_ && refPow > kMinRefPow) {  // echo-only block: learn the residual gain
      const float r = outPow / refPow;
      resGain_ += (r < resGain_ ? kGainDown : kGainUp) * (r - resGain_);
    }
  }

  void clearWeights() {
    for (size_t i = 0; i < Taps; ++i) wf_[i] = wb_[i] = 0.0f;
    gPending_ = 0.0f;
  }

  // The pending background update was computed for wb_: it is dropped only when wb_ is overwritten.
  void copyWeights(float* dst, const float* src) {
    for (size_t i = 0; i < Taps; ++i) dst[i] = src[i];
    if (dst == wb_) gPending_ = 0.0f;
  }

  void guardReset() {
    ++resets_;
    clearWeights();
  }

  // Newest sample at hist_[head_]; each sample is stored twice so every window is contiguous.
  // hist_[head_ + delay_ + Taps] (read as x[Taps] by the fused loop) is always inside the array.
  void push(float v) {
    head_ = head_ == 0 ? kHist - 1 : head_ - 1;
    hist_[head_] = v;
    hist_[head_ + kHist] = v;
    // The filter window is hist_[head_ + delay_ .. + Taps - 1]: one sample enters, one leaves.
    const float in = hist_[head_ + delay_];
    const float gone = hist_[head_ + delay_ + Taps];
    energy_ += in * in - gone * gone;
    // Silence peak: running max with a 1/Taps decay per sample instead of a Taps-long scan. It
    // overestimates the true window max for up to a few filter lengths after a loud sample leaves, so
    // adaptation runs a little past the end of a reply.
    const float a = fabsf(in);
    const float d = peak_ * kPeakDecay;
    peak_ = a > d ? a : d;
  }

  // Exact window energy and peak (after a delay change).
  void resync() {
    float en = 0.0f, pk = 0.0f;
    const float* x = &hist_[head_ + delay_];
    for (size_t j = 0; j < Taps; ++j) {
      en += x[j] * x[j];
      const float a = fabsf(x[j]);
      if (a > pk) pk = a;
    }
    energy_ = en;
    peak_ = pk;
    sinceCheck_ = 0;
  }

  // Every kCopyBlock samples: move weights between the two paths. The background takes over the foreground
  // after two good blocks in a row (its error under copyRatio_ of the foreground's). The foreground goes back
  // into the background when the background's error is above the mic energy: it made the mic worse than nothing.
  // Blocks without reference signal are not judged.
  void evaluate() {
    if (blockLive_ > 0) {
      erleMic_ += blockMic_;  // the double totals take one add per block, not per sample (no double FPU on ESP32)
      erleOut_ += blockOut_;
      if (blockErr_ > blockMic_) {
        copyWeights(wb_, wf_);
        reverted_ = true;
        goodBlocks_ = 0;
      } else if (blockErr_ < copyRatio_ * blockFg_) {
        if (++goodBlocks_ >= 2) {
          copyWeights(wf_, wb_);
          goodBlocks_ = 0;
        }
      } else {
        goodBlocks_ = 0;
      }
    }
    blockErr_ = 0.0f;
    blockFg_ = 0.0f;
    blockMic_ = 0.0f;
    blockOut_ = 0.0f;
    blockLive_ = 0;
    sinceBlock_ = 0;
  }

  // Every kCheckEvery samples: clear float drift in the energy and bound the weights. An over-large background
  // restarts from the foreground; an over-large foreground zeroes both.
  void check() {
    float en = 0.0f, fn = 0.0f, bn = 0.0f;
    const float* x = &hist_[head_ + delay_];
    for (size_t j = 0; j < Taps; ++j) {
      en += x[j] * x[j];
      fn += wf_[j] * wf_[j];
      bn += wb_[j] * wb_[j];
    }
    energy_ = en;
    sinceCheck_ = 0;
    if (!isfinite(fn) || fn > kMaxWeightNormSq) {
      guardReset();
    } else if (!isfinite(bn) || bn > kMaxWeightNormSq) {
      ++resets_;
      reverted_ = true;
      copyWeights(wb_, wf_);
    }
  }

  float wf_[Taps];  // foreground: makes the output, never adapts
  float wb_[Taps];  // background: adapts by NLMS, copied to and from the foreground
  float hist_[2 * kHist];
  size_t head_ = 0;
  size_t delay_ = 0;
  size_t sinceCheck_ = 0;
  size_t sinceBlock_ = 0;
  size_t blockLive_ = 0;   // samples of the current copy block with reference signal
  size_t goodBlocks_ = 0;  // blocks in a row the background beat the foreground by copyRatio_
  float copyRatio_ = kCopyRatio;
  float energy_ = 0.0f;
  float peak_ = 0.0f;
  float gPending_ = 0.0f;
  float blockErr_ = 0.0f, blockFg_ = 0.0f, blockMic_ = 0.0f, blockOut_ = 0.0f;  // energies over the current copy block
  float dcIn_ = 0.0f, dcOut_ = 0.0f;  // DC blocker state (previous raw mic, previous blocked mic)
  double erleMic_ = 0.0, erleOut_ = 0.0;
  uint32_t micClips_ = 0;
  bool reverted_ = false;
  bool frozen_ = false;
  bool nearEnd_ = false;
  float resGain_ = 1.0f;
  uint32_t resets_ = 0;
  uint32_t nonFinite_ = 0;
};

}  // namespace bob
