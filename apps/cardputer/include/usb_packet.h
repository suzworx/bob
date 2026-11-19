// Bob Cardputer v2 — USB-Serial-JTAG packet edges (#709 c3), pure so the
// host tests run it.
//
// The HWCDC TX ISR moves at most 64 bytes of the TX ring into the IN FIFO per
// packet and commits it with wr_done (arduino-esp32 3.20017 HWCDC.cpp:127-137,
// usb_serial_jtag_ll.h:21 USB_SERIAL_JTAG_PACKET_SZ_BYTES). It never sends a
// zero-length packet, and the HAL does not document one (usb_serial_jtag_ll.h:
// 150-159; usb_serial_jtag_reg.h:50-51 WR_DONE). A USB bulk IN transfer ends
// on a short packet, so when a burst of output ends on a full 64-byte packet
// the host driver can hold those bytes until more output follows.
//
// The guard: a line that could end a burst on a full packet is written in two
// parts: all but its last packetEdgeTail() bytes, then, once the ring has
// drained, the tail on its own, a short packet. The bytes never change.
#pragma once

#include <cstddef>

namespace bob {

constexpr size_t kUsbPacketBytes = 64;

// The size of the last packet when `length` bytes are appended to `queued`
// bytes still in the TX ring and all of it leaves in 64-byte packets: 1..64,
// or 0 for nothing at all.
constexpr size_t lastPacketBytes(size_t queued, size_t length) {
  return queued + length == 0 ? 0
         : (queued + length) % kUsbPacketBytes == 0 ? kUsbPacketBytes
                                                     : (queued + length) % kUsbPacketBytes;
}

// True when writing `length` bytes now could end the burst on a full packet:
// behind the queued bytes, or on its own if the ISR drains the queued bytes
// (fewer than 64 go as one short packet) between the check and the write.
constexpr bool endsOnPacketBoundary(size_t queued, size_t length) {
  return length > 0 && (lastPacketBytes(queued, length) == kUsbPacketBytes ||
                        length % kUsbPacketBytes == 0);
}

// How many bytes to hold back and write alone once the ring is empty: always
// a short, non-empty packet, and never the whole line (0 for a 1-byte line,
// which cannot be split and cannot fill a packet either).
constexpr size_t packetEdgeTail(size_t length) { return length >= 2 ? 1 : 0; }

// `T echo <n>` (test console): a reply line of exactly n bytes, "T> " and
// CRLF included, for n in [kEchoMinBytes, kEchoMaxBytes].
constexpr size_t kEchoMinBytes = 16;
constexpr size_t kEchoMaxBytes = 300;
constexpr bool validEchoLength(long n) {
  return n >= static_cast<long>(kEchoMinBytes) && n <= static_cast<long>(kEchoMaxBytes);
}
// The reply text between "T> " and CRLF.
constexpr size_t echoReplyBytes(size_t n) { return n - 5; }

}  // namespace bob
