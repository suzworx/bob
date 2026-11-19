// Bob Cardputer v2 — on-device wake word (microWakeWord) and energy VAD.
#include "wake_word.h"

#include "barge_policy.h"
#include <Arduino.h>
#include <esp_heap_caps.h>
#include "level_meter.h"
#include <soc/soc_memory_layout.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <new>
#include "tensorflow/lite/experimental/microfrontend/lib/frontend.h"
#include "tensorflow/lite/experimental/microfrontend/lib/frontend_util.h"
#include "tensorflow/lite/micro/micro_error_reporter.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/micro/micro_resource_variable.h"
#include "tensorflow/lite/schema/schema_generated.h"

// Each .tflite goes into flash rodata, 16-byte aligned: the flatbuffer is read
// in 32-bit words and PlatformIO's embed_files gave it an odd address. The
// assembler finds them through -Wa,-I in platformio.ini. Edits to a .tflite
// are not dependency-tracked; touch this file after replacing a model.
// Order matches kWakeModels (wake_models.h).
#if defined(BOB_WAKE_MODEL_JARVIS)
#define BOB_WAKE_BACKUP_FILE "hey_jarvis.tflite"
#elif defined(BOB_WAKE_MODEL_BOB)
// The untracked candidate, found through -Wa,-I<repo>/data; the path keeps it
// apart from the tracked lib/wake_models/hey_bob.tflite of the same name.
#define BOB_WAKE_BACKUP_FILE "wake-test/hey_bob.tflite"
#else
#define BOB_WAKE_BACKUP_FILE "hey_bob.tflite"
#endif
asm(".section .rodata.bob_wake_models,\"a\"\n"
    ".balign 16\n"
    ".global bob_wake_model_alexa\n"
    "bob_wake_model_alexa:\n"
    ".incbin \"alexa.tflite\"\n"
    ".balign 16\n"
    ".global bob_wake_model_backup\n"
    "bob_wake_model_backup:\n"
    ".incbin \"" BOB_WAKE_BACKUP_FILE "\"\n"
    ".previous\n");
extern "C" const uint8_t bob_wake_model_alexa[];
extern "C" const uint8_t bob_wake_model_backup[];

