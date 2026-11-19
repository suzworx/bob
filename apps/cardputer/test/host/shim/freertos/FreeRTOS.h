// Host shim: the FreeRTOS surface src/mp3_ring_source.h touches. The host
// tests are single-threaded, so a mutex is a flag that must be free on take
// (a double take would deadlock on the device) and vTaskDelay only counts.
// task.h and semphr.h include this file.
#pragma once

#include <cstdint>

#include "doctest.h"

using TickType_t = uint32_t;
#define portMAX_DELAY 0xffffffffu
#define pdTRUE 1

namespace hostshim {

struct Semaphore {
  bool taken = false;
};

inline uint32_t g_taskDelays = 0;
// Runs on each vTaskDelay: the "other task" (e.g. the network pushing the next
// chunk) while a blocked ring read polls. Must end the wait, or it spins.
inline void (*g_onTaskDelay)() = nullptr;

}  // namespace hostshim

using SemaphoreHandle_t = hostshim::Semaphore*;

inline SemaphoreHandle_t xSemaphoreCreateMutex() { return new hostshim::Semaphore(); }
inline void vSemaphoreDelete(SemaphoreHandle_t sem) { delete sem; }
inline int xSemaphoreTake(SemaphoreHandle_t sem, TickType_t) {
  REQUIRE_FALSE(sem->taken);
  sem->taken = true;
  return pdTRUE;
}
inline int xSemaphoreGive(SemaphoreHandle_t sem) {
  REQUIRE(sem->taken);
  sem->taken = false;
  return pdTRUE;
}
inline void vTaskDelay(TickType_t) {
  hostshim::g_taskDelays++;
  REQUIRE_MESSAGE(hostshim::g_onTaskDelay != nullptr, "blocked ring read with no producer");
  hostshim::g_onTaskDelay();
}
