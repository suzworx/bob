// Full-duplex reply playback + echo-cancelled mic task (#1364). See audio_duplex.h for the contract.
#include "audio_duplex.h"

#if defined(BOB_BOARD_WAVESHARE_185C)

#include <Arduino.h>
#include <esp_heap_caps.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

#include <atomic>
#include <cmath>
#include <cstring>
#include <new>

#include "config.h"
#include "echo_canceller.h"
#include "journal.h"
#include "ws185_hw.h"

namespace bob {
namespace duplex {

namespace {

using Canceller = NlmsEchoCanceller<128, kMaxBulkDelay>;
// Power of two, ~256 ms at 16 kHz. Deliberately small: a 1 s ring let a whole reply burst fill the mp3 decoder's
// write() side, so the decoder ran ahead flat out and starved the loop (loop_max 365 vs ~265). At 256 ms, write()
// blocks the decoder like M5.Speaker did. pumpPcm refills it in kPcmChunkSamples (2048) steps, which still fits.
constexpr size_t kOutRing = 4096;
constexpr size_t kFrameRing = 32;
constexpr uint32_t kTransferTimeoutMs = 30;  // a 10 ms block; bounds end()'s wait
constexpr uint32_t kEndWaitMs = 1000;
constexpr uint32_t kNoDelay = 0xFFFFFFFFu;

struct Duplex {
  // Output ring: monotonically increasing indices (wrap-safe unsigned maths), slot = index & mask.
  // Producer (playback) owns outHead, consumer (task) owns outTail.
  std::atomic<uint32_t> outHead{0}, outTail{0};
  // Frame ring: producer (task) owns frHead; frTail is moved by the consumer (nextFrame) and, when the
  // ring is full, by the producer dropping the oldest frame, so both advance it with compare-exchange.
  std::atomic<uint32_t> frHead{0}, frTail{0};
  std::atomic<bool> stop{false};
  std::atomic<uint32_t> pendingDelay{kNoDelay};
  std::atomic<float> pendingDt{0.0f};  // <= 0 = nothing pending
  std::atomic<uint32_t> curDelay{kDefaultBulkDelay};  // in force, written by the task (and begin)
  std::atomic<float> curDt{kDefaultDoubleTalk};
  std::atomic<bool> ready{false};  // driver is up (calibrate waits for it)
  // calibrate(): the task copies the raw reference and mic of each block into these until capLen is full.
  std::atomic<int16_t*> capRef{nullptr}, capMic{nullptr};
  std::atomic<uint32_t> capLen{0}, capPos{0};
  std::atomic<uint32_t> frames{0}, underruns{0}, overflows{0}, frozen{0};
  std::atomic<float> erleDb{0.0f}, resGainDb{0.0f}, micSum{0.0f}, refSum{0.0f};  // task writes; takeStats resets sums
  std::atomic<uint32_t> cpuSumUs{0}, cpuMaxUs{0}, xferMaxUs{0}, aecResets{0}, micClips{0};
  uint8_t nearEnd[kFrameRing] = {};  // per frame-ring slot: the canceller saw a near-end talker in that block
  int16_t* out = nullptr;           // kOutRing samples
  int16_t* frame = nullptr;         // kFrameRing x kFrameSamples
  Canceller* aec = nullptr;
  SemaphoreHandle_t exited = nullptr;
  std::atomic<uint32_t> stackFreeBytes{0};  // task stack high-water mark (least free so far)
};

// The one Duplex lives for the life of the program (allocated on first begin(), re-initialised in place for
// each reply, never freed), so a late write()/nextFrame() from an abandoned task can never touch freed
// memory. `g` is the "active" flag: it is published before the task starts and cleared only after the I2S
// driver is uninstalled, so earcons/M5.Speaker stay away from I2S0 for the whole handoff.
Duplex* g_state = nullptr;
std::atomic<Duplex*> g{nullptr};
bool g_wedged = false;  // a task outlived end(): refuse a new reply until it has exited
bool g_aecInPsram = true;

void addF(std::atomic<float>& a, float v) {
  float o = a.load(std::memory_order_relaxed);
  while (!a.compare_exchange_weak(o, o + v, std::memory_order_relaxed)) {}
}

void maxU(std::atomic<uint32_t>& a, uint32_t v) {
  uint32_t o = a.load(std::memory_order_relaxed);
  while (v > o && !a.compare_exchange_weak(o, v, std::memory_order_relaxed)) {}
}

template <typename T>
float meanSquare(const T* s, size_t n) {
  float e = 0;
  for (size_t i = 0; i < n; ++i) e += float(s[i]) * s[i];
  return e / float(n);
}

int toDb(float meanSq) { return int(lroundf(10.0f * log10f(meanSq + 1.0f) - 90.3f)); }  // 90.3 = 20log10(32768)

void taskMain(void* arg) {
  Duplex* s = static_cast<Duplex*>(arg);
  int16_t ref[kFrameSamples], clean[kFrameSamples];
  int32_t mic[kFrameSamples];  // unclipped: the canceller needs the echo above int16 (#1382)
  bool wasEmpty = true;
  // The slow part (speaker/mic teardown, I2S install, codec) runs here so begin() never blocks the loop;
  // write() buffers into the output ring meanwhile.
  // The weights carry over from the last reply (same speaker-to-mic path, calibrate() included: its noise trains
  // them too); the history and ERLE sums start clean.
  s->aec->beginReply();
  s->aec->setBulkDelay(kDefaultBulkDelay);
  s->aec->setDoubleTalkThreshold(kDefaultDoubleTalk);
  const uint32_t t0 = millis();
  const bool up = ws185::duplexBegin(config::kSampleRateHz);
  journal("duplex_begin", State::kAwaiting, "",
          String("ms=") + (millis() - t0) + (up ? "" : ",ok=0") + ",aec=" + (g_aecInPsram ? "psram" : "int") +
              ",free_int=" + heap_caps_get_free_size(MALLOC_CAP_INTERNAL) +
              ",largest_int=" + heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
  s->ready.store(up, std::memory_order_release);
  while (!s->stop.load(std::memory_order_acquire)) {
    const uint32_t d = s->pendingDelay.exchange(kNoDelay);
    if (d != kNoDelay) {
      s->aec->setBulkDelay(d);
      s->curDelay.store(d > kMaxBulkDelay ? uint32_t(kMaxBulkDelay) : d, std::memory_order_relaxed);
    }
    const float dt = s->pendingDt.exchange(0.0f);
    if (dt > 0.0f) {
      s->aec->setDoubleTalkThreshold(dt);
      s->curDt.store(dt, std::memory_order_relaxed);
    }
    const uint32_t tail = s->outTail.load(std::memory_order_relaxed);
    const uint32_t avail = s->outHead.load(std::memory_order_acquire) - tail;
    const size_t take = avail < kFrameSamples ? avail : kFrameSamples;
    for (size_t i = 0; i < take; ++i) ref[i] = s->out[(tail + i) & (kOutRing - 1)];
    memset(ref + take, 0, (kFrameSamples - take) * sizeof(int16_t));
    s->outTail.store(tail + take, std::memory_order_release);
    if (take < kFrameSamples && !wasEmpty) s->underruns.fetch_add(1, std::memory_order_relaxed);
    wasEmpty = take == 0;  // an underrun is counted once per run-dry, not for every silent block after
    const int64_t x0 = esp_timer_get_time();
    if (!up || ws185::duplexTransfer(ref, mic, kFrameSamples, kTransferTimeoutMs) != kFrameSamples) {
      // A failed or instant-return transfer must not spin. Pace the ring at real time instead.
      vTaskDelay(pdMS_TO_TICKS(10));
      continue;
    }
    const int64_t c0 = esp_timer_get_time();
    const uint32_t cl = s->capLen.load(std::memory_order_acquire);
    const uint32_t cp = s->capPos.load(std::memory_order_relaxed);
    if (cp < cl) {
      const uint32_t k = cl - cp < kFrameSamples ? cl - cp : uint32_t(kFrameSamples);
      memcpy(s->capRef.load() + cp, ref, k * sizeof(int16_t));
      int16_t* capMic = s->capMic.load() + cp;
      for (uint32_t i = 0; i < k; ++i) {
        capMic[i] = int16_t(mic[i] > INT16_MAX ? INT16_MAX : mic[i] < INT16_MIN ? INT16_MIN : mic[i]);
      }
      s->capPos.store(cp + k, std::memory_order_release);
    }
    s->aec->process(ref, mic, clean, kFrameSamples);
    const uint32_t cpu = uint32_t(esp_timer_get_time() - c0);
    const uint32_t xfer = uint32_t(c0 - x0);
    s->cpuSumUs.fetch_add(cpu, std::memory_order_relaxed);
    maxU(s->cpuMaxUs, cpu);
    maxU(s->xferMaxUs, xfer);
    s->aecResets.store(s->aec->resets(), std::memory_order_relaxed);
    s->micClips.store(s->aec->micClips(), std::memory_order_relaxed);
    const float erle = s->aec->erleDb();
    s->erleDb.store(std::isfinite(erle) ? erle : 0.0f, std::memory_order_relaxed);
    const float rg = s->aec->residualGainDb();
    s->resGainDb.store(std::isfinite(rg) ? rg : 0.0f, std::memory_order_relaxed);
    addF(s->micSum, meanSquare(mic, kFrameSamples));
    addF(s->refSum, meanSquare(ref, kFrameSamples));
    if (s->aec->frozen()) s->frozen.fetch_add(1, std::memory_order_relaxed);
    s->frames.fetch_add(1, std::memory_order_relaxed);
    const uint32_t head = s->frHead.load(std::memory_order_relaxed);
    uint32_t t = s->frTail.load(std::memory_order_acquire);
    if (head - t >= kFrameRing && s->frTail.compare_exchange_strong(t, t + 1)) {  // drop the oldest
      s->overflows.fetch_add(1, std::memory_order_relaxed);
    }
    memcpy(s->frame + (head % kFrameRing) * kFrameSamples, clean, sizeof(clean));
    s->nearEnd[head % kFrameRing] = s->aec->nearEnd() ? 1 : 0;
    s->frHead.store(head + 1, std::memory_order_release);
    if (head % 50 == 0) s->stackFreeBytes.store(uxTaskGetStackHighWaterMark(nullptr) * sizeof(StackType_t), std::memory_order_relaxed);
  }
  s->stackFreeBytes.store(uxTaskGetStackHighWaterMark(nullptr) * sizeof(StackType_t), std::memory_order_relaxed);
  xSemaphoreGive(s->exited);  // last touch of *s; the Duplex itself is never freed
  vTaskDelete(nullptr);       // the task holds no driver or lock any more
}

// Buffers live for the life of the program: allocating them per reply put ~90 ms on the loop at reply
// start (reply-burst loop_max). The task owns them while a reply runs, so a wedged end() just leaks the
// Duplex header, never these.
int16_t* g_out = nullptr;
int16_t* g_frame = nullptr;
Canceller* g_aec = nullptr;
uint32_t g_beginUs = 0;  // loop-side cost of the last begin(), journaled with end()'s as duplex_loop

}  // namespace

bool init() {
  if (g_state && g_out && g_frame && g_aec) return true;
  if (!g_out) g_out = static_cast<int16_t*>(heap_caps_calloc(kOutRing, sizeof(int16_t), MALLOC_CAP_SPIRAM));
  if (!g_frame) g_frame = static_cast<int16_t*>(heap_caps_calloc(kFrameRing * kFrameSamples, sizeof(int16_t), MALLOC_CAP_SPIRAM));
  if (!g_aec) {
    // ~18.4 KB (2 x 128 taps + 2048-sample delay history, float): PSRAM, so a reply never competes with the MP3
    // decoder for internal RAM. The per-block cost is journaled (cpu_avg_us/cpu_max_us in duplex_stats) and
    // the placement in duplex_begin (aec=); move it to internal only if those show the PSRAM bus costing.
    void* aec = heap_caps_calloc(1, sizeof(Canceller), MALLOC_CAP_SPIRAM);
    g_aecInPsram = aec != nullptr;
    if (!aec) aec = heap_caps_calloc(1, sizeof(Canceller), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (aec) g_aec = new (aec) Canceller();
  }
  if (!g_out || !g_frame || !g_aec) return false;
  if (!g_state) {
    SemaphoreHandle_t exited = xSemaphoreCreateBinary();
    if (!exited) return false;
    g_state = new (std::nothrow) Duplex();
    if (!g_state) {
      vSemaphoreDelete(exited);
      return false;
    }
    g_state->out = g_out;
    g_state->frame = g_frame;
    g_state->aec = g_aec;
    g_state->exited = exited;
  }
  return true;
}

bool begin() {
  if (g.load(std::memory_order_acquire)) return true;
  if (g_wedged) {
    // The previous task never confirmed it had stopped; it is only safe to reuse the state once it has.
    if (!g_state || xSemaphoreTake(g_state->exited, 0) != pdTRUE) return false;
    g_wedged = false;
  }
  const uint32_t t0 = micros();
  if (!init()) return false;  // normally done at boot; this is the fallback
  // No task is running (not active, not wedged): start the reply from clean state, keeping the buffers.
  SemaphoreHandle_t exited = g_state->exited;
  g_state->~Duplex();
  new (g_state) Duplex();
  Duplex* s = g_state;
  s->out = g_out;
  s->frame = g_frame;
  s->aec = g_aec;
  s->exited = exited;
  // Publish "active" before the task exists: the task preempts this one (priority 3) and runs the driver
  // takeover, during which nothing else may touch M5.Speaker/I2S0.
  g.store(s, std::memory_order_release);
  // The driver is installed by the task (taskMain), not here: that takes ~500 ms and begin() runs on the loop.
  // Core 1, priority 3: the I/O cadence beats the wake task (see the header).
  TaskHandle_t th = nullptr;
  if (xTaskCreatePinnedToCore(taskMain, "duplex", 6144, s, 3, &th, 1) != pdPASS) {
    g.store(nullptr, std::memory_order_release);
    return false;
  }
  g_beginUs = micros() - t0;
  return true;
}

void end() {
  Duplex* s = g.load(std::memory_order_acquire);
  if (!s) return;
  const uint32_t t0 = micros();
  s->stop.store(true, std::memory_order_release);
  // The task may sit in duplexTransfer for one 30 ms timeout, then exits by itself.
  bool exited = xSemaphoreTake(s->exited, pdMS_TO_TICKS(kEndWaitMs)) == pdTRUE;
  if (!exited) journal("duplex_end_timeout", State::kAwaiting, "");
  // Always uninstall the driver and drop the amp: a wedged task then fails its transfers instantly, paces
  // itself and exits on `stop`. Active stays true until the driver is gone.
  ws185::duplexEnd();
  if (!exited) exited = xSemaphoreTake(s->exited, pdMS_TO_TICKS(kEndWaitMs / 5)) == pdTRUE;
  g_wedged = !exited;  // the Duplex is never freed either way; begin() refuses until the task is gone
  g.store(nullptr, std::memory_order_release);
  journal("duplex_loop", State::kAwaiting, "", String("begin_us=") + g_beginUs + ",end_us=" + (micros() - t0));
}

bool active() { return g.load(std::memory_order_acquire) != nullptr; }

size_t space() {
  Duplex* s = g.load(std::memory_order_acquire);
  return s ? kOutRing - (s->outHead.load() - s->outTail.load()) : 0;
}
size_t pending() {
  Duplex* s = g.load(std::memory_order_acquire);
  return s ? s->outHead.load() - s->outTail.load() : 0;
}

size_t write(const int16_t* mono, size_t n) {
  Duplex* s = g.load(std::memory_order_acquire);
  if (!s || s->stop.load(std::memory_order_acquire)) return 0;
  const size_t room = kOutRing - (s->outHead.load() - s->outTail.load());
  const size_t k = n < room ? n : room;
  const uint32_t head = s->outHead.load(std::memory_order_relaxed);
  for (size_t i = 0; i < k; ++i) s->out[(head + i) & (kOutRing - 1)] = mono[i];
  s->outHead.store(head + k, std::memory_order_release);
  return k;
}

bool nextFrame(int16_t out[kFrameSamples], bool* nearEnd) {
  Duplex* s = g.load(std::memory_order_acquire);
  if (!s) return false;
  for (;;) {
    uint32_t t = s->frTail.load(std::memory_order_acquire);
    if (s->frHead.load(std::memory_order_acquire) == t) return false;
    memcpy(out, s->frame + (t % kFrameRing) * kFrameSamples, kFrameSamples * sizeof(int16_t));
    const bool ne = s->nearEnd[t % kFrameRing] != 0;
    if (s->frTail.compare_exchange_strong(t, t + 1)) {  // else the producer dropped it: retry
      if (nearEnd) *nearEnd = ne;
      return true;
    }
  }
}

void setBulkDelay(size_t samples) {
  Duplex* s = g.load(std::memory_order_acquire);
  if (s) s->pendingDelay.store(uint32_t(samples));
}

void setDoubleTalkThreshold(float ratio) {
  Duplex* s = g.load(std::memory_order_acquire);
  if (s && ratio > 0.0f) s->pendingDt.store(ratio);
}

namespace {

Stats readStats(bool reset) {
  Stats st{};
  Duplex* s = g.load(std::memory_order_acquire);
  if (!s) return st;
  auto rd = [reset](std::atomic<uint32_t>& a) { return reset ? a.exchange(0) : a.load(); };
  st.frames = rd(s->frames);
  st.underruns = rd(s->underruns);
  st.overflows = rd(s->overflows);
  st.frozenFrames = rd(s->frozen);
  st.erleDb = s->erleDb.load();
  st.residualGainDb = s->resGainDb.load();
  const uint32_t cpuSum = rd(s->cpuSumUs);
  st.cpuAvgUs = st.frames ? cpuSum / st.frames : 0;
  st.cpuMaxUs = rd(s->cpuMaxUs);
  st.xferMaxUs = rd(s->xferMaxUs);
  st.aecResets = s->aecResets.load();
  st.micClips = s->micClips.load();
  st.dtRatio = s->curDt.load();
  st.delay = s->curDelay.load();
  st.stackFreeBytes = s->stackFreeBytes.load();
  const float n = st.frames ? float(st.frames) : 1.0f;
  st.micDb = toDb((reset ? s->micSum.exchange(0.0f) : s->micSum.load()) / n);
  st.refDb = toDb((reset ? s->refSum.exchange(0.0f) : s->refSum.load()) / n);
  return st;
}

}  // namespace

Stats takeStats() { return readStats(true); }
Stats peekStats() { return readStats(false); }

int calibrate() {
  if (active()) return -1;  // a reply is playing (or about to): never touch its driver
  constexpr uint32_t kNoiseSamples = 4800;  // 300 ms
  constexpr uint32_t kCapSamples = 8000;    // noise + the longest lag + the block-boundary lead
  constexpr float kNoiseAmp = 1794.0f;      // uniform +-1794 = -30 dBFS rms (1036 / 0.577)
  const uint32_t t0 = millis();
  int16_t* ref = static_cast<int16_t*>(heap_caps_calloc(kCapSamples, sizeof(int16_t), MALLOC_CAP_SPIRAM));
  int16_t* mic = static_cast<int16_t*>(heap_caps_calloc(kCapSamples, sizeof(int16_t), MALLOC_CAP_SPIRAM));
  int16_t* noise = static_cast<int16_t*>(heap_caps_calloc(kNoiseSamples, sizeof(int16_t), MALLOC_CAP_SPIRAM));
  int lag = -1;
  float peak = 0.0f;
  if (ref && mic && noise && begin()) {
    Duplex* s = g.load(std::memory_order_acquire);
    uint32_t lcg = 12345;
    for (uint32_t i = 0; i < kNoiseSamples; ++i) {
      lcg = lcg * 1664525u + 1013904223u;
      noise[i] = int16_t((float(lcg >> 8) / float(1u << 24) * 2.0f - 1.0f) * kNoiseAmp);
    }
    uint32_t waited = 0;
    while (!s->ready.load(std::memory_order_acquire) && waited < 3000) { delay(10); waited += 10; }
    if (s->ready.load()) {
      s->capRef.store(ref);
      s->capMic.store(mic);
      s->capPos.store(0);
      s->capLen.store(kCapSamples, std::memory_order_release);
      size_t sent = 0;
      for (waited = 0; waited < 3000 && s->capPos.load(std::memory_order_acquire) < kCapSamples; waited += 10) {
        if (sent < kNoiseSamples) sent += write(noise + sent, kNoiseSamples - sent);
        delay(10);
      }
      if (s->capPos.load(std::memory_order_acquire) >= kCapSamples) {
        // mic[n] ~ ref[n - L]: the lag with the largest |correlation|, normalised by the signal energies.
        double eRef = 0, eMic = 0;
        for (uint32_t i = 0; i < kCapSamples; ++i) {
          eRef += double(ref[i]) * ref[i];
          eMic += double(mic[i]) * mic[i];
        }
        const double norm = sqrt(eRef * eMic);
        float best = 0.0f;
        if (norm > 0.0) {
          for (uint32_t L = 0; L < kMaxBulkDelay; ++L) {
            float c = 0.0f;
            for (uint32_t n = L; n < kCapSamples; ++n) c += float(ref[n - L]) * float(mic[n]);
            const float a = fabsf(c);
            if (a > best) { best = a; lag = int(L); }
          }
          peak = float(best / norm);
          if (peak > 1.0f) peak = 1.0f;
        }
      }
    }
    end();
  }
  heap_caps_free(ref);
  heap_caps_free(mic);
  heap_caps_free(noise);
  journal("aec_cal", State::kAwaiting, "",
          String("delay=") + lag + ",peak=" + String(peak, 3) + ",ms=" + (millis() - t0));
  return lag;
}

}  // namespace duplex
}  // namespace bob

#endif  // BOB_BOARD_WAVESHARE_185C
