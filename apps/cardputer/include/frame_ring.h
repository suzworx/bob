// Bob Cardputer v2 — the capture frame ring (bookkeeping only, no I/O).
//
// M5Unified's Mic_Class::record() is asynchronous: it queues a buffer in one
// of two request slots and returns; the mic task fills it later and reports it
// through the buffer release callback. When no request is pending the task
// drops what the I2S DMA delivered meanwhile. So capture keeps two buffers
// queued at all times and reads a frame only after the mic has filled it.
//
// Buffers are handed to the mic in ring order, and the mic fills requests in
// the order they were queued, so three monotonic counters describe the ring:
//   read <= filled <= queued <= read + N,   queued - filled <= kMicSlots.
// Single producer (whoever holds the right to call record(): the release
// callback or the main loop, never both at once) and single consumer (the main
// loop). Each counter has one writer; all are atomics so the other side's
// reads are defined, and `filled` is published with release/acquire so a
// reader sees the samples the mic wrote.
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>

namespace bob {

template <size_t N, size_t Samples>
class FrameRing {
 public:
  // M5Unified keeps two record() requests.
  static constexpr uint32_t kMicSlots = 2;
  static_assert(N >= kMicSlots, "the ring must cover both mic slots");
  // A power of two keeps index % N continuous across the counters' 2^32 wrap.
  static_assert((N & (N - 1)) == 0, "N must be a power of two");

  // `storage` holds N * Samples samples. `start` seeds the counters (tests
  // use it to cross the 2^32 wrap).
  explicit FrameRing(int16_t* storage, uint32_t start = 0)
      : storage_(storage), queued_(start), filled_(start), read_(start) {}

  // Producer: the next buffer to queue with the mic, or nullptr when both
  // slots are busy or every other slot still holds an unread frame. The
  // buffer counts as queued at once (the mic may fill it before record()
  // returns); unclaim() if record() refused it.
  int16_t* claimForQueue() {
    const uint32_t queued = queued_.load(std::memory_order_relaxed);
    const uint32_t filled = filled_.load(std::memory_order_acquire);
    const uint32_t read = read_.load(std::memory_order_acquire);
    if (queued - filled >= kMicSlots || queued - read >= N) return nullptr;
    queued_.store(queued + 1, std::memory_order_release);
    return slot(queued);
  }

  void unclaim() { queued_.store(queued_.load(std::memory_order_relaxed) - 1, std::memory_order_release); }

  // Release callback: the mic filled `data`. It must be the oldest buffer in
  // flight; anything else is refused (false) and changes nothing.
  bool markFilled(const void* data) {
    const uint32_t filled = filled_.load(std::memory_order_relaxed);
    if (filled == queued_.load(std::memory_order_acquire) || data != slot(filled)) return false;
    filled_.store(filled + 1, std::memory_order_release);
    return true;
  }

  // Consumer: the oldest filled, unread frame (Samples samples) or nullptr.
  const int16_t* peek() const {
    const uint32_t read = read_.load(std::memory_order_relaxed);
    return filled_.load(std::memory_order_acquire) != read ? slot(read) : nullptr;
  }

  // Consumer: done with peek()'s frame; its slot may be queued again.
  void pop() { read_.store(read_.load(std::memory_order_relaxed) + 1, std::memory_order_release); }

  // Buffers the mic holds right now (0 means capture has a gap).
  uint32_t inFlight() const {
    return queued_.load(std::memory_order_acquire) - filled_.load(std::memory_order_acquire);
  }

  // Consumer: filled frames not read yet (peek() does not change it).
  uint32_t ready() const {
    return filled_.load(std::memory_order_acquire) - read_.load(std::memory_order_acquire);
  }

 private:
  int16_t* slot(uint32_t index) const { return storage_ + (index % N) * Samples; }

  int16_t* storage_;
  std::atomic<uint32_t> queued_;  // written by the producer only.
  std::atomic<uint32_t> filled_;
  std::atomic<uint32_t> read_;
};

}  // namespace bob
