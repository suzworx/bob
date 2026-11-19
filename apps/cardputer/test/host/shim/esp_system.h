// Host shim for esp_system.h: esp_random() as a seeded xorshift32, so
// generateClaim() is reproducible in tests (see hostshim::seedRandom).
#pragma once

#include <cstdint>

#include "Arduino.h"

inline uint32_t esp_random() {
  uint32_t x = hostshim::g_random;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  hostshim::g_random = x;
  return x;
}
