// Bob Cardputer v2 — keeping TLS handshakes from stalling the main loop
// (#710), pure so the host tests run it. A handshake is ~0.6 s of software
// ECC (the P-384 chain verify has no hardware help) that never blocks, so
// whatever task runs it holds core 1 for that long.
#pragma once

#include <atomic>
#include <cstdint>

#include "wifi_join.h"

namespace bob {

// ws_net's FreeRTOS priority. While (re)connecting it runs at 1, level with
// loopTask and mp3_decode, so the handshake round-robins with them every tick
// instead of starving them. Once connected it takes 2 back: an arriving
// reply frame must preempt decode (src/network.cpp, Network::setup).
constexpr uint8_t wsNetPriority(bool connected) { return connected ? 2 : 1; }

enum class ProbePhase : uint8_t { kIdle, kRunning, kDone };

// What poll() found. kResult and kStale both consume the result (back to idle).
enum class ProbePoll : uint8_t { kIdle, kRunning, kResult, kStale };

// The one internet probe (Network::probeInternet) that runs on its own
// short-lived task: idle -> running -> done -> consumed (idle). The main loop
// starts it, polls it and discards it; the probe task only calls finish().
// The slot is static and outlives the task, so a discard never frees
// anything the task still writes: it only marks the result stale, and a new
// probe waits until the old task has finished.
class ProbeTaskSlot {
 public:
  // Main loop: claims the slot for a new probe; the caller then starts the
  // task. False while a probe is still running (never two at once). An
  // unconsumed result is dropped.
  bool start() {
    if (phase() == ProbePhase::kRunning) return false;
    stale_ = false;
    phase_.store(static_cast<uint8_t>(ProbePhase::kRunning), std::memory_order_release);
    return true;
  }

  // Main loop: the task could not be created; the slot is idle again.
  void abort() { phase_.store(static_cast<uint8_t>(ProbePhase::kIdle), std::memory_order_release); }

  // Probe task, last thing before it deletes itself: publishes the result,
  // how long the probe took, and the task's stack high-water mark.
  void finish(ProbeResult result, uint32_t ms, uint32_t stackFree) {
    result_ = result;
    ms_ = ms;
    stackFree_ = stackFree;
    phase_.store(static_cast<uint8_t>(ProbePhase::kDone), std::memory_order_release);
  }

  // Main loop: a reload, pause or reset. A running probe's result will be
  // reported stale (the link it checked may be gone); a finished one is
  // dropped now.
  void discard() {
    if (phase() == ProbePhase::kRunning) {
      stale_ = true;
    } else {
      phase_.store(static_cast<uint8_t>(ProbePhase::kIdle), std::memory_order_release);
    }
  }

  // Main loop: kResult or kStale hand over the finished probe (result, ms)
  // and leave the slot idle.
  ProbePoll poll(ProbeResult& result, uint32_t& ms) {
    const ProbePhase now = phase();
    if (now == ProbePhase::kIdle) return ProbePoll::kIdle;
    if (now == ProbePhase::kRunning) return ProbePoll::kRunning;
    result = result_;
    ms = ms_;
    const bool stale = stale_;
    stale_ = false;
    phase_.store(static_cast<uint8_t>(ProbePhase::kIdle), std::memory_order_release);
    return stale ? ProbePoll::kStale : ProbePoll::kResult;
  }

  ProbePhase phase() const {
    return static_cast<ProbePhase>(phase_.load(std::memory_order_acquire));
  }

  // The last finished probe task's stack high-water mark (bytes).
  uint32_t stackFree() const { return stackFree_; }

 private:
  // Written by the task only in finish() (running -> done); every other
  // transition is the main loop's, and only while no task is running.
  std::atomic<uint8_t> phase_{static_cast<uint8_t>(ProbePhase::kIdle)};
  // Main loop only.
  bool stale_ = false;
  // Written by the task before phase_ becomes kDone; read after.
  ProbeResult result_ = ProbeResult::kOnline;
  uint32_t ms_ = 0;
  uint32_t stackFree_ = 0;
};

}  // namespace bob
