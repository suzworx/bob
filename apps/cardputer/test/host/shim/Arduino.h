// Host shim: the Arduino core surface src/protocol.cpp touches, plus the
// test-only knobs that make it deterministic. millis() returns a value the
// test sets, so builder ids ("hello_<ms>_v2") are exact bytes a fixture can
// hold; esp_random() (esp_system.h) is a seeded xorshift, not a real RNG.
#pragma once

#include <cstdint>

#include "WString.h"

#define PROGMEM

namespace hostshim {

inline unsigned long g_millis = 0;
inline uint32_t g_random = 0x9e3779b9u;

inline void setMillis(unsigned long value) { g_millis = value; }
inline void seedRandom(uint32_t seed) { g_random = seed != 0 ? seed : 1u; }

}  // namespace hostshim

inline unsigned long millis() { return hostshim::g_millis; }
inline unsigned long micros() { return hostshim::g_millis * 1000ul; }
