// NLMS echo canceller (include/echo_canceller.h): convergence on a synthetic room, double-talk
// freeze, silent reference, saturation. Pure DSP, deterministic LCG noise.
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <vector>

#include "doctest.h"
#include "echo_canceller.h"

using bob::NlmsEchoCanceller;

namespace {

constexpr size_t kBlock = 160;       // 10 ms at 16 kHz
constexpr size_t kRate = 16000;
constexpr size_t kRoomTaps = 64;
constexpr size_t kRoomDelay = 40;

struct Lcg {
  uint32_t s = 12345;
  // Uniform in [-1, 1).
  float next() {
    s = s * 1664525u + 1013904223u;
    return static_cast<float>(static_cast<int32_t>(s)) / 2147483648.0f;
  }
};

// Fixed decaying random impulse response, peak 0.15: a speaker-to-mic path is far quieter than the ref.
std::vector<float> makeRoom() {
  Lcg rng;
  rng.s = 777;
  std::vector<float> h(kRoomTaps);
  for (size_t i = 0; i < kRoomTaps; ++i) h[i] = 0.15f * rng.next() * std::exp(-static_cast<float>(i) / 12.0f);
  return h;
}

// Plays ref through the room into a mic, optionally with a near-end signal, and feeds the canceller.
struct Sim {
  explicit Sim(NlmsEchoCanceller<256, 128>* a) : aec(a) {}
  NlmsEchoCanceller<256, 128>* aec;
  std::vector<float> room = makeRoom();
  std::vector<float> refHist = std::vector<float>(kRoomDelay + kRoomTaps, 0.0f);
  Lcg refRng, noiseRng, nearRng;
  float refAmp = 6000.0f;
  float noiseAmp = 10.0f;
  bool speechRef = false;                 // amplitude-modulated bursts (0.6 s period, pauses between) instead of steady noise
  std::function<void()> onBlock;          // called after each processed block
  bool voiced = false;                    // the last block had reference signal (not a speech pause)
  double nearSq = 0, resSq = 0;           // near-end power, and residual echo (out minus near-end), summed over runs
  size_t sampleNo = 0;

  // Runs `seconds` of audio; powers (mean square) of mic and out over the final `tailSeconds`.
  void run(float seconds, float tailSeconds, float nearAmp, double* micPow, double* outPow) {
    const size_t total = static_cast<size_t>(seconds * kRate) / kBlock * kBlock;
    const size_t tailStart = total - static_cast<size_t>(tailSeconds * kRate);
    double m = 0, o = 0;
    size_t cnt = 0;
    int16_t ref[kBlock], out[kBlock];
    int32_t mic[kBlock];
    float near[kBlock];
    for (size_t at = 0; at < total; at += kBlock) {
      voiced = false;
      for (size_t i = 0; i < kBlock; ++i) {
        float env = 1.0f;
        if (speechRef) {
          const float ph = static_cast<float>(sampleNo % 9600) / 9600.0f;  // 0.6 s
          env = ph < 0.7f ? std::sin(3.14159265f * ph / 0.7f) : 0.0f;
        }
        if (env > 0.0f) voiced = true;
        ++sampleNo;
        const float r = refAmp * env * refRng.next();
        refHist.insert(refHist.begin(), r);
        refHist.pop_back();
        float echo = 0;
        for (size_t k = 0; k < kRoomTaps; ++k) echo += room[k] * refHist[kRoomDelay + k];
        near[i] = nearAmp * nearRng.next();
        ref[i] = static_cast<int16_t>(r);
        mic[i] = static_cast<int32_t>(echo + noiseAmp * noiseRng.next() + near[i]);
      }
      aec->process(ref, mic, out, kBlock);
      for (size_t i = 0; i < kBlock; ++i) {
        nearSq += static_cast<double>(near[i]) * near[i];
        const double res = static_cast<double>(out[i]) - near[i];
        resSq += res * res;
      }
      if (onBlock) onBlock();
      if (at >= tailStart) {
        for (size_t i = 0; i < kBlock; ++i) {
          m += static_cast<double>(mic[i]) * mic[i];
          o += static_cast<double>(out[i]) * out[i];
          ++cnt;
        }
      }
    }
    *micPow = m / static_cast<double>(cnt);
    *outPow = o / static_cast<double>(cnt);
  }
};

double db(double a, double b) { return 10.0 * std::log10(a / b); }

}  // namespace

