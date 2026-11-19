// Bob Cardputer v2 — main state machine and module wiring.
#pragma once

#include <WString.h>

namespace bob {

// Initializes the Cardputer, modules, and playback buffer.
void stateSetup();

// Runs one main-loop iteration: Wi-Fi/WebSocket supervision, PTT capture,
// reply playback drain, and error retry.
void stateLoop();

// Returns true when the device has been welcomed by the server.
bool isWelcomed();

// Diagnostics, exported for the playback teardown journal: session-scoped
// network RX counters and the ws_net task's stack high-water mark.
String networkRxJournalDetail();
uint32_t wsNetStackWatermark();

}  // namespace bob
