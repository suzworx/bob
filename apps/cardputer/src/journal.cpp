// Bob Cardputer v2 — PII-free single-line diagnostics to USB serial.
//
// Logging must never stall the caller (HIL run 20260924-045753-ec6f: a
// 1230 ms main-loop stall mid-capture, half the turn's audio lost). On the
// ESP32-S3 the Serial port is HWCDC (USB-Serial-JTAG): write() only returns at
// once when its TX ring has room for the whole write; otherwise it spins in
// delay(1) until the host drains the ring, restarting its timeout on every bit
// of progress, and flush() waits the same way. So each line is formatted
// first and written only when the ring has room for all of it; otherwise it
// is dropped and counted, and a log_dropped line reports the loss once there
// is room again. There is no flush().
//
// setTxTimeoutMs(0) is not used: this core's write() retry loop starts its
// counter at the timeout and decrements before testing for zero, so 0 would
// wrap and spin. The short timeout only bounds the core's own tx lock and any
// write that does not go through this gate.
#include "journal.h"

#include <Arduino.h>
#include <cstdio>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#if ARDUINO_USB_MODE && ARDUINO_USB_CDC_ON_BOOT
#include <hal/usb_serial_jtag_ll.h>
#endif
#include "types.h"
#include "usb_packet.h"

