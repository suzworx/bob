// Bob Cardputer v2 — the outbound control-message queue (pure C++, no
// Arduino or FreeRTOS: host-tested in test/host/test_control_queue.cpp).
//
// The main loop queues control messages; whoever holds the socket (the
// network task, or the main loop just before an audio frame) sends them. The
// caller never waits for the socket, so a message can no longer be lost
// because the network task was busy streaming a reply (HIL run
// 20260923-231708-ab39: a stop pressed mid-playback never reached the server).
//
// Order and priority, by design:
// - Every message except device_state goes through one FIFO, so turn_start,
//   turn_end, cancel, announce_ack, ... reach the server in the order sent.
// - device_state is a snapshot, not an event: it has one slot of its own, and
//   a newer one replaces an unsent older one. The slot goes out only when the
//   FIFO is empty. So a cancel is never queued behind a device_state, and a
//   device_state can never take FIFO room away from a cancel.
// - The FIFO is bounded twice: at most Depth messages, in an Arena-byte ring
//   of length-prefixed messages (real messages are 60-210 bytes, turn_timing up to ~470; any message
//   up to MaxMessage-1 bytes fits). A push that does not fit is refused,
//   never blocks.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

namespace bob {

// protocol.cpp builds every control message in a 512-byte buffer.
constexpr size_t kControlMaxBytes = 512;
constexpr size_t kControlQueueDepth = 8;
// Room for kControlQueueDepth messages of up to 254 bytes each.
constexpr size_t kControlArenaBytes = 2048;
constexpr size_t kControlTypeBytes = 24;

enum class ControlPush : uint8_t {
  kQueued,    // appended to the FIFO, or the device_state slot was empty.
  kReplaced,  // a newer device_state replaced the unsent one.
  kFull,      // FIFO out of messages or bytes: refused.
  kTooLong,   // empty, or MaxMessage bytes or more: refused.
};

// The message's "type" value into `out` (wire type names only, never user
// text), or "unknown".
inline void controlType(const char* body, char* out, size_t outSize) {
  static const char kKey[] = "\"type\":\"";
  if (outSize == 0) return;
  const char* start = body ? std::strstr(body, kKey) : nullptr;
  size_t n = 0;
  if (start != nullptr) {
    start += sizeof(kKey) - 1;
    while (start[n] != '\0' && start[n] != '"' && n + 1 < outSize) {
      out[n] = start[n];
      ++n;
    }
  }
  if (n == 0) {
    std::strncpy(out, "unknown", outSize - 1);
    out[outSize - 1] = '\0';
    return;
  }
  out[n] = '\0';
}

inline bool isDeviceStateMessage(const char* body) {
  return body != nullptr && std::strstr(body, "\"type\":\"device_state\"") != nullptr;
}

template <size_t Depth, size_t Arena, size_t MaxMessage>
class ControlQueue {
  static_assert(Depth > 0, "a queue needs at least one FIFO message");
  static_assert(MaxMessage > 1 && MaxMessage <= 65535, "lengths are stored in 16 bits");
  static_assert(Arena >= MaxMessage + 1, "the arena must hold one maximum-size message");

 public:
  // Copies `body` (length bytes, no NUL needed) into the queue.
  ControlPush push(const char* body, size_t length) {
    if (length == 0 || length >= MaxMessage) return ControlPush::kTooLong;
    if (isDeviceStateMessage(body)) {
      const bool replaced = hasState_;
      std::memcpy(state_, body, length);
      stateLength_ = static_cast<uint16_t>(length);
      hasState_ = true;
      return replaced ? ControlPush::kReplaced : ControlPush::kQueued;
    }
    const size_t need = kPrefix + length;
    if (count_ == Depth || used_ + need > Arena) return ControlPush::kFull;
    const uint8_t prefix[kPrefix] = {static_cast<uint8_t>(length >> 8), static_cast<uint8_t>(length & 0xff)};
    size_t at = (head_ + used_) % Arena;
    at = write(at, prefix, kPrefix);
    write(at, reinterpret_cast<const uint8_t*>(body), length);
    used_ += need;
    ++count_;
    return ControlPush::kQueued;
  }

  // Takes the next message into `out` (NUL-terminated): the FIFO first, then
  // the device_state slot. False when empty or `out` is too small (the
  // message then stays queued).
  bool pop(char* out, size_t outSize, size_t* length) {
    if (count_ > 0) {
      uint8_t prefix[kPrefix];
      read(head_, prefix, kPrefix);
      const size_t n = (static_cast<size_t>(prefix[0]) << 8) | prefix[1];
      if (outSize <= n) return false;
      read((head_ + kPrefix) % Arena, reinterpret_cast<uint8_t*>(out), n);
      out[n] = '\0';
      if (length != nullptr) *length = n;
      head_ = (head_ + kPrefix + n) % Arena;
      used_ -= kPrefix + n;
      --count_;
      return true;
    }
    if (!hasState_ || outSize <= stateLength_) return false;
    std::memcpy(out, state_, stateLength_);
    out[stateLength_] = '\0';
    if (length != nullptr) *length = stateLength_;
    hasState_ = false;
    return true;
  }

  size_t size() const { return count_ + (hasState_ ? 1 : 0); }
  bool empty() const { return size() == 0; }
  static constexpr size_t capacity() { return Depth + 1; }

 private:
  static constexpr size_t kPrefix = 2;

  // Copies into / out of the ring at `at`, wrapping; returns the index after.
  size_t write(size_t at, const uint8_t* data, size_t n) {
    const size_t first = n < Arena - at ? n : Arena - at;
    std::memcpy(arena_ + at, data, first);
    std::memcpy(arena_, data + first, n - first);
    return (at + n) % Arena;
  }

  void read(size_t at, uint8_t* data, size_t n) const {
    const size_t first = n < Arena - at ? n : Arena - at;
    std::memcpy(data, arena_ + at, first);
    std::memcpy(data + first, arena_, n - first);
  }

  uint8_t arena_[Arena] = {};
  size_t head_ = 0;   // index of the oldest message's length prefix.
  size_t used_ = 0;   // bytes in use, prefixes included.
  size_t count_ = 0;  // messages in the FIFO.
  char state_[MaxMessage] = {};
  uint16_t stateLength_ = 0;
  bool hasState_ = false;
};

}  // namespace bob
