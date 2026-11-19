// Bob Cardputer v2 — Wi-Fi and WebSocket lifecycle.
#pragma once

#include <functional>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include "control_queue.h"
#include "reconnect_backoff.h"
#include "types.h"
#include "uplink_queue.h"
#include "wifi_join.h"

namespace bob {

// The WebSocket client plus a view of its TCP socket, so an audio write can
// check the send buffer has room first instead of blocking in lwIP until a
// lost segment is retransmitted (HIL run 20260924-195519-54b4: 1.0-1.33 s).
class BobWsClient : public WebSocketsClient {
 public:
  // The plain TCP socket, or -1 (no connection, or TLS: the secure client
  // keeps its own socket, and writes then stay blocking as before).
  int socketFd() { return _client.tcp != nullptr ? _client.tcp->fd() : -1; }
};

// A socket write that took longer than kTxSlowWriteMs (journaled as
// tx_write_slow by the main loop).
constexpr uint32_t kTxSlowWriteMs = 100;
struct TxSlowWrite {
  uint32_t ms;
  uint32_t bytes;
};

// Why a queued control message never reached the socket (journaled by the
// main loop as control_dropped; the type only, never the body).
enum class ControlDropReason : uint8_t {
  kQueueFull,     // the FIFO was full when it was queued.
  kTooLong,       // larger than a queue entry.
  kDisconnected,  // still queued when the socket closed.
  kSendFailed,    // the WebSocket library refused it.
};

struct ControlDrop {
  ControlDropReason reason;
  char type[kControlTypeBytes];
};

const char* controlDropReasonName(ControlDropReason reason);

// Why a server text (control) message never reached the main loop
// (journaled as rx_text_dropped; the type only, never the body).
enum class RxTextDropReason : uint8_t {
  kQueueFull,  // the event queue stayed full for kRxTextQueueWaitMs.
  kAlloc,      // no heap for its copy.
  kTooLong,    // over config::kMaxRxFrameBytes.
};

struct RxTextDrop {
  RxTextDropReason reason;
  char type[kControlTypeBytes];
};

const char* rxTextDropReasonName(RxTextDropReason reason);

// WebSocket event callback signature. The receiver is responsible for parsing
// text/binary payloads and driving playback/capture state.
using WebSocketEventCallback = std::function<void(WStype_t type, uint8_t* payload, size_t length)>;

class Network {
 public:
  Network();
  explicit Network(WebSocketEventCallback callback);

  // Replaces the event callback.
  void setCallback(WebSocketEventCallback callback);

  // Initializes the WebSocket callback and starts the dedicated network task;
  // does not connect Wi-Fi.
  void setup();

  // Connects to the configured Wi-Fi access point and starts the WebSocket.
  void start();

  // Drains socket events queued by the network task and invokes the callback
  // for each, on the caller's thread. Call frequently from loop().
  void pollEvents();

  // True once the client has been welcomed by the server.
  bool welcomed() const;
  void setWelcomed(bool value);

  // Server-assigned opaque session id from the welcome payload.
  const String& sessionId() const;
  void setSessionId(const String& value);

  // Queues a JSON control message when welcomed (or hello/pair_request before
  // welcome). Never waits for the socket: the network task sends it from its
  // own loop (control_queue.h has the order and priority rules). A message
  // that cannot be queued or sent is reported through takeControlDrop().
  void sendControl(const String& body);
  // Best effort diagnostics never occupy a busy control queue or retry.
  void sendDiagnostic(const char* body, size_t length);

  // Tries to send a binary OLX2 frame, waiting at most ~5 ms for the network
  // task to let go of the client, and only when the TCP send buffer has room
  // (the socket is writable), so the write itself does not wait for ACKs. Control messages queued before it are sent
  // first, so a turn_start always precedes the turn's first audio_up. False:
  // not sent (the client was busy); the caller keeps the frame and retries
  // (uplink_queue.h), so a busy socket never becomes a sequence gap.
  bool sendBinary(const uint8_t* data, size_t length);

  // The next control message that was dropped, for the main loop to journal.
  bool takeControlDrop(ControlDrop& out);

  // Current Wi-Fi status.
  wl_status_t wifiStatus() const;

  // The internet check after a Wi-Fi join (#676): HTTPS /health on the
  // production host with the bundled CA roots, then a plain-HTTP request to
  // tell a captive portal from no internet. Blocks up to ~15 s, so the Wi-Fi
  // manager runs it on its own task (#710), never while a socket connect is
  // open: one TLS context at a time. Touches no Network member. Journals
  // nothing (the caller does).
  ProbeResult probeInternet();

  // Last millis() of a connection attempt, used for timeouts and backoff.
  uint32_t lastConnectAttemptAt() const;
  void markConnectAttempt();

  // Exponential backoff for WebSocket reconnects (#709). Only start() ever
  // connects: the library's own reconnect is off, so superviseConnections()
  // owns the cadence and waits reconnectDelayMs(), the journaled retry_ms.
  uint32_t reconnectDelayMs() const;
  void scheduleReconnect();
  void resetReconnectDelay();

  // Disconnects any existing socket and makes exactly one connect attempt.
  // When the network task holds the client past a short bounded wait, nothing
  // starts (journaled socket_connect_busy); the caller starts again later.
  void restart();

  // True from a start() until pollEvents() has handled that attempt's
  // CONNECTED or DISCONNECTED (a TCP connect alone can take ~5 s), so a
  // failure's new back-off is set before anything starts again. Main thread.
  bool connecting() const;