namespace bob {
namespace {

// ESPHome's TFLM plans alexa in 22348 B and hey_jarvis in 22860 B; this older
// TFLM plans slightly differently, so leave headroom. hey_bob has no ESPHome
// figure: what each model really uses is logged (wake_listening arena_used=).
#ifdef BOB_WAKE_ARENA_BYTES
constexpr size_t kArenaBytes = BOB_WAKE_ARENA_BYTES;
#else
constexpr size_t kArenaBytes = 28 * 1024;
#endif
static_assert(kArenaBytes > 0 && kArenaBytes % 16 == 0, "wake arena must be positive and 16-byte sized");
constexpr int kResourceVariables = 20;
constexpr size_t kFeatures = kWakeFeatureBins;

tflite::MicroErrorReporter errorReporter;
tflite::MicroMutableOpResolver<20> resolver;
bool resolverReady = false;

uint8_t* arena = nullptr;
tflite::MicroInterpreter* interpreter = nullptr;
FrontendState frontend;
bool frontendReady = false;
bool running = false;
volatile bool detected = false;  // set by the model, read by the loop (a task on the Waveshare)
size_t heldBytes = 0;
// Cost of one 10 ms frame through frontend + model, since the last wake_stats read (journaled).
volatile uint32_t feedUsSum = 0, feedUsMax = 0, feedFrames = 0, feedDropped = 0;
size_t arenaUsedBytes = 0;
// Why the last wakeWordBegin() failed, for the caller's journal line: this
// module never prints (every serial line is a journal() line).
const char* lastError = "";
int stride = 0;
int slice = 0;
int cooldown = 0;
// The running model's cutoff and sliding window (wakeModelSpec()).
uint8_t cutoff = 255;
// Bob is playing (barge_policy.h): stricter cutoff, noise floor frozen.
volatile bool playbackGuard = false;
size_t windowSize = kWakeWindowMax;
uint8_t window[kWakeWindowMax] = {};
size_t windowPos = 0;
uint32_t lastInvokeUs = 0;
uint32_t maxInvokeUs = 0;
WakeStatsWindow stats;

// Returns the frame's dB after moving the noise floor with it.
float updateNoiseFloor(const int16_t* samples, size_t n);

// The op set ESPHome registers for microWakeWord v2 streaming models.
void registerOps() {
  if (resolverReady) return;
  resolver.AddCallOnce(); resolver.AddVarHandle(); resolver.AddReshape();
  resolver.AddReadVariable(); resolver.AddStridedSlice(); resolver.AddConcatenation();
  resolver.AddAssignVariable(); resolver.AddConv2D(); resolver.AddMul();
  resolver.AddAdd(); resolver.AddMean(); resolver.AddFullyConnected();
  resolver.AddLogistic(); resolver.AddQuantize(); resolver.AddDepthwiseConv2D();
  resolver.AddAveragePool2D(); resolver.AddMaxPool2D(); resolver.AddPad();
  resolver.AddPack(); resolver.AddSplitV();
  resolverReady = true;
}

// micro_speech frontend settings microWakeWord was trained with.
bool beginFrontend() {
  FrontendConfig config;
  FrontendFillConfigWithDefaults(&config);
  config.window.size_ms = 30;
  config.window.step_size_ms = 10;
  config.filterbank.num_channels = kFeatures;
  config.filterbank.lower_band_limit = 125.0f;
  config.filterbank.upper_band_limit = 7500.0f;
  config.noise_reduction.smoothing_bits = 10;
  config.noise_reduction.even_smoothing = 0.025f;
  config.noise_reduction.odd_smoothing = 0.06f;
  config.noise_reduction.min_signal_remaining = 0.05f;
  config.pcan_gain_control.enable_pcan = 1;
  config.pcan_gain_control.strength = 0.95f;
  config.pcan_gain_control.offset = 80.0f;
  config.pcan_gain_control.gain_bits = 21;
  config.log_scale.enable_log = 1;
  config.log_scale.scale_shift = 6;
  frontendReady = FrontendPopulateState(&config, &frontend, 16000) != 0;
  return frontendReady;
}

void runModel() {
  const uint32_t started = micros();
  if (interpreter->Invoke() != kTfLiteOk) return;
  lastInvokeUs = micros() - started;
  if (lastInvokeUs > maxInvokeUs) maxInvokeUs = lastInvokeUs;
  const uint8_t probability = interpreter->output(0)->data.uint8[0];
  stats.addProbability(probability);
  window[windowPos] = probability;
  windowPos = (windowPos + 1) % windowSize;
  if (cooldown > 0) {
    cooldown -= 1;
    return;
  }
  const uint8_t active = playbackGuard ? static_cast<uint8_t>(bargeCutoff(cutoff)) : cutoff;
  if (wakeWindowDetects(window, windowSize, active)) {
    detected = true;
    cooldown = wakeCooldownInvokes(stride);
    for (uint8_t& p : window) p = 0;
  }
}

// Quantises one 40-bin feature slice the way micro_speech/ESPHome do.
void pushFeatures(const FrontendOutput& out) {
  int8_t* input = interpreter->input(0)->data.int8 + slice * kFeatures;
  for (size_t i = 0; i < kFeatures && i < out.size; ++i) {
    int32_t v = ((static_cast<int32_t>(out.values[i]) * 256) + 333) / 666 - 128;
    input[i] = static_cast<int8_t>(v < -128 ? -128 : (v > 127 ? 127 : v));
  }
  if (++slice >= stride) {
    slice = 0;
    runModel();
  }
}

bool validTensorContract() {
  if (interpreter->inputs_size() != 1 || interpreter->outputs_size() != 1) return false;
  const TfLiteTensor* input = interpreter->input(0);
  const TfLiteTensor* output = interpreter->output(0);
  if (!input || !output || !input->dims || !output->dims ||
      input->type != kTfLiteInt8 || output->type != kTfLiteUInt8 ||
      !input->data.int8 || !output->data.uint8) return false;
  stride = wakeInputStride(input->dims->data, input->dims->size, input->bytes);
  return stride > 0 && wakeOutputShape(output->dims->data, output->dims->size, output->bytes);
}

}  // namespace

static void feedFrame(const int16_t* samples, size_t n);

#if defined(BOB_BOARD_WAVESHARE_185C)
// The Waveshare loop also draws the round UI, so ~7 ms of CPU per 10 ms frame in the loop task
// saturated it (wake phase ~550 ms per pass, Bob at ~1 fps). The loop only copies the frame into a
// small ring; this task, pinned to the other core, runs the frontend and the model. The Cardputer
// keeps the inline path below.
namespace {

constexpr size_t kFeedRingFrames = 64;  // 640 ms of audio; a full ring drops the newest frame
constexpr size_t kFeedFrameSamples = 160;
int16_t feedRing[kFeedRingFrames][kFeedFrameSamples];
volatile uint32_t feedHead = 0;  // written by the loop (producer)
volatile uint32_t feedTail = 0;  // written by the task, or under procMutex by wakeWordEnd()
TaskHandle_t wakeTaskHandle = nullptr;
SemaphoreHandle_t procMutex = nullptr;  // held while a frame is processed and while the model is freed

// Scheduling, so IDLE0 and Wi-Fi always run and the task watchdog stays armed: the task sleeps on a
// notification (one per frame, from wakeWordFeed) when the ring is empty, handles at most
// kFramesPerTurn frames per wake-up and always yields a tick afterwards. If inference cannot keep up
// with the 10 ms frame period the backlog is cut to the newest kBacklogKeep frames once it passes
// kBacklogMax, and the cut frames are counted in wake_stats dropped= (the model state and the
// frontend see a gap, never a snowballing delay).
constexpr uint32_t kFramesPerTurn = 2;
constexpr uint32_t kBacklogMax = 24;   // 240 ms of audio
constexpr uint32_t kBacklogKeep = 4;

void wakeTask(void*) {
  for (;;) {
    if (feedTail == feedHead) {
      ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
      continue;
    }
    xSemaphoreTake(procMutex, portMAX_DELAY);
    if (!running) {
      feedTail = feedHead;  // not listening: drop whatever is queued instead of spinning on it
    } else {
      const uint32_t behind = feedHead - feedTail;
      if (behind > kBacklogMax) {
        feedDropped += behind - kBacklogKeep;
        feedTail = feedHead - kBacklogKeep;
      }
      for (uint32_t i = 0; i < kFramesPerTurn && feedTail != feedHead; ++i) {
        feedFrame(feedRing[feedTail % kFeedRingFrames], kFeedFrameSamples);
        feedTail = feedTail + 1;
      }
    }
    xSemaphoreGive(procMutex);
    vTaskDelay(1);  // always: lets IDLE0, Wi-Fi and the loop's teardown take the mutex
  }
}

// Starts the task on first use; false (inline feeding is then wrong to assume) only on no memory.
bool ensureWakeTask() {
  if (wakeTaskHandle) return true;
  if (!procMutex) procMutex = xSemaphoreCreateMutex();
  if (!procMutex) return false;
  return xTaskCreatePinnedToCore(wakeTask, "wake", 12 * 1024, nullptr, 2, &wakeTaskHandle, 0) == pdPASS;
}

}  // namespace
#endif

bool wakeWordBegin(WakeWord word) {
  if (running) return true;
  word = wakeWordFromStored(static_cast<uint8_t>(word));
  const size_t freeBefore = heap_caps_get_free_size(MALLOC_CAP_8BIT);
  lastError = "";
  const uint8_t* data =
      word == WakeWord::kAlexa ? bob_wake_model_alexa : bob_wake_model_backup;
  const WakeModelSpec& spec = wakeModelSpec(word);
  cutoff = spec.cutoff;
  windowSize = spec.window <= kWakeWindowMax ? spec.window : kWakeWindowMax;
  windowPos = 0;
  const tflite::Model* model = tflite::GetModel(data);
  // Flatbuffer fields are read as 32-bit words; unaligned data would fault.
  if (reinterpret_cast<uintptr_t>(data) % 4 != 0 ||
      model->version() != TFLITE_SCHEMA_VERSION) {
    lastError = "model_rejected";
    return false;
  }
  registerOps();
  arena = static_cast<uint8_t*>(
      heap_caps_malloc(kArenaBytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  if (!arena) {
    lastError = "arena_alloc_failed";
    return false;
  }
  tflite::MicroAllocator* allocator =
      tflite::MicroAllocator::Create(arena, kArenaBytes, &errorReporter);
  tflite::MicroResourceVariables* variables =
      allocator ? tflite::MicroResourceVariables::Create(allocator, kResourceVariables)
                : nullptr;
  interpreter = variables ? new (std::nothrow) tflite::MicroInterpreter(
                                model, resolver, allocator, &errorReporter, variables)
                          : nullptr;
  // Input int8 features, output one uint8 probability, as ESPHome requires.
  if (!interpreter || interpreter->AllocateTensors() != kTfLiteOk ||
      !validTensorContract() || !beginFrontend()) {
    lastError = "model_init_failed";
    running = true;  // Let wakeWordEnd() release whatever was built.
    wakeWordEnd();
    return false;
  }
  slice = 0;
  cooldown = wakeCooldownInvokes(stride);  // Frontend noise/PCAN estimates settle first.
  lastInvokeUs = 0;
  maxInvokeUs = 0;
  for (uint8_t& p : window) p = 0;
  detected = false;
  stats.begin(millis());
  feedUsSum = feedUsMax = feedFrames = feedDropped = 0;
#if defined(BOB_BOARD_WAVESHARE_185C)
  if (!ensureWakeTask()) {
    lastError = "task_alloc_failed";
    running = true;  // Let wakeWordEnd() release whatever was built.
    wakeWordEnd();
    return false;
  }
  feedTail = feedHead;  // nothing queued from an earlier listen
#endif
  running = true;
  heldBytes =freeBefore - heap_caps_get_free_size(MALLOC_CAP_8BIT);
  arenaUsedBytes = interpreter->arena_used_bytes();
  return true;
}

// One frame through noise floor, frontend and (every `stride` slices) the model, timed.
static void feedFrame(const int16_t* samples, size_t n) {
  const uint32_t started = micros();
  stats.addFrame(updateNoiseFloor(samples, n));
  while (n > 0) {
    size_t read = 0;
    FrontendOutput out = FrontendProcessSamples(&frontend, samples, n, &read);
    if (read == 0) break;
    samples += read;
    n -= read;
    if (out.size > 0) pushFeatures(out);
  }
  const uint32_t us = micros() - started;
  feedUsSum += us;
  feedFrames += 1;
  if (us > feedUsMax) feedUsMax = us;
}


void wakeWordFeed(const int16_t* samples, size_t n) {
  if (!running) return;
#if defined(BOB_BOARD_WAVESHARE_185C)
  while (n > 0) {
    const size_t take = n < kFeedFrameSamples ? n : kFeedFrameSamples;
    if (feedHead - feedTail >= kFeedRingFrames) {
      feedDropped += 1;
    } else {
      memcpy(feedRing[feedHead % kFeedRingFrames], samples, take * sizeof(int16_t));
      feedHead = feedHead + 1;
    }
    samples += take;
    n -= take;
  }
  if (wakeTaskHandle) xTaskNotifyGive(wakeTaskHandle);
#else
  feedFrame(samples, n);
#endif
}

void wakeWordSetPlaybackGuard(bool on) { playbackGuard = on; }

bool wakeWordDetected() {
  const bool was = detected;
  detected = false;
  return was;
}

void wakeWordEnd() {
  if (!running) return;
#if defined(BOB_BOARD_WAVESHARE_185C)
  running = false;  // the task skips frames from here on...
  if (procMutex) xSemaphoreTake(procMutex, portMAX_DELAY);  // ...and is not inside the model now
  feedTail = feedHead;
#endif
  if (frontendReady) FrontendFreeStateContents(&frontend);
  frontendReady = false;
  delete interpreter;
  interpreter = nullptr;
  heap_caps_free(arena);
  arena = nullptr;
  running = false;
  detected = false;
  heldBytes = 0;
#if defined(BOB_BOARD_WAVESHARE_185C)
  if (procMutex) xSemaphoreGive(procMutex);
#endif
}

size_t wakeWordArenaBytes() { return running ? heldBytes : 0; }
size_t wakeWordArenaUsedBytes() { return running ? arenaUsedBytes : 0; }
const char* wakeWordArenaRegion() {
  if (!running || !arena) return "none";
  return esp_ptr_external_ram(arena) ? "psram" : "internal";
}
const char* wakeWordLastError() { return lastError; }
uint32_t wakeWordLastInvokeUs() { return lastInvokeUs; }
uint32_t wakeWordMaxInvokeUs() { return maxInvokeUs; }

bool wakeWordStatsDue(uint32_t nowMs) { return running && stats.due(nowMs, kWakeStatsPeriodMs); }
WakeStats wakeWordTakeStats(uint32_t nowMs) {
#if defined(BOB_BOARD_WAVESHARE_185C)
  if (procMutex) xSemaphoreTake(procMutex, portMAX_DELAY);  // the task updates stats per frame
  WakeStats out = stats.take(nowMs);
  // Inference stays on the wake task: frames still queued are only counted.
  out.pending = running ? feedHead - feedTail : 0;
  if (procMutex) xSemaphoreGive(procMutex);
  return out;
#else
  return stats.take(nowMs);
#endif
}

WakeFeedStats wakeWordTakeFeedStats() {
  WakeFeedStats out;
  out.frames = feedFrames;
  out.avgUs = feedFrames ? feedUsSum / feedFrames : 0;
  out.maxUs = feedUsMax;
  out.dropped = feedDropped;
  feedUsSum = feedUsMax = feedFrames = feedDropped = 0;
  return out;
}

// --- End of speech -----------------------------------------------------------

namespace {

constexpr float kFloorRiseDbPerFrame = 0.01f;  // Floor creeps up 1 dB/s, drops at once.

float noiseFloorDb = -1.0f;  // < 0 = not yet measured.
EndOfSpeech endOfSpeech;

// Mean-square energy in dB relative to one LSB (int16 full scale ~ 90 dB).
float frameDb(const int16_t* samples, size_t n) {
  if (n == 0) return 0.0f;
  uint64_t sum = 0;
  for (size_t i = 0; i < n; ++i) sum += static_cast<int32_t>(samples[i]) * samples[i];
  return 10.0f * log10f(static_cast<float>(sum) / n + 1.0f);
}

void updateNoiseFloorDb(float db) {
  if (noiseFloorDb < 0.0f || db < noiseFloorDb) {
    noiseFloorDb = db;
  } else {
    noiseFloorDb += fminf(db - noiseFloorDb, kFloorRiseDbPerFrame);
  }
}

float updateNoiseFloor(const int16_t* samples, size_t n) {
  const float db = frameDb(samples, n);
  // Residual echo must not become the floor (unless there is none yet).
  if (!playbackGuard || noiseFloorDb < 0.0f) updateNoiseFloorDb(db);
  level::captureMeter().update(level::captureTarget01(db, noiseFloorDb), millis());  // ring light
  return db;
}

}  // namespace

void vadReset(uint32_t onsetMs, VadOnset policy, uint32_t endSilenceMs) { endOfSpeech.reset(onsetMs, policy, endSilenceMs); }

void vadFeed(const int16_t* samples, size_t n) {
  if (endOfSpeech.ended() || n == 0) return;
  const float db = frameDb(samples, n);
  const uint32_t ms = static_cast<uint32_t>(n) * kVadFrameMs / 160;
  // Only silence moves the floor mid-turn (not speech, not a dip between
  // syllables), so a long sentence cannot raise it.
  if (!endOfSpeech.feed(db, noiseFloorDb, ms)) updateNoiseFloorDb(db);
  level::captureMeter().update(level::captureTarget01(db, noiseFloorDb), millis());  // ring light
}

float wakeWordNoiseFloorDb() { return noiseFloorDb < 0.0f ? 0.0f : noiseFloorDb; }

bool vadSpeechEnded() { return endOfSpeech.ended(); }
bool vadHeardSpeech() { return endOfSpeech.heardSpeech(); }
bool vadVoicedRun() { return endOfSpeech.voicedRun(); }
VadEnd vadEndReason() { return endOfSpeech.endReason(); }
uint32_t vadSpeechMs() { return endOfSpeech.speechMs(); }
uint32_t vadSpeechEndMs() { return endOfSpeech.speechEndMs(); }

}  // namespace bob
