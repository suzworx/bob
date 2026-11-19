// bob-sim shim for M5Cardputer.h: board.h and round_touch.h only name the key-state type in
// declarations; the sim never reads keys, so an empty struct is enough.
#pragma once

#include "M5Unified.h"

struct Keyboard_Class
{
  struct KeysState
  {
    bool del = false, enter = false, tab = false, fn = false, shift = false, ctrl = false, opt = false, alt = false, space = false;
  };
};
