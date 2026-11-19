// Bob Cardputer v2 — downlink playback: PCM fallback and MP3 streaming decode.
#include "audio_playback.h"
#include "audio_hang.h"
#include "level_meter.h"

#include <M5Cardputer.h>
#include <AudioFileSource.h>
#include <AudioGeneratorMP3.h>
#include <AudioOutput.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <esp_heap_caps.h>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <new>

#include "config.h"
#include "earcons.h"
#include "journal.h"
#include "mp3_ring_source.h"
#include "settings.h"
#include "state.h"
#include "types.h"
#if defined(BOB_BOARD_WAVESHARE_185C)
#include "audio_duplex.h"
#include "ws185_hw.h"
#endif

namespace bob {

namespace {

// playback_level, right after playback_completed (whose line is near the journal's length cap): the
// level the speaker API accepted (playbackLevel01 scale), the master volume and, on the Waveshare, the
// amp and the DAC's output path. The stages a silent reply can be lost in, side by side (P0 #1063).
void journalPlaybackLevel(const level::ReplyLevel& lvl, const char* format) {
  String detail = String("playback_level01_peak=") + String(lvl.peak(), 2) +
                  ",playback_level01_mean=" + String(lvl.mean(), 2) + ",blocks=" + lvl.blocks() +
                  ",spk_vol=" + M5Cardputer.Speaker.getVolume();
#if defined(BOB_BOARD_WAVESHARE_185C)
  char codec[96] = "";
  ws185::codecState(codec, sizeof(codec));
  detail += String(",amp=") + (ws185::ampIsOn() ? 1 : 0) + "," + codec;
#endif
  journal("playback_level", State::kAwaiting, "", detail + ",format=" + format);
}

// Full-duplex playback (#1364, Waveshare): replies go through audio_duplex's output ring instead of
// M5.Speaker so the echo-cancelled mic keeps listening. On the Cardputer these are inert stubs.
#if defined(BOB_BOARD_WAVESHARE_185C)
// Drain tail after the output ring empties: the I2S TX DMA still holds 4 x 10 ms (ws185_hw.cpp).
constexpr uint32_t kDuplexDmaDrainMs = 50;
uint32_t g_duplexEmptySince = 0;
constexpr uint32_t kDuplexStallMs = 2000;  // a non-empty ring that never moves: the task is wedged
size_t g_duplexLastPending = 0;
uint32_t g_duplexMovedAt = 0;
bool g_pcmDuplex = false;  // the active PCM reply plays through duplex
// Decided once per reply in beginPlayback: barge-in only exists in wake mode, so push-to-talk replies
// play through M5.Speaker as before the duplex (a mode change mid-reply keeps the reply's path).
bool g_replyDuplex = false;

// The gain M5.Speaker applies to a mono 16-bit sample (Speaker_Class.inl, stereo output): the mixer
// scales by magnification*2 (stereo) * master^2 * channel^2 / 2^28, and the I2S stage shifts right by 8,
// so out = s * 2 * magnification * master^2 * channel0^2 / 2^36. Same master (applySpeakerGain) and
// channel 0 volume, so a reply is exactly as loud as before.
float duplexGain() {
  auto& sp = M5Cardputer.Speaker;
  const float m = sp.getVolume(), c = sp.getChannelVolume(0);
  return 2.0f * sp.config().magnification * m * m * c * c / 68719476736.0f;
}

// n post-volume mono samples written to the ring; false if the duplex ended while waiting for space
// or `stop` was raised (backpressure, like the blocking playRaw it replaces).
bool duplexWriteScaled(const int16_t* in, size_t n, const volatile bool* stop) {
  const float gain = duplexGain();
  int16_t out[256];
  while (n > 0) {
    const size_t k = n < 256 ? n : 256;
    for (size_t i = 0; i < k; ++i) {
      const float v = in[i] * gain;
      out[i] = static_cast<int16_t>(v > 32767.0f ? 32767.0f : v < -32768.0f ? -32768.0f : v);
    }
    for (size_t done = 0; done < k;) {
      done += duplex::write(out + done, k - done);
      if (done < k) {
        if (!duplex::active() || (stop && *stop)) return false;
        vTaskDelay(1);
      }
    }
    in += k;
    n -= k;
  }
  return true;
}

// Journals the playback's duplex aggregates (never samples), stops the task and frees the port.
void duplexFinish() {
  if (!duplex::active()) return;
  const duplex::Stats s = duplex::takeStats();
  journal("duplex_stats", State::kAwaiting, "",
          String("erle_db=") + String(s.erleDb, 1) + ",mic_db=" + s.micDb + ",ref_db=" + s.refDb +
              ",frames=" + s.frames + ",underruns=" + s.underruns + ",overflows=" + s.overflows +
              ",frozen=" + s.frozenFrames + ",cpu_avg_us=" + s.cpuAvgUs + ",cpu_max_us=" + s.cpuMaxUs +
              ",xfer_max_us=" + s.xferMaxUs + ",aec_resets=" + s.aecResets +
              ",dt=" + String(s.dtRatio, 2) + ",delay=" + s.delay + ",res_gain_db=" + String(s.residualGainDb, 1) +
              ",stack_free=" + s.stackFreeBytes + ",mic_clip=" + s.micClips);
  duplex::end();
  g_pcmDuplex = false;
}

// True while the reply still has audio to play: the ring, then the DMA tail (duplex), or M5.Speaker.
bool replyAudioBusy(uint32_t now) {
  if (!duplex::active()) return M5Cardputer.Speaker.isPlaying();
  const size_t pending = duplex::pending();
  if (pending > 0) {
    g_duplexEmptySince = 0;
    // The duplex task installs the driver after begin() (~0.5 s); a ring that does not move for
    // kDuplexStallMs means the task is wedged, so let the reply end rather than hang forever.
    if (pending != g_duplexLastPending) {
      g_duplexLastPending = pending;
      g_duplexMovedAt = now;
    }
    return now - g_duplexMovedAt < kDuplexStallMs;
  }
  g_duplexLastPending = 0;
  if (g_duplexEmptySince == 0) g_duplexEmptySince = now;
  return now - g_duplexEmptySince < kDuplexDmaDrainMs;
}
#else
void duplexFinish() {}
bool replyAudioBusy(uint32_t) { return M5Cardputer.Speaker.isPlaying(); }
#endif

// How long the teardown path (loop/abort) lets the MP3 decode task drain buffered audio after
// the server's last frame before force-stopping it, and how long to then let
// the speaker finish the already-queued tail. Sized for the worst-case gap
// between "all bytes received" and "all audio played" (the server streams
// faster than real time), while still bounding a wedged decoder.
constexpr uint32_t kMp3DrainTimeoutMs = 15000;
constexpr uint32_t kSpeakerDrainTimeoutMs = 5000;
// How long abort() waits for the decode task after stopping the speaker; one
// decode iteration is a few ms, so this only bounds a wedged task.
constexpr uint32_t kAbortWaitMs = 500;

// Routes decoded MP3 PCM samples through M5Unified's Speaker_Class instead of
// writing raw I2S (what AudioOutputI2S does). This board's Speaker_Class
// applies a 16x software gain multiplier specific to the Cardputer's speaker
// wiring (see M5Unified.cpp's board_M5Cardputer config); AudioOutputI2S wrote
// directly to the I2S peripheral and bypassed that gain entirely, so MP3
// replies decoded and "completed" successfully but were inaudible. The PCM16
// path was never affected — it already calls M5Cardputer.Speaker.playRaw()
// directly. Pattern mirrors M5Unified's own reference example
// (examples/Advanced/MP3_with_ESP8266Audio).
class AudioOutputM5Speaker : public AudioOutput {
 public:
  // submitted: the reply's first-speaker-submission stamp (turn_timing.h).
  AudioOutputM5Speaker(m5::Speaker_Class* speaker, TimingStamp* submitted)
      : speaker_(speaker), submitted_(submitted) {}

