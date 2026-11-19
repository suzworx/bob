// Bob Cardputer v2 — the wake words the device can listen for (pure logic;
// host-tested in test/host/test_wake_models.cpp).
//
// "Alexa" (ESPHome's pretrained model) is the default and "Hey Bob" the backup;
// the `w` key switches between them and the choice persists in NVS. Only one
// model runs at a time: an Invoke() is ~16 ms of the 30 ms budget. The tracked
// backup model is lib/wake_models/hey_bob.tflite (kahrendt/microWakeWord).
// -DBOB_WAKE_MODEL_JARVIS puts ESPHome's hey_jarvis in the backup slot for HIL
// comparisons; -DBOB_WAKE_MODEL_BOB puts the untracked Hey Bob candidate
// (data/wake-test/hey_bob.tflite) there instead. src/wake_word.cpp .incbin's
// the matching file.
#pragma once

#include <cstddef>
#include <cstring>
#include <cstdint>

#if defined(BOB_WAKE_MODEL_BOB) && defined(BOB_WAKE_MODEL_JARVIS)
#error "Choose only one backup wake model: BOB or JARVIS"
#endif

namespace bob {

// Stored in NVS as its byte value: keep the numbers stable.
enum class WakeWord : uint8_t {
  kAlexa = 0,
  kBob = 1,  // the backup slot: Hey Bob (Hey Jarvis only in its comparison build).
};

// The Waveshare build defaults to the Hey Bob candidate.
#if defined(BOB_DEFAULT_WAKE_BOB) && !defined(BOB_WAKE_MODEL_BOB)
#error "BOB_DEFAULT_WAKE_BOB needs BOB_WAKE_MODEL_BOB (the untracked Hey Bob candidate weights)"
#endif
#if defined(BOB_DEFAULT_WAKE_BOB)
constexpr WakeWord kWakeWordDefault = WakeWord::kBob;
#else
constexpr WakeWord kWakeWordDefault = WakeWord::kAlexa;
#endif

struct WakeModelSpec {
  const char* name;    // journal value: wake_word_changed word=, wake_listening word=.
  const char* phrase;  // what the UI tells the user to say.
  uint8_t cutoff;      // probability_cutoff x 255, floored.
  uint8_t window;      // sliding_window_size.
};

// Private experimental candidate; upstream reuse permission remains unclear.
// TaterTotterson/Tater-Wake-Words @ 5400697e1fb3fc454ac18f6a9d3f714f663f2842,
// microWakeWordsV1/hey_bob.json: v2, 10 ms features, advertised 30000 B arena.
// The latter is not a measurement with our allocator; keep the existing arena.
constexpr WakeModelSpec kHeyBobCandidateSpec = {"bob", "Hey Bob", 247, 5};

// Per-model probability cutoff and sliding window, from each model's JSON.
constexpr WakeModelSpec kWakeModels[] = {
    {"alexa", "Alexa", 229, 5},  // alexa.json: 0.9.
#if defined(BOB_WAKE_MODEL_JARVIS)
    {"jarvis", "Hey Jarvis", 247, 5},  // hey_jarvis.json: 0.97.
#elif defined(BOB_WAKE_MODEL_BOB)
    kHeyBobCandidateSpec,
#else
    {"bob", "Hey Bob", 251, 5},  // hey_bob.json: 0.988 x 255 = 251.94, floored.
#endif
};
constexpr size_t kWakeModelCount = sizeof(kWakeModels) / sizeof(kWakeModels[0]);

// The largest sliding window any model uses (the detector's buffer size).
constexpr size_t kWakeWindowMax = 5;
constexpr size_t kWakeFeatureBins = 40;

// Frontend emits 10 ms slices. Preserve the original 34 * 30 ms cooldown
// across model strides; round up so a different stride cannot shorten it.
inline int wakeCooldownInvokes(int stride) {
  return stride > 0 ? 102 / stride + (102 % stride != 0 ? 1 : 0) : 0;
}

// Reject incompatible tensors before indexing dim[1] or writing feature slices.
// Comparing division/remainder avoids overflowing a stride * bins product.
inline int wakeInputStride(const int* dims, size_t rank, size_t bytes) {
  if (!dims || rank != 3 || dims[0] != 1 || dims[1] <= 0 ||
      dims[2] != static_cast<int>(kWakeFeatureBins) || bytes % kWakeFeatureBins != 0 ||
      bytes / kWakeFeatureBins != static_cast<size_t>(dims[1])) return 0;
  return dims[1];
}

inline bool wakeOutputShape(const int* dims, size_t rank, size_t bytes) {
  return dims && rank == 2 && dims[0] == 1 && dims[1] == 1 && bytes == 1;
}

// The wire name of a wake word (device_state, device_control): always the
// assistant, "bob", never "alexa"; the model behind it is the device's own choice.
inline const char* wakeWordWireName(WakeWord) { return "bob"; }

// The other direction: "bob" selects this build's default model.
inline bool parseWakeWordWire(const char* name, WakeWord& out) {
  if (strcmp(name, "bob") != 0) return false;
  out = kWakeWordDefault;
  return true;
}

inline WakeWord wakeWordFromStored(uint8_t value) {
  return value < kWakeModelCount ? static_cast<WakeWord>(value) : kWakeWordDefault;
}

inline const WakeModelSpec& wakeModelSpec(WakeWord word) {
  return kWakeModels[static_cast<uint8_t>(wakeWordFromStored(static_cast<uint8_t>(word)))];
}

inline WakeWord nextWakeWord(WakeWord word) {
  return word == WakeWord::kAlexa ? WakeWord::kBob : WakeWord::kAlexa;
}

// ESPHome's rule (streaming_model.cpp determine_detected): the window's sum
// against cutoff x size, so no rounding of a mean can lower the bar.
inline bool wakeWindowDetects(const uint8_t* window, size_t size, uint8_t cutoff) {
  uint32_t sum = 0;
  for (size_t i = 0; i < size; ++i) sum += window[i];
  return sum > static_cast<uint32_t>(cutoff) * size;
}

}  // namespace bob
