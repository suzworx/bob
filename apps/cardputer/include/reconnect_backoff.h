// Bob Cardputer v2 — the WebSocket reconnect back-off (#709), pure so the
// host tests run it. One value owns the cadence: after a failed or lost
// socket, superviseConnections() (state.cpp) starts the next attempt once
// delayMs() has passed, and socket_closed journals the same value as
// retry_ms. The WebSockets library never reconnects on its own.
#pragma once

#include <cstdint>

namespace bob {

// The delay after one more failed connect: doubled, never past maxMs.
constexpr uint32_t nextReconnectDelayMs(uint32_t currentMs, uint32_t maxMs) {
  return currentMs >= maxMs / 2 ? maxMs : currentMs * 2;
}

// superviseConnections(): the next start() is due once more than delayMs has
// passed since the last attempt or failed close. Unsigned, so it holds across
// the millis() wrap.
constexpr bool reconnectDue(uint32_t nowMs, uint32_t sinceMs, uint32_t delayMs) {
  return static_cast<uint32_t>(nowMs - sinceMs) > delayMs;
}

// The longest one connect attempt can take before the library reports it
// (CONNECTED or DISCONNECTED), from the pinned sources (WebSockets 2.7.3,
// arduino-esp32 3.20017):
//   DNS: up to 16 s for the resolver to go idle, then 15 s for the answer
//     (WiFiGeneric.cpp:1572, :1578; WiFiClientSecure.cpp:132-133);
//   TCP connect: WEBSOCKETS_TCP_TIMEOUT = 5 s (platformio.ini build flag,
//     WebSocketsClient.cpp:331 -> ssl_client.cpp:88-105);
//   TLS handshake: 120 s (WiFiClientSecure.cpp:40, ssl_client.cpp:270-275);
//   WS upgrade response: WEBSOCKETS_TCP_TIMEOUT = 5 s (WebSocketsClient.cpp:646).
// 161 s in all; 180 s leaves margin for loop passes and the event hand-off.
constexpr uint32_t kConnectAttemptMaxMs = 180000;

// True once an attempt started at startedMs has run more than maxMs.
// Unsigned, so it holds across the millis() wrap.
constexpr bool attemptExpired(uint32_t startedMs, uint32_t nowMs, uint32_t maxMs) {
  return static_cast<uint32_t>(nowMs - startedMs) > maxMs;
}

// The open connect attempt, main thread only. begin() at each start(); the
// attempt ends when its own CONNECTED/DISCONNECTED arrives (end), or when it
// runs past kConnectAttemptMaxMs because that event was lost (expire). An end
// for any other id (an expired or superseded attempt) is stale.
class ConnectAttempt {
 public:
  // Opens a new attempt; returns its id (never 0).
  uint32_t begin(uint32_t nowMs) {
    if (++id_ == 0) id_ = 1;
    open_ = true;
    startedMs_ = nowMs;
    return id_;
  }
  // No attempt could start (no endpoint to begin): nothing is open.
  void cancel() { open_ = false; }
  bool open() const { return open_; }
  uint32_t id() const { return id_; }
  // An end event for attemptId: true when it ends the open attempt; false
  // when it is stale and must be ignored.
  bool end(uint32_t attemptId) {
    if (!open_ || attemptId == 0 || attemptId != id_) return false;
    open_ = false;
    return true;
  }
  // True once, when the open attempt has run past maxMs: it is closed, and
  // elapsedMs says how long it ran.
  bool expire(uint32_t nowMs, uint32_t maxMs, uint32_t& elapsedMs) {
    if (!open_ || !attemptExpired(startedMs_, nowMs, maxMs)) return false;
    open_ = false;
    elapsedMs = nowMs - startedMs_;
    return true;
  }

 private:
  uint32_t id_ = 0;
  uint32_t startedMs_ = 0;
  bool open_ = false;
};

class ReconnectBackoff {
 public:
  ReconnectBackoff(uint32_t initialMs, uint32_t maxMs)
      : initialMs_(initialMs), maxMs_(maxMs), delayMs_(initialMs) {}

  // The wait after a failed or lost socket before the next connect attempt.
  uint32_t delayMs() const { return delayMs_; }
  // A connect failed or the socket dropped: wait longer next time.
  void fail() { delayMs_ = nextReconnectDelayMs(delayMs_, maxMs_); }
  // Connected (or a clean close / user retry): back to the first step.
  void reset() { delayMs_ = initialMs_; }

 private:
  uint32_t initialMs_;
  uint32_t maxMs_;
  uint32_t delayMs_;  // main loop only.
};

}  // namespace bob