  bool begin() override { return true; }

  bool ConsumeSample(int16_t sample[2]) override {
    if (bufferIndex_ < kBufferSize) {
      buffer_[triIndex_][bufferIndex_] = sample[0];
      buffer_[triIndex_][bufferIndex_ + 1] = sample[1];
      bufferIndex_ += 2;
      return true;
    }
    flush();
    return false;
  }

  void flush() override {
    if (bufferIndex_ == 0) return;
    // false = do not block waiting for a free virtual channel; a dropped
    // chunk under buffer pressure is preferable to stalling the decode task
    // and re-triggering the WS-read-timeout disconnect this firmware already
    // fought to fix.
    const uint32_t chunkMs =
        static_cast<uint32_t>(bufferIndex_ / 2) * 1000u / static_cast<uint32_t>(hertz);
    const float target = level::playbackTarget01(level::rmsOf(buffer_[triIndex_], bufferIndex_));
    level::playbackMeter().update(target, millis());  // ring light
    const uint32_t flushStart = micros();
    const bool duplexFormatOk = !duplexMode_ || (hertz == config::kSampleRateHz && channels == 1);
    if (!duplexFormatOk) rejectDuplexFormat();
    const bool accepted = duplexMode_ ? (duplexFormatOk && submitDuplex())
                                      : speaker_->playRaw(buffer_[triIndex_], bufferIndex_, hertz, true, 1,
                                                          kVirtualChannel);
    const uint32_t flushUs = micros() - flushStart;
    flushMicros_ += flushUs;
    if (flushUs > flushMaxUs_) flushMaxUs_ = flushUs;
    if (flushUs > kFlushStallThresholdUs) flushBlocked_++;
    if (!accepted) playrawDrops_++;
    if (accepted) level_.add(target);

    // Boundary-gap probe (M4): if the channel is silent right after a publish,
    // the speaker retired the previous chunk and a gap is forming. Approximate
    // its size as the idle time beyond the chunk's own duration.
    const uint32_t now = millis();
    if (accepted && submitted_ != nullptr) submitted_->mark(now);
    if (!duplexMode_ && !speaker_->isPlaying(kVirtualChannel)) {
      gapEvents_++;
      if (lastFlushAt_ != 0 && now > lastFlushAt_ + chunkMs) {
        gapMs_ += now - lastFlushAt_ - chunkMs;
      }
    }
    lastFlushAt_ = now;

    // Rate/volume accounting (M9): flush_ms dominating decode_cpu_ms means the
    // speaker drains slower than real time, which is a sample-rate symptom
    // rather than a buffer-depth one. Record the rate the generator actually
    // set and how many frames were published, so expected-vs-actual playback
    // duration is computable from the teardown journal alone.
    lastHertz_ = static_cast<uint32_t>(hertz);
    if (firstHertz_ == 0) firstHertz_ = lastHertz_;
    // Compare against the PREVIOUS rate, not the first one: comparing to
    // firstHertz_ would re-count every remaining flush after a single switch
    // and would miss a switch back to the original rate.
    if (prevHertz_ != 0 && lastHertz_ != prevHertz_) rateChanges_++;
    prevHertz_ = lastHertz_;
    // Only count audio the speaker actually accepted. Counting refused chunks
    // would inflate out_expected_ms exactly when the queue is under pressure,
    // making the harness report play_short in the one case — starvation —
    // where the measurement needs to be trustworthy.
    if (accepted) framesPushed_ += bufferIndex_ / 2;
    flushes_++;

    triIndex_ = (triIndex_ + 1) % 3;
    bufferIndex_ = 0;
  }

  bool stop() override {
    flush();
    speaker_->stop(kVirtualChannel);
    return true;
  }

  // Waveshare: play through the duplex ring (audio_duplex.h) instead of M5.Speaker. Set by the decode
  // task before the generator starts; abort() raises requestStop() so a write waiting for ring space ends.
  void useDuplex(bool on) { duplexMode_ = on; }
  void requestStop() { stopRequested_ = true; }

  // Diagnostics accessors (M3/M4/M5): flush block time, >5 ms stalls, boundary
  // gaps, and playRaw refusals. Read once at teardown.
  uint32_t flushMicros() const { return flushMicros_; }
  uint32_t flushMaxUs() const { return flushMaxUs_; }
  uint32_t flushBlocked() const { return flushBlocked_; }
  uint32_t gapEvents() const { return gapEvents_; }
  uint32_t gapMs() const { return gapMs_; }
  uint32_t playrawDrops() const { return playrawDrops_; }
  uint32_t firstHertz() const { return firstHertz_; }
  uint32_t lastHertz() const { return lastHertz_; }
  uint32_t rateChanges() const { return rateChanges_; }
  uint32_t framesPushed() const { return framesPushed_; }
  uint32_t flushes() const { return flushes_; }
  const level::ReplyLevel& level() const { return level_; }

