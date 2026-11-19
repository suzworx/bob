// bob-sim shim for M5Unified.h: M5Canvas is a LovyanGFX sprite and M5.Display is a 360x360
// RGB565 sprite standing in for the panel (the sim reads it back and writes PNGs).
// `using namespace lgfx` is avoided on purpose: LovyanGFX's Linux layer defines its own
// millis()/delay() that would clash with the deterministic clock in Arduino.h.
#pragma once

#include <LovyanGFX.hpp>

#include "Arduino.h"

using namespace lgfx::v1::textdatum;

using M5Canvas = lgfx::LGFX_Sprite;

struct M5Class
{
  lgfx::LGFX_Sprite Display;
};
inline M5Class M5;
