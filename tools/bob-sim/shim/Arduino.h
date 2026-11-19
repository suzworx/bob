// bob-sim shim: the Arduino core surface the round UI touches. millis()/micros() read a fake,
// caller-driven clock so renders are deterministic; Serial and delay do nothing.
#pragma once

#include <cstdint>
#include <cstdio>
#include <cstdlib>

#include "WString.h"

namespace bobsim
{
inline uint32_t g_nowMs = 0;
inline void setNowMs(uint32_t ms) { g_nowMs = ms; }
} // namespace bobsim

inline uint32_t millis() { return bobsim::g_nowMs; }
inline uint32_t micros() { return bobsim::g_nowMs * 1000u; }
inline void delay(uint32_t) {}

struct SerialStub
{
  void println(const char*) {}
  void println(const String&) {}
  template <typename... A> void printf(const char*, A...) {}
};
inline SerialStub Serial;