 private:
  // The buffered stereo pairs as post-volume mono samples into the duplex ring.
  bool submitDuplex() {
#if defined(BOB_BOARD_WAVESHARE_185C)
    int16_t mono[kBufferSize / 2];
    const size_t n = bufferIndex_ / 2;
    for (size_t i = 0; i < n; ++i) {
      mono[i] = static_cast<int16_t>((buffer_[triIndex_][2 * i] + buffer_[triIndex_][2 * i + 1]) / 2);
    }
    return duplexWriteScaled(mono, n, &stopRequested_);
#else
    return false;
#endif
  }

  // The reply is not 16 kHz mono (replies always are; this should never run): the duplex ring has no
  // resampler, so fail the reply. Nothing is torn down here (this is the mp3 task); stopRequested_ ends the
  // write loop and the loop-side teardown runs duplexFinish().
  void rejectDuplexFormat() {
    if (stopRequested_) return;
    stopRequested_ = true;
    journal("duplex_bad_format", State::kAwaiting, "", String("hz=") + hertz + ",channels=" + channels);
  }

  bool duplexMode_ = false;
  volatile bool stopRequested_ = false;
  static constexpr uint8_t kVirtualChannel = 0;
  static constexpr size_t kBufferSize = 1536;
  static constexpr uint32_t kFlushStallThresholdUs = 5000;
  m5::Speaker_Class* speaker_;
  TimingStamp* submitted_;
  int16_t buffer_[3][kBufferSize];
  size_t bufferIndex_ = 0;
  size_t triIndex_ = 0;
  uint32_t flushMicros_ = 0;
  uint32_t flushMaxUs_ = 0;
  uint32_t flushBlocked_ = 0;
  uint32_t gapEvents_ = 0;
  uint32_t gapMs_ = 0;
  uint32_t playrawDrops_ = 0;
  uint32_t lastFlushAt_ = 0;
  uint32_t firstHertz_ = 0;
  uint32_t lastHertz_ = 0;
  uint32_t prevHertz_ = 0;
  uint32_t rateChanges_ = 0;
  uint32_t framesPushed_ = 0;
  uint32_t flushes_ = 0;
  level::ReplyLevel level_;
};

// ESP8266Audio's default constructor sets only `buff`; stream/frame/synth stay
// uninitialised until begin() allocates them, yet its destructor (and stop())
// free all four. A generator whose begin() never ran or returned early (an
// abort closed the source, mp3_oom, the decode task never started) then freed
// garbage: heap_caps_free assert, HIL run 20260924-152435-04ca. Nulling them
// here makes deleting such a generator safe; planMp3Teardown keeps stop() off it.
class SafeAudioGeneratorMP3 : public AudioGeneratorMP3 {
 public:
  SafeAudioGeneratorMP3() {
    stream = nullptr;
    frame = nullptr;
    synth = nullptr;
  }
};

// A reply that could not start (no buffer, no decoder, no task) ends now, failed.
void markPlaybackFailed(PlaybackStamps& stamps) {
  stamps.failed = true;
  stamps.ended.mark(millis());
}

#ifdef BOB_TEST_CONSOLE
// Armed by `T mp3 abort_at_begin`; consumed by the next decode task.
volatile bool g_testAbortAtBegin = false;
constexpr uint32_t kTestHoldMaxMs = 5000;
#endif

}  // namespace

#ifdef BOB_TEST_CONSOLE
void testArmMp3AbortAtBegin() { g_testAbortAtBegin = true; }
#endif

struct AudioPlayback::Mp3State {
  AudioPlayback* owner;
  ByteRingBuffer ring;
  RingBufferFileSource* source;
  AudioGeneratorMP3* generator;
  AudioOutputM5Speaker* output;
  TaskHandle_t task;
  SemaphoreHandle_t mutex;
  bool eof;
  bool stop;
  // Set by the decode task when generator->begin() succeeded; read by the
  // teardown only after the task has exited (see planMp3Teardown).
  bool began_;
  // The decode task's turn_timing stamps, copied into the reply's stamps_ at
  // teardown. They live here, not in AudioPlayback, so an abandoned task (its
  // Mp3State is leaked, never freed) can never stamp a later reply.
  TimingStamp decoderReady;
  TimingStamp submitted;
  bool decodeFailed = false;

  // Decode-loop diagnostics (M1/M7), written by the decode task and read once
  // by the teardown path (loop/abort) after the task has exited.
  uint32_t decodeCpuUs_;
  uint32_t loopMaxUs_;
  uint32_t loops_;
  bool finishAnnouncementCue = false;
  const char* exitReason_;
  // Written by the decode task just before it exits. Reading the watermark
  // from the teardown path (loop/abort) via the task handle always returned 0, because the task
  // nulls the handle before deleting itself.
  uint32_t stackWatermark_;
  // Given by the decode task once it will no longer touch anything owned by
  // this object. the teardown path (loop/abort) waits on THIS, not on `task` going null: the
  // task nulls that handle and then keeps running (vTaskDelete, scheduler
  // exit), so a nulled handle never meant "safe to free the generator and
  // output the task is still writing into".
  SemaphoreHandle_t exited;

  explicit Mp3State(AudioPlayback* playback)
      : owner(playback),
        ring(config::kMp3RingBufferBytes),
        source(nullptr),
        generator(nullptr),
        output(nullptr),
        task(nullptr),
        mutex(nullptr),
        eof(false),
        stop(false),
        began_(false),
        decodeCpuUs_(0),
        loopMaxUs_(0),
        loops_(0),
        exitReason_("n/a"),
        stackWatermark_(0),
        exited(nullptr) {
    mutex = xSemaphoreCreateMutex();
    exited = xSemaphoreCreateBinary();
  }

  ~Mp3State() {
    if (exited) {
      vSemaphoreDelete(exited);
      exited = nullptr;
    }
    if (mutex) {
      vSemaphoreDelete(mutex);
      mutex = nullptr;
    }
  }

