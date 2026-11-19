// Full-duplex reply playback with an echo-cancelled mic (#1364, Waveshare only). One task owns the
// I2S0 driver (ws185::duplexTransfer) and runs a 10 ms lock-step loop: take 160 speaker samples from the
// output ring, transfer, run the NLMS canceller (reference = what was just written to the speaker) and
// push the echo-free mic frame to the frame ring. The wake word reads those frames while Bob speaks.
//
// Concurrency (all rings are single producer / single consumer, std::atomic indices, no locks):
//   output ring : producer = the playback side (loop task or mp3 task, never both at once), consumer = "duplex"
//   frame ring  : producer = "duplex" task, consumer = the Arduino loop (nextFrame)
// The "duplex" task runs on core 1 at priority 3 (above the wake task's 2 on core 0 and the Arduino loop):
// the I/O cadence must win, the canceller is cheap (~1 ms per 10 ms block) and Bob's render tolerates the
// ~10% it takes. At priority 1 on core 0 it starved under the wake task (136 frames for a 20 s reply). ~6 KB stack.
#pragma once

#include <stddef.h>
#include <stdint.h>

#if defined(BOB_BOARD_WAVESHARE_185C)

namespace bob {
namespace duplex {

constexpr size_t kFrameSamples = 160;  // 10 ms at 16 kHz

// Bulk delay between a sample entering the output ring's I2S write and its echo reaching the mic:
// lock-step keeps the I2S TX DMA full, so a sample waits behind (kDmaBufCount - 1) buffers of 160 frames
// (ws185_hw.cpp: 4 x 160) = 480 samples, plus ~32 samples (2 ms) of codec/ADC latency. That is only a
// guess (RX DMA buffers too, so the real lag may be ~8 x 160): measure it with calibrate() and tune with
// setBulkDelay(). Measured on the board (HIL 20261029-035415-fe84, `aec_cal delay=682`): 682 samples minus
// a ~22-sample lead so the direct path lands inside the 128-tap window.
constexpr size_t kDefaultBulkDelay = 660;
constexpr size_t kMaxBulkDelay = 2048;  // the canceller's MaxDelay (the ~18.4 KB canceller lives in PSRAM)

// Two-path copy ratio (echo_canceller.h): the background replaces the foreground once its error energy is under
// this fraction of the foreground's. The board's mic runs about +11 dB over the reference on speech (HIL
// 20261029-051554-383f: mic -11 vs ref -22 dBFS), so a level gate (the old Geigel ratio) tripped on the echo
// itself. The two-path rule has no level gate.
constexpr float kDefaultDoubleTalk = 0.5f;

struct Stats {
  float erleDb;
  float dtRatio;     // double-talk threshold in force
  uint32_t delay;    // bulk delay in force, samples
  int micDb, refDb;  // mean power of the raw mic and of the speaker reference over the interval, dBFS
  uint32_t frames, underruns, overflows, frozenFrames;
  uint32_t cpuAvgUs, cpuMaxUs;  // time inside the canceller per 10 ms block
  uint32_t xferMaxUs;           // longest duplexTransfer (I/O wait included)
  uint32_t aecResets;           // canceller divergence resets (cumulative)
  float residualGainDb;         // canceller residual gain (dB), journaled as res_gain_db
  uint32_t stackFreeBytes;      // duplex task stack high-water mark (least free so far), journaled as stack_free
  uint32_t micClips;            // raw mic samples beyond int16 this reply (cumulative), journaled as mic_clip
};

bool init();   // idempotent; the one-time allocations (rings, canceller, semaphore), done at boot so begin() is cheap
bool begin();  // idempotent; false = playback should use M5.Speaker
void end();    // idempotent; returns after the task has stopped and the driver is released
bool active();

size_t write(const int16_t* mono, size_t n);  // post-volume samples; returns how many fit
size_t space();
size_t pending();                             // samples still in the output ring
// Single consumer; false when none. *nearEnd (optional) = the canceller saw a near-end talker in that block.
bool nextFrame(int16_t out[kFrameSamples], bool* nearEnd = nullptr);
void setBulkDelay(size_t samples);
void setDoubleTalkThreshold(float ratio);     // applied at the next block boundary; ratio <= 0 is ignored

// Console/test action, blocks the caller ~0.5 s and only while no reply plays (-1 otherwise): begins the
// duplex, plays 300 ms of -30 dBFS deterministic white noise, finds the cross-correlation lag between the
// speaker reference and the raw mic over 0..kMaxBulkDelay-1 samples, ends the duplex, journals
// `aec_cal delay=<lag>,peak=<0..1>,ms=<n>` and returns the lag (-1 on failure). Never changes the default.
// Its noise also trains the canceller's weights, which carry into the next reply.
int calibrate();
Stats takeStats();  // resets the counters: once per reply (duplexFinish)
Stats peekStats();  // same figures, no reset: for periodic journals (barge_stats)

}  // namespace duplex
}  // namespace bob

#else  // other boards: no duplex, so every caller takes the M5.Speaker path

namespace bob {
namespace duplex {

constexpr size_t kFrameSamples = 160;

struct Stats {
  float erleDb;
  float dtRatio;
  uint32_t delay;
  int micDb, refDb;
  uint32_t frames, underruns, overflows, frozenFrames;
  uint32_t cpuAvgUs, cpuMaxUs;
  uint32_t xferMaxUs;
  uint32_t aecResets;
  float residualGainDb;
  uint32_t stackFreeBytes;
  uint32_t micClips;
};

inline bool init() { return false; }
inline bool begin() { return false; }
inline void end() {}
inline bool active() { return false; }
inline size_t write(const int16_t*, size_t) { return 0; }
inline size_t space() { return 0; }
inline size_t pending() { return 0; }
inline bool nextFrame(int16_t[kFrameSamples], bool* = nullptr) { return false; }
inline void setBulkDelay(size_t) {}
inline void setDoubleTalkThreshold(float) {}
inline int calibrate() { return -1; }
inline Stats takeStats() { return Stats{}; }
inline Stats peekStats() { return Stats{}; }

}  // namespace duplex
}  // namespace bob

#endif  // BOB_BOARD_WAVESHARE_185C
