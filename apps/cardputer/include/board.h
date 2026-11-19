// Bob Cardputer v2 — board seam. One implementation .cpp per board, chosen at
// build time (board_cardputer.cpp unless BOB_BOARD_WAVESHARE_185C is defined).
// Only the calls that are not plain M5.* references live here; Display,
// Speaker, Mic, BtnA and Power are used directly.
#pragma once

#include <M5Cardputer.h>

namespace bob {
namespace board {

// M5 config and begin, plus display rotation. Call once from setup().
void begin();

// Polls the board's inputs. Call once per loop pass.
void update();

// True when the key state changed since the last update(). A board without a
// keyboard always returns false.
bool keysChanged();

// Current key state. A board without a keyboard returns an empty state.
const Keyboard_Class::KeysState& keys();

// True while any key is held.
bool anyKeyPressed();

// Board id sent in the OTA manifest request, e.g. "cardputer".
const char* id();

// Device model sent in pair_request (at most 64 chars): what the web app lists the device as.
const char* model();

// Battery level 0..100, or -1 when the board cannot tell.
int batteryPct();

// 1 charging, 0 discharging, -1 unknown.
int charging();

}  // namespace board
}  // namespace bob