TEST_CASE("echo canceller: converges on a synthetic room, ERLE >= 20 dB after 1 s") {
  static NlmsEchoCanceller<256, 128> aec;
  aec.reset();
  aec.setBulkDelay(kRoomDelay);
  Sim sim(&aec);
  double mic, out;
  sim.run(1.0f, 0.25f, 0.0f, &mic, &out);
  const double erle = db(mic, out);
  printf("[echo_canceller] converge ERLE measured %.1f dB, erleDb() %.1f dB\n", erle, aec.erleDb());
  CHECK(erle >= 20.0);
  // erleDb() accumulates from reset(), so the first second (before convergence) keeps it under the tail ERLE.
  CHECK(aec.erleDb() >= 10.0f);
  CHECK(aec.erleDb() <= erle);
  CHECK_FALSE(aec.frozen());
}

TEST_CASE("echo canceller: a loud near-end talker passes through and does not diverge the filter") {
  static NlmsEchoCanceller<256, 128> aec;
  aec.reset();
  aec.setBulkDelay(kRoomDelay);
  Sim sim(&aec);
  double mic, out;
  sim.run(1.0f, 0.25f, 0.0f, &mic, &out);
  sim.run(0.5f, 0.5f, 16000.0f, &mic, &out);
  const double nearPow = (16000.0 * 16000.0) / 3.0;  // uniform noise power
  printf("[echo_canceller] double-talk out vs near %.1f dB\n", db(out, nearPow));
  CHECK(std::fabs(db(out, nearPow)) <= 3.0);
  sim.run(0.5f, 0.25f, 0.0f, &mic, &out);
  printf("[echo_canceller] ERLE after double talk %.1f dB\n", db(mic, out));
  CHECK(db(mic, out) >= 15.0);
}

// The mic path has gain, so the echo can be louder than the digital reference. The two-path canceller must
// still converge there (the old Geigel gate froze the filter on exactly this).
void scaleRoomToPeak(Sim* sim, float peak) {
  float cur = 0.0f;
  for (float v : sim->room) cur = std::fmax(cur, std::fabs(v));
  for (float& v : sim->room) v *= peak / cur;
}

TEST_CASE("echo canceller: loud room converges with the default copy ratio") {
  static NlmsEchoCanceller<256, 128> aec;
  double mic, out;

  aec.reset();
  aec.setBulkDelay(kRoomDelay);
  CHECK(aec.doubleTalkThreshold() == doctest::Approx(0.5f));
  Sim sim(&aec);
  sim.refAmp = 2000.0f;  // keeps the 2.0-peak echo inside int16
  scaleRoomToPeak(&sim, 2.0f);
  sim.run(1.0f, 0.25f, 0.0f, &mic, &out);
  printf("[echo_canceller] loud room ERLE %.1f dB\n", db(mic, out));
  CHECK(db(mic, out) >= 20.0);
  sim.run(0.5f, 0.5f, 8.0f * sim.refAmp, &mic, &out);  // near end 8x louder than the reference
  sim.run(0.5f, 0.25f, 0.0f, &mic, &out);
  printf("[echo_canceller] loud room ERLE after double talk %.1f dB\n", db(mic, out));
  CHECK(db(mic, out) >= 15.0);
}

// The copy ratio is a fraction: anything outside (0, 1) is the default, and tuning survives reset().
TEST_CASE("echo canceller: the copy ratio accepts 0..1 only and survives reset()") {
  static NlmsEchoCanceller<256, 128> aec;
  aec.setDoubleTalkThreshold(0.25f);
  aec.reset();
  CHECK(aec.doubleTalkThreshold() == doctest::Approx(0.25f));
  aec.setDoubleTalkThreshold(8.0f);
  CHECK(aec.doubleTalkThreshold() == doctest::Approx(0.5f));
}