namespace bob {

namespace {

// Room for a burst of lines while the host is slow to read (heap, not static).
constexpr size_t kSerialTxBufferBytes = 4096;
constexpr uint32_t kSerialTxTimeoutMs = 5;
constexpr size_t kLineBytes = 768;  // the longest journal line is ~520 chars.

// The packet-edge guard's wait for the ring to drain before a held-back tail:
// the ISR moves a packet each time the host takes one, so a handful of
// packets take about a millisecond each; a longer backlog is not waited out.
constexpr uint32_t kPacketEdgeWaitMs = 10;

SemaphoreHandle_t g_serialMutex = nullptr;
char g_line[kLineBytes];  // formatted under g_serialMutex.
uint32_t g_droppedLines = 0;
uint32_t g_droppedBytes = 0;
uint32_t g_totalDroppedLines = 0;
// Below all under g_serialMutex. The TX ring's free size while empty, read at
// journalBegin: free space short of it is what still waits to go out.
int g_ringFreeWhenEmpty = 0;
bool g_packetEdgeGuard = true;  // `T zlp off` (test console) turns it off.
uint32_t g_packetEdgeLate = 0;  // tails written before the ring drained.

// Re-arms the USB-Serial-JTAG transmitter. The core's ISR disables its
// "IN FIFO empty" interrupt whenever the TX ring runs dry, and only write()
// enables it again, and only while the core believes a host is connected.
// A caller that skips write() because the ring is full (below) would
// otherwise leave the ring stuck full for good, every later line and console
// reply dropped (HIL run 20260924-051303-1d85). This is the same register
// pair write() uses. Only while plugged: unplugged, the ISR returns without
// writing and the empty FIFO would re-raise the interrupt continuously.
void kickTransmitter() {
#if ARDUINO_USB_MODE && ARDUINO_USB_CDC_ON_BOOT
  if (!HWCDC::isPlugged()) return;
  usb_serial_jtag_ll_txfifo_flush();
  usb_serial_jtag_ll_ena_intr_mask(USB_SERIAL_JTAG_INTR_SERIAL_IN_EMPTY);
#endif
}

bool writeNow(const char* text, size_t length) {
  const bool sent = Serial.write(reinterpret_cast<const uint8_t*>(text), length) == length;
  kickTransmitter();
  return sent;
}

// Waits, at most kPacketEdgeWaitMs, until the ISR has taken every byte from
// the TX ring (it is then back to its free size at boot). False: timed out.
bool waitRingDrained() {
  for (uint32_t waited = 0; waited < kPacketEdgeWaitMs; ++waited) {
    if (Serial.availableForWrite() >= g_ringFreeWhenEmpty) return true;
    kickTransmitter();
    delay(1);
  }
  return Serial.availableForWrite() >= g_ringFreeWhenEmpty;
}

// Writes all of `text` or nothing, never waiting for the host to read a
// backlog. A line that could end a burst on a full 64-byte packet (the host
// then holds it until more output follows: HIL run 20260929-233629-b7e0, a
// 128-byte T state reply late by 3 s) goes out as its head, then, once the
// ring has drained (a few packets; bounded by kPacketEdgeWaitMs), its last
// byte alone: a short packet that ends the transfer (usb_packet.h).
bool emit(const char* text, size_t length) {
  const int free = Serial.availableForWrite();
  if (free < static_cast<int>(length)) {
    kickTransmitter();
    return false;
  }
  size_t tail = 0;
#if ARDUINO_USB_MODE && ARDUINO_USB_CDC_ON_BOOT
  const size_t queued = g_ringFreeWhenEmpty > free ? static_cast<size_t>(g_ringFreeWhenEmpty - free) : 0;
  if (g_packetEdgeGuard && HWCDC::isPlugged() && endsOnPacketBoundary(queued, length)) {
    tail = packetEdgeTail(length);
  }
#endif
  if (tail == 0) return writeNow(text, length);
  const size_t head = length - tail;
  if (!writeNow(text, head)) return false;
  if (!waitRingDrained()) ++g_packetEdgeLate;
  return writeNow(text + head, tail);
}

void countDrop(size_t length) {
  ++g_droppedLines;
  ++g_totalDroppedLines;
  g_droppedBytes += length;
}

// "<uptime> INFO v2.<event> state=<STATE>[ session=<id>][ <detail>]\r\n",
// cut to kLineBytes (the line break is kept).
size_t format(const char* event, State state, const String& sessionId, const String& detail) {
  int n = snprintf(g_line, kLineBytes - 2, "%lu INFO v2.%s state=%s%s%s%s%s", millis(), event,
                   stateName(state), sessionId.isEmpty() ? "" : " session=", sessionId.c_str(),
                   detail.isEmpty() ? "" : " ", detail.c_str());
  if (n < 0) n = 0;
  size_t length = static_cast<size_t>(n) < kLineBytes - 3 ? static_cast<size_t>(n) : kLineBytes - 3;
  g_line[length++] = '\r';
  g_line[length++] = '\n';
  g_line[length] = '\0';
  return length;
}

}  // namespace

void journalBegin() {
  if (!g_serialMutex) g_serialMutex = xSemaphoreCreateMutex();
  Serial.setTxBufferSize(kSerialTxBufferBytes);  // before begin(), or it keeps 256 B.
  Serial.setTxTimeoutMs(kSerialTxTimeoutMs);
  Serial.begin(115200);
  g_ringFreeWhenEmpty = Serial.availableForWrite();  // nothing written yet.
}

void journal(const char* event, State state, const String& sessionId, const String& detail) {
  // Intentionally excludes audio, text, credentials, URLs, headers, and tokens.
  if (!g_serialMutex) return;  // before journalBegin(): nowhere to write yet.
  xSemaphoreTake(g_serialMutex, portMAX_DELAY);  // held only to format and copy.
  if (g_droppedLines > 0) {
    const String loss = String("lines=") + g_droppedLines + ",bytes=" + g_droppedBytes;
    const size_t length = format("log_dropped", state, sessionId, loss);
    if (emit(g_line, length)) {
      g_droppedLines = 0;
      g_droppedBytes = 0;
    }
  }
  const size_t length = format(event, state, sessionId, detail);
  if (g_droppedLines > 0 || !emit(g_line, length)) countDrop(length);
  xSemaphoreGive(g_serialMutex);
}

uint32_t journalDroppedLines() { return g_totalDroppedLines; }

#ifdef BOB_TEST_CONSOLE
// A console reply is what the HIL runner waits for, so it waits up to 200 ms
// for room (the host is reading by definition), taking the lock only to try.
void consoleReply(const String& reply) {
  if (!g_serialMutex) return;
  const String line = String("T> ") + reply + "\r\n";
  for (int tries = 0; tries < 200; ++tries) {
    xSemaphoreTake(g_serialMutex, portMAX_DELAY);
    const bool sent = emit(line.c_str(), line.length());
    xSemaphoreGive(g_serialMutex);
    if (sent) return;
    delay(1);
  }
  xSemaphoreTake(g_serialMutex, portMAX_DELAY);
  countDrop(line.length());
  xSemaphoreGive(g_serialMutex);
}

void journalSetPacketEdgeGuard(bool on) {
  if (!g_serialMutex) return;
  xSemaphoreTake(g_serialMutex, portMAX_DELAY);
  g_packetEdgeGuard = on;
  xSemaphoreGive(g_serialMutex);
}

bool journalPacketEdgeGuard() { return g_packetEdgeGuard; }

uint32_t journalPacketEdgeLate() { return g_packetEdgeLate; }
#endif

}  // namespace bob
