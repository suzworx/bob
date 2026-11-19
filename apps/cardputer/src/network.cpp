// Bob Cardputer v2 — Wi-Fi and WebSocket lifecycle.
#include "network.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <lwip/sockets.h>
#include <WiFiClientSecure.h>

#include "ca_roots.h"
#include "config.h"
#include "device_settings.h"
#include "device_token.h"
#include "journal.h"
#include "probe_task.h"
#include "protocol.h"

namespace bob {

namespace {

// A parsed WebSocket event, queued from the network task to the main thread.
// `data` is a heap copy owned by the queue entry; the consumer frees it after
// invoking the callback.
struct NetEvent {
  WStype_t type;
  uint8_t* data;
  size_t length;
  // Non-zero on the CONNECTED/DISCONNECTED that ends a start()'s attempt: that
  // attempt's id (Network::attemptId_).
  uint32_t endsAttempt;
};

// The id of the start() whose attempt is still open, from restart() until the
// library raises its CONNECTED or DISCONNECTED; 0 when none is. Only touched
// inside library calls and restart(), all under clientMutex_, so the event
// that ends an attempt is told apart from the DISCONNECTED of the socket
// restart() itself closes.
uint32_t g_liveAttempt = 0;
// Attempt-ending events the queue had no room for; the main loop then
// recovers through Network::expireAttempt.
volatile uint32_t g_attemptEndDrops = 0;

constexpr UBaseType_t kEventQueueDepth = 24;
// Main-thread client_ access (begin/disconnect/sendBIN) never waits longer
// than this for the network task to release clientMutex_, so a slow
// reconnect attempt can never freeze button/display polling. Control
// messages do not take the mutex at all: they are queued (sendControl).
constexpr TickType_t kClientMutexWaitTicks = pdMS_TO_TICKS(20);
// An audio frame waits much less: the network task holds the client for a
// whole client_.loop(), and a frame not sent now stays queued for the next
// pass (uplink_queue.h) instead of stalling the capture loop.
constexpr TickType_t kAudioMutexWaitTicks = pdMS_TO_TICKS(5);
// The library's reconnect interval between starts: loop() waits while
// (millis() - _lastConnectionFail) < interval, which with the largest
// unsigned long holds for ~49.7 days after the last failure.
constexpr unsigned long kNoAutoReconnectMs = ~0UL;
// Drop reports waiting for the main loop. One flush drops at most the whole
// queue (kControlQueueDepth + the device_state slot), and the main loop
// drains reports every iteration, so this depth is not reached in practice.
constexpr UBaseType_t kDropQueueDepth = kControlQueueDepth + 4;

// The library's onEvent callback must be a plain function pointer (no
// capture), so it cannot reach a Network member directly. Since exactly one
// Network instance exists in this firmware, route through a file-scope queue
// handle set by Network::setup(), mirroring the g_wsCallback trampoline this
// module already used for the same reason.
QueueHandle_t g_eventQueue = nullptr;

// Session-scoped binary RX diagnostics (reset at welcome): frames/bytes the
// WS library handed to the callback and how many were dropped on a full event
// queue. The queue-drop count discriminates app-layer loss from TCP-delivery
// starvation: frames counted here but never processed show up as downlink
// sequence gaps on the playback side.
volatile uint32_t g_rxBinFrames = 0;
volatile uint32_t g_rxBinBytes = 0;
volatile uint32_t g_rxDrops = 0;

// Server text (control) messages: a lost one strands the device (a picker
// that never fills, a stop the server never confirms), so a full event queue
// makes the network task wait up to this long for the main loop to drain it
// instead of dropping. The main loop drains the whole queue every iteration,
// so the queue only stays full while the loop is stalled; waiting here holds
// back only this task, never the main loop. A drop after the wait, a failed
// allocation or an oversize message is counted, never silent; each drop is
// also journaled unless the report queue overflows (then that is counted).
// The wait cannot overlap a capture in practice: while capturing, the main
// loop drains the queue every iteration (~10 ms), so it only stays full when
// that loop is stalled, and a stalled loop is not sending audio either.
constexpr TickType_t kRxTextQueueWaitTicks = pdMS_TO_TICKS(500);
constexpr UBaseType_t kRxDropQueueDepth = 8;
QueueHandle_t g_rxDropQueue = nullptr;
volatile uint32_t g_rxTextFrames = 0;
volatile uint32_t g_rxTextDrops = 0;
volatile uint32_t g_rxQueueHigh = 0;
volatile uint32_t g_rxDropReportsLost = 0;

// True when the TCP send buffer has room: lwIP marks a socket writable once
// about half of its send buffer is free, so a 346 B frame then goes straight
// in. Zero timeout: never waits.
bool socketWritable(int fd) {
  fd_set writable;
  FD_ZERO(&writable);
  FD_SET(fd, &writable);
  timeval now = {0, 0};
  return select(fd + 1, nullptr, &writable, nullptr, &now) > 0 && FD_ISSET(fd, &writable);
}

void reportRxTextDrop(RxTextDropReason reason, const uint8_t* payload, size_t length) {
  g_rxTextDrops++;
  RxTextDrop drop{reason, {}};
  // The type sits near the start of every control message; copy a bounded,
  // NUL-terminated prefix to read it.
  char head[96];
  const size_t n = payload != nullptr ? (length < sizeof(head) - 1 ? length : sizeof(head) - 1) : 0;
  if (n > 0) std::memcpy(head, payload, n);
  head[n] = '\0';
  controlType(head, drop.type, sizeof(drop.type));
  if (!g_rxDropQueue || xQueueSend(g_rxDropQueue, &drop, 0) != pdTRUE) g_rxDropReportsLost++;
}

}  // namespace

const char* rxTextDropReasonName(RxTextDropReason reason) {
  switch (reason) {
    case RxTextDropReason::kQueueFull: return "queue_full";
    case RxTextDropReason::kAlloc: return "alloc";
    case RxTextDropReason::kTooLong: return "too_long";
  }
  return "unknown";
}

Network::Network()
    : callback_(),
      welcomed_(false),
      lastConnectAttemptAt_(0),
      backoff_(config::kSocketReconnectInitialMs, config::kSocketReconnectMaxMs),
      clientMutex_(nullptr),
      eventQueue_(nullptr),
      task_(nullptr),
      txBuffer_{},
      dropQueue_(nullptr) {}

Network::Network(WebSocketEventCallback callback)
    : callback_(callback),
      welcomed_(false),
      lastConnectAttemptAt_(0),
      backoff_(config::kSocketReconnectInitialMs, config::kSocketReconnectMaxMs),
      clientMutex_(nullptr),
      eventQueue_(nullptr),
      task_(nullptr),
      txBuffer_{},
      dropQueue_(nullptr) {}

const char* controlDropReasonName(ControlDropReason reason) {
  switch (reason) {
    case ControlDropReason::kQueueFull: return "queue_full";
    case ControlDropReason::kTooLong: return "too_long";
    case ControlDropReason::kDisconnected: return "disconnected";
    case ControlDropReason::kSendFailed: return "send_failed";
  }
  return "unknown";
}

void Network::setCallback(WebSocketEventCallback callback) {
  callback_ = callback;
}

void Network::setup() {
  clientMutex_ = xSemaphoreCreateMutex();
  eventQueue_ = xQueueCreate(kEventQueueDepth, sizeof(NetEvent));
  dropQueue_ = xQueueCreate(kDropQueueDepth, sizeof(ControlDrop));
  g_eventQueue = eventQueue_;
  g_rxDropQueue = xQueueCreate(kRxDropQueueDepth, sizeof(RxTextDrop));

  client_.onEvent([](WStype_t type, uint8_t* payload, size_t length) {
    const bool text = type == WStype_TEXT;
    if (type == WStype_BIN) {
      g_rxBinFrames++;
      g_rxBinBytes += length;
    }
    if (text) g_rxTextFrames++;

    // Drop oversize frames before allocating to prevent heap exhaustion.
    if (length > config::kMaxRxFrameBytes) {
      if (type == WStype_BIN) g_rxDrops++;
      if (text) reportRxTextDrop(RxTextDropReason::kTooLong, payload, length);
      return;
    }

    const uint32_t ends =
        type == WStype_CONNECTED || type == WStype_DISCONNECTED ? g_liveAttempt : 0;
    if (ends != 0) g_liveAttempt = 0;
    NetEvent evt{type, nullptr, length, ends};
    if (length > 0 && payload) {
      evt.data = static_cast<uint8_t*>(malloc(length));
      if (evt.data) {
        std::memcpy(evt.data, payload, length);
      } else if (text) {
        // An empty text event would reach the main loop as an unparseable
        // message and vanish there; report it here instead.
        reportRxTextDrop(RxTextDropReason::kAlloc, payload, length);
        return;
      } else {
        evt.length = 0;
      }
    }
    // Audio frames never wait (a late one is useless and the drop is
    // counted); a control message waits for room (kRxTextQueueWaitTicks), and
    // so does the end of a connect attempt, which superviseConnections needs.
    const TickType_t wait = text || ends ? kRxTextQueueWaitTicks : 0;
    if (!g_eventQueue || xQueueSend(g_eventQueue, &evt, wait) != pdTRUE) {
      if (type == WStype_BIN) g_rxDrops++;
      if (text) reportRxTextDrop(RxTextDropReason::kQueueFull, payload, length);
      if (ends != 0) g_attemptEndDrops++;
      if (evt.data) free(evt.data);
      return;
    }
    const uint32_t waiting = uxQueueMessagesWaiting(g_eventQueue);
    if (waiting > g_rxQueueHigh) g_rxQueueHigh = waiting;
  });
  client_.enableHeartbeat(10000, 3000, 2);
  // The library's loop() runs a BLOCKING tcp connect (WEBSOCKETS_TCP_TIMEOUT
  // override, plus the underlying WiFiClient's own ~5s connect timeout which
  // that flag does not cover) whenever it thinks the socket is down. It now
  // runs on its own task (see networkTaskLoop) precisely so that block can
  // never freeze button/display polling on the main loop. It connects only
  // after a start() (networkTaskLoop); superviseConnections() decides when,
  // on the device back-off (#709).
  client_.setReconnectInterval(kNoAutoReconnectMs);

  // Core 0 is the ESP32 Wi-Fi/lwIP system core in the Arduino framework; the
  // Arduino loopTask (ARDUINO_RUNNING_CORE) and every task this firmware
  // creates deliberately stay off it and share core 1 instead.
  //
  // Priority 2, strictly above the mp3_decode task's priority 1: FreeRTOS
  // preempts by priority first, not round-robin, so equal priority with
  // decode let a single MAD-decode-plus-blocking-I2S-write call hold the CPU
  // long enough that this task's client_.loop() never got back to servicing
  // the socket mid-reply — confirmed on-device as a WS 1002 close after the
  // device received exactly 1 of 95 frames the server actually sent. At
  // priority 2, an arriving TCP byte wakes this task and it preempts decode
  // immediately instead of waiting for decode to voluntarily yield.
  xTaskCreatePinnedToCore(&Network::networkTaskTrampoline, "ws_net", 6144,
                           this, 2, &task_, 1);
}

void Network::networkTaskTrampoline(void* param) {
  static_cast<Network*>(param)->networkTaskLoop();
}

void Network::networkTaskLoop() {
  for (;;) {
    xSemaphoreTake(clientMutex_, portMAX_DELAY);
    // The TLS handshake's ECC never blocks: at priority 2 it held core 1 from
    // loopTask for ~0.66 s (#710). Level with loopTask while not connected, so
    // they share the core; priority 2 again once connected (Network::setup).
    const UBaseType_t priority = wsNetPriority(client_.isConnected());
    if (priority != wsPriority_) {
      vTaskPrioritySet(nullptr, priority);
      wsPriority_ = priority;
    }
    // superviseConnections() owns the reconnect cadence (#709). loop() only
    // connects once (millis() - _lastConnectionFail) reaches the interval, and
    // begin() zeroes _lastConnectionFail, so: interval 0 for the one pass after
    // a start(), which connects at once, and kNoAutoReconnectMs for every other
    // pass, which never elapses, so the library never reconnects by itself.
    const bool armed = connectArmed_;
    client_.setReconnectInterval(armed ? 0 : kNoAutoReconnectMs);
    const uint32_t started = millis();
    client_.loop();
    const uint32_t took = millis() - started;
    if (took > wsLoopMaxMs_) wsLoopMaxMs_ = took;
    // That pass made the attempt (connected, or failed and timed out); the
    // failure reaches the main loop as WStype_DISCONNECTED on the next pass.
    if (armed) connectArmed_ = false;
    flushControlsLocked();
    xSemaphoreGive(clientMutex_);
    vTaskDelay(1);
  }
}

void Network::start() {
  restart();
}

void Network::restart() {
  // Timed even when the client is busy below, so superviseConnections()
  // re-issues a dropped start() after the back-off, never on every tick.
  lastConnectAttemptAt_ = millis();
  welcomed_ = false;
  char token[kDeviceTokenBytes];
  const bool hasToken = loadDeviceToken(token, sizeof(token));
#ifdef BOB_LEGACY_SECRET
  const int legacyAuth = DEVICE_SECRET[0] != '\0' ? 1 : 0;
#else
  const int legacyAuth = 0;
#endif
  // The active server profile's endpoint (#675); only its name and TLS flag
  // are journaled, never the host.
  const Endpoint& endpoint = activeEndpoint();
  if (xSemaphoreTake(clientMutex_, kClientMutexWaitTicks) != pdTRUE) {
    // The network task held the client (a slow loop pass); nothing was
    // started, so nothing is journaled as a connect. superviseConnections()
    // starts again after reconnectDelayMs().
    journal("socket_connect_busy", State::kSocket, sessionId_);
    return;
  }
  journal("socket_connect", State::kSocket, sessionId_);
  journal("ws_mode", State::kSocket, "",
          "tls=" + String(endpoint.tls ? 1 : 0) + " profile=" + profileName(activeProfile()) +
              " auth=" +
              // 0 = no header, 1 = legacy compiled secret, 2 = NVS device token.
              String(hasToken ? 2 : legacyAuth));
  {
    // The socket closed here is not this start's attempt, so its DISCONNECTED
    // must not end the attempt.
    g_liveAttempt = 0;
    client_.disconnect();
    // One attempt per start(): the next client loop connects at once
    // (networkTaskLoop), and the library never retries on its own. The
    // attempt stays open (connecting()) until the main loop has handled its
    // CONNECTED or DISCONNECTED (pollEvents), or it expires (expireAttempt).
    const bool begins = endpoint.tls || kDevOptions;
    const uint32_t id = attempt_.begin(millis());
    if (!begins) attempt_.cancel();
    connectArmed_ = begins;
    g_liveAttempt = begins ? id : 0;
    if (endpoint.tls) {
      client_.beginSslWithCA(endpoint.host, endpoint.port, "/v2/cardputer", kCaRoots);
    } else if (kDevOptions) {  // plain ws:// never loads on other builds (endpointCheck)
      client_.begin(endpoint.host, endpoint.port, "/v2/cardputer");
    }
    // Bearer auth on the WS upgrade. Must be set AFTER begin()/beginSslWithCA()
    // on every connect — the library resets `_client.plainAuthorization` inside
    // begin(), wiping the header. The NVS token (paired device) takes
    // precedence; the legacy compiled-in secret is used only when
    // BOB_LEGACY_SECRET=1 and no token exists (contract S-6, obligation 13).
    if (hasToken) {
      char header[kDeviceTokenBytes + 8];
      snprintf(header, sizeof(header), "Bearer %s", token);
      client_.setAuthorization(header);
    }
#ifdef BOB_LEGACY_SECRET
    else if (DEVICE_SECRET[0] != '\0') {
      client_.setAuthorization("Bearer " DEVICE_SECRET);
    }
#endif
  }
  xSemaphoreGive(clientMutex_);
}

bool Network::connecting() const { return attempt_.open(); }

bool Network::expireAttempt(uint32_t nowMs, uint32_t& elapsedMs) {
  return attempt_.expire(nowMs, kConnectAttemptMaxMs, elapsedMs);
}

uint32_t Network::attemptEndDrops() const { return g_attemptEndDrops; }

void Network::pollEvents() {
  NetEvent evt;
  while (xQueueReceive(eventQueue_, &evt, 0) == pdTRUE) {
    // The end of an attempt that expired (its failure is already counted) or
    // that a later start() replaced: passing it on would count it twice.
    if (evt.endsAttempt != 0 && !attempt_.end(evt.endsAttempt)) {
      journal("socket_event_stale", State::kSocket, "",
              String("type=") + (evt.type == WStype_CONNECTED ? "connected" : "disconnected") +
                  ",attempt=" + evt.endsAttempt);
    } else if (callback_) {
      callback_(evt.type, evt.data, evt.length);
    }
    if (evt.data) free(evt.data);
  }
}

bool Network::welcomed() const { return welcomed_; }

void Network::setWelcomed(bool value) { welcomed_ = value; }

const String& Network::sessionId() const { return sessionId_; }

void Network::setSessionId(const String& value) { sessionId_ = value; }

void Network::sendControl(const String& body) {
  // Before welcome only hello and pair_request may be sent — an unpaired
  // session never receives a welcome (it gets pairing_required instead), so
  // the pairing flow must not be blocked by the welcome gate.
  if (!welcomed_ && body.indexOf("\"type\":\"hello\"") < 0 &&
      body.indexOf("\"type\":\"pair_request\"") < 0) {
    return;
  }
  portENTER_CRITICAL(&queueLock_);
  const ControlPush result = controls_.push(body.c_str(), body.length());
  portEXIT_CRITICAL(&queueLock_);
  if (result == ControlPush::kFull) reportDrop(ControlDropReason::kQueueFull, body.c_str());
  if (result == ControlPush::kTooLong) reportDrop(ControlDropReason::kTooLong, body.c_str());
}

void Network::sendDiagnostic(const char* body, size_t length) {
  if (!welcomed_) return;
  portENTER_CRITICAL(&queueLock_);
  if (controls_.empty()) controls_.push(body, length);
  portEXIT_CRITICAL(&queueLock_);
}

bool Network::sendBinary(const uint8_t* data, size_t length) {
  const uint32_t start = millis();
  if (xSemaphoreTake(clientMutex_, kAudioMutexWaitTicks) != pdTRUE) {
    if (millis() - start > txWaitMaxMs_) txWaitMaxMs_ = millis() - start;
    return false;  // the caller keeps the frame queued (uplink_queue.h).
  }
  const uint32_t locked = millis();
  flushControlsLocked();  // keeps controls and audio in the order sent.
  // No room in the TCP send buffer (lwIP is waiting for ACKs, e.g. to
  // retransmit a lost segment): leave the frame queued rather than block the
  // loop in the write until room appears.
  const int fd = client_.socketFd();
  if (fd >= 0 && !socketWritable(fd)) {
    xSemaphoreGive(clientMutex_);
    txBusy_.refused(locked);
    if (locked - start > txWaitMaxMs_) txWaitMaxMs_ = locked - start;
    return false;
  }
  client_.sendBIN(data, length);
  xSemaphoreGive(clientMutex_);
  const uint32_t done = millis();
  txBusy_.sent(done);
  if (locked - start > txWaitMaxMs_) txWaitMaxMs_ = locked - start;
  if (done - locked > txSendMaxMs_) txSendMaxMs_ = done - locked;
  if (done - locked > kTxSlowWriteMs) {
    txSlow_ = {done - locked, static_cast<uint32_t>(length)};
    txSlowPending_ = true;
  }
  return true;
}

const TxBusyTracker& Network::txBusy() const { return txBusy_; }

bool Network::takeTxSlowWrite(TxSlowWrite& out) {
  if (!txSlowPending_) return false;
  out = txSlow_;
  txSlowPending_ = false;
  return true;
}

uint32_t Network::txAudioDrops() const { return txAudioDrops_; }
void Network::noteAudioDropped(uint32_t frames) { txAudioDrops_ += frames; }
void Network::resetTxAudioDrops() { txAudioDrops_ = 0; }
uint32_t Network::txWaitMaxMs() const { return txWaitMaxMs_; }
uint32_t Network::txSendMaxMs() const { return txSendMaxMs_; }

void Network::resetTxTiming() {
  txWaitMaxMs_ = 0;
  txSendMaxMs_ = 0;
  txBusy_.reset();
}

uint32_t Network::rxDropReportsLost() const { return g_rxDropReportsLost; }

void Network::flushControlsLocked() {
  const bool connected = client_.isConnected();
  // Bounded to what can be queued, so a flush always ends.
  for (size_t i = 0; i < controls_.capacity(); ++i) {
    size_t length = 0;
    portENTER_CRITICAL(&queueLock_);
    const bool taken = controls_.pop(txBuffer_, sizeof(txBuffer_), &length);
    portEXIT_CRITICAL(&queueLock_);
    if (!taken) return;
    if (!connected) {
      reportDrop(ControlDropReason::kDisconnected, txBuffer_);
    } else if (!client_.sendTXT(txBuffer_, length)) {
      reportDrop(ControlDropReason::kSendFailed, txBuffer_);
    }
  }
}

void Network::reportDrop(ControlDropReason reason, const char* body) {
  ControlDrop drop{reason, {}};
  controlType(body, drop.type, sizeof(drop.type));
  if (dropQueue_) xQueueSend(dropQueue_, &drop, 0);
}

uint32_t Network::rxTextFrames() const { return g_rxTextFrames; }

uint32_t Network::rxTextDrops() const { return g_rxTextDrops; }

uint32_t Network::rxQueueHighWater() const { return g_rxQueueHigh; }

bool Network::takeRxTextDrop(RxTextDrop& out) {
  return g_rxDropQueue && xQueueReceive(g_rxDropQueue, &out, 0) == pdTRUE;
}

bool Network::takeControlDrop(ControlDrop& out) {
  return dropQueue_ && xQueueReceive(dropQueue_, &out, 0) == pdTRUE;
}

wl_status_t Network::wifiStatus() const { return WiFi.status(); }

namespace {

constexpr uint32_t kProbeConnectTimeoutMs = 5000;
constexpr uint32_t kProbeReadTimeoutS = 5;
constexpr size_t kProbeMaxHeaderLines = 24;

// "HTTP/1.1 302 Found" -> 302; 0 when the line is not a status line.
int httpStatus(const String& line) {
  if (!line.startsWith("HTTP/1.")) return 0;
  const int space = line.indexOf(' ');
  return space > 0 ? line.substring(space + 1, space + 4).toInt() : 0;
}

void sendHealthRequest(Client& client) {
  client.print(String("GET /health HTTP/1.1\r\nHost: ") + kProdHost +
               "\r\nConnection: close\r\n\r\n");
}

}  // namespace

ProbeResult Network::probeInternet() {
  ProbeFacts facts{};
  IPAddress address;
  facts.dnsOk = WiFi.hostByName(kProdHost, address) == 1;
  if (facts.dnsOk) {
    WiFiClientSecure tls;
    tls.setCACert(kCaRoots);
    tls.setTimeout(kProbeReadTimeoutS);
    if (tls.connect(kProdHost, kProdPort, kProbeConnectTimeoutMs)) {
      sendHealthRequest(tls);
      facts.httpsOk = httpStatus(tls.readStringUntil('\n')) > 0;
    }
    tls.stop();
  }
  if (facts.dnsOk && !facts.httpsOk) {
    WiFiClient plain;
    plain.setTimeout(kProbeReadTimeoutS);
    if (plain.connect(kProdHost, 80, kProbeConnectTimeoutMs)) {
      facts.plainConnected = true;
      sendHealthRequest(plain);
      facts.plainStatus = httpStatus(plain.readStringUntil('\n'));
      const String home = String("://") + kProdHost;
      for (size_t i = 0; i < kProbeMaxHeaderLines && plain.connected(); ++i) {
        String header = plain.readStringUntil('\n');
        header.trim();
        if (header.length() == 0) break;
        header.toLowerCase();
        if (header.startsWith("location:")) {
          // Exactly the production host: "…://api.heybob.xyz/…" or ending
          // there, never "…://api.heybob.xyz.example/…".
          facts.plainRedirectsHome =
              header.indexOf(home + "/") > 0 || header.endsWith(home);
        }
      }
    }
    plain.stop();
  }
  return classifyProbe(facts);
}

uint32_t Network::lastConnectAttemptAt() const { return lastConnectAttemptAt_; }

void Network::markConnectAttempt() { lastConnectAttemptAt_ = millis(); }

// superviseConnections() waits this long after a failed connect before the
// next start(), and socket_closed journals the same value as retry_ms.
uint32_t Network::reconnectDelayMs() const { return backoff_.delayMs(); }

void Network::scheduleReconnect() { backoff_.fail(); }

void Network::resetReconnectDelay() { backoff_.reset(); }

uint32_t Network::rxBinFrames() const { return g_rxBinFrames; }

uint32_t Network::rxBinBytes() const { return g_rxBinBytes; }

uint32_t Network::rxDrops() const { return g_rxDrops; }

void Network::resetRxCounters() {
  g_rxBinFrames = 0;
  g_rxBinBytes = 0;
  g_rxDrops = 0;
}

uint32_t Network::stackWatermark() const {
  return task_ ? uxTaskGetStackHighWaterMark(task_) : 0;
}

uint32_t Network::wsLoopMaxMs() const { return wsLoopMaxMs_; }

void Network::resetWsLoopMax() { wsLoopMaxMs_ = 0; }

}  // namespace bob