  // An attempt whose end event was lost (event queue full) would keep
  // connecting() true forever. Past kConnectAttemptMaxMs this closes it once
  // and returns true with how long it ran; the caller counts it as a failed
  // connect. Its end event, if it still comes, is then stale: pollEvents()
  // journals socket_event_stale and does not pass it on. Main thread.
  bool expireAttempt(uint32_t nowMs, uint32_t& elapsedMs);

  // Since boot: attempt-ending CONNECTED/DISCONNECTED events the event queue
  // had no room for (shown as att_drop in `T state`).
  uint32_t attemptEndDrops() const;

  // Diagnostics: session-scoped binary RX counters (reset by resetRxCounters
  // at welcome) — frames/bytes observed by the WS library callback and how
  // many were dropped because the main-thread event queue was full.
  uint32_t rxBinFrames() const;
  uint32_t rxBinBytes() const;
  uint32_t rxDrops() const;
  void resetRxCounters();

  // Since boot: text messages the library delivered, text messages dropped
  // (each is also reported through takeRxTextDrop), and the most events ever
  // waiting in the event queue at once.
  uint32_t rxTextFrames() const;
  uint32_t rxTextDrops() const;
  uint32_t rxQueueHighWater() const;
  bool takeRxTextDrop(RxTextDrop& out);
  // Every text drop is counted (rxTextDrops); each is also reported through
  // takeRxTextDrop unless the small report queue overflows, which this counts.
  uint32_t rxDropReportsLost() const;

  // Since boot (or resetTxAudioDrops): audio_up frames the uplink gave up on,
  // counted by the caller through noteAudioDropped (a turn ended with frames
  // still queued). Main thread only.
  uint32_t txAudioDrops() const;
  void noteAudioDropped(uint32_t frames);
  void resetTxAudioDrops();

  // Slowest sendBinary since resetTxTiming(), in ms: the wait for the client
  // mutex and the socket write itself (a full TCP send buffer blocks it).
  // Main thread only; journaled per turn on turn_ended.
  uint32_t txWaitMaxMs() const;
  uint32_t txSendMaxMs() const;
  void resetTxTiming();

  // Since resetTxTiming(): audio writes refused because the send buffer had
  // no room, and how long the socket took nothing (TxBusyTracker). Main
  // thread only; journaled per turn on turn_ended (tx_busy, tx_busy_max_ms).
  const TxBusyTracker& txBusy() const;

  // The last write slower than kTxSlowWriteMs since the previous call (false:
  // none). Main thread only.
  bool takeTxSlowWrite(TxSlowWrite& out);

  // Stack high-water mark of the ws_net task (0 when the task is not up).
  uint32_t stackWatermark() const;

  // Slowest client_.loop() pass on ws_net since boot or resetWsLoopMax(), in
  // ms (#710): a TLS handshake shows up here as one long pass (`T state`
  // ws_loop_max).
  uint32_t wsLoopMaxMs() const;
  void resetWsLoopMax();

 private:
  static void networkTaskTrampoline(void* param);
  void networkTaskLoop();

  // Sends every queued control message, or drops them all when the socket is
  // closed. Caller holds clientMutex_ (the network task, or sendBinary).
  void flushControlsLocked();
  void reportDrop(ControlDropReason reason, const char* body);

  BobWsClient client_;
  WebSocketEventCallback callback_;
  bool welcomed_;
  String sessionId_;
  uint32_t lastConnectAttemptAt_;
  ReconnectBackoff backoff_;
  // Set by restart() and cleared by the network task after the one client
  // loop that makes the attempt, both under clientMutex_.
  volatile bool connectArmed_ = false;
  // Main thread only: the latest start()'s attempt, open from restart() until
  // pollEvents() handles its CONNECTED/DISCONNECTED or expireAttempt() gives up.
  ConnectAttempt attempt_;

  // client_ is only ever touched while holding clientMutex_: the network task
  // calls client_.loop() and sends queued control messages continuously, while
  // the main thread calls begin/disconnect/sendBIN. Main-thread acquisitions are bounded
  // (never portMAX_DELAY) so a slow reconnect attempt on the network task can
  // never freeze button/display polling on the main loop.
  SemaphoreHandle_t clientMutex_;
  QueueHandle_t eventQueue_;
  TaskHandle_t task_;

  // Outbound control messages. controls_ is only touched inside a queueLock_
  // critical section (a 512-byte copy at most), so neither side ever waits on
  // the other's socket work. txBuffer_ is the send copy, used only under
  // clientMutex_. dropQueue_ carries ControlDrop reports to the main loop.
  ControlQueue<kControlQueueDepth, kControlArenaBytes, kControlMaxBytes> controls_;
  portMUX_TYPE queueLock_ = portMUX_INITIALIZER_UNLOCKED;
  char txBuffer_[kControlMaxBytes];
  QueueHandle_t dropQueue_;
  uint32_t txAudioDrops_ = 0;
  uint32_t txWaitMaxMs_ = 0;
  uint32_t txSendMaxMs_ = 0;
  TxBusyTracker txBusy_;
  TxSlowWrite txSlow_ = {0, 0};
  bool txSlowPending_ = false;
  // Written by ws_net, reset by the main loop (`T state reset`).
  volatile uint32_t wsLoopMaxMs_ = 0;
  // ws_net's current priority (wsNetPriority, include/probe_task.h); ws_net only.
  UBaseType_t wsPriority_ = 2;
};

}  // namespace bob