  // Last thing the decode task does while it can still touch this object.
  // Capture the watermark here, from inside the task, then publish the
  // "no longer using your memory" signal.
  void signalExit() {
    stackWatermark_ = uxTaskGetStackHighWaterMark(nullptr);
    task = nullptr;
    if (exited) xSemaphoreGive(exited);
  }

  // Blocks until the decode task has signalled it is done, or the budget runs
  // out. Returns true if the task is provably finished.
  bool waitForExit(uint32_t timeoutMs) {
    if (!exited) return task == nullptr;
    return xSemaphoreTake(exited, pdMS_TO_TICKS(timeoutMs)) == pdTRUE;
  }

  void lock() {
    if (mutex) xSemaphoreTake(mutex, portMAX_DELAY);
  }
  void unlock() {
    if (mutex) xSemaphoreGive(mutex);
  }
};

// One PCM reply: the ring pushDownlink() fills and three chunks the speaker
// plays from. playRaw() does not copy and holds at most two buffers (playing +
// next), so the third is always free to fill, as in AudioOutputM5Speaker.
struct AudioPlayback::PcmState {
  PcmRing ring;
  int16_t chunks[3][config::kPcmChunkSamples];
  uint8_t next;
  uint32_t refused;
  level::ReplyLevel level;  // what the speaker accepted (#1063)

