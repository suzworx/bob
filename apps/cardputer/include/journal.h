// Bob Cardputer v2 — PII-free single-line diagnostics to USB serial.
#pragma once

#include <WString.h>
#include "types.h"

namespace bob {

// Emits one line to USB serial. The server-assigned session id is appended once
// a welcome has been accepted so device lines correlate with server journal
// entries. Intentionally excludes audio, text, credentials, URLs, headers, and
// tokens.
void journal(const char* event, State state, const String& sessionId, const String& detail = "");

// Sets up Serial for non-blocking journal output (a 4 KB TX ring, a short TX
// timeout) and begins it at 115200. Call once, first thing in setup.
void journalBegin();

// Journal lines dropped since boot because the host was not reading fast
// enough (never waits for the host; see journal.cpp).
uint32_t journalDroppedLines();

#ifdef BOB_TEST_CONSOLE
// One `T> <reply>` line for the HIL test console, under the same serial lock
// as journal() so a reply never interleaves with a journal line.
void consoleReply(const String& reply);

// `T zlp on|off`: the packet-edge guard (usb_packet.h) is on from boot; off
// writes every line in one piece, as before #709 c3, so a HIL run can compare.
void journalSetPacketEdgeGuard(bool on);
bool journalPacketEdgeGuard();
// Since boot: held-back tails written before the ring had drained (the wait
// is bounded), so their line may still have ended on a full packet.
uint32_t journalPacketEdgeLate();
#endif

}  // namespace bob
