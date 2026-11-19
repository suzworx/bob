// CP-709-BACKOFF c3: a serial line whose burst ends on a full 64-byte USB
// packet can stick on the host (include/usb_packet.h). The guard splits such a
// line so the burst always ends on a short packet.
#include <cstddef>
#include <vector>

#include "doctest.h"
#include "usb_packet.h"

using bob::echoReplyBytes;
using bob::endsOnPacketBoundary;
using bob::kEchoMaxBytes;
using bob::kEchoMinBytes;
using bob::kUsbPacketBytes;
using bob::lastPacketBytes;
using bob::packetEdgeTail;
using bob::validEchoLength;

namespace {

// The HWCDC ISR's view: the ring's bytes leave in packets of up to 64.
std::vector<size_t> packetize(size_t bytes) {
  std::vector<size_t> packets;
  while (bytes > 0) {
    const size_t n = bytes < kUsbPacketBytes ? bytes : kUsbPacketBytes;
    packets.push_back(n);
    bytes -= n;
  }
  return packets;
}

// The last packet the host sees for one line written by the guarded emit():
// the whole line behind `queued`, or head behind `queued`, a drain, then the
// tail alone.
size_t lastPacketGuarded(size_t queued, size_t length) {
  if (!endsOnPacketBoundary(queued, length)) return packetize(queued + length).back();
  const size_t tail = packetEdgeTail(length);
  return packetize(tail).back();
}

}  // namespace

TEST_CASE("usb packet: the last packet of a burst") {
  CHECK(lastPacketBytes(0, 0) == 0);
  CHECK(lastPacketBytes(0, 63) == 63);
  CHECK(lastPacketBytes(0, 64) == 64);
  CHECK(lastPacketBytes(0, 65) == 1);
  CHECK(lastPacketBytes(0, 128) == 64);
  CHECK(lastPacketBytes(2, 126) == 64);  // a 126-byte reply behind 2 queued bytes
  CHECK(lastPacketBytes(10, 100) == 46);
  for (size_t n = 1; n <= 300; ++n) CHECK(lastPacketBytes(0, n) == packetize(n).back());
}

TEST_CASE("usb packet: which lines are at risk") {
  // The HIL run 20260929-233629-b7e0 case: a 128-byte T state reply.
  CHECK(endsOnPacketBoundary(0, 128));
  for (size_t n : {64u, 128u, 192u, 256u}) CHECK(endsOnPacketBoundary(0, n));
  for (size_t n : {63u, 65u, 126u, 127u, 129u}) CHECK_FALSE(endsOnPacketBoundary(0, n));
  CHECK(endsOnPacketBoundary(2, 126));    // together they fill two packets
  CHECK(endsOnPacketBoundary(10, 128));   // the ISR may take the 10 alone first
  CHECK_FALSE(endsOnPacketBoundary(10, 100));
  CHECK_FALSE(endsOnPacketBoundary(0, 0));
}

TEST_CASE("usb packet: the guard always ends a line on a short packet") {
  for (size_t queued = 0; queued <= 200; ++queued) {
    for (size_t length = 2; length <= 300; ++length) {
      CAPTURE(queued);
      CAPTURE(length);
      const size_t last = lastPacketGuarded(queued, length);
      CHECK(last > 0);
      CHECK(last < kUsbPacketBytes);
      // And if the ISR drained the queued bytes before the write:
      CHECK(lastPacketGuarded(0, length) < kUsbPacketBytes);
    }
  }
}

TEST_CASE("usb packet: the split keeps every byte, head first") {
  for (size_t length = 2; length <= 300; ++length) {
    const size_t tail = packetEdgeTail(length);
    CHECK(tail >= 1);
    CHECK(tail < length);
    CHECK(tail < kUsbPacketBytes);
    CHECK((length - tail) + tail == length);
  }
  CHECK(packetEdgeTail(1) == 0);
  CHECK(packetEdgeTail(0) == 0);
}

TEST_CASE("usb packet: T echo lengths") {
  CHECK(kEchoMinBytes == 16);
  CHECK(kEchoMaxBytes == 300);
  CHECK_FALSE(validEchoLength(15));
  CHECK(validEchoLength(16));
  CHECK(validEchoLength(300));
  CHECK_FALSE(validEchoLength(301));
  CHECK_FALSE(validEchoLength(-1));
  CHECK(echoReplyBytes(128) + 5 == 128);  // "T> " + reply + "\r\n"
}