// With no reference the output is the mic after the DC blocker (kDcPole), not the raw mic.
TEST_CASE("echo canceller: a silent reference passes the DC-blocked mic through") {
  static NlmsEchoCanceller<256, 128> aec;
  aec.reset();
  int16_t ref[kBlock] = {}, out[kBlock];
  int32_t mic[kBlock];
  Lcg rng;
  float dcIn = 0.0f, dcOut = 0.0f;
  for (int b = 0; b < 20; ++b) {
    for (size_t i = 0; i < kBlock; ++i) mic[i] = static_cast<int32_t>(9000.0f * rng.next());
    aec.process(ref, mic, out, kBlock);
    for (size_t i = 0; i < kBlock; ++i) {
      const float y = mic[i] - dcIn + 0.995f * dcOut;
      dcIn = static_cast<float>(mic[i]);
      dcOut = y;
      CHECK(std::fabs(static_cast<float>(out[i]) - y) <= 1.0f);
    }
  }
  CHECK(aec.frozen());
}

TEST_CASE("echo canceller: full-scale input never overflows or goes NaN") {
  static NlmsEchoCanceller<256, 128> aec;
  aec.reset();
  aec.setBulkDelay(10);
  int16_t ref[kBlock], out[kBlock];
  int32_t mic[kBlock];
  Lcg rng;
  for (int b = 0; b < 100; ++b) {
    for (size_t i = 0; i < kBlock; ++i) {
      ref[i] = rng.next() < 0 ? INT16_MIN : INT16_MAX;
      mic[i] = (b % 2) ? ref[i] : static_cast<int16_t>(-ref[i] - (ref[i] == INT16_MIN ? 1 : 0));
    }
    aec.process(ref, mic, out, kBlock);
    for (size_t i = 0; i < kBlock; ++i) CHECK(out[i] >= INT16_MIN);  // int16 by type; guards NaN casts below
    CHECK(std::isfinite(aec.erleDb()));
  }
}

// Device evidence (HIL 20261029): a 440 Hz sine reply through a short echo with a DC offset on the mic made
// erleDb() NaN. -14 dBFS reference, echo about -21 dBFS at the mic, 200 LSB DC.
TEST_CASE("echo canceller: sine reference with a DC offset converges and never resets") {
  static NlmsEchoCanceller<256, 512> aec;
  aec.reset();
  aec.setBulkDelay(100);
  const float refAmp = 32768.0f * 0.2f;
  std::vector<float> ref(kRate * 5 + 200);
  for (size_t n = 0; n < ref.size(); ++n) ref[n] = refAmp * std::sin(2.0f * 3.14159265f * 440.0f * static_cast<float>(n) / 16000.0f);
  int16_t r[kBlock], o[kBlock];
  int32_t m[kBlock];
  double mic = 0, out = 0;
  size_t cnt = 0;
  const size_t blocks = kRate * 5 / kBlock;
  for (size_t b = 0; b < blocks; ++b) {
    for (size_t i = 0; i < kBlock; ++i) {
      const size_t n = b * kBlock + i + 200;
      r[i] = static_cast<int16_t>(ref[n]);
      m[i] = static_cast<int32_t>(0.3f * ref[n - 100] + 0.15f * ref[n - 103] + 200.0f);
    }
    aec.process(r, m, o, kBlock);
    CHECK(std::isfinite(aec.erleDb()));
    if (b >= blocks - 50) {
      for (size_t i = 0; i < kBlock; ++i) {
        mic += static_cast<double>(m[i]) * m[i];
        out += static_cast<double>(o[i]) * o[i];
        ++cnt;
      }
    }
  }
  printf("[echo_canceller] sine+DC ERLE %.1f dB, erleDb() %.1f, resets %u\n", db(mic / cnt, out / cnt), aec.erleDb(),
         static_cast<unsigned>(aec.resets()));
  CHECK(db(mic / cnt, out / cnt) >= 15.0);
  CHECK(aec.resets() == 0);
}

