// bob-sim shim: PSRAM allocation is plain malloc on the desktop.
#pragma once
#include <cstdlib>
#define MALLOC_CAP_SPIRAM 0
#define MALLOC_CAP_8BIT 0
#define MALLOC_CAP_INTERNAL 0
inline void* heap_caps_malloc(size_t n, int) { return std::malloc(n); }