  PcmState()
      : ring(config::kPcmRingBufferBytes, config::kPcmPrebufferBytes),
        next(0),
        refused(0) {}
};

AudioPlayback::AudioPlayback()
    : pcm_(nullptr),
      pcmSamples_(0),
      active_(false),
      format_(AudioFormat::kPcm16),
      downFrames_(0),
      lastFrameAt_(0),
      overflowLogged_(false),
      firstSeq_(0),
      lastSeq_(0),
      seqGapCount_(0),
      draining_(false),
      drainStartedAt_(0),
      decodeExited_(false),
      mp3_(nullptr) {
  allocateBuffer();
}

AudioPlayback::~AudioPlayback() {
  if (active_) {
    abort();
  }
  freePcmBuffer();
}

bool AudioPlayback::allocateBuffer() {
  // PCM buffer is now allocated lazily on the first PCM reply so the full
  // heap stays available for MP3 streaming. The duplex rings and canceller are
  // allocated once here (boot) so the first reply's begin() costs the loop nothing.
#if defined(BOB_BOARD_WAVESHARE_185C)
  duplex::init();
#endif
  return true;
}

void AudioPlayback::freePcmBuffer() {
  delete pcm_;
  pcm_ = nullptr;
}

void AudioPlayback::beginPlayback(AudioFormat format, bool finishAnnouncementCue) {
  if (active_) {
    abort();
  }

  format_ = format;
  draining_ = false;
  decodeExited_ = false;
  downFrames_ = 0;
  lastFrameAt_ = millis();
  overflowLogged_ = false;
  firstSeq_ = 0;
  lastSeq_ = 0;
  seqGapCount_ = 0;
  stamps_.clear();
  stamps_.start.mark(millis());  // the playback_start control's receipt.
  stamps_.decoder = format_ == AudioFormat::kMp3;
#if defined(BOB_BOARD_WAVESHARE_185C)
  g_replyDuplex = settings().mode == DeviceMode::kWake;
  if (!g_replyDuplex) journal("duplex_skipped", State::kAwaiting, "", "reason=ptt");
#endif

  if (format_ == AudioFormat::kPcm16) {
    // A bounded ring the speaker drains as frames arrive (#674): the old
    // whole-reply block (320 KB, then 160 KB) never fit the ~156 KB largest
    // free block, so every PCM reply was dropped.
    freePcmBuffer();
    pcm_ = new (std::nothrow) PcmState();
    if (!pcm_ || !pcm_->ring.ok()) {
      freePcmBuffer();
      active_ = false;
      markPlaybackFailed(stamps_);
      journal("playback_buffer_failed", State::kAwaiting, "",
              String("free=") + heap_caps_get_free_size(MALLOC_CAP_8BIT) +
                  ",largest=" + heap_caps_get_largest_free_block(MALLOC_CAP_8BIT) +
                  ",format=pcm16");
      return;
    }
    journal("playback_buffer", State::kAwaiting, "",
            String("capacity_bytes=") + pcm_->ring.capacity());
#if defined(BOB_BOARD_WAVESHARE_185C)
    g_duplexEmptySince = 0;
    g_duplexLastPending = 0;
    g_duplexMovedAt = millis();
    // The duplex task ends M5.Speaker itself (ws185::duplexBegin); the loop must not touch the speaker
    // until duplex::ready, because Speaker.end() can wait on M5's speaker task (it cost ~90 ms here).
    g_pcmDuplex = g_replyDuplex && duplex::begin();  // takes the speaker over; false falls back to M5.Speaker
    if (!g_pcmDuplex) restartSpeaker();
#else
    restartSpeaker();
#endif
    applySpeakerGain();  // the user's level (#314), 0 while muted (duplexGain() reads it too).
    pcmSamples_ = 0;
    active_ = true;
  } else if (format_ == AudioFormat::kMp3) {
    // Routed through M5Cardputer.Speaker (see AudioOutputM5Speaker above),
    // same begin()/setVolume() sequence as the PCM branch above — that gain
    // stage is what makes MP3 playback audible on this hardware.
    // Only MP3 announcements have a prelude. Normal replies and PCM retain
    // immediate speaker ownership; the WS receiver keeps filling the ring.
#if defined(BOB_BOARD_WAVESHARE_185C)
    g_duplexEmptySince = 0;
    // The decode task takes the port for duplex once any announcement cue is done, or restarts
    // M5.Speaker itself if duplex cannot start.
#else
    if (!finishAnnouncementCue || !earconPlaying()) restartSpeaker();
#endif
    applySpeakerGain();  // the user's level (#314), 0 while muted.

    mp3_ = new AudioPlayback::Mp3State(this);
    if (!mp3_) {
      active_ = false;
      markPlaybackFailed(stamps_);
      return;
    }

    mp3_->finishAnnouncementCue = finishAnnouncementCue;
    mp3_->source = new RingBufferFileSource(&mp3_->ring);
    mp3_->output = new AudioOutputM5Speaker(&M5Cardputer.Speaker, &mp3_->submitted);

    mp3_->generator = new SafeAudioGeneratorMP3();
    if (!mp3_->generator || !mp3_->source || !mp3_->output) {
      delete mp3_->generator;
      delete mp3_->source;
      delete mp3_->output;
      delete mp3_;
      mp3_ = nullptr;
      active_ = false;
      markPlaybackFailed(stamps_);
      return;
    }

    mp3_->source->open("");

    struct DecodeTask {
      static void run(void* param) {
        AudioPlayback::Mp3State* state = static_cast<AudioPlayback::Mp3State*>(param);
        if (!state || !state->generator) {
          if (state) state->signalExit();
          vTaskDelete(NULL);
          return;
        }

        // Wait for the first MP3 chunk to arrive before starting the decoder;
        // beginning on an empty source causes AudioGeneratorMP3 to treat EOF
        // and exit immediately.
        while (state->ring.available() == 0 && !state->ring.isEof()) {
          vTaskDelay(2);  // 20 ms; pdMS_TO_TICKS(1) truncates to 0
        }
        journal("mp3_ring_ready", State::kAwaiting, "",
                String("avail=") + state->ring.available() +
                    ",eof=" + state->ring.isEof() +
                    ",free=" + heap_caps_get_free_size(MALLOC_CAP_8BIT));

        if (state->finishAnnouncementCue) {
          const uint32_t cueStart = millis();
          while (true) {
            state->lock();
            const bool stopped = state->stop;
            state->unlock();
            if (stopped) {
              state->signalExit();
              vTaskDelete(NULL);
              return;
            }
            if (!waitForAnnouncementCue(earconPlaying(), false, millis() - cueStart,
                                        state->ring.available(), config::kMp3RingBufferBytes)) break;
            vTaskDelay(1);
          }
          stopEarcon();  // silence any bounded/pressure-truncated tail before speech.
        }

        // The decoder mallocs per frame; if internal heap is critically low the
        // generator null-derefs (StoreProhibited panic). Bail cleanly instead.
        if (heap_caps_get_free_size(MALLOC_CAP_8BIT) < config::kMp3MinDecodeHeapBytes) {
          journal("mp3_oom", State::kAwaiting, "",
                  String("free=") +
                      heap_caps_get_free_size(MALLOC_CAP_8BIT));
          state->decodeFailed = true;
          state->signalExit();
          vTaskDelete(NULL);
          return;
        }

#ifdef BOB_TEST_CONSOLE
        // HIL: hold here until an abort sets stop (it also closes the source),
        // so begin() below runs on the aborted source, the late-stop race.
        if (g_testAbortAtBegin) {
          g_testAbortAtBegin = false;
          journal("test_mp3_hold", State::kAwaiting, "");
          const uint32_t holdStart = millis();
          while (millis() - holdStart < kTestHoldMaxMs) {
            state->lock();
            const bool stopped = state->stop;
            state->unlock();
            if (stopped) break;
            vTaskDelay(2);
          }
        }
#endif

#if defined(BOB_BOARD_WAVESHARE_185C)
        if (g_replyDuplex && duplex::begin()) {
          state->output->useDuplex(true);
        } else {
          if (!M5Cardputer.Speaker.isRunning()) restartSpeaker();
          applySpeakerGain();
        }
#endif
        bool began = state->generator->begin(state->source, state->output);
        state->began_ = began;
        // The decoder is ready (or failed) for turn_timing's decoder_ready_ms.
        if (began) {
          state->decoderReady.mark(millis());
        } else {
          state->decodeFailed = true;
        }
        journal("mp3_began", State::kAwaiting, "",
                String("ok=") + (began ? "1" : "0"));
        if (!began) {
          journal("mp3_begin_failed", State::kAwaiting, "");
        }

        bool running = began;
        while (running) {
          state->lock();
          bool shouldStop = state->stop;
          state->unlock();
          if (shouldStop) {
            state->exitReason_ = "stopped";
            break;
          }

          if (!state->generator->isRunning()) {
            journal("mp3_generator_stopped", State::kAwaiting, "");
            state->exitReason_ = "generator_stopped";
            running = false;
            break;
          }
          const uint32_t loopStartUs = micros();
          const bool loopOk = state->generator->loop();
          const uint32_t loopUs = micros() - loopStartUs;
          state->decodeCpuUs_ += loopUs;
          if (loopUs > state->loopMaxUs_) state->loopMaxUs_ = loopUs;
          state->loops_++;
          if (!loopOk) {
            // Exit classification (M7): EOF when the ring is closed and empty,
            // otherwise the generator bailed with data still available — the
            // truncation signature this instrumentation is meant to catch.
            state->exitReason_ =
                (state->ring.isEof() && state->ring.available() == 0)
                    ? "eof"
                    : "loop_false_early";
            journal("mp3_loop_ended", State::kAwaiting, "");
            running = false;
            break;
          }
          // Do NOT sleep between decode iterations. Each generator->loop()
          // produces roughly one MP3 frame (~8 ms of audio), so a 20 ms delay
          // here decoded ~3.5x slower than real time and the reply came out
          // audibly chopped. Backpressure already comes from two natural
          // blocking points: the ring read blocks when the server hasn't
          // delivered the next chunk yet, and playRaw() blocks when the
          // speaker's queue is full — both of which yield the CPU, so the
          // idle task still runs and the task watchdog stays fed.
          taskYIELD();
        }

        // loop() sees the exit signal and tears the reply down once the
        // speaker has played what was queued.
        state->signalExit();
        vTaskDelete(NULL);
      }
    };

    // Pin decode to core 1 — NOT core 0. Core 0 is the ESP32 Wi-Fi/lwIP system
    // core in the Arduino framework; an earlier attempt pinned decode there
    // believing it was the "safe" core away from the loop, but that put a
    // CPU-heavy decode task in direct contention with the radio/TCP stack and
    // reliably killed the connection a few frames into every MP3 reply. The
    // Arduino loopTask and the WebSocket network task (see network.cpp) both
    // run on core 1 too; decode shares it with them instead of core 0.
    BaseType_t created = xTaskCreatePinnedToCore(
        &DecodeTask::run, "mp3_decode", 12288, mp3_, 1, &mp3_->task, 1);
    if (created != pdPASS) {
      mp3_->task = nullptr;
      delete mp3_->generator;
      delete mp3_->source;
      delete mp3_->output;
      delete mp3_;
      mp3_ = nullptr;
      active_ = false;
      markPlaybackFailed(stamps_);
      return;
    }

    active_ = true;
  }
}

void AudioPlayback::pushDownlink(const Olx2Header& header, const uint8_t* payload) {
  if (!active_) {
    return;
  }
  markFrameReceived();
  if (downFrames_ == 0) stamps_.firstDown.mark(millis());

  // Sequence integrity (diagnostics): downlink frames must arrive with +1
  // sequence increments; a gap means frames were lost between the server and
  // the app layer (TCP/WS drops), which is what the truncation instrumentation
  // distinguishes from decode-side failures.
  if (downFrames_ == 0) {
    firstSeq_ = header.sequence;
  } else if (header.sequence != lastSeq_ + 1) {
    seqGapCount_++;
  }
  lastSeq_ = header.sequence;

  if (format_ == AudioFormat::kPcm16) {
    if (!pcm_) return;
    const size_t stored = pcm_->ring.push(payload, header.payloadBytes);
    if (stored < header.payloadBytes && !overflowLogged_) {
      overflowLogged_ = true;
      journal("playback_overflow", State::kAwaiting, "",
              String("dropped_bytes=") + (header.payloadBytes - stored) +
                  ",format=pcm16");
    }
    pumpPcm();
  } else if (format_ == AudioFormat::kMp3 && mp3_) {
    size_t pushed = mp3_->ring.push(payload, header.payloadBytes);
    if (pushed < header.payloadBytes && !overflowLogged_) {
      overflowLogged_ = true;
      uint32_t dropped = static_cast<uint32_t>(header.payloadBytes - pushed);
      journal("playback_overflow", State::kAwaiting, "",
              String("dropped_bytes=") + dropped);
    }
  }

  downFrames_++;
  stamps_.downFrames = downFrames_;
}

void AudioPlayback::finishStream() {
  if (!active_ || draining_) return;
  draining_ = true;
  drainStartedAt_ = millis();
  if (format_ == AudioFormat::kPcm16) {
    // The end opens the prebuffer gate for a short reply and lets the last
    // partial chunk go; loop() tears down once the ring and speaker are empty.
    pumpPcm();
    return;
  }
  if (!mp3_) return;
  journal("playback_ending", State::kAwaiting, "", String("frames=") + downFrames_);
  // Marking end-of-data unblocks the decode task's blocking ring read and
  // lets the generator drain whatever is still buffered. It must NOT close
  // the source: begin() refuses a closed source, so a reply fully buffered
  // before the decode task reached begin() was dropped (mp3_begin_failed,
  // see mp3_ring_source.h). Do
  // NOT set stop=true here: the server finishes sending well before the
  // audio finishes playing (a ~1.5 s reply arrives in ~0.6 s), so forcing
  // the task to exit on the last frame threw away most of the audio
  // undecoded — the ring still held ~21 KB of 30 KB at teardown, which is
  // why replies were inaudible.
  endMp3Stream(mp3_->source);
}

void AudioPlayback::loop() {
  // Every path that ends a reply (drain, abort, a failed start) drops the
  // hold here, and the idle rule then ends the speaker (CP-QUIET).
  holdSpeaker(active_);
  speakerIdleTick(millis());
  if (!active_) return;
  if (format_ == AudioFormat::kPcm16) {
    pumpPcm();
    if (draining_) {
      // A duplex ring that never moves ends the reply even with PCM still queued (a wedged task
      // used to leave the ring non-empty forever, so this never tore down).
      const bool busy = replyAudioBusy(millis());
      const bool ringEmpty = !pcm_ || pcm_->ring.available() == 0;
#if defined(BOB_BOARD_WAVESHARE_185C)
      const bool stalled = g_pcmDuplex && duplex::pending() > 0;  // stuck full, not merely between pumps
#else
      const bool stalled = false;
#endif
      if (!busy && (ringEmpty || stalled)) {
        if (!ringEmpty) journal("duplex_pcm_stall", State::kAwaiting, "", String("ring_avail=") + pcm_->ring.available());
        teardownPcm();
      }
    }
    return;
  }
  if (!mp3_) {
    active_ = false;
    draining_ = false;
    return;
  }
  // Only once the task has exited on its own (EOF, or an early bail such as
  // mp3_oom) is it safe to stop/free the generator: stop() frees buff/stream
  // and a task still inside Input()/mad_stream_buffer would decode into freed
  // memory (StoreProhibited panic at address 0x0).
  if (!decodeExited_ && mp3_->waitForExit(0)) {
    decodeExited_ = true;
    drainStartedAt_ = millis();  // from here on this times the speaker tail.
  }
  if (decodeExited_) {
    // playRaw() is asynchronous: let the speaker finish what was queued.
    if (!replyAudioBusy(millis()) ||
        millis() - drainStartedAt_ >= kSpeakerDrainTimeoutMs) {
      teardownMp3(true);
    }
    return;
  }
  // Backstop: if the decoder is wedged past the drain budget, force it out
  // so a stuck task can never hold playback active indefinitely.
  if (draining_ && millis() - drainStartedAt_ >= kMp3DrainTimeoutMs) {
    journal("mp3_drain_timeout", State::kAwaiting, "",
            String("ring_avail=") + mp3_->ring.available());
    stamps_.failed = true;  // a wedged decoder: the reply may be cut short.
    mp3_->lock();
    mp3_->stop = true;
    mp3_->unlock();
    const bool stopped = mp3_->waitForExit(2000);
    if (!stopped) {
      // The task never acknowledged. It may still be inside ConsumeSample or
      // flush, writing into the generator and output, so freeing them would
      // be a use-after-free. Leak this session's decode objects instead: a
      // bounded one-off leak is recoverable, a heap corruption is not.
      journal("mp3_task_abandoned", State::kAwaiting, "",
              String("ring_avail=") + mp3_->ring.available());
    }
    teardownMp3(stopped);
  }
}

void AudioPlayback::abort() {
  if (!active_) return;
  if (format_ == AudioFormat::kPcm16) {
    M5Cardputer.Speaker.stop(0);
    teardownPcm();
    return;
  }
  if (!mp3_) {
    active_ = false;
    draining_ = false;
    return;
  }
  journal("playback_aborted", State::kAwaiting, "", String("frames=") + downFrames_);
  mp3_->lock();
  mp3_->stop = true;
  mp3_->unlock();
  if (mp3_->source) mp3_->source->close();  // wakes a blocked ring read.
  if (mp3_->output) mp3_->output->requestStop();  // ends a duplex write waiting for ring space.
  M5Cardputer.Speaker.stop(0);  // wakes a playRaw() waiting for a free slot.
  const bool stopped = decodeExited_ || mp3_->waitForExit(kAbortWaitMs);
  M5Cardputer.Speaker.stop(0);  // drops anything queued while it stopped.
  if (!stopped) {
    journal("mp3_task_abandoned", State::kAwaiting, "",
            String("ring_avail=") + mp3_->ring.available());
  }
  teardownMp3(stopped);
}

void AudioPlayback::pumpPcm() {
  if (!pcm_) return;
#if defined(BOB_BOARD_WAVESHARE_185C)
  if (g_pcmDuplex) {
    // Whole chunks into the duplex ring while it has room, so duplexWriteScaled never waits here.
    while (duplex::space() >= config::kPcmChunkSamples) {
      int16_t* chunk = pcm_->chunks[0];
      const size_t n = pcm_->ring.take(chunk, config::kPcmChunkSamples, draining_, duplex::pending() == 0);
      if (n == 0) return;
      const float target = level::playbackTarget01(level::rmsOf(chunk, n));
      level::playbackMeter().update(target, millis());  // ring light
      if (duplexWriteScaled(chunk, n, nullptr)) {
        if (pcmSamples_ == 0) journal("duplex_pcm_first", State::kAwaiting, "", String("samples=") + n);
        pcmSamples_ += n;
        pcm_->level.add(target);
        stamps_.submitted.mark(millis());
      } else {
        pcm_->refused++;
      }
    }
    return;
  }
#endif
  // Only into a free queue slot (isPlaying < 2), so playRaw never blocks the
  // loop. Even if it did, it returns only once at most two buffers are queued,
  // so the chunk written next is never one the speaker still reads.
  while (M5Cardputer.Speaker.isPlaying(0) < 2) {
    int16_t* chunk = pcm_->chunks[pcm_->next];
    const size_t n = pcm_->ring.take(chunk, config::kPcmChunkSamples, draining_,
                                     M5Cardputer.Speaker.isPlaying(0) == 0);
    if (n == 0) return;
    const float target = level::playbackTarget01(level::rmsOf(chunk, n));
    level::playbackMeter().update(target, millis());  // ring light
    if (M5Cardputer.Speaker.playRaw(chunk, n, config::kSampleRateHz, false, 1, 0)) {
      pcmSamples_ += n;
      pcm_->level.add(target);
      stamps_.submitted.mark(millis());  // the speaker API took the first samples.
    } else {
      pcm_->refused++;
    }
    pcm_->next = static_cast<uint8_t>((pcm_->next + 1) % 3);
  }
}

void AudioPlayback::teardownPcm() {
  stamps_.ended.mark(millis());
  duplexFinish();  // stats journal + stop the task, before the listen earcon can take the speaker
  if (M5Cardputer.Speaker.isRunning()) {
    AudioCall guard(AudioStage::kSpeakerEnd, millis());
    M5Cardputer.Speaker.end();
  }
  journal("playback_completed", State::kAwaiting, "",
          String("samples=") + pcmSamples_ + ",down_frames=" + downFrames_ +
              ",ring_avail=" + (pcm_ ? pcm_->ring.available() : 0) +
              ",ring_peak=" + (pcm_ ? pcm_->ring.peak() : 0) +
              ",dropped_bytes=" + (pcm_ ? pcm_->ring.droppedBytes() : 0) +
              ",underruns=" + (pcm_ ? pcm_->ring.underruns() : 0) +
              ",playraw_drops=" + (pcm_ ? pcm_->refused : 0) +
              ",seq_gaps=" + seqGapCount_ + ",format=pcm16");
  journalPlaybackLevel(pcm_ ? pcm_->level : level::ReplyLevel(), "pcm16");
  freePcmBuffer();
  active_ = false;
  draining_ = false;
}

void AudioPlayback::teardownMp3(bool drained) {
  stamps_.ended.mark(millis());
  if (mp3_) {
    // The decode task's stamps (it has exited, or was abandoned with mp3_ leaked).
    if (mp3_->decoderReady.set) stamps_.decoderReady.mark(mp3_->decoderReady.at);
    if (mp3_->submitted.set) stamps_.submitted.mark(mp3_->submitted.at);
    if (mp3_->decodeFailed) stamps_.failed = true;
    // Capture ring/overflow state before teardown so the next test separates
    // RX under-delivery (ring stays low, no overflow) from decode the failure
    // to the server bus (ring peaks at capacity -> overflowLogged_).
    size_t ringAvail = mp3_->ring.available();

    // Diagnostics: capture every counter while its owner is still alive; the
    // ring lives inside mp3_ and the output counters must be read before the
    // delete below.
    const size_t ringWatermark = mp3_->ring.watermark();
    const uint32_t ringWaitMs = static_cast<uint32_t>(mp3_->ring.waitMicros() / 1000);
    const uint32_t emptyPolls = mp3_->ring.emptyPolls();
    const char* mp3Exit = mp3_->exitReason_;
    const uint32_t decodeCpuMs = mp3_->decodeCpuUs_ / 1000;
    const uint32_t loopMaxUs = mp3_->loopMaxUs_;
    const uint32_t loops = mp3_->loops_;
    // Recorded by the task itself in signalExit(); querying it here through
    // the handle always read 0, since the task nulls the handle before it
    // exits.
    const uint32_t decodeStack = mp3_->stackWatermark_;
    const uint32_t wsStack = wsNetStackWatermark();

    // Only touch the decode objects once the task has provably stopped using
    // them. generator->stop() frees buff/stream, and a task still inside
    // Input()/mad_stream_buffer would then decode into freed memory. began_ is
    // safe to read here: the task wrote it before signalling its exit.
    const Mp3TeardownPlan plan = planMp3Teardown(drained, mp3_->began_);
    if (plan.stopGenerator && mp3_->generator) mp3_->generator->stop();
    if (plan.stopOutput && mp3_->output) mp3_->output->stop();
    duplexFinish();  // stats journal + stop the task (also on abort), before the listen earcon

    // Read output-side counters (M3/M4/M5) before the output is destroyed.
    const uint32_t flushMs = mp3_->output->flushMicros() / 1000;
    const uint32_t flushMaxUs = mp3_->output->flushMaxUs();
    const uint32_t flushBlocked = mp3_->output->flushBlocked();
    const uint32_t gapEvents = mp3_->output->gapEvents();
    const uint32_t gapMs = mp3_->output->gapMs();
    const uint32_t playrawDrops = mp3_->output->playrawDrops();
    const uint32_t firstHz = mp3_->output->firstHertz();
    const uint32_t lastHz = mp3_->output->lastHertz();
    const uint32_t rateChanges = mp3_->output->rateChanges();
    const uint32_t framesPushed = mp3_->output->framesPushed();
    const uint32_t flushes = mp3_->output->flushes();
    const level::ReplyLevel replyLevel = mp3_->output->level();
    // Real-time budget the decoded audio *should* have taken, from the rate
    // the generator actually reported. Comparing this against the observed
    // playback_started -> playback_completed span separates "published at the
    // wrong rate" from "queue starved".
    const uint32_t expectedPlayMs =
        lastHz > 0 ? static_cast<uint32_t>((framesPushed * 1000ull) / lastHz) : 0;

    if (plan.freeObjects) {
      delete mp3_->generator;
      delete mp3_->source;
      delete mp3_->output;
      delete mp3_;
    }
    // When not drained the objects are deliberately leaked (see
    // mp3_task_abandoned above): an abandoned task still holds pointers into
    // them. Drop our reference either way so a new playback starts clean.
    mp3_ = nullptr;

    journal("playback_completed", State::kAwaiting, "",
            String("down_frames=") + downFrames_ + ",ring_avail=" +
                ringAvail + ",ring_peak=" + ringWatermark +
                ",overflow=" + overflowLogged_ +
                ",seq_first=" + firstSeq_ + ",seq_last=" + lastSeq_ +
                ",seq_gaps=" + seqGapCount_ +
                ",mp3_exit=" + mp3Exit +
                ",decode_cpu_ms=" + decodeCpuMs +
                ",loop_max_us=" + loopMaxUs +
                ",loops=" + loops +
                ",ring_wait_ms=" + ringWaitMs +
                ",empty_polls=" + emptyPolls +
                ",flush_ms=" + flushMs +
                ",flush_max_us=" + flushMaxUs +
                ",flush_blocked=" + flushBlocked +
                ",gap_events=" + gapEvents +
                ",gap_ms=" + gapMs +
                ",playraw_drops=" + playrawDrops +
                ",out_hz_first=" + firstHz +
                ",out_hz_last=" + lastHz +
                ",out_rate_changes=" + rateChanges +
                ",out_frames=" + framesPushed +
                ",out_flushes=" + flushes +
                ",out_expected_ms=" + expectedPlayMs +
                ",ws_stack=" + wsStack +
                ",decode_stack=" + decodeStack +
                "," + networkRxJournalDetail() +
                ",format=mp3");
    journalPlaybackLevel(replyLevel, "mp3");
  }

  // Drained: nothing can write to the speaker any more, so the amp goes off
  // now, like teardownPcm(). An abandoned task may still call playRaw(), so
  // that case is left to the idle rule.
  if (drained && M5Cardputer.Speaker.isRunning()) {
    AudioCall guard(AudioStage::kSpeakerEnd, millis());
    M5Cardputer.Speaker.end();
  }
  active_ = false;
  draining_ = false;
  decodeExited_ = false;
}

bool AudioPlayback::active() const { return active_; }

bool AudioPlayback::draining() const { return draining_; }

AudioFormat AudioPlayback::format() const { return format_; }

uint32_t AudioPlayback::downFrameCount() const { return downFrames_; }

void AudioPlayback::markFrameReceived() { lastFrameAt_ = millis(); }

uint32_t AudioPlayback::lastFrameAt() const { return lastFrameAt_; }

// A draining reply receives no more frames by design, so it is never stalled.
bool AudioPlayback::isStalled(uint32_t now) const {
  return active_ && !draining_ &&
         (now - lastFrameAt_ > config::kDownlinkStallThresholdMs);
}

bool AudioPlayback::overflowLogged() const { return overflowLogged_; }

void AudioPlayback::toneTest() {
#ifdef BOB_TONE_TEST
  // Plays 1 s of a 1 kHz sine at the negotiated PCM rate and journals the
  // wall-clock time the speaker took. Nominal is ~1000 ms; anything beyond
  // ~1100 ms means the speaker's I2S clock (or resampler) is running slow,
  // which would independently explain slow/chopped playback and would need a
  // speaker-config fix before any decode-side tuning matters.
  constexpr size_t kToneSamples = config::kSampleRateHz;
  int16_t* tone = static_cast<int16_t*>(
      heap_caps_malloc(kToneSamples * sizeof(int16_t),
                       MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  if (!tone) {
    journal("tone_play", State::kAwaiting, "", "alloc_failed=1");
    return;
  }
  for (size_t i = 0; i < kToneSamples; ++i) {
    tone[i] = static_cast<int16_t>(
        0.5f * 32767.0f *
        sinf(2.0f * static_cast<float>(M_PI) * 1000.0f *
             static_cast<float>(i) / static_cast<float>(config::kSampleRateHz)));
  }
  restartSpeaker();
  applySpeakerGain();  // the user's level, like replies (CP-QUIET).
  const uint32_t toneStart = millis();
  M5Cardputer.Speaker.playRaw(tone, kToneSamples, config::kSampleRateHz, false,
                              1, 0);
  while (M5Cardputer.Speaker.isPlaying()) {
    M5Cardputer.update();
    delay(1);
  }
  const uint32_t toneMs = millis() - toneStart;
  heap_caps_free(tone);
  journal("tone_play", State::kAwaiting, "",
          String("ms=") + toneMs + ",expect=1000");
#else
  (void)0;
#endif
}

float playbackLevel01() { return level::playbackMeter().level(millis()); }

}  // namespace bob
