// Bob's board seam (ADR 0004): what the portable core needs from a target, as one descriptor per board, the way the
// Muse gadget SDK describes a board (geometry, capabilities, a few operations). Each target defines bob::hal() once:
// apps/cardputer/src/bob_board.cpp for the ESP32 boards, tools/bob-sim/src/stubs.cpp for the desktop simulator.
// No Arduino, no M5 here. libs/bob-device/README.md lists which operations the core calls today.
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace bob
{

// RGB565 pixels in the panel's byte order (big-endian, as LovyanGFX sprites hold them), rows of w * 2 bytes.
struct Framebuffer
{
  uint8_t* pixels;
  int w, h;
};

struct Rect
{
  int16_t x, y, w, h;
};

// Where an allocation lives: kAny is any byte-addressable RAM, kLarge the big pool (PSRAM on the ESP32-S3).
enum class Mem : uint8_t { kAny, kLarge };

struct Board
{
  const char* id;  // the board id the server knows (board::id() on the device): "cardputer", "waveshare-s3-185c", "sim"
  int16_t w, h;    // the display, px
  bool round;      // a round glass (the Bob-first UI) or a rectangle
  bool touch, keyboard;
  // Operations; null where the board lacks the feature.
  Framebuffer (*framebuffer)();               // the screen's framebuffer
  void (*dirty)(Rect r);                      // marks part of it for the next present
  void (*present)(uint32_t nowMs);            // pushes the dirty rectangles to the panel
  bool (*touchPoint)(int16_t* x, int16_t* y); // the finger, false when none
  bool (*buttonHeld)();                       // the talk button
  float (*micLevel01)();                      // live audio levels, 0..1
  float (*speakerLevel01)();
  uint32_t (*nowMs)();                        // the monotonic clock
  void* (*alloc)(size_t bytes, Mem where);    // null when out of memory
};

const Board& hal();

} // namespace bob