// Uncorrelated mic far louder than a barely-audible reference: the weights run away.
TEST_CASE("echo canceller: a runaway filter is caught by the guard and the output stays finite") {
  static NlmsEchoCanceller<256, 512> aec;
  aec.reset();
  Lcg rr, mr;
  int16_t r[kBlock], o[kBlock];
  int32_t m[kBlock];
  for (int b = 0; b < 300; ++b) {
    for (size_t i = 0; i < kBlock; ++i) {
      r[i] = static_cast<int16_t>(20.0f * rr.next());
      m[i] = static_cast<int32_t>(30000.0f * mr.next());
    }
    aec.process(r, m, o, kBlock);
    CHECK(std::isfinite(aec.erleDb()));
  }
  printf("[echo_canceller] runaway resets %u nonFinite %u\n", static_cast<unsigned>(aec.resets()),
         static_cast<unsigned>(aec.nonFinite()));
  CHECK(aec.resets() > 0);
}

// A background that goes worse than the mic (loud mic uncorrelated with the reference, reference still playing)
// is put back to the foreground: frozen() reports it, and the foreground's ERLE survives.
TEST_CASE("echo canceller: a diverging background is reverted and the foreground holds") {
  static NlmsEchoCanceller<256, 128> aec;
  aec.reset();
  aec.setBulkDelay(kRoomDelay);
  Sim sim(&aec);
  sim.speechRef = true;
  double mic, out;
  sim.run(3.0f, 1.0f, 0.0f, &mic, &out);  // converge; ERLE over the last 1 s
  const double before = db(mic, out);
  size_t voicedBlocks = 0, revertedBlocks = 0;
  sim.onBlock = [&] {
    if (!sim.voiced) return;
    ++voicedBlocks;
    revertedBlocks += aec.frozen() ? 1 : 0;
  };
  sim.run(0.2f, 0.0f, 20000.0f, &mic, &out);  // 0.2 s of near-end noise far above the echo
  sim.onBlock = nullptr;
  // The mic DC blocker rings for tens of ms after a burst this loud; that ringing is in the output, so the
  // foreground is judged after it settles.
  sim.run(0.1f, 0.0f, 0.0f, &mic, &out);
  sim.run(1.0f, 1.0f, 0.0f, &mic, &out);  // echo only again
  const double after = db(mic, out);
  printf("[echo_canceller] diverging background: %zu/%zu voiced blocks reverted, ERLE %.1f -> %.1f dB\n",
         revertedBlocks, voicedBlocks, before, after);
  CHECK(revertedBlocks > 0);
  CHECK(after >= before - 3.0);
}

// The wake gate must only trust the model when a person talks over Bob: residual echo alone is not near-end.
TEST_CASE("echo canceller: nearEnd() is false on echo-only speech-like audio") {
  static NlmsEchoCanceller<256, 128> aec;
  aec.reset();
  aec.setBulkDelay(kRoomDelay);
  Sim sim(&aec);
  sim.speechRef = true;
  double mic, out;
  sim.run(3.0f, 0.25f, 0.0f, &mic, &out);  // converge
  size_t blocks = 0, near = 0;
  sim.onBlock = [&] { ++blocks; near += aec.nearEnd() ? 1 : 0; };
  sim.run(3.0f, 0.25f, 0.0f, &mic, &out);
  printf("[echo_canceller] echo-only nearEnd rate %.1f%% (%zu/%zu), residual gain %.1f dB, ERLE %.1f dB\n",
         100.0 * near / blocks, near, blocks, aec.residualGainDb(), aec.erleDb());
  CHECK(near * 100 <= blocks * 5);
}

TEST_CASE("echo canceller: nearEnd() is true for a talker 6 dB below the raw echo") {
  static NlmsEchoCanceller<256, 128> aec;
  aec.reset();
  aec.setBulkDelay(kRoomDelay);
  Sim sim(&aec);
  sim.speechRef = true;
  double mic, out;
  sim.run(3.0f, 3.0f, 0.0f, &mic, &out);  // converge; mic is the raw echo power over the last 3 s
  const float nearAmp = std::sqrt(3.0 * mic / 4.0);  // uniform noise of power mic / 4: 6 dB below the echo
  size_t blocks = 0, near = 0;
  sim.onBlock = [&] { ++blocks; near += aec.nearEnd() ? 1 : 0; };
  sim.run(2.0f, 0.25f, nearAmp, &mic, &out);
  printf("[echo_canceller] near-end burst nearEnd rate %.1f%% (%zu/%zu), nearAmp %.0f\n", 100.0 * near / blocks, near,
         blocks, nearAmp);
  CHECK(near * 100 >= blocks * 80);
}

