// Metadata-only diagnostics. No journal detail, text payload or retry queue.
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace bob {
inline bool deviceLogEventAllowed(const char* event) {
  const char* const allowed[] = {"welcome_accepted", "turn_started", "turn_ended", "playback_started",
      "turn_cancelled", "server_error", "capture_failed", "downlink_stalled", "audio_down_seq_gap"};
  if (!event) return false;
  for (const char* item : allowed) if (std::strcmp(event, item) == 0) return true;
  return false;
}

inline bool deviceLogTurnAllowed(const char* turn) {
  if (!turn) return true;
  size_t length = 0;
  for (; turn[length] != '\0' && length <= 64; ++length) {
    const char c = turn[length];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '_' || c == '-')) return false;
  }
  return length >= 8 && length <= 64;
}

inline size_t encodeDeviceLog(char* out, size_t capacity, const char* event, const char* turn,
                             uint32_t uptime, uint32_t freeHeap, uint32_t largestHeap) {
  if (!out || capacity == 0) return 0;
  out[0] = '\0';
  if (capacity < 320) return 0;
  if (!deviceLogEventAllowed(event) || !deviceLogTurnAllowed(turn)) return 0;
  const int length = std::snprintf(out, capacity,
      "{\"v\":1,\"type\":\"device_log\",\"id\":\"log_%lu_v2\",%s%s%s"
      "\"payload\":{\"event\":\"%s\",\"uptime_ms\":%lu,\"heap_free\":%lu,\"heap_largest\":%lu}}",
      static_cast<unsigned long>(uptime), turn ? "\"turn_ref\":\"" : "", turn ? turn : "",
      turn ? "\"," : "", event, static_cast<unsigned long>(uptime),
      static_cast<unsigned long>(freeHeap), static_cast<unsigned long>(largestHeap));
  if (length < 0 || static_cast<size_t>(length) >= capacity) { out[0] = '\0'; return 0; }
  return static_cast<size_t>(length);
}

class DeviceLogRate {
 public:
  bool due(uint32_t now) const { return !started_ || static_cast<uint32_t>(now - last_) >= 1000; }
  void sent(uint32_t now) { last_ = now; started_ = true; }
 private:
  uint32_t last_ = 0;
  bool started_ = false;
};
}  // namespace bob
