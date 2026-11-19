// The wake word table (include/wake_models.h): "Alexa" by default, "Hey Bob"
// as the backup, the persisted byte, the key's toggle and ESPHome's
// sliding-window detection rule. Expected values are the owner's decisions
// (2026-09-24): alexa cutoff 0.9 -> 229, hey_bob 0.988 -> 251
// (floor(0.988 x 255) = floor(251.94); review 2026-09-24), window 5.
#include <cstdint>
#include <string>

#include "doctest.h"
#include "wake_models.h"

using bob::WakeWord;

TEST_CASE("Hey Bob retains its manifest threshold and exact trained phrase") {
  const bob::WakeModelSpec& spec = bob::kHeyBobCandidateSpec;
  CHECK(std::string(spec.name) == "bob");
  CHECK(std::string(spec.phrase) == "Hey Bob");
  CHECK(spec.cutoff == 247);
  CHECK(spec.window == 5);
  const uint8_t atCutoff[5] = {247, 247, 247, 247, 247};
  const uint8_t oneOver[5] = {247, 247, 247, 247, 248};
  CHECK_FALSE(bob::wakeWindowDetects(atCutoff, spec.window, spec.cutoff));
  CHECK(bob::wakeWindowDetects(oneOver, spec.window, spec.cutoff));
}

TEST_CASE("Alexa is the default wake word") {
  CHECK(bob::kWakeWordDefault == WakeWord::kAlexa);
  const bob::WakeModelSpec& spec = bob::wakeModelSpec(WakeWord::kAlexa);
  CHECK(std::string(spec.name) == "alexa");
  CHECK(std::string(spec.phrase) == "Alexa");
  CHECK(spec.cutoff == 229);
  CHECK(spec.window == 5);
}

#if defined(BOB_WAKE_MODEL_BOB)
TEST_CASE("private build puts the Hey Bob candidate in the backup slot") {
  const bob::WakeModelSpec& spec = bob::wakeModelSpec(WakeWord::kBob);
  CHECK(std::string(spec.name) == "bob");
  CHECK(std::string(spec.phrase) == "Hey Bob");
  CHECK(spec.cutoff == 247);
  CHECK(spec.window == 5);
}
#elif defined(BOB_WAKE_MODEL_JARVIS)
TEST_CASE("Jarvis build retains Hey Jarvis as backup") {
  CHECK(std::string(bob::wakeModelSpec(WakeWord::kBob).phrase) == "Hey Jarvis");
}
#else
TEST_CASE("Hey Bob is the backup, with its own cutoff") {
  const bob::WakeModelSpec& spec = bob::wakeModelSpec(WakeWord::kBob);
  CHECK(std::string(spec.name) == "bob");
  CHECK(std::string(spec.phrase) == "Hey Bob");
  CHECK(spec.cutoff == 251);
  CHECK(spec.window == 5);
}
#endif

TEST_CASE("input contract accepts model strides only with the exact feature buffer") {
  const int alexa[] = {1, 3, 40};
  const int bob[] = {1, 2, 40};
  const int batch[] = {2, 2, 40};
  const int bins[] = {1, 2, 39};
  const int empty[] = {1, 0, 40};
  const int dynamic[] = {1, -1, 40};
  CHECK(bob::wakeInputStride(alexa, 3, 120) == 3);
  CHECK(bob::wakeInputStride(bob, 3, 80) == 2);
  CHECK(bob::wakeInputStride(bob, 3, 79) == 0);
  CHECK(bob::wakeInputStride(bob, 3, 120) == 0);
  CHECK(bob::wakeInputStride(bob, 2, 80) == 0);
  CHECK(bob::wakeInputStride(nullptr, 3, 80) == 0);
  CHECK(bob::wakeInputStride(batch, 3, 160) == 0);
  CHECK(bob::wakeInputStride(bins, 3, 78) == 0);
  CHECK(bob::wakeInputStride(empty, 3, 0) == 0);
  CHECK(bob::wakeInputStride(dynamic, 3, 40) == 0);
}

TEST_CASE("output contract accepts one probability only") {
  const int scalar[] = {1, 1};
  const int multiple[] = {1, 2};
  CHECK(bob::wakeOutputShape(scalar, 2, 1));
  CHECK_FALSE(bob::wakeOutputShape(scalar, 1, 1));
  CHECK_FALSE(bob::wakeOutputShape(scalar, 2, 2));
  CHECK_FALSE(bob::wakeOutputShape(multiple, 2, 2));
  CHECK_FALSE(bob::wakeOutputShape(nullptr, 2, 1));
}

TEST_CASE("cooldown preserves 1020 ms across input strides and rounds up") {
  CHECK(bob::wakeCooldownInvokes(3) == 34);
  CHECK(bob::wakeCooldownInvokes(2) == 51);
  CHECK(bob::wakeCooldownInvokes(1) == 102);
  CHECK(bob::wakeCooldownInvokes(4) == 26);
  CHECK(bob::wakeCooldownInvokes(0) == 0);
  CHECK(bob::wakeCooldownInvokes(-1) == 0);
}

TEST_CASE("the w key toggles between the two words") {
  CHECK(bob::nextWakeWord(WakeWord::kAlexa) == WakeWord::kBob);
  CHECK(bob::nextWakeWord(WakeWord::kBob) == WakeWord::kAlexa);
}

TEST_CASE("the stored byte round-trips, and junk falls back to Alexa") {
  CHECK(bob::wakeWordFromStored(0) == WakeWord::kAlexa);
  CHECK(bob::wakeWordFromStored(1) == WakeWord::kBob);
  CHECK(bob::wakeWordFromStored(2) == WakeWord::kAlexa);
  CHECK(bob::wakeWordFromStored(255) == WakeWord::kAlexa);
}

TEST_CASE("detection needs the window sum strictly above cutoff x size") {
  // ESPHome streaming_model.cpp: 5 x 229 = 1145 is not enough, 1146 is.
  const uint8_t atCutoff[5] = {229, 229, 229, 229, 229};
  const uint8_t oneOver[5] = {229, 229, 229, 229, 230};
  CHECK_FALSE(bob::wakeWindowDetects(atCutoff, 5, 229));
  CHECK(bob::wakeWindowDetects(oneOver, 5, 229));
  // One loud slice cannot trigger on its own.
  const uint8_t spike[5] = {0, 0, 255, 0, 0};
  CHECK_FALSE(bob::wakeWindowDetects(spike, 5, 229));
  // hey_bob's 251 rejects a window that clears Alexa's 229.
  const uint8_t alexaOnly[5] = {240, 240, 240, 240, 240};
  CHECK(bob::wakeWindowDetects(alexaOnly, 5, 229));
  CHECK_FALSE(bob::wakeWindowDetects(alexaOnly, 5, 251));
}