TEST_CASE("echo canceller: nearEnd() with a silent reference follows the mic level") {
  static NlmsEchoCanceller<256, 128> aec;
  aec.reset();
  int16_t ref[kBlock] = {}, out[kBlock];
  int32_t mic[kBlock];
  Lcg rng;
  for (int b = 0; b < 10; ++b) {
    for (size_t i = 0; i < kBlock; ++i) mic[i] = static_cast<int32_t>(2000.0f * rng.next());
    aec.process(ref, mic, out, kBlock);
    CHECK(aec.nearEnd());
  }
  // The mic DC blocker (~12 ms memory) still carries the loud phase for the first 3 blocks, so judge after that.
  for (int b = 0; b < 10; ++b) {
    for (size_t i = 0; i < kBlock; ++i) mic[i] = static_cast<int32_t>(8.0f * rng.next());
    aec.process(ref, mic, out, kBlock);
    if (b >= 3) CHECK_FALSE(aec.nearEnd());
  }
}

template <size_t T>
void bench(const char* name) {
  static NlmsEchoCanceller<T, 512> aec;
  aec.reset();
  aec.setBulkDelay(100);
  Lcg rr;
  int16_t r[kBlock], o[kBlock];
  int32_t m[kBlock];
  const int blocks = 2000;
  const auto t0 = std::chrono::steady_clock::now();
  for (int b = 0; b < blocks; ++b) {
    for (size_t i = 0; i < kBlock; ++i) {
      r[i] = static_cast<int16_t>(6000.0f * rr.next());
      m[i] = static_cast<int32_t>(0.2f * r[i]);
    }
    aec.process(r, m, o, kBlock);
  }
  const double ns = std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - t0).count();
  printf("[echo_canceller] bench %s: %.1f ns/sample\n", name, ns / (static_cast<double>(blocks) * kBlock));
}

// Scales the room so its power gain is `db`: mic power over reference power for a white reference.
void scaleRoomGain(Sim* sim, double db) {
  double e = 0;
  for (float v : sim->room) e += static_cast<double>(v) * v;
  const float k = static_cast<float>(std::sqrt(std::pow(10.0, db / 10.0) / e));
  for (float& v : sim->room) v *= k;
}

// Device evidence (HIL 20261029-051554-383f): a speech reply with the echo +11 dB over the reference clips the
// mic, so the canceller must converge on the unclipped int32 mic. ERLE is the tail power ratio over the last 2 s.
TEST_CASE("echo canceller: speech with the echo 11 dB over the reference converges") {
  static NlmsEchoCanceller<256, 128> aec;
  aec.reset();
  aec.setBulkDelay(kRoomDelay);
  Sim sim(&aec);
  sim.speechRef = true;
  sim.refAmp = 6000.0f;
  scaleRoomGain(&sim, 11.0);
  double mic, out;
  sim.run(4.0f, 0.0f, 0.0f, &mic, &out);  // converge
  size_t voicedBlocks = 0, frozenVoiced = 0;
  sim.onBlock = [&] {
    if (!sim.voiced) return;
    ++voicedBlocks;
    frozenVoiced += aec.frozen() ? 1 : 0;
  };
  sim.run(2.0f, 2.0f, 0.0f, &mic, &out);  // last 2 s of 6 s
  printf("[echo_canceller] speech 11 dB: ERLE %.1f dB, erleDb() %.1f, frozen on voiced blocks %zu/%zu\n", db(mic, out),
         aec.erleDb(), frozenVoiced, voicedBlocks);
  CHECK(db(mic, out) >= 25.0);
  CHECK(frozenVoiced * 2 < voicedBlocks);
  CHECK(aec.micClips() > 0);  // the int32 path is in use: the mic went beyond int16
}

// Near-end talker 20 dB below the echo, on top of a converged filter: the filter must hold (no double-talk
// gate), so the residual echo stays 6 dB under the talker and ERLE recovers within a second of the burst.
TEST_CASE("echo canceller: near-end under loud echo is kept") {
  static NlmsEchoCanceller<256, 128> aec;
  aec.reset();
  aec.setBulkDelay(kRoomDelay);
  Sim sim(&aec);
  sim.speechRef = true;
  sim.refAmp = 6000.0f;
  scaleRoomGain(&sim, 11.0);
  double mic, out;
  sim.run(4.0f, 2.0f, 0.0f, &mic, &out);  // converge; mic is the echo power over the last 2 s
  const float nearAmp = std::sqrt(3.0 * mic / 100.0);  // uniform noise of power mic / 100: 20 dB below the echo
  sim.nearSq = sim.resSq = 0;
  sim.run(1.0f, 1.0f, nearAmp, &mic, &out);  // near-end burst
  printf("[echo_canceller] near-end burst: residual echo %.1f dB under the talker\n", db(sim.resSq, sim.nearSq));
  CHECK(db(sim.resSq, sim.nearSq) <= -6.0);
  sim.run(1.0f, 0.0f, 0.0f, &mic, &out);  // 1 s gap
  sim.run(1.0f, 1.0f, 0.0f, &mic, &out);
  printf("[echo_canceller] ERLE 1 s after the burst %.1f dB\n", db(mic, out));
  CHECK(db(mic, out) >= 20.0);
}

// The mic is unclipped int32, up to 16 x full scale (the device's x16 magnification on a loud echo). Samples
// beyond int16 are counted, and the output stays finite.
TEST_CASE("echo canceller: an int32 mic beyond int16 is counted and never breaks the output") {
  static NlmsEchoCanceller<256, 128> aec;
  aec.reset();
  aec.setBulkDelay(10);
  Lcg rng;
  int16_t ref[kBlock], out[kBlock];
  int32_t mic[kBlock];
  size_t beyond = 0;
  for (int b = 0; b < 100; ++b) {
    for (size_t i = 0; i < kBlock; ++i) {
      ref[i] = static_cast<int16_t>(20000.0f * rng.next());
      mic[i] = static_cast<int32_t>(16.0f * 32767.0f * rng.next());
      beyond += (mic[i] > 32767 || mic[i] < -32768) ? 1 : 0;
    }
    aec.process(ref, mic, out, kBlock);
    CHECK(std::isfinite(aec.erleDb()));
  }
  printf("[echo_canceller] int32 mic: %zu samples beyond int16, micClips() %u\n", beyond,
         static_cast<unsigned>(aec.micClips()));
  CHECK(beyond > 0);
  CHECK(aec.micClips() == beyond);
}

// The speaker-to-mic path is fixed hardware, so a reply starts from the weights the last reply learned.
TEST_CASE("echo canceller: weights carry over to the next reply") {
  static NlmsEchoCanceller<256, 128> aec;
  aec.reset();
  aec.setBulkDelay(kRoomDelay);
  Sim sim(&aec);
  sim.speechRef = true;
  sim.refAmp = 6000.0f;
  scaleRoomGain(&sim, 11.0);
  double mic, out;
  sim.run(4.0f, 0.0f, 0.0f, &mic, &out);  // reply 1 converges
  const uint32_t clipsBefore = aec.micClips();
  aec.beginReply();  // reply 2 starts: the weights carry over
  sim.run(0.3f, 0.3f, 0.0f, &mic, &out);  // the first 300 ms of reply 2
  printf("[echo_canceller] next reply: ERLE first 300 ms %.1f dB, erleDb() %.1f, micClips() %u (before %u)\n",
         db(mic, out), aec.erleDb(), static_cast<unsigned>(aec.micClips()), static_cast<unsigned>(clipsBefore));
  CHECK(db(mic, out) >= 20.0);
  CHECK(aec.micClips() <= 4800u);  // counted from the start of reply 2 only (300 ms = 4800 samples)
}

TEST_CASE("echo canceller: micro-benchmark (prints ns/sample, no assertion)") {
  bench<128>("<128, 512>");
  bench<256>("<256, 512>");
}
